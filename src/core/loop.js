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
import { EnergyVad, rmsDbFromPcm16 } from './vad.js';
import { buildWav } from './wav.js';
import {
  extractMessageText,
  matchVoiceCommand,
  prepareSpeechText,
  summarizeText,
} from './text.js';
import { ReplyTracker } from './reply.js';
import { createStreamSpeaker } from './stream-speech.js';

/** Spoken when transcription keeps failing: guide the user instead of silent retries. */
const TRANSCRIBE_FAILURE_MESSAGE = '我这边一直没听清你的声音，先暂停语音模式。检查一下麦克风，然后再输入 /voice on 重试。';

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** Quietest level reported for digital silence, matching core/vad.js. */
const MIN_LEVEL_DB = -120;
const EMPTY_BUFFER = Buffer.alloc(0);

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
    this.stats = deps.stats !== null && typeof deps.stats === 'object' ? deps.stats : null;
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
    this._lastActivityAt = null;
    this._consecutiveFailures = 0;
    this._streamSpeaker = null;
    this._streamTurn = null;
    this._streamAttempt = null;
    this._streamSeenText = '';
    this._assistantTurn = null;
    this._assistantCommitted = '';
    this._assistantStream = '';
    this._suppressSpeakUntilTurnEnd = false;
    this._lastLevelDb = MIN_LEVEL_DB;
    this._levelLeftover = EMPTY_BUFFER;
    this._levelFrameBytes = Math.max(
      2,
      Math.round((this.vadOptions.sampleRate * this.vadOptions.frameMs) / 1000) * 2,
    );
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
      lastLevelDb: this._lastLevelDb,
      assistantText: this._assistantTextValue(),
      lastError: this._lastError,
      replyActive: this.reply.active,
      replyTurn: this.reply.turn,
      lastActivityAt: this._lastActivityAt,
      consecutiveFailures: this._consecutiveFailures,
      speaking: this._isSpeaking(),
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
    this._lastActivityAt = Date.now();
    this._consecutiveFailures = 0;
    this._sorrySaid = false;
    this._suppressSpeakUntilTurnEnd = false;
    this._resetAssistantText(null);
    this._resetLevel();
    this._resetStreamTracking();
    this._streamSpeaker = createStreamSpeaker({
      tts: this.tts,
      log: this.log,
      maxSentenceChars: this.maxSentenceChars,
      languageThreshold: this.languageThreshold,
      minSegmentChars: pick(this.config.minSegmentChars, 8),
      onBeforeSpeak: () => this._onBeforeStreamSpeak(),
    });
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
    this._suppressSpeakUntilTurnEnd = false;
    this._resetAssistantText(null);
    this._resetLevel();
    this._resetStreamTracking();
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
    const streamSpeaker = this._streamSpeaker;
    this._streamSpeaker = null;
    let ttsCancelled = false;
    if (streamSpeaker !== null) {
      try {
        await streamSpeaker.cancel();
        ttsCancelled = true;
      } catch (error) {
        this.log.warn('[voice] stream speech cancel failed: ' + errorMessage(error));
      }
      try {
        streamSpeaker.dispose();
      } catch (_disposeError) {
        // The queue is already invalidated by cancel(); dispose is a no-op here.
      }
    }
    if (!ttsCancelled) {
      try {
        await this.tts.cancel();
      } catch (error) {
        this.log.warn('[voice] tts cancel failed: ' + errorMessage(error));
      }
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

  /** Speak one short Chinese system message (idle reminders / error recovery). */
  async announceChinese(text) {
    return this.announce(text, 'zh');
  }

  /**
   * Client Stop button: cancel any in-flight spoken reply.
   *
   * - speaking: stop playback immediately and return to listening.
   * - awaiting-reply: mark the pending turn so its reply is not spoken when the
   *   turn ends; the full assistant text is still cached for "repeat that".
   * - other states: cancel any announcement and stay put.
   *
   * Idempotent and repeatable; never throws.
   * @param {string} [reason] diagnostic reason for the log.
   * @returns {Promise<boolean>} true when the request was handled.
   */
  async interruptSpeech(reason = 'client') {
    try {
      const state = this.sm.state;
      if (state === 'speaking' || state === 'awaiting-reply') {
        this._suppressSpeakUntilTurnEnd = true;
      }
      if (state === 'speaking') this._listening('client-interrupt');
      this._touch();
      this.log.info('[voice] client interrupt (state=' + state + ', reason=' + String(reason) + ')');
      const cancellations = [];
      const cancelSafely = (label, operation) => {
        try {
          cancellations.push(Promise.resolve(operation()).catch((error) => {
            this.log.warn('[voice] ' + label + ' cancel failed: ' + errorMessage(error));
          }));
        } catch (error) {
          this.log.warn('[voice] ' + label + ' cancel failed: ' + errorMessage(error));
        }
      };
      const speaker = this._streamSpeaker;
      if (speaker !== null) cancelSafely('stream speech', () => speaker.cancel());
      cancelSafely('tts', () => this.tts.cancel());
      await Promise.allSettled(cancellations);
      return true;
    } catch (error) {
      this.log.warn('[voice] interruptSpeech failed: ' + errorMessage(error));
      return false;
    }
  }

  /** Feed one raw PCM16 chunk from the microphone. */
  handleAudio(chunk) {
    this._measureLevel(chunk);
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
        this._touch();
        this._stat('onSpeech', Number.isFinite(event.durationMs) ? event.durationMs : 0);
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
    this._touch();
    if (this.sm.state === 'listening') {
      this.sm.transition('capturing', { reason: 'speech-start' });
      this.log.info('[voice] speech onset t=' + (event.timeMs / 1000).toFixed(2) + 's');
      return;
    }
    if (this.sm.state === 'speaking' && this.config.bargeIn !== false) {
      this.log.info('[voice] barge-in: cancelling speech');
      this._cancelSpeech('barge-in');
      this.sm.transition('capturing', { reason: 'barge-in' });
    }
  }

  async _onUtterance(event) {
    const generation = this._generation;
    this._touch();
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
      this._consecutiveFailures = 0;
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
    this._statError('transcribe');
    this._touch();
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= 3) {
      this.log.warn('[voice] ' + this._consecutiveFailures
        + ' consecutive transcription failures; explaining in Chinese and leaving voice mode');
      this._listening('transcribe-failed');
      this._track(this._sayTranscribeFailure());
      return;
    }
    this._saySorry();
    this._listening('transcribe-error');
  }

  /**
   * Third consecutive failure: say what went wrong in Chinese, then ask the host
   * to leave voice mode so the user can fix the microphone.
   */
  async _sayTranscribeFailure() {
    const generation = this._generation;
    await this.announce(TRANSCRIBE_FAILURE_MESSAGE, 'zh');
    if (this._stopped || generation !== this._generation) return;
    try {
      await this.requestVoiceOff('transcribe-failed');
    } catch (error) {
      this.log.warn('[voice] voice off after transcribe failures failed: ' + errorMessage(error));
    }
  }

  async _submitText(text, generation) {
    this._touch();
    this._suppressSpeakUntilTurnEnd = false;
    this._resetStreamTracking();
    if (this._streamSpeaker !== null) this._streamSpeaker.reset();
    this.reply.begin(text);
    try {
      await this.submit(text, { sessionId: this.sessionId });
      this._stat('onUserText', text);
    } catch (error) {
      this.reply.reset();
      this._lastError = errorMessage(error);
      this.log.error('[voice] submit failed: ' + errorMessage(error));
      this._statError('submit');
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
      this._touch();
      const turn = Number.isFinite(data.turn) ? data.turn : null;
      // A new turn clears the caption. A suppression flag raised while waiting
      // for THIS reply (reply bound but turn not started yet) must survive the
      // reply turn's own start; a flag left over from an already-finished turn
      // is stale and is dropped here.
      const replyTurnPending = this.reply.active && this.reply.turn === null;
      if (this._suppressSpeakUntilTurnEnd && !replyTurnPending) {
        this._suppressSpeakUntilTurnEnd = false;
      }
      this._resetAssistantText(turn);
      if (this.reply.onTurnStart(data.turn)) {
        this._clearReplyTimer();
        this.log.info('[voice] reply turn ' + data.turn + ' started');
      }
      return;
    }
    if (type === 'assistant/message') {
      const text = extractMessageText(data.message);
      if (text === '') return;
      this._touch();
      this._stat('onAssistantText', text);
      this._appendCommittedAssistantText(Number.isFinite(data.turn) ? data.turn : null, text);
      if (this.reply.onAssistantText(data.turn, text)) {
        this.log.info('[voice] assistant text in turn ' + data.turn + ' (+' + text.length + ' chars)');
      }
      return;
    }
    if (type === 'turn/end') {
      this._touch();
      const reasonKind = data.reason !== null && typeof data.reason === 'object' ? data.reason.kind : undefined;
      const result = this.reply.onTurnEnd(data.turn, reasonKind);
      if (result === null) return;
      this._clearReplyTimer();
      this._track(this._handleReply(result));
    }
  }

  async _handleReply(result) {
    const reasonKind = result.reasonKind;
    const suppressPlayback = this._suppressSpeakUntilTurnEnd;
    this._suppressSpeakUntilTurnEnd = false;
    const streamedText = this._streamSeenText;
    const hasStreamed = typeof streamedText === 'string' && streamedText.trim() !== '';
    this.log.info('[voice] reply turn ' + result.turn + ' ended (' + String(reasonKind) + ', '
      + result.text.length + ' chars' + (hasStreamed ? ', streamed ' + streamedText.length + ' chars' : '') + ')');
    if (reasonKind !== 'completed') {
      this._lastError = 'turn ended with ' + String(reasonKind);
      this.log.warn('[voice] not speaking: turn ended with ' + String(reasonKind));
      if (hasStreamed) await this._cancelStreamSpeech('turn-not-completed');
      this._resetStreamTracking();
      this._listening('turn-not-completed');
      return;
    }
    if (suppressPlayback) {
      // Client Stop: keep the full reply for "repeat that", but never speak it.
      const cached = prepareSpeechText(result.text, {
        maxChars: this.maxSpeechChars,
        maxSentenceChars: this.maxSentenceChars,
        threshold: this.languageThreshold,
      });
      if (cached.segments.length > 0) this._lastReplySegments = cached.segments;
      if (hasStreamed) await this._cancelStreamSpeech('client-suppressed');
      this._resetStreamTracking();
      this.log.info('[voice] client interrupt: skipping reply playback for turn ' + result.turn
        + ' (kept ' + this._lastReplySegments.length + ' segment(s) for repeat)');
      this._listening('client-suppressed');
      return;
    }
    if (hasStreamed && this._streamSpeaker !== null) {
      // Streamed playback already spoke (most of) this turn: flush the tail and
      // never replay the accumulated whole-reply text.
      const cached = prepareSpeechText(result.text, {
        maxChars: this.maxSpeechChars,
        maxSentenceChars: this.maxSentenceChars,
        threshold: this.languageThreshold,
      });
      if (cached.segments.length > 0) this._lastReplySegments = cached.segments;
      this.log.info('[voice] flushing streamed reply speech');
      try {
        await this._streamSpeaker.flush();
      } catch (error) {
        this.log.warn('[voice] stream flush failed: ' + errorMessage(error));
      }
      this._resetStreamTracking();
      if (this._stopped) return;
      if (this.sm.state === 'speaking') {
        if (this._vad !== null) this._vad.suppress(this.ttsTailGuardMs);
        this._listening('tts-done:stream');
      } else if (this.sm.state === 'awaiting-reply' || this.sm.state === 'transcribing') {
        this._listening('stream-empty');
      } else {
        this.log.info('[voice] stream speech finished while state=' + this.sm.state);
      }
      return;
    }
    this._resetStreamTracking();
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

  /**
   * Forward one host assistant-stream frame. Frames are accepted only for the
   * reply turn the loop is currently waiting for, and only while waiting for or
   * speaking that reply. The real host puts turn/step only on the start frame,
   * so later chunk/end frames are matched through the tracked attempt.
   * @param {{type:'start'|'chunk'|'end', attemptId?:string, turn?:number, step?:number, chunk?:object}} frame
   */
  onStreamFrame(frame) {
    if (this._stopped || frame === null || typeof frame !== 'object') return;
    const speaker = this._streamSpeaker;
    if (speaker === null) return;
    const type = frame.type;
    if (type !== 'start' && type !== 'chunk' && type !== 'end') return;
    if (this.sm.state !== 'awaiting-reply' && this.sm.state !== 'speaking') return;
    if (!this.reply.active) return;
    const expectedTurn = this.reply.activeTurn;
    const explicitTurn = Number.isFinite(frame.turn) ? frame.turn : null;
    if (type === 'start') {
      if (explicitTurn === null || expectedTurn === null || explicitTurn !== expectedTurn) {
        this.log.debug('[voice] assistant stream start ignored (turn=' + String(explicitTurn)
          + ', expected=' + String(expectedTurn) + ')');
        return;
      }
      if (this._streamTurn !== explicitTurn) {
        this._streamTurn = explicitTurn;
        this._streamSeenText = '';
      }
      this._streamAttempt = {
        attemptId: frame.attemptId === undefined || frame.attemptId === null ? null : frame.attemptId,
        turn: explicitTurn,
      };
      speaker.reset();
      this.log.info('[voice] assistant stream started (turn=' + explicitTurn
        + ', step=' + String(frame.step) + ')');
      return;
    }
    if (this._streamAttempt === null) return;
    if (explicitTurn !== null && explicitTurn !== this._streamAttempt.turn) return;
    if (frame.attemptId !== undefined && frame.attemptId !== null
      && this._streamAttempt.attemptId !== null && frame.attemptId !== this._streamAttempt.attemptId) {
      return;
    }
    if (type === 'end') return;
    const chunk = frame.chunk;
    if (chunk === null || typeof chunk !== 'object') return;
    if (chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return;
    if (this._streamTurn === null || (expectedTurn !== null && this._streamTurn !== expectedTurn)) return;
    this._streamSeenText += chunk.text;
    this._touch();
    this._appendStreamedAssistantText(this._streamTurn, chunk.text);
    if (this._suppressSpeakUntilTurnEnd) {
      this.log.debug('[voice] streamed speech suppressed by client interrupt');
      return;
    }
    speaker.pushText(chunk.text);
  }

  /** Called by the stream speaker right before each queued segment starts. */
  _onBeforeStreamSpeak() {
    if (this._stopped) return;
    this._touch();
    if (this._suppressSpeakUntilTurnEnd) {
      this.log.info('[voice] streamed segment suppressed by client interrupt');
      this._cancelSpeech('client-suppress');
      return;
    }
    const state = this.sm.state;
    if (state !== 'speaking' && state !== 'awaiting-reply' && state !== 'transcribing') {
      this.log.info('[voice] suppressing streamed speech in state ' + state);
      this._cancelSpeech('state-guard');
      return;
    }
    if (this._vad !== null) this._vad.suppress(this.ttsOnsetGuardMs);
    if (state !== 'speaking' && this.sm.can('speaking')) {
      this.sm.transition('speaking', { kind: 'stream' });
      this.log.info('[voice] streaming speech started');
    }
  }

  /** Cancel playback without awaiting (barge-in must be prompt). */
  _cancelSpeech(reason) {
    const speaker = this._streamSpeaker;
    let cancellation;
    try {
      cancellation = speaker === null ? this.tts.cancel() : speaker.cancel();
    } catch (error) {
      this.log.warn('[voice] ' + reason + ' cancel failed: ' + errorMessage(error));
      return;
    }
    Promise.resolve(cancellation).catch((error) => {
      this.log.warn('[voice] ' + reason + ' cancel failed: ' + errorMessage(error));
    });
  }

  async _cancelStreamSpeech(reason) {
    const speaker = this._streamSpeaker;
    if (speaker === null) return;
    try {
      await speaker.cancel();
    } catch (error) {
      this.log.warn('[voice] ' + reason + ' stream cancel failed: ' + errorMessage(error));
    }
  }

  _resetStreamTracking() {
    this._streamTurn = null;
    this._streamAttempt = null;
    this._streamSeenText = '';
  }

  /** Caption text: committed assistant messages plus the live stream tail. */
  _assistantTextValue() {
    const committed = this._assistantCommitted;
    const streamed = this._assistantStream;
    if (streamed === '') return committed;
    if (committed === '') return streamed;
    return committed + '\n' + streamed;
  }

  /** Clear the caption for a new (or no) turn. */
  _resetAssistantText(turn) {
    this._assistantTurn = Number.isFinite(turn) ? turn : null;
    this._assistantCommitted = '';
    this._assistantStream = '';
  }

  /**
   * Fold an authoritative assistant/message into the caption. The committed
   * message supersedes whatever the current attempt already streamed.
   */
  _appendCommittedAssistantText(turn, text) {
    if (typeof text !== 'string' || text === '') return;
    const value = Number.isFinite(turn) ? turn : this._assistantTurn;
    if (value !== this._assistantTurn) this._resetAssistantText(value);
    this._assistantCommitted = this._assistantCommitted === ''
      ? text
      : this._assistantCommitted + '\n' + text;
    this._assistantStream = '';
  }

  /** Append one live stream delta to the caption (converged by messages later). */
  _appendStreamedAssistantText(turn, delta) {
    if (typeof delta !== 'string' || delta === '') return;
    const value = Number.isFinite(turn) ? turn : this._assistantTurn;
    if (value !== this._assistantTurn) this._resetAssistantText(value);
    this._assistantStream += delta;
  }

  /**
   * Track the most recent 20 ms frame level in dBFS for the client volume bar.
   * Chunks are re-framed here because the VAD keeps its frames private.
   */
  _measureLevel(chunk) {
    if (chunk === null || chunk === undefined) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length === 0) return;
    const frameBytes = this._levelFrameBytes;
    const combined = this._levelLeftover.length === 0 ? buffer : Buffer.concat([this._levelLeftover, buffer]);
    const usable = combined.length - (combined.length % frameBytes);
    if (usable < frameBytes) {
      this._levelLeftover = Buffer.from(combined);
      return;
    }
    this._lastLevelDb = rmsDbFromPcm16(combined.subarray(usable - frameBytes, usable));
    this._levelLeftover = usable === combined.length ? EMPTY_BUFFER : Buffer.from(combined.subarray(usable));
  }

  _resetLevel() {
    this._lastLevelDb = MIN_LEVEL_DB;
    this._levelLeftover = EMPTY_BUFFER;
  }

  _isSpeaking() {
    if (this.sm.state === 'speaking') return true;
    if (this._streamSpeaker !== null && this._streamSpeaker.speaking === true) return true;
    return this.tts !== null && this.tts.speaking === true;
  }

  _touch() {
    this._lastActivityAt = Date.now();
  }

  _stat(method, ...args) {
    const stats = this.stats;
    if (stats === null) return;
    try {
      if (typeof stats[method] === 'function') stats[method](...args);
    } catch (error) {
      this.log.warn('[voice] stats.' + method + ' failed: ' + errorMessage(error));
    }
  }

  _statError(kind) {
    this._stat('onError', kind);
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
    this._touch();
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
      this._statError('tts');
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
