/**
 * core/stream-speech.js - incremental sentence splitting and serial TTS playback
 * for assistant replies that arrive as a stream of text deltas.
 *
 * Pure orchestration around an injected TTS adapter ({ speak(segments), cancel(),
 * speaking }), reusing core/text.js cleanup/splitting/language classification.
 * It buffers partial sentences, queues complete ones and plays them strictly in
 * order, so the first sentence starts before the full reply has been generated.
 *
 * Cancellation is generation based: after cancel()/reset() no queued or late
 * segment may reach the TTS adapter, while the in-flight say process is stopped
 * through tts.cancel().
 */
import { cleanForSpeech, segmentByLanguage, splitSentences } from './text.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const SENTENCE_END = /[.!?…。！？]/;
// CJK terminals and the ellipsis end a sentence without a following space in
// Chinese/mixed text, so they boundary immediately; ASCII .!? need whitespace.
const SENTENCE_END_UNSPACED = /[。！？…]/;
const HARD_BREAK = /[,;:，、；：\s]/;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch (_textError) {
    return 'unknown error';
  }
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Join two cleaned fragments, omitting the space between CJK and CJK. */
function joinFragments(left, right) {
  if (left === '') return right;
  if (right === '') return left;
  const last = left[left.length - 1];
  const first = right[0];
  return CJK_CHAR.test(last) || CJK_CHAR.test(first) ? left + right : left + ' ' + right;
}

/**
 * Index just past the first sentence boundary in text.
 * A boundary is [.!?…。！？] followed by whitespace or the end of the available
 * buffer, or a newline. Partial buffers therefore speak as soon as a sentence
 * is complete enough, without waiting for the whole reply.
 * @param {string} text
 * @returns {number|null}
 */
export function findSentenceBoundary(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') return index + 1;
    if (SENTENCE_END.test(char)) {
      if (SENTENCE_END_UNSPACED.test(char)) return index + 1;
      const next = text[index + 1];
      if (next === undefined || /\s/u.test(next)) return index + 1;
    }
  }
  return null;
}

/**
 * Streaming speech scheduler.
 *
 * Speaker interface used by the voice loop:
 *   reset(), pushText(delta), flush() -> Promise, cancel() -> Promise,
 *   spokenText, speaking, dispose().
 */
