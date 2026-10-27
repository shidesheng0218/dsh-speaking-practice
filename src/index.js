/**
 * index.js - Cordis host entry for dsh-speaking-practice v0.2.
 *
 * Registers the /voice command, owns the single active voice session, forwards
 * session events into the voice loop, injects transcripts as user messages and
 * speaks assistant replies through macOS say. v0.2 also wires in the coach
 * protocol (src/coach.js): /voice on loads content/, selects a scenario and
 * installs the coach section on the current agent's system prompt; /voice off
 * and plugin dispose release it again.
 *
 * Defensive service lookup: ctx.commands / ctx.speechToText / ctx.subprocess /
 * ctx.agents are resolved with ctx.get(name) and a missing service is logged
 * instead of crashing the whole plugin, so installation problems stay
 * diagnosable from logs/voice-practice.log.
 */
import z from '@deepseek-ai/schemastery';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-speaking-practice';
export const inject = [];

/**
 * Cache-busting token inherited from the dev shell (plugin.js imports this
 * module with ?t=<timestamp> on reload). Applying it to local module URLs makes
 * edits under src/core take effect on remount as well.
 */
const IMPORT_VERSION = (() => {
  try {
    return new URL(import.meta.url).search;
  } catch (_urlError) {
    return '';
  }
})();

async function loadLocalModules() {
  const [logModule, micModule, ttsModule, loopModule, optionsModule, textModule, coachModule, statsModule, lightRecapModule] = await Promise.all([
    import('./log.js' + IMPORT_VERSION),
    import('./mic.js' + IMPORT_VERSION),
    import('./tts.js' + IMPORT_VERSION),
    import('./core/loop.js' + IMPORT_VERSION),
    import('./core/options.js' + IMPORT_VERSION),
    import('./core/text.js' + IMPORT_VERSION),
    import('./coach.js' + IMPORT_VERSION),
    import('./core/stats.js' + IMPORT_VERSION),
    import('./core/light-recap.js' + IMPORT_VERSION),
  ]);
  return {
    createLog: logModule.createLog,
    createMic: micModule.createMic,
    createSpeaker: ttsModule.createSpeaker,
    VoiceLoop: loopModule.VoiceLoop,
    isWithinRoot: optionsModule.isWithinRoot,
    normalizeOptions: optionsModule.normalizeOptions,
    resolveLogPath: optionsModule.resolveLogPath,
    summarizeText: textModule.summarizeText,
    createCoachController: coachModule.createCoachController,
    ensureRecapDir: coachModule.ensureRecapDir,
    loadScenarios: coachModule.loadScenarios,
    resolvePracticeDir: coachModule.resolvePracticeDir,
    createSessionStats: statsModule.createSessionStats,
    writeLightRecap: lightRecapModule.writeLightRecap,
  };
}

export const Config = z.object({
  practiceRoot: z.string().default(''),
  englishVoice: z.string().default('Samantha'),
  chineseVoice: z.string().default('Tingting'),
  rate: z.natural().min(80).max(320).default(175),
  language: z.string().default('auto'),
  silenceMs: z.natural().min(250).max(2000).default(600),
  minSpeechMs: z.natural().min(80).max(2000).default(200),
  maxUtteranceSec: z.natural().min(5).max(180).default(45),
  bargeIn: z.boolean().default(true),
  logFile: z.string().default('logs/voice-practice.log'),
  selfTest: z.boolean().default(false),
});

function errorText(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch (_textError) {
    return 'unknown error';
  }
}

function shortId(id) {
  const text = typeof id === 'string' ? id : String(id ?? '');
  return text.length <= 12 ? text : text.slice(0, 8) + '...';
}

function safeGet(ctx, serviceName) {
  try {
    const service = ctx.get(serviceName);
    return service === undefined ? null : service;
  } catch (error) {
    return null;
  }
}

/**
 * Cordis plugin body.
 * @param {object} ctx cordis host context.
 * @param {object} rawConfig Config payload from cordis.patch.yml.
 */
