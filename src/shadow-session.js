/**
 * shadow-session.js - v0.4 shadowing (listen & repeat) orchestration.
 *
 * Reuses the same primitives as the conversation loop (resident ffmpeg mic,
 * energy VAD, SenseVoice transcription, macOS say) but runs its own small state
 * machine: speak target -> listen -> transcribe -> word diff -> feedback ->
 * next. Only one of {conversation loop, shadow session} may own the mic; the
 * index stops voice mode before starting shadowing.
 *
 * All dependencies are injected so the module can be exercised with fakes.
 *
 * @module dsh-speaking-practice/shadow-session
 */
import { buildWav } from './core/wav.js';
import { EnergyVad } from './core/vad.js';
import { diffWords, feedbackLine, pickDrills } from './core/shadow.js';

const PASS_SCORE = 70;
const MAX_ATTEMPTS = 2;
const NO_SPEECH_TIMEOUT_MS = 20000;

const NOOP_LOG = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

/**
 * @param {object} deps
 * @param {object} deps.log logger
 * @param {object} deps.config normalized plugin options
 * @param {object} deps.speaker TTS speaker (speak/cancel)
 * @param {Function} deps.createMic createMic factory
 * @param {Function} deps.stt stt adapter factory returning { transcribe(wav, signal) }
 * @param {Function} deps.getDrills async () => drills.json object
 */
