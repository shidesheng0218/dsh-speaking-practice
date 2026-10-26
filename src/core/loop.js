/**
 * core/loop.js - the host-side hands-free voice loop.
 *
 * Pure orchestration: it receives mic PCM, drives the energy VAD, asks the
 * injected speech-to-text adapter for a transcript, submits transcripts through
 * the injected submit callback, tracks the assistant turn that answers it and
 * speaks the cleaned reply through the injected TTS adapter.
 *
 * The module has no @deepseek-ai imports, so the whole loop can be exercised
 * with fake mic/stt/tts/submit dependencies in node:test.
 */
import { VoiceStateMachine } from './state.js';
import { EnergyVad } from './vad.js';
import { buildWav } from './wav.js';
import {
  extractMessageText,
  matchVoiceCommand,
  prepareSpeechText,
  summarizeText,
} from './text.js';
import { ReplyTracker } from './reply.js';

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function pick(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch (_textError) {
    return 'unknown error';
  }
}

/**
 * One active voice session. Create, start, feed audio, forward session events,
 * then stop. All resources it owns are the injected mic / tts handles.
 */
export class VoiceLoop {
  constructor(deps) {
    if (deps === null || typeof deps !== 'object') throw new TypeError('VoiceLoop requires a dependency object');
    if (typeof deps.mic !== 'object' || deps.mic === null) throw new TypeError('VoiceLoop requires mic');
    if (typeof deps.stt !== 'object' || deps.stt === null) throw new TypeError('VoiceLoop requires stt');
    if (typeof deps.tts !== 'object' || deps.tts === null) throw new TypeError('VoiceLoop requires tts');
    if (typeof deps.submit !== 'function') throw new TypeError('VoiceLoop requires submit()');

    this.sessionId = pick(deps.sessionId, 'unknown');
    this.cwd = pick(deps.cwd, '');
    this.config = pick(deps.config, {});
    this.log = pick(deps.logger, NOOP_LOGGER);
    this.mic = deps.mic;
    this.stt = deps.stt;
    this.tts = deps.tts;
    this.submit = deps.submit;
    this.requestVoiceOff = pick(deps.requestVoiceOff, async () => {});
    this.onFatal = pick(deps.onFatal, () => {});
    this.createVad = pick(deps.createVad, (options) => new EnergyVad(options));

    const cfg = this.config;
    this.vadOptions = {
      sampleRate: pick(cfg.sampleRate, 16000),
      frameMs: pick(cfg.frameMs, 20),
      relThresholdDb: pick(cfg.relThresholdDb, 12),
      absThresholdDb: pick(cfg.absThresholdDb, -45),
      maxThresholdDb: pick(cfg.maxThresholdDb, -20),
      minSpeechMs: pick(cfg.minSpeechMs, 200),
      silenceMs: pick(cfg.silenceMs, 600),
      maxUtteranceSec: pick(cfg.maxUtteranceSec, 45),
      onsetFrames: pick(cfg.onsetFrames, 3),
      calibrateMs: pick(cfg.calibrateMs, 400),
      prerollMs: pick(cfg.prerollMs, 300),
    };
    this.transcribeTimeoutMs = pick(cfg.transcribeTimeoutMs, 15000);
    this.replyTimeoutMs = pick(cfg.replyTimeoutMs, 120000);
    this.ttsOnsetGuardMs = pick(cfg.ttsOnsetGuardMs, 150);
    this.ttsTailGuardMs = pick(cfg.ttsTailGuardMs, 120);
    this.maxSpeechChars = pick(cfg.maxSpeechChars, 1200);
    this.maxSentenceChars = pick(cfg.maxSentenceChars, 220);
    this.languageThreshold = pick(cfg.languageThreshold, 0.3);

    this.sm = new VoiceStateMachine();
    this.reply = new ReplyTracker({ maxWaitMs: this.replyTimeoutMs });
    this._vad = null;
    this._micRunning = false;
    this._stopped = true;
    this._generation = 0;
    this._pending = new Set();
    this._sttController = null;
    this._replyTimer = null;
    this._lastReplySegments = [];
    this._lastTranscript = '';
    this._lastError = '';
    this._sorrySaid = false;
    this._startedAt = null;
    this._unsubState = this.sm.onChange((entry) => this._logTransition(entry));
  }

  get state() {
    return this.sm.state;
  }

  get started() {
    return this._startedAt !== null;
  }