export class StreamSpeaker {
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('StreamSpeaker requires an options object');
    }
    const tts = options.tts;
    if (tts === null || typeof tts !== 'object' || typeof tts.speak !== 'function') {
      throw new TypeError('StreamSpeaker requires tts.speak()');
    }
    this.tts = tts;
    this.log = options.log !== null && typeof options.log === 'object' ? options.log : NOOP_LOG;
    this.maxSentenceChars = Math.max(20, Math.round(numberOr(options.maxSentenceChars, 220)));
    this.minSegmentChars = Math.max(1, Math.round(numberOr(options.minSegmentChars, 8)));
    this.languageThreshold = numberOr(options.languageThreshold, 0.3);
    this.onBeforeSpeak = typeof options.onBeforeSpeak === 'function' ? options.onBeforeSpeak : null;

    this._generation = 0;
    this._buffer = '';
    this._carry = '';
    this._queue = [];
    this._spoken = '';
    this._pumping = false;
    this._drainPromise = null;
    this._drainResolve = null;
    this._cancelled = false;
    this._disposed = false;
  }

  /** All text handed to the TTS queue during this attempt (dedupe / diagnostics). */
  get spokenText() {
    return this._spoken;
  }

  /** True while a segment is being spoken or still queued. */
  get speaking() {
    return this._pumping || this._queue.length > 0 || this.tts.speaking === true;
  }

  /** Begin a new assistant attempt: drop buffers/queue and invalidate old work. */
  reset() {
    this._generation += 1;
    this._buffer = '';
    this._carry = '';
    this._queue.length = 0;
    this._spoken = '';
    this._cancelled = false;
  }

  /** Append one text delta and speak any sentences it completes. */
  pushText(delta) {
    if (this._disposed || this._cancelled) return;
    if (typeof delta !== 'string' || delta === '') return;
    this._buffer += delta;
    this._drainBuffer(false);
  }

  /**
   * Speak the remaining (unpunctuated) tail and wait until the queue is empty.
   * @returns {Promise<string>} spoken text once playback settles.
   */
  flush() {
    if (this._disposed || this._cancelled) return Promise.resolve(this._spoken);
    this._drainBuffer(true);
    return this._waitDrained();
  }

  /** Drop buffered/queued speech, stop the current utterance, invalidate stale work. */
  cancel() {
    this._cancelled = true;
    this._generation += 1;
    this._buffer = '';
    this._carry = '';
    this._queue.length = 0;
    this._spoken = '';
    let cancelPromise;
    try {
      cancelPromise = Promise.resolve(this.tts.cancel());
    } catch (error) {
      this.log.warn('[stream-speech] tts cancel failed: ' + errorMessage(error));
      cancelPromise = Promise.resolve();
    }
    return cancelPromise
      .catch((error) => {
        this.log.warn('[stream-speech] tts cancel failed: ' + errorMessage(error));
      })
      .then(() => this._waitDrained());
  }

  /** Release the queue for good. Safe to call repeatedly (and after cancel()). */
  dispose() {
    if (this._disposed) return Promise.resolve();
    this._disposed = true;
    if (this._cancelled) {
      this._buffer = '';
      this._carry = '';
      this._queue.length = 0;
      return Promise.resolve();
    }
    return this.cancel();
  }

  _drainBuffer(isFinal) {
    if (this._disposed || this._cancelled) {
      this._buffer = '';
      this._carry = '';
      return;
    }
    while (this._buffer !== '') {
      const boundary = findSentenceBoundary(this._buffer);
      if (boundary !== null) {
        const raw = this._buffer.slice(0, boundary);
        this._buffer = this._buffer.slice(boundary);
        this._emit(raw, false);
        continue;
      }
      if (this._buffer.length > this.maxSentenceChars) {
        const cut = this._hardCutIndex();
        if (cut > 0 && cut < this._buffer.length) {
          const raw = this._buffer.slice(0, cut);
          this._buffer = this._buffer.slice(cut);
          this._emit(raw, false);
          continue;
        }
      }
      break;
    }
    if (isFinal) {
      const tail = this._buffer;
      this._buffer = '';
      this._emit(tail, true);
      if (this._carry !== '') {
        const carry = this._carry;
        this._carry = '';
        this._enqueueText(carry);
      }
    }
  }

  _hardCutIndex() {
    const limit = this.maxSentenceChars;
    const text = this._buffer;
    if (text.length <= limit) return -1;
    const scanLength = Math.min(text.length, limit + 1);
    let lastBreak = -1;
    for (let index = 0; index < scanLength; index += 1) {
      if (HARD_BREAK.test(text[index])) lastBreak = index;
    }
    let cut = lastBreak > 0 ? lastBreak + 1 : limit;
    if (cut > limit) cut = limit;
    if (cut > 1 && /[\uD800-\uDBFF]/u.test(text[cut - 1])) cut -= 1;
    return cut;
  }

  /**
   * Clean one raw fragment and enqueue it, merging or holding back short pieces.
   * @param {string} raw
   * @param {boolean} isFinal true when flushing the tail
   */
  _emit(raw, isFinal) {
    const cleaned = cleanForSpeech(String(raw ?? ''));
    if (cleaned === '') {
      if (isFinal && this._carry !== '') {
        const carry = this._carry;
        this._carry = '';
        this._enqueueText(carry);
      }
      return;
    }
    if (!isFinal && cleaned.length < this.minSegmentChars) {
      this._carry = joinFragments(this._carry, cleaned);
      return;
    }
    const merged = this._carry === '' ? cleaned : joinFragments(this._carry, cleaned);
    this._carry = '';
    this._enqueueText(merged);
  }

  _enqueueText(text) {
    const sentences = splitSentences(text, { maxChars: this.maxSentenceChars });
    if (sentences.length === 0) return;
    const segments = segmentByLanguage(sentences, { threshold: this.languageThreshold });
    this._enqueue(segments);
  }

  _enqueue(segments) {
    if (this._disposed || this._cancelled || segments.length === 0) return;
    this._spoken = segments.reduce(
      (acc, segment) => joinFragments(acc, segment.text),
      this._spoken,
    );
    this._queue.push({ segments, generation: this._generation });
    this._pump();
  }

  _pump() {
    if (this._pumping || this._disposed) return;
    this._pumping = true;
    const run = async () => {
      try {
        while (this._queue.length > 0 && !this._disposed) {
          const job = this._queue.shift();
          if (job.generation !== this._generation) continue;
          const generation = this._generation;
          if (this.onBeforeSpeak !== null) {
            try {
              this.onBeforeSpeak();
            } catch (error) {
              this.log.warn('[stream-speech] onBeforeSpeak failed: ' + errorMessage(error));
            }
          }
          if (generation !== this._generation || this._disposed) continue;
          try {
            await this.tts.speak(job.segments);
          } catch (error) {
            this.log.warn('[stream-speech] segment failed, continuing: ' + errorMessage(error));
          }
        }
      } finally {
        this._pumping = false;
        this._settleDrain();
        if (this._queue.length > 0 && !this._disposed) this._pump();
      }
    };
    run().catch((error) => {
      this.log.error('[stream-speech] playback queue failed: ' + errorMessage(error));
      this._pumping = false;
      this._settleDrain();
    });
  }

  _waitDrained() {
    if (!this._pumping && this._queue.length === 0) return Promise.resolve(this._spoken);
    if (this._drainPromise === null) {
      this._drainPromise = new Promise((resolve) => {
        this._drainResolve = resolve;
      });
    }
    return this._drainPromise;
  }

  _settleDrain() {
    if (this._pumping || this._queue.length > 0) return;
    if (this._drainResolve === null) return;
    const resolve = this._drainResolve;
    this._drainResolve = null;
    this._drainPromise = null;
    resolve(this._spoken);
  }
}

/** @returns {StreamSpeaker} */
export function createStreamSpeaker(options) {
  return new StreamSpeaker(options);
}