export function createShadowSession(deps) {
  const log = deps.log ?? NOOP_LOG;
  const config = deps.config ?? {};
  const speaker = deps.speaker;
  const createMic = deps.createMic;
  const stt = typeof deps.stt === 'function' ? deps.stt() : deps.stt;
  const getDrills = deps.getDrills;

  let generation = 0;
  let mic = null;
  let vad = null;
  let listenTimer = null;
  let busy = false;
  let drillsCache = null;
  let picked = [];

  const state = {
    active: false,
    phase: 'idle',
    index: 0,
    total: 0,
    target: '',
    said: '',
    score: null,
    tokens: [],
    attempts: 0,
    averageScore: null,
    results: [],
    lastError: '',
    startedAt: 0,
  };

  function snapshot() {
    return {
      active: state.active,
      phase: state.phase,
      index: state.index,
      total: state.total,
      target: state.target,
      said: state.said,
      score: state.score,
      tokens: Array.isArray(state.tokens) ? state.tokens.slice(0, 60) : [],
      attempts: state.attempts,
      averageScore: state.averageScore,
      results: state.results.map((item) => ({ index: item.index, score: item.score, target: item.target, said: item.said })),
      lastError: state.lastError,
      startedAt: state.startedAt,
    };
  }

  function clearListenTimer() {
    if (listenTimer !== null) {
      clearTimeout(listenTimer);
      listenTimer = null;
    }
  }

  async function say(text) {
    if (speaker === null || speaker === undefined || typeof speaker.speak !== 'function') return;
    try {
      vad?.setSuspended?.(true);
      await speaker.speak([{ lang: 'en', text }]);
    } catch (error) {
      log.warn('shadow tts failed: ' + errorText(error));
    } finally {
      vad?.setSuspended?.(false);
      vad?.suppress?.(150);
    }
  }

  function armListenTimeout(gen) {
    clearListenTimer();
    listenTimer = setTimeout(() => {
      if (gen !== generation || state.phase !== 'listening') return;
      void onNoSpeech(gen);
    }, NO_SPEECH_TIMEOUT_MS);
    if (typeof listenTimer.unref === 'function') listenTimer.unref();
  }

  async function onNoSpeech(gen) {
    if (gen !== generation) return;
    state.attempts += 1;
    if (state.attempts >= MAX_ATTEMPTS + 1) {
      state.lastError = '没有听到声音，跳过这一句';
      await next(gen);
      return;
    }
    await say("I didn't hear you. Listen again: " + state.target);
    if (gen !== generation) return;
    state.phase = 'listening';
    armListenTimeout(gen);
  }

  async function start(input) {
    if (state.active) return { ok: false, error: 'shadow session already running' };
    const count = Math.max(1, Math.min(10, Number(input?.count) || 5));
    if (drillsCache === null) {
      try {
        drillsCache = await getDrills();
      } catch (error) {
        return { ok: false, error: '跟读素材加载失败：' + errorText(error) };
      }
    }
    picked = pickDrills(drillsCache, count);
    if (picked.length === 0) return { ok: false, error: '跟读素材为空（content/pronunciation/drills.json）' };
    generation += 1;
    const gen = generation;
    Object.assign(state, {
      active: true,
      phase: 'preparing',
      index: 0,
      total: picked.length,
      target: '',
      said: '',
      score: null,
      tokens: [],
      attempts: 0,
      averageScore: null,
      results: [],
      lastError: '',
      startedAt: Date.now(),
    });
    try {
      await openMic(gen);
    } catch (error) {
      state.active = false;
      state.phase = 'idle';
      state.lastError = '麦克风启动失败：' + errorText(error);
      return { ok: false, error: state.lastError };
    }
    if (gen !== generation) return { ok: true };
    await say('Shadowing practice. I will read one sentence. Listen, then repeat it after me.');
    if (gen !== generation) return { ok: true };
    await present(gen);
    log.info('shadow session started: ' + picked.length + ' sentence(s)');
    return { ok: true, total: picked.length };
  }

  async function openMic(gen) {
    if (typeof createMic !== 'function') throw new Error('createMic unavailable');
    mic = createMic({ subprocess: deps.subprocess, config, log });
    vad = new EnergyVad({
      sampleRate: 16000,
      silenceMs: config.silenceMs ?? 600,
      minSpeechMs: config.minSpeechMs ?? 200,
      maxUtteranceSec: Math.min(config.maxUtteranceSec ?? 45, 20),
    });
    await mic.start({
      onData: (chunk) => {
        if (gen !== generation || vad === null) return;
        let events = [];
        try {
          events = vad.push(chunk);
        } catch (error) {
          log.warn('shadow vad failed: ' + errorText(error));
          return;
        }
        for (const event of events) {
          if (event.type === 'utterance') void onUtterance(gen, event);
        }
      },
      onFatal: (error) => {
        log.error('shadow mic fatal: ' + errorText(error));
        state.lastError = '麦克风断开：' + errorText(error);
        void stop('mic-fatal');
      },
    });
  }

  async function present(gen) {
    if (gen !== generation) return;
    const item = picked[state.index];
    if (item === undefined) {
      await finish(gen);
      return;
    }
    state.target = typeof item.text === 'string' ? item.text : '';
    state.said = '';
    state.score = null;
    state.tokens = [];
    state.attempts = 0;
    state.phase = 'speaking';
    await say('Listen: ' + state.target);
    if (gen !== generation) return;
    state.phase = 'listening';
    armListenTimeout(gen);
  }

  async function onUtterance(gen, event) {
    if (gen !== generation || state.phase !== 'listening') return;
    clearListenTimer();
    state.phase = 'transcribing';
    let text = '';
    try {
      const wav = buildWav(event.pcm);
      const result = await stt.transcribe(wav, AbortSignal.timeout(20000));
      text = result !== null && typeof result === 'object' && typeof result.text === 'string'
        ? result.text.trim()
        : '';
    } catch (error) {
      state.lastError = '识别失败：' + errorText(error);
      state.phase = 'listening';
      armListenTimeout(gen);
      return;
    }
    if (gen !== generation) return;
    const diff = diffWords(state.target, text);
    state.said = text;
    state.score = diff.score;
    state.tokens = diff.tokens;
    state.attempts += 1;
    state.phase = 'feedback';
    const feedback = feedbackLine(diff);
    await say(feedback);
    if (gen !== generation) return;
    const passed = diff.score >= PASS_SCORE;
    if (passed || state.attempts >= MAX_ATTEMPTS) {
      state.results.push({ index: state.index, score: diff.score, target: state.target, said: text });
      await next(gen);
      return;
    }
    await say('One more time: ' + state.target);
    if (gen !== generation) return;
    state.phase = 'listening';
    armListenTimeout(gen);
  }

  async function next(gen) {
    if (gen !== generation) return { ok: false };
    state.index += 1;
    if (state.index >= picked.length) {
      await finish(gen);
      return { ok: true, done: true };
    }
    await present(gen);
    return { ok: true };
  }

  async function finish(gen) {
    clearListenTimer();
    await closeMic();
    const scores = state.results.map((item) => item.score).filter((value) => Number.isFinite(value));
    state.averageScore = scores.length === 0 ? null : Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    state.phase = 'done';
    const summary = state.averageScore === null
      ? 'Practice finished.'
      : 'Practice finished. Your average score is ' + state.averageScore + ' out of 100.';
    await say(summary);
    if (gen !== generation) return;
    state.active = false;
    state.phase = 'idle';
    log.info('shadow session finished: average=' + String(state.averageScore));
  }

  async function closeMic() {
    if (mic !== null) {
      try {
        await mic.stop();
      } catch (error) {
        log.warn('shadow mic stop failed: ' + errorText(error));
      }
      mic = null;
    }
    vad = null;
  }

  async function stop(reason) {
    generation += 1;
    clearListenTimer();
    const wasActive = state.active;
    state.active = false;
    state.phase = 'idle';
    await closeMic();
    if (speaker !== null && speaker !== undefined && typeof speaker.cancel === 'function') {
      try {
        await speaker.cancel();
      } catch (_error) {
        // already settled
      }
    }
    if (wasActive) log.info('shadow session stopped (' + String(reason || 'manual') + ')');
    return { ok: true, wasActive };
  }

  return {
    start,
    stop,
    next: () => next(generation),
    getState: snapshot,
    get active() {
      return state.active;
    },
    get generation() {
      return generation;
    },
    dispose: () => stop('dispose'),
  };
}
