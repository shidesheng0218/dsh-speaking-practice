/**
 * index.js - Cordis host entry for dsh-speaking-practice v0.1.
 *
 * Registers the /voice command, owns the single active voice session, forwards
 * session events into the voice loop, injects transcripts as user messages and
 * speaks assistant replies through macOS say.
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
  const [logModule, micModule, ttsModule, loopModule, optionsModule, textModule] = await Promise.all([
    import('./log.js' + IMPORT_VERSION),
    import('./mic.js' + IMPORT_VERSION),
    import('./tts.js' + IMPORT_VERSION),
    import('./core/loop.js' + IMPORT_VERSION),
    import('./core/options.js' + IMPORT_VERSION),
    import('./core/text.js' + IMPORT_VERSION),
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

  async function voiceOn(agent) {
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
    if (active !== null) {
      log.info('voice mode restart requested; stopping the previous session first');
      await voiceOff('restart', false);
    }
    const mic = createMic({ subprocess: services.subprocess, config: options, log });
    const loop = new VoiceLoop({
      sessionId,
      cwd,
      config: options,
      logger: log,
      mic,
      tts: speaker,
      stt: sttAdapter,
      submit: (text) => submitTranscript(sessionId, text),
      requestVoiceOff: () => voiceOff('voice-command', true),
      onFatal: (error) => {
        log.error('microphone fatal; leaving voice mode: ' + errorText(error));
        Promise.resolve(voiceOff('mic-fatal', true)).catch((offError) => {
          log.error('voice off after mic fatal failed: ' + errorText(offError));
        });
      },
    });
    active = { sessionId, cwd, loop, mic, startedAt: Date.now() };
    try {
      await loop.start();
    } catch (error) {
      active = null;
      const tail = error !== null && typeof error === 'object' && typeof error.stderrTail === 'string'
        ? error.stderrTail
        : '';
      log.error('microphone start failed: ' + errorText(error));
      if (tail !== '') log.error('ffmpeg stderr tail: ' + tail);
      return {
        kind: 'error',
        text: '/voice on failed: ' + errorText(error)
          + (tail === '' ? '' : ' | ffmpeg: ' + summarizeText(tail, 200))
          + ' (log: ' + logPath + ')',
      };
    }
    try {
      services.speechToText.prepare('sensevoice-local');
      log.info('speech-to-text prepare requested (sensevoice-local)');
    } catch (error) {
      log.warn('speech-to-text prepare failed: ' + errorText(error));
    }
    loop.announce('Voice mode is on. I am listening.').catch((error) => {
      log.warn('on announcement failed: ' + errorText(error));
    });
    log.info('voice mode ON session=' + shortId(sessionId) + ' cwd=' + cwd);
    return {
      kind: 'success',
      text: 'Voice mode ON. Listening on session ' + shortId(sessionId)
        + '. Say "stop listening" or use /voice off to exit.',
    };
  }

  async function voiceOff(reason, shouldAnnounce = true) {
    const current = active;
    active = null;
    if (current !== null) {
      try {
        await current.loop.stop(reason);
      } catch (error) {
        log.warn('voice loop stop failed: ' + errorText(error));
      }
      log.info('voice mode OFF (' + reason + ')');
    }
    if (shouldAnnounce && speaker !== null) {
      Promise.resolve(speaker.speak([{ lang: 'en', text: 'Voice mode is off.' }])).catch((error) => {
        log.warn('off announcement failed: ' + errorText(error));
      });
    }
    return { wasActive: current !== null };
  }

  function voiceStatus() {
    const current = active;
    if (current === null) {
      return { kind: 'success', text: 'Voice mode: off.\nLog: ' + logPath };
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
      'mic: ' + (status.micRunning ? 'capturing' : 'stopped'),
      'last transcript: ' + (status.lastTranscript === '' ? '(none)' : summarizeText(status.lastTranscript, 100)),
      'last error: ' + (status.lastError === '' ? '(none)' : summarizeText(status.lastError, 120)),
      'reply: ' + (status.replyActive ? 'waiting (turn=' + String(status.replyTurn) + ')' : 'idle'),
      'log: ' + logPath,
    ];
    return { kind: 'success', text: lines.join('\n') };
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
      ? invocation.rawInput.trim().toLowerCase()
      : '';
    try {
      if (raw === '' || raw === 'status') return voiceStatus();
      if (raw === 'selftest') {
        if (options.selfTest !== true) {
          // Allow the diagnostic to run on demand even when startup self-test is off.
          setTimeout(() => {
            runSelfTest().catch((error) => log.error('SELFTEST FAIL: ' + errorText(error)));
          }, 50);
          return { kind: 'success', text: 'Self-test started; result will appear in ' + logPath + ' (SELFTEST ...)' };
        }
        return { kind: 'success', text: 'Self-test already enabled for this mount; see ' + logPath };
      }
      if (raw === 'on') return await voiceOn(invocation.agent);
      if (raw === 'off') {
        const result = await voiceOff('command', true);
        return {
          kind: 'success',
          text: result.wasActive
            ? 'Voice mode OFF. Microphone and speech released.'
            : 'Voice mode is already off.',
        };
      }
      return { kind: 'error', text: 'Usage: /voice on | off | status (received "' + raw + '")' };
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
        description: 'Hands-free English practice: listen, transcribe and speak replies',
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
    if (current !== null) {
      try {
        await current.loop.stop('dispose');
      } catch (error) {
        log.warn('loop stop during dispose failed: ' + errorText(error));
      }
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