export async function apply(ctx, rawConfig) {
  const {
    createLog,
    createMic,
    createSpeaker,
    VoiceLoop,
    isWithinRoot,
    normalizeOptions,
    resolveLogPath,
    summarizeText,
    createCoachController,
    ensureRecapDir,
    loadScenarios,
    resolvePracticeDir,
    createSessionStats,
    writeLightRecap,
  } = await loadLocalModules();
  const options = normalizeOptions(rawConfig);
  const logPath = resolveLogPath(options.practiceRoot, options.logFile);
  const log = createLog({ filePath: logPath, ctxLogger: ctx?.logger, scope: 'voice-practice' });
  log.info('plugin loaded: practiceRoot=' + (options.practiceRoot === '' ? '(any)' : options.practiceRoot)
    + ' log=' + logPath);

  const services = {
    commands: safeGet(ctx, 'commands'),
    speechToText: safeGet(ctx, 'speechToText'),
    subprocess: safeGet(ctx, 'subprocess'),
    agents: safeGet(ctx, 'agents'),
    systemPrompt: safeGet(ctx, 'systemPrompt'),
  };
  for (const serviceName of Object.keys(services)) {
    if (services[serviceName] === null) {
      log.warn('service "' + serviceName + '" is unavailable; voice features depending on it are disabled');
    }
  }

  let createUserMessage = null;
  try {
    const llm = await import('@deepseek-ai/dsh-llm');
    if (typeof llm.createUserMessage === 'function') createUserMessage = llm.createUserMessage;
    else log.error('@deepseek-ai/dsh-llm has no createUserMessage export');
  } catch (error) {
    log.error('cannot load @deepseek-ai/dsh-llm: ' + errorText(error));
  }

  let speaker = null;
  if (services.subprocess === null) {
    log.warn('ctx.subprocess is missing: microphone capture and TTS are unavailable');
  } else {
    speaker = createSpeaker({ subprocess: services.subprocess, config: options, log });
  }

  let active = null;

  // v0.2 coach protocol: loads <pluginRoot>/content + profile.md on every
  // /voice on, composes one system-prompt section and owns its disposer.
  const coach = createCoachController({ log });

  async function voiceOn(agent, scenarioQuery = '') {
    const session = agent !== null && typeof agent === 'object' ? agent.session : null;
    const sessionId = session !== null && typeof session === 'object' && typeof session.id === 'string'
      ? session.id
      : '';
    const cwd = session !== null && typeof session === 'object' && session.header !== null
      && typeof session.header === 'object' && typeof session.header.cwd === 'string'
      ? session.header.cwd
      : '';
    if (sessionId === '') return { kind: 'error', text: '/voice on needs an active session.' };
    if (!isWithinRoot(cwd, options.practiceRoot)) {
      return {
        kind: 'error',
        text: '/voice on refused: session cwd "' + (cwd === '' ? '?' : cwd)
          + '" is outside practiceRoot "' + options.practiceRoot + '".',
      };
    }
    if (services.subprocess === null) {
      return { kind: 'error', text: '/voice on unavailable: ctx.subprocess service missing (see ' + logPath + ')' };
    }
    if (services.speechToText === null) {
      return { kind: 'error', text: '/voice on unavailable: ctx.speechToText service missing (see ' + logPath + ')' };
    }
    if (speaker === null) {
      return { kind: 'error', text: '/voice on unavailable: TTS adapter could not be created (see ' + logPath + ')' };
    }
    // Resolve the scenario before touching a running session: a mistyped id
    // must not interrupt voice mode that is already listening.
    const prepared = await coach.prepare(scenarioQuery);
    if (!prepared.ok) {
      const available = prepared.available.length === 0 ? '(none)' : prepared.available.join(', ');
      return {
        kind: 'error',
        text: '/voice on: ' + prepared.error + '. Available scenarios: ' + available,
      };
    }
    if (active !== null) {
      log.info('voice mode restart requested; stopping the previous session and its coach prompt first');
      await voiceOff('restart', false);
    }
    // The recap template asks the model to write practice/YYYY-MM-DD-HHmm-<scenario>.md,
    // so the directory has to exist before the first turn; failure only warns.
    const practiceDir = resolvePracticeDir(options.practiceRoot, cwd);
    await ensureRecapDir(practiceDir, log);
    // Injection failure never blocks voice mode: the loop keeps running and the
    // status command/log report coach: off with the reason.
    let activation = null;
    try {
      activation = await coach.activate({
        agent,
        ctx,
        scenarioQuery,
        practiceDir,
        materials: prepared.materials,
      });
    } catch (error) {
      log.error('coach activation threw; continuing without the coach prompt: ' + errorText(error));
    }
    const scenario = activation !== null && activation.scenario !== undefined && activation.scenario !== null
      ? activation.scenario
      : prepared.scenario;
    const coachScope = activation !== null && activation.injected === true ? activation.scope : '';
    if (coachScope === '') {
      log.warn('coach prompt is not active; voice mode continues without it (see ' + logPath + ')');
    }
    const sessionStats = createSessionStats({
      sessionId,
      scenarioId: scenario.id,
      level: scenario.level,
    });
    const mic = createMic({ subprocess: services.subprocess, config: options, log });
    const loop = new VoiceLoop({
      sessionId,
      cwd,
      config: options,
      logger: log,
      mic,
      tts: speaker,
      stt: sttAdapter(),
      stats: sessionStats,
      submit: (text) => submitTranscript(sessionId, text),
      requestVoiceOff: (reason) => voiceOff(typeof reason === 'string' && reason !== '' ? reason : 'voice-command', true),
      onFatal: (error) => {
        log.error('microphone fatal; leaving voice mode: ' + errorText(error));
        // Speak a human explanation before the loop is torn down.
        Promise.resolve()
          .then(() => announceChinese('麦克风好像断开了，语音模式已关闭，练习记录会尽量保存。'))
          .catch(() => {})
          .then(() => voiceOff('mic-fatal', false))
          .catch((offError) => {
            log.error('voice off after mic fatal failed: ' + errorText(offError));
          });
      },
    });
    active = {
      sessionId,
      cwd,
      loop,
      mic,
      stats: sessionStats,
      startedAt: Date.now(),
      scenarioId: scenario.id,
      scenarioTitle: typeof scenario.name === 'string' ? scenario.name : scenario.id,
      level: typeof scenario.level === 'string' ? scenario.level : '',
      coachScope,
      practiceDir,
    };
    try {
      await loop.start();
    } catch (error) {
      active = null;
      await coach.release();
      const tail = error !== null && typeof error === 'object' && typeof error.stderrTail === 'string'
        ? error.stderrTail
        : '';
      log.error('microphone start failed: ' + errorText(error));
      if (tail !== '') log.error('ffmpeg stderr tail: ' + tail);
      return {
        kind: 'error',
        text: '/voice on 启动失败：' + errorText(error)
          + (tail === '' ? '' : '｜ffmpeg: ' + summarizeText(tail, 200))
          + '（排查日志：' + logPath + '）',
      };
    }
    startIdleWatch(active);
    try {
      services.speechToText.prepare('sensevoice-local');
      log.info('speech-to-text prepare requested (sensevoice-local)');
    } catch (error) {
      log.warn('speech-to-text prepare failed: ' + errorText(error));
    }
    loop.announce('Voice mode is on. I am listening.').catch((error) => {
      log.warn('on announcement failed: ' + errorText(error));
    });
    log.info('voice mode ON session=' + shortId(sessionId) + ' cwd=' + cwd
      + ' scenario=' + scenario.id + ' coach=' + (coachScope === '' ? 'off' : coachScope));
    return {
      kind: 'success',
      text: 'Voice mode ON. Scenario: ' + scenario.id
        + (typeof scenario.nameZh === 'string' && scenario.nameZh !== '' ? ' (' + scenario.nameZh + ')' : '')
        + '. Coach prompt: ' + (coachScope === '' ? 'OFF (see ' + logPath + ')' : 'on (' + coachScope + ' scope)')
        + '. Listening on session ' + shortId(sessionId)
        + '. Say "stop listening" or use /voice off to exit.',
    };
  }

  async function voiceOff(reason, shouldAnnounce = true) {
    const current = active;
    active = null;
    stopIdleWatch(current);
    // Remove the coach section before stopping the loop so the next model step
    // can never be assembled from a half-released prompt.
    await coach.release();
    if (current !== null) {
      try {
        await current.loop.stop(reason);
      } catch (error) {
        log.warn('voice loop stop failed: ' + errorText(error));
      }
      log.info('voice mode OFF (' + reason + ')');
    }
    const recap = await maybeWriteLightRecap(current, reason);
    if (shouldAnnounce && speaker !== null) {
      await announceChinese('语音模式已关闭。');
      if (recap !== null && typeof recap.path === 'string' && recap.path !== '') {
        await announceChinese('练习记录已保存到 practice 文件夹。');
      }
    }
    return { wasActive: current !== null, recap };
  }

  /** Speak one short system message with the Chinese voice (never throws). */
  async function announceChinese(text) {
    if (speaker === null || typeof text !== 'string' || text === '') return;
    try {
      await speaker.speak([{ lang: 'zh', text }]);
    } catch (error) {
      log.warn('chinese announcement failed: ' + errorText(error));
    }
  }

  const IDLE_REMIND_MS = 180000;
  const IDLE_STOP_MS = 600000;

  function stopIdleWatch(target) {
    const current = target === undefined ? active : target;
    if (current === null || current === undefined) return;
    if (current.idleTimer !== undefined && current.idleTimer !== null) {
      clearInterval(current.idleTimer);
      current.idleTimer = null;
    }
  }

  function startIdleWatch(current) {
    stopIdleWatch(current);
    current.idleReminded = false;
    current.idleTimer = setInterval(() => {
      void checkIdle(current);
    }, 15000);
    if (typeof current.idleTimer.unref === 'function') current.idleTimer.unref();
  }

  async function checkIdle(current) {
    if (active !== current) {
      stopIdleWatch(current);
      return;
    }
    let last = 0;
    try {
      const status = typeof current.loop.status === 'function' ? current.loop.status() : null;
      if (status !== null && status !== undefined && Number.isFinite(Number(status.lastActivityAt))) {
        last = Number(status.lastActivityAt);
      }
    } catch (error) {
      log.warn('idle status read failed: ' + errorText(error));
    }
    if (last === 0) last = current.startedAt;
    const idleMs = Date.now() - last;
    if (idleMs >= IDLE_STOP_MS) {
      log.info('idle timeout reached; closing voice mode');
      await voiceOff('idle', true);
      return;
    }
    if (idleMs >= IDLE_REMIND_MS && current.idleReminded !== true) {
      current.idleReminded = true;
      await announceChinese('还在吗？我们可以继续，或者说 end session 结束练习。');
      return;
    }
    if (idleMs < IDLE_REMIND_MS) current.idleReminded = false;
  }

  /**
   * Write the deterministic light recap after a session. The model-written recap
   * (from "end session") wins: writeLightRecap skips when it already exists.
   * Never throws; returns { path, skipped, reason }.
   */
  async function maybeWriteLightRecap(current, reason) {
    if (current === null || current === undefined) return { path: '', skipped: true, reason: 'no-session' };
    if (reason === 'restart') return { path: '', skipped: true, reason: 'restart' };
    const stats = current.stats;
    if (stats === null || stats === undefined || typeof stats.snapshot !== 'function') {
      return { path: '', skipped: true, reason: 'no-stats' };
    }
    let snapshot = null;
    try {
      snapshot = stats.snapshot();
    } catch (error) {
      log.warn('session stats snapshot failed: ' + errorText(error));
      return { path: '', skipped: true, reason: 'snapshot-failed' };
    }
    if (snapshot === null || typeof snapshot !== 'object' || Number(snapshot.userUtterances) === 0) {
      log.info('light recap skipped: no user utterances');
      return { path: '', skipped: true, reason: 'no-utterances' };
    }
    // Very short sessions (mic test, hot-reload during dev) are not worth a file.
    if (Number.isFinite(Number(snapshot.durationMs)) && Number(snapshot.durationMs) < 60000) {
      log.info('light recap skipped: session shorter than 60s');
      return { path: '', skipped: true, reason: 'short-session' };
    }
    try {
      const result = await writeLightRecap({
        practiceDir: current.practiceDir,
        stats: snapshot,
        scenario: {
          id: current.scenarioId,
          name: current.scenarioTitle,
          nameZh: '',
        },
        level: current.level,
        log,
        now: new Date(),
      });
      if (result !== null && typeof result === 'object' && result.skipped === true) {
        log.info('light recap skipped: ' + String(result.reason));
      } else if (result !== null && typeof result === 'object') {
        log.info('light recap written: ' + String(result.path));
      }
      return result;
    } catch (error) {
      log.warn('light recap failed: ' + errorText(error));
      return { path: '', skipped: true, reason: 'error' };
    }
  }

  /** One /voice status line describing the coach prompt injection. */
  function coachStatusLine() {
    const status = coach.status();
    if (status.active === true) return 'coach: on (scope=' + status.scope + ', ' + status.textLength + ' chars)';
    // Only surface the failure while voice mode is on; otherwise the reason
    // would be a stale leftover from a previous session.
    const detail = active !== null && status.error !== ''
      ? ' (injection failed: ' + summarizeText(status.error, 100) + ')'
      : '';
    return 'coach: off' + detail;
  }

  function voiceStatus() {
    const current = active;
    if (current === null) {
      return {
        kind: 'success',
        text: [
          'Voice mode: off.',
          'scenario: (none)',
          coachStatusLine(),
          'log: ' + logPath,
        ].join('\n'),
      };
    }
    let status;
    try {
      status = current.loop.status();
    } catch (error) {
      return { kind: 'error', text: '/voice status failed: ' + errorText(error) };
    }
    const lines = [
      'Voice mode: ON (' + status.state + ')',
      'session: ' + shortId(status.sessionId) + '  cwd=' + (status.cwd === '' ? '?' : status.cwd),
      'scenario: ' + (typeof current.scenarioId === 'string' && current.scenarioId !== '' ? current.scenarioId : '?')
        + (typeof current.practiceDir === 'string' && current.practiceDir !== '' ? '  practice=' + current.practiceDir : ''),
      coachStatusLine(),
      'mic: ' + (status.micRunning ? 'capturing' : 'stopped'),
      'last transcript: ' + (status.lastTranscript === '' ? '(none)' : summarizeText(status.lastTranscript, 100)),
      'last error: ' + (status.lastError === '' ? '(none)' : summarizeText(status.lastError, 120)),
      'reply: ' + (status.replyActive ? 'waiting (turn=' + String(status.replyTurn) + ')' : 'idle'),
      'log: ' + logPath,
    ];
    return { kind: 'success', text: lines.join('\n') };
  }

  /** List the scenarios found in content/scenarios (or the built-in fallback). */
  async function voiceScenarios() {
    let listing;
    try {
      listing = await loadScenarios({ log });
    } catch (error) {
      return { kind: 'error', text: '/voice scenarios failed: ' + errorText(error) + ' (log: ' + logPath + ')' };
    }
    const lines = listing.scenarios.map((scenario) => {
      const zh = typeof scenario.nameZh === 'string' && scenario.nameZh !== '' ? ' — ' + scenario.nameZh : '';
      const level = typeof scenario.level === 'string' && scenario.level !== '' ? scenario.level : 'level ?';
      const source = scenario.source === 'builtin' ? ' (built-in fallback)' : '';
      return '- ' + scenario.id + zh + ' [' + level + ']' + source;
    });
    const footer = listing.fallback
      ? '\nNo usable content/scenarios/*.json yet; the built-in fallback is in use.'
      : '';
    return {
      kind: 'success',
      text: ['Available scenarios (' + listing.scenarios.length + '):'].concat(lines).join('\n') + footer,
    };
  }

  function sttAdapter() {
    return {
      async transcribe(wavBuffer, signal) {
        const speech = services.speechToText;
        if (speech === null) throw new Error('ctx.speechToText service missing');
        const language = options.language === '' ? 'auto' : options.language;
        const spec = speech.resolve({ audio: wavBuffer, language });
        return speech.transcribe(spec, signal);
      },
    };
  }

  async function submitTranscript(sessionId, text) {
    if (typeof createUserMessage !== 'function') {
      throw new Error('@deepseek-ai/dsh-llm unavailable: cannot create a user message');
    }
    const agents = services.agents;
    if (agents === null || typeof agents.get !== 'function') {
      throw new Error('ctx.agents service missing');
    }
    const found = agents.get(sessionId);
    const agent = found !== null && typeof found === 'object' && found.agent !== undefined ? found.agent : found;
    if (agent === null || agent === undefined) {
      throw new Error('no live agent for session ' + shortId(sessionId) + ' (open the session first)');
    }
    if (typeof agent.followup !== 'function') {
      throw new Error('agent does not expose followup()');
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    agent.followup(message);
    log.info('submitted transcript to ' + shortId(sessionId) + ' (' + text.length + ' chars)');
    return { messageId: message.id };
  }

  async function handleCommand(invocation) {
    const raw = invocation !== null && typeof invocation === 'object'
      && typeof invocation.rawInput === 'string'
      ? invocation.rawInput.trim()
      : '';
    const lower = raw.toLowerCase();
    try {
      if (lower === '' || lower === 'status') return voiceStatus();
      if (lower === 'scenarios' || lower === 'list') return await voiceScenarios();
      if (lower === 'selftest') {
        if (options.selfTest !== true) {
          // Allow the diagnostic to run on demand even when startup self-test is off.
          setTimeout(() => {
            runSelfTest().catch((error) => log.error('SELFTEST FAIL: ' + errorText(error)));
          }, 50);
          return { kind: 'success', text: 'Self-test started; result will appear in ' + logPath + ' (SELFTEST ...)' };
        }
        return { kind: 'success', text: 'Self-test already enabled for this mount; see ' + logPath };
      }
      if (lower === 'on') return await voiceOn(invocation.agent, '');
      if (lower.startsWith('on ')) return await voiceOn(invocation.agent, raw.slice(3).trim());
      if (lower === 'off') {
        const result = await voiceOff('command', true);
        return {
          kind: 'success',
          text: result.wasActive
            ? '语音模式已关闭，麦克风与朗读已释放。'
            : '语音模式当前已经是关闭状态。',
        };
      }
      return {
        kind: 'error',
        text: 'Usage: /voice on [scenario] | off | scenarios | status (received "' + raw + '")',
      };
    } catch (error) {
      const message = errorText(error);
      log.error('/voice ' + raw + ' failed: ' + message);
      return { kind: 'error', text: '/voice failed: ' + message + ' (log: ' + logPath + ')' };
    }
  }

  if (services.commands !== null && typeof services.commands.register === 'function') {
    try {
      const disposeCommand = services.commands.register({
        name: 'voice',
        description: 'Hands-free English practice: coach prompt, scenario and spoken replies',
        input: { hint: 'on | off | status' },
        handler: handleCommand,
      });
      ctx.effect(() => (typeof disposeCommand === 'function' ? disposeCommand : undefined), 'voice: command');
      log.info('/voice command registered');
    } catch (error) {
      log.error('registering the /voice command failed: ' + errorText(error));
    }
  } else {
    log.warn('ctx.commands is unavailable: the /voice command was not registered');
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    try {
      const current = active;
      if (current === null) return;
      const streamSessionId = agent !== null && agent !== undefined && agent.session !== undefined
        ? agent.session.id
        : '';
      if (streamSessionId !== current.sessionId) return;
      if (typeof current.loop.onStreamFrame === 'function') current.loop.onStreamFrame(frame);
    } catch (error) {
      log.warn('assistant stream handling failed: ' + errorText(error));
    }
  }, { global: true });

  ctx.on('session/event', (session, event) => {
    try {
      const current = active;
      if (current === null) return;
      if (session === null || typeof session !== 'object' || session.id !== current.sessionId) return;
      current.loop.onSessionEvent(event);
    } catch (error) {
      log.error('session event handling failed: ' + errorText(error));
    }
  });

  ctx.effect(() => async () => {
    const current = active;
    active = null;
    stopIdleWatch(current);
    // Hot reload / uninstall must not leave an agent-scoped coach section
    // behind: release it even if the agent itself outlives this plugin mount.
    try {
      await coach.release();
    } catch (error) {
      log.warn('coach prompt release during dispose failed: ' + errorText(error));
    }
    if (current !== null) {
      try {
        await current.loop.stop('dispose');
      } catch (error) {
        log.warn('loop stop during dispose failed: ' + errorText(error));
      }
      await maybeWriteLightRecap(current, 'dispose');
    }
    if (speaker !== null) {
      try {
        await speaker.cancel();
      } catch (_cancelError) {
        // Already settled.
      }
    }
    log.info('plugin disposed');
    await log.close();
  }, 'voice: dispose');

  log.info('voice-practice ready');

  // --- optional hardware self-test (config selfTest: true) -------------------
  if (options.selfTest === true) {
    setTimeout(() => {
      runSelfTest().catch((error) => log.error('SELFTEST FAIL: ' + errorText(error)));
    }, 300);
  }

  async function runSelfTest() {
    const report = [];
    let ttsOk = false;
    let micOk = false;
    try {
      report.push('subprocess=' + (services.subprocess === null ? 'MISSING' : 'ok'));
      report.push('speechToText=' + (services.speechToText === null ? 'MISSING' : 'ok'));
      report.push('commands=' + (services.commands === null ? 'MISSING' : 'ok'));
      report.push('agents=' + (services.agents === null ? 'MISSING' : 'ok'));
      report.push('createUserMessage=' + (typeof createUserMessage === 'function' ? 'ok' : 'MISSING'));
      if (services.speechToText !== null && typeof services.speechToText.listProviders === 'function') {
        const providers = services.speechToText.listProviders();
        report.push('providers=' + (providers.length === 0 ? 'none' : providers.map((p) => p.id).join(',')));
      }
      if (services.speechToText !== null && typeof services.speechToText.snapshot === 'function') {
        try {
          const snapshot = services.speechToText.snapshot();
          report.push('stt-selection=' + JSON.stringify(snapshot.selection ?? null));
        } catch (error) {
          report.push('stt-snapshot=FAILED(' + errorText(error) + ')');
        }
      }
      if (speaker !== null) {
        const voices = await speaker.detectVoices();
        report.push('voices=' + (Array.isArray(voices) ? voices.length : 'unavailable')
          + (Array.isArray(voices) && voices.length > 0
            ? '(' + voices.slice(0, 4).map((v) => v.name + '/' + v.locale).join(',') + ')' : ''));
      }
      if (services.subprocess !== null) {
        const mic = createMic({ subprocess: services.subprocess, config: options, log });
        let bytes = 0;
        let chunks = 0;
        let squareSum = 0;
        let sampleCount = 0;
        let peak = 0;
        await mic.start({
          onData: (chunk) => {
            bytes += chunk.length;
            chunks += 1;
            const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            for (let i = 0; i + 1 < view.length; i += 2) {
              const sample = view.readInt16LE(i) / 32768;
              squareSum += sample * sample;
              sampleCount += 1;
              const absolute = Math.abs(sample);
              if (absolute > peak) peak = absolute;
            }
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await mic.stop();
        const rms = sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0;
        const dbfs = (value) => (value > 0 ? (20 * Math.log10(value)).toFixed(1) : '-inf');
        micOk = bytes > 8000 && chunks > 0;
        report.push('mic=' + (micOk ? 'ok' : 'FAIL')
          + ' bytes=' + bytes + ' chunks=' + chunks
          + ' rmsdBFS=' + dbfs(rms) + ' peakdBFS=' + dbfs(peak));
      }
      if (services.subprocess !== null && services.speechToText !== null) {
        try {
          const sayExe = await services.subprocess.resolveExecutable('say');
          let ffmpegExe = '/opt/homebrew/bin/ffmpeg';
          try {
            ffmpegExe = await services.subprocess.resolveExecutable('ffmpeg');
          } catch (_ffmpegError) {
            // fall back to the Homebrew path measured in docs/audio-feasibility.md
          }
          const aiff = join(tmpdir(), 'dsh-voice-selftest.aiff');
          const pcmPath = join(tmpdir(), 'dsh-voice-selftest.pcm');
          const sayHandle = services.subprocess.spawn({
            argv: [sayExe, '-v', options.englishVoice, '-o', aiff, 'Hello, this is a speech recognition self test.'],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 4096 } },
            graceMs: 2000,
          });
          await sayHandle.done;
          // ffmpeg writes a LIST/INFO chunk, which the canonical-WAV validator rejects;
          // emit raw PCM and build the exact 44-byte header ourselves instead.
          const convert = services.subprocess.spawn({
            argv: [ffmpegExe, '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 8192 } },
            graceMs: 2000,
          });
          const converted = await convert.done;
          if (converted.exitCode !== 0) throw new Error('ffmpeg pcm conversion failed (code=' + String(converted.exitCode) + ')');
          const pcm = await readFile(pcmPath);
          const wavModule = await import('./core/wav.js' + IMPORT_VERSION);
          const audio = wavModule.buildWav(pcm);
          await unlink(aiff).catch(() => {});
          await unlink(pcmPath).catch(() => {});
          const spec = services.speechToText.resolve({ audio, language: 'en' });
          const transcript = await services.speechToText.transcribe(spec, AbortSignal.timeout(60000));
          const text = transcript !== null && typeof transcript === 'object' && typeof transcript.text === 'string'
            ? transcript.text.trim()
            : '';
          report.push('stt-transcribe=' + (text === '' ? 'EMPTY' : 'ok')
            + ' text="' + text.slice(0, 100) + '"');
        } catch (error) {
          report.push('stt-transcribe=FAILED(' + errorText(error) + ')');
        }
      }
      if (speaker !== null) {
        await speaker.speak([{ lang: 'en', text: 'Voice practice self test complete. I am ready.' }]);
        ttsOk = true;
        report.push('say=ok');
      }
    } catch (error) {
      report.push('error=' + errorText(error));
    }
    const verdict = micOk && ttsOk ? 'PASS' : 'INCOMPLETE';
    log.info('SELFTEST ' + verdict + ' | ' + report.join(' | '));
  }
}