  status() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      state: this.sm.state,
      stateSince: this.sm.since,
      startedAt: this._startedAt,
      micRunning: this._micRunning,
      lastTranscript: this._lastTranscript,
      lastError: this._lastError,
      replyActive: this.reply.active,
      replyTurn: this.reply.turn,
      lastReplySegments: this._lastReplySegments.length,
      vad: this._vad === null ? null : this._vad.getStats(),
    };
  }

  _logTransition(entry) {
    const meta = entry.meta !== null && typeof entry.meta === 'object' ? entry.meta : {};
    const reason = typeof meta.reason === 'string' ? meta.reason : typeof meta.kind === 'string' ? meta.kind : '';
    const suffix = reason === '' ? '' : ' (' + reason + ')';
    this.log.info('[voice] state ' + entry.from + ' -> ' + entry.to + suffix);
  }

  _isCurrent(generation) {
    return !this._stopped && generation === this._generation;
  }

  _track(promise) {
    const task = Promise.resolve(promise).catch((error) => {
      this._lastError = errorMessage(error);
      this.log.error('[voice] async task failed: ' + errorMessage(error));
    });
    this._pending.add(task);
    task.finally(() => this._pending.delete(task));
    return task;
  }

  /** Await all currently tracked async work (tests / diagnostics). */
  async settled() {
    while (this._pending.size > 0) {
      await Promise.allSettled(Array.from(this._pending));
    }
  }

  /** Poll until the loop reaches one of the given states (tests). */
  async waitForState(states, timeoutMs = 2000) {
    const wanted = Array.isArray(states) ? states : [states];
    const deadline = Date.now() + timeoutMs;
    while (!wanted.includes(this.sm.state)) {
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for voice state ' + wanted.join('/') + ', current=' + this.sm.state);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    return this.sm.state;
  }

  /**
   * Start the microphone and enter listening.
   * Rejects when the mic cannot be started (the caller reports the error).
   */
  async start() {
    if (this._startedAt !== null) return this;
    this._stopped = false;
    this._generation += 1;
    this._vad = this.createVad(this.vadOptions);
    this.log.info('[voice] starting mic session=' + this.sessionId);
    try {
      await this.mic.start({
        onData: (chunk) => this.handleAudio(chunk),
        onFatal: (error) => this._onMicFatal(error),
      });
    } catch (error) {
      this._stopped = true;
      this._vad = null;
      this._lastError = errorMessage(error);
      this.log.error('[voice] mic start failed: ' + errorMessage(error));
      throw error;
    }
    this._startedAt = Date.now();
    this._micRunning = true;
    this.sm.transition('listening', { reason: 'start' });
    this.log.info('[voice] listening session=' + this.sessionId);
    return this;
  }

  /** Stop listening, cancel speech and release the mic. Idempotent. */
  async stop(reason = 'stop') {
    if (this._stopped) return;
    this._stopped = true;
    this._generation += 1;
    this._startedAt = null;
    this._micRunning = false;
    this._clearReplyTimer();
    this.reply.reset();
    if (this._sttController !== null) {
      try {
        this._sttController.abort(new Error('voice loop stopped'));
      } catch (_abortError) {
        // AbortController.abort never throws for a normal reason.
      }
      this._sttController = null;
    }
    try {
      await this.mic.stop();
    } catch (error) {
      this.log.warn('[voice] mic stop failed: ' + errorMessage(error));
    }
    try {
      await this.tts.cancel();
    } catch (error) {
      this.log.warn('[voice] tts cancel failed: ' + errorMessage(error));
    }
    this._vad = null;
    this.sm.transition('idle', { force: true, reason });
    this.log.info('[voice] stopped (' + reason + ') session=' + this.sessionId);
  }

  /** Speak a one-off announcement with VAD detection suspended. */
  async announce(text, lang = 'en') {
    const value = String(text ?? '').trim();
    if (value === '') return;
    const generation = this._generation;
    if (this._vad !== null) this._vad.setSuspended(true);
    try {
      await this.tts.speak([{ lang, text: value }], { kind: 'announcement' });
    } catch (error) {
      this.log.warn('[voice] announcement failed: ' + errorMessage(error));
    } finally {
      if (generation === this._generation || !this._stopped) {
        if (this._vad !== null) {
          this._vad.setSuspended(false);
          this._vad.suppress(this.ttsTailGuardMs);
        }
      }
    }
  }

  /** Feed one raw PCM16 chunk from the microphone. */
  handleAudio(chunk) {
    if (this._vad === null || this._stopped) return;
    let events;
    try {
      events = this._vad.push(chunk);
    } catch (error) {
      this._lastError = errorMessage(error);
      this.log.error('[voice] vad failed: ' + errorMessage(error));
      return;
    }
    for (const event of events) {
      try {
        this._onVadEvent(event);
      } catch (error) {
        this._lastError = errorMessage(error);
        this.log.error('[voice] vad event failed: ' + errorMessage(error));
      }
    }
  }

  _onVadEvent(event) {
    switch (event.type) {
      case 'calibrated':
        this.log.info('[voice] vad calibrated noise=' + event.noiseFloorDb.toFixed(1)
          + 'dBFS threshold=' + event.thresholdDb.toFixed(1) + 'dBFS');
        return;
      case 'speech-start':
        this._onSpeechStart(event);
        return;
      case 'utterance':
        if (this.sm.state === 'capturing' || this.sm.state === 'listening') {
          this._track(this._onUtterance(event));
        } else {
          this.log.debug('[voice] utterance ignored in state ' + this.sm.state);
        }
        return;
      case 'discarded':
        this.log.info('[voice] utterance discarded (' + event.reason + ', speech='
          + Math.round(event.speechMs) + 'ms)');
        if (this.sm.state === 'capturing') this._listening('too-short');
        return;
      default:
        this.log.debug('[voice] unknown vad event ' + String(event.type));
    }
  }

  _onSpeechStart(event) {
    if (this.sm.state === 'listening') {
      this.sm.transition('capturing', { reason: 'speech-start' });
      this.log.info('[voice] speech onset t=' + (event.timeMs / 1000).toFixed(2) + 's');
      return;
    }
    if (this.sm.state === 'speaking' && this.config.bargeIn !== false) {
      this.log.info('[voice] barge-in: cancelling speech');
      Promise.resolve(this.tts.cancel()).catch((error) => {
        this.log.warn('[voice] barge-in cancel failed: ' + errorMessage(error));
      });
      this.sm.transition('capturing', { reason: 'barge-in' });
    }
  }

  async _onUtterance(event) {
    const generation = this._generation;
    if (this.sm.state === 'capturing') {
      this.sm.transition('transcribing', {
        reason: 'utterance',
        durationMs: Math.round(event.durationMs),
        speechMs: Math.round(event.speechMs),
      });
    }
    const wav = buildWav(event.pcm);
    const controller = new AbortController();
    this._sttController = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('transcription timeout'));
    }, this.transcribeTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      this.log.info('[voice] transcribing utterance ' + Math.round(event.durationMs)
        + 'ms (speech ' + Math.round(event.speechMs) + 'ms)');
      const result = await this.stt.transcribe(wav, controller.signal);
      if (!this._isCurrent(generation)) return;
      const text = result !== null && typeof result === 'object' && typeof result.text === 'string'
        ? result.text.trim()
        : '';
      this._lastTranscript = text;
      if (text === '') {
        this.log.info('[voice] empty transcript, listening again');
        this._listening('empty-transcript');
        return;
      }
      this.log.info('[voice] transcript: ' + summarizeText(text, 160));
      const command = matchVoiceCommand(text);
      if (command !== null && command.kind === 'off') {
        this.log.info('[voice] spoken off command received');
        await this.requestVoiceOff('voice-command');
        return;
      }
      if (command !== null && command.kind === 'repeat') {
        await this._repeat();
        return;
      }
      await this._submitText(text, generation);
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      this._handleTranscribeError(error, timedOut);
    } finally {
      clearTimeout(timer);
      if (this._sttController === controller) this._sttController = null;
    }
  }

  _handleTranscribeError(error, timedOut) {
    const detail = timedOut ? 'transcription timed out' : errorMessage(error);
    this._lastError = detail;
    this.log.warn('[voice] transcription failed: ' + detail);
    this._saySorry();
    this._listening('transcribe-error');
  }

  async _submitText(text, generation) {
    this.reply.begin(text);
    try {
      await this.submit(text, { sessionId: this.sessionId });
    } catch (error) {
      this.reply.reset();
      this._lastError = errorMessage(error);
      this.log.error('[voice] submit failed: ' + errorMessage(error));
      this._saySorry();
      this._listening('submit-failed');
      return;
    }
    if (!this._isCurrent(generation)) return;
    if (this.sm.state !== 'transcribing') {
      this.log.debug('[voice] submit finished while state=' + this.sm.state);
      return;
    }
    this.sm.transition('awaiting-reply', { reason: 'submitted' });
    this._armReplyTimeout();
  }

  /** Forward one session/event from the active session only. */
  onSessionEvent(event) {
    if (event === null || typeof event !== 'object' || this._stopped) return;
    const type = event.type;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    if (type === 'turn/start') {
      if (this.reply.onTurnStart(data.turn)) {
        this._clearReplyTimer();
        this.log.info('[voice] reply turn ' + data.turn + ' started');
      }
      return;
    }
    if (type === 'assistant/message') {
      const text = extractMessageText(data.message);
      if (text === '') return;
      if (this.reply.onAssistantText(data.turn, text)) {
        this.log.info('[voice] assistant text in turn ' + data.turn + ' (+' + text.length + ' chars)');
      }
      return;
    }
    if (type === 'turn/end') {
      const reasonKind = data.reason !== null && typeof data.reason === 'object' ? data.reason.kind : undefined;
      const result = this.reply.onTurnEnd(data.turn, reasonKind);
      if (result === null) return;
      this._clearReplyTimer();
      this._track(this._handleReply(result));
    }
  }

  async _handleReply(result) {
    const reasonKind = result.reasonKind;
    this.log.info('[voice] reply turn ' + result.turn + ' ended (' + String(reasonKind) + ', '
      + result.text.length + ' chars)');
    if (reasonKind !== 'completed') {
      this._lastError = 'turn ended with ' + String(reasonKind);
      this.log.warn('[voice] not speaking: turn ended with ' + String(reasonKind));
      this._listening('turn-not-completed');
      return;
    }
    const prepared = prepareSpeechText(result.text, {
      maxChars: this.maxSpeechChars,
      maxSentenceChars: this.maxSentenceChars,
      threshold: this.languageThreshold,
    });
    if (prepared.segments.length === 0) {
      this.log.info('[voice] assistant turn has no speakable text');
      this._listening('no-text');
      return;
    }
    this._lastReplySegments = prepared.segments;
    this.log.info('[voice] speaking reply: ' + prepared.segments.length + ' segment(s)'
      + (prepared.truncated ? ', truncated' : ''));
    await this._speak(prepared.segments, 'reply');
  }

  async _repeat() {
    if (this._lastReplySegments.length === 0) {
      this.log.info('[voice] repeat requested but no cached reply');
      this._listening('repeat-empty');
      return;
    }
    this.log.info('[voice] repeating last reply');
    await this._speak(this._lastReplySegments, 'repeat');
  }

  async _speak(segments, kind) {
    if (this._stopped || segments.length === 0) return;
    const generation = this._generation;
    if (!this.sm.can('speaking')) {
      this.log.warn('[voice] cannot speak from state ' + this.sm.state);
      return;
    }
    this.sm.transition('speaking', { kind, segments: segments.length });
    if (this._vad !== null) this._vad.suppress(this.ttsOnsetGuardMs);
    try {
      await this.tts.speak(segments, { kind });
    } catch (error) {
      this._lastError = errorMessage(error);
      this.log.error('[voice] tts failed: ' + errorMessage(error));
    }
    if (!this._isCurrent(generation)) return;
    if (this.sm.state === 'speaking') {
      if (this._vad !== null) this._vad.suppress(this.ttsTailGuardMs);
      this._listening('tts-done:' + kind);
    } else {
      this.log.info('[voice] speech finished while state=' + this.sm.state);
    }
  }

  _saySorry() {
    if (this._sorrySaid) return;
    this._sorrySaid = true;
    const generation = this._generation;
    const task = (async () => {
      if (this._vad !== null) this._vad.setSuspended(true);
      try {
        await this.tts.speak([{ lang: 'en', text: 'Sorry, I did not catch that.' }], { kind: 'sorry' });
      } catch (error) {
        this.log.warn('[voice] sorry prompt failed: ' + errorMessage(error));
      } finally {
        if (this._isCurrent(generation) && this._vad !== null) {
          this._vad.setSuspended(false);
          this._vad.suppress(this.ttsTailGuardMs);
        }
      }
    })();
    this._track(task);
  }

  _listening(reason) {
    if (this._stopped) return;
    if (this.sm.state === 'idle') return;
    if (this.sm.state === 'listening') return;
    if (!this.sm.can('listening')) {
      this.log.warn('[voice] cannot return to listening from ' + this.sm.state);
      return;
    }
    this.sm.transition('listening', { reason });
  }

  _armReplyTimeout() {
    this._clearReplyTimer();
    this._replyTimer = setTimeout(() => {
      this._replyTimer = null;
      if (this._stopped || !this.reply.active) return;
      this.log.warn('[voice] no reply turn arrived within ' + this.replyTimeoutMs + 'ms');
      this._lastError = 'reply timeout';
      this.reply.reset();
      if (this.sm.state === 'awaiting-reply') this._listening('reply-timeout');
    }, this.replyTimeoutMs);
    if (typeof this._replyTimer.unref === 'function') this._replyTimer.unref();
  }

  _clearReplyTimer() {
    if (this._replyTimer !== null) {
      clearTimeout(this._replyTimer);
      this._replyTimer = null;
    }
  }

  _onMicFatal(error) {
    this._lastError = 'microphone failed: ' + errorMessage(error);
    this.log.error('[voice] microphone fatal: ' + errorMessage(error));
    this._track((async () => {
      try {
        await this.onFatal(error);
      } catch (fatalError) {
        this.log.error('[voice] fatal handler failed: ' + errorMessage(fatalError));
      }
    })());
  }
}
