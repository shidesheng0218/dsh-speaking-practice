/**
 * core/vad.js - streaming energy VAD / endpointing for 16 kHz mono PCM16.
 *
 * Pure JS module (no DSH imports), fully unit-testable with synthetic PCM.
 * Algorithm follows lab/vad_energy.py and docs/audio-feasibility.md:
 *   - 20 ms frames, RMS -> dBFS
 *   - first 400 ms calibrates the ambient noise floor (median)
 *   - threshold = clamp(noise + 12 dB, -45 dBFS, -20 dBFS)
 *   - 3 consecutive voiced frames start an utterance
 *   - 600 ms (configurable) of silence ends it (hangover)
 *   - a 300 ms pre-roll ring buffer is prepended to every utterance
 *   - too-short utterances are discarded
 */

export const VAD_DEFAULTS = Object.freeze({
  sampleRate: 16000,
  frameMs: 20,
  relThresholdDb: 12,
  absThresholdDb: -45,
  maxThresholdDb: -20,
  minSpeechMs: 200,
  silenceMs: 600,
  maxUtteranceSec: 45,
  onsetFrames: 3,
  calibrateMs: 400,
  prerollMs: 300,
});

const EMPTY = Buffer.alloc(0);

/**
 * RMS level of little-endian PCM16 samples in dBFS.
 * @param {Buffer|Uint8Array} pcm
 * @returns {number} dBFS, clamped to [-120, 0].
 */
export function rmsDbFromPcm16(pcm) {
  const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || EMPTY);
  const count = buffer.length >> 1;
  if (count === 0) return -120;
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = buffer.readInt16LE(index * 2);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / count);
  if (rms <= 0) return -120;
  return Math.max(-120, 20 * Math.log10(rms / 32768));
}

/**
 * Streaming endpointing VAD.
 *
 * Usage:
 *   const vad = new EnergyVad({ silenceMs: 600, minSpeechMs: 200 });
 *   for (const chunk of pcmChunks) {
 *     for (const event of vad.push(chunk)) handle(event);
 *   }
 *   for (const event of vad.flush()) handle(event);
 */
export class EnergyVad {
  constructor(options = {}) {
    const merged = Object.assign({}, VAD_DEFAULTS, options);
    this.sampleRate = Math.max(8000, Math.round(merged.sampleRate));
    this.frameMsOption = merged.frameMs;
    const frameSamples = Math.max(1, Math.round((this.sampleRate * merged.frameMs) / 1000));
    this.frameSamples = frameSamples;
    this.frameBytes = frameSamples * 2;
    this.frameMs = (frameSamples / this.sampleRate) * 1000;

    this.relThresholdDb = merged.relThresholdDb;
    this.absThresholdDb = merged.absThresholdDb;
    this.maxThresholdDb = merged.maxThresholdDb;
    this.minSpeechMs = merged.minSpeechMs;
    this.silenceMs = merged.silenceMs;
    this.maxUtteranceMs = merged.maxUtteranceSec * 1000;
    this.onsetFrames = Math.max(1, Math.round(merged.onsetFrames));
    this.calibrateFrames = Math.max(1, Math.round(merged.calibrateMs / this.frameMs));
    this.prerollFrames = Math.max(0, Math.round(merged.prerollMs / this.frameMs));
    this.silenceFrames = Math.max(1, Math.round(this.silenceMs / this.frameMs));
    this.maxUtteranceFrames = Math.max(1, Math.round(this.maxUtteranceMs / this.frameMs));
    this.ringLimit = Math.max(this.onsetFrames, this.prerollFrames, 1);

    this._resetRuntime(true);
  }

  _resetRuntime(resetCalibration) {
    this._leftover = EMPTY;
    this._ring = [];
    this._frameIndex = 0;
    this._timeMs = 0;
    this._state = 'silence';
    this._speechRun = 0;
    this._silenceRun = 0;
    this._speechStartFrame = null;
    this._lastVoicedFrame = null;
    this._utteranceFrames = null;
    this._utteranceFirstFrame = 0;
    this._suppressedUntilMs = 0;
    this._suspended = false;
    this._speechMs = 0;
    this._counters = { frames: 0, utterances: 0, discarded: 0 };
    if (resetCalibration) {
      this._calibration = [];
      this._calibrated = false;
      this._noiseFloorDb = -120;
      this._thresholdDb = this.absThresholdDb;
    }
  }

  get state() {
    return this._state;
  }

  get calibrated() {
    return this._calibrated;
  }

  get noiseFloorDb() {
    return this._noiseFloorDb;
  }

  get thresholdDb() {
    return this._thresholdDb;
  }

  get timeMs() {
    return this._timeMs;
  }

  getStats() {
    return {
      state: this._state,
      calibrated: this._calibrated,
      noiseFloorDb: this._noiseFloorDb,
      thresholdDb: this._thresholdDb,
      timeMs: this._timeMs,
      frames: this._counters.frames,
      utterances: this._counters.utterances,
      discarded: this._counters.discarded,
      suspended: this._suspended,
    };
  }

  /** Ignore detection for the next ms of audio (TTS start transient guard). */
  suppress(ms) {
    const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    this._suppressedUntilMs = Math.max(this._suppressedUntilMs, this._timeMs + duration);
  }

  /** Suspend/resume onset detection (used while speaking announcements). */
  setSuspended(value) {
    this._suspended = Boolean(value);
  }

  /** Drop any in-progress utterance and optionally recalibrate. */
  reset(options = {}) {
    this._resetRuntime(options.recalibrate !== false);
  }

  _recomputeThreshold() {
    const relative = this._noiseFloorDb + this.relThresholdDb;
    this._thresholdDb = Math.min(
      Math.max(relative, this.absThresholdDb),
      this.maxThresholdDb,
    );
  }

  _adaptNoise(db, voiced) {
    if (db < this._noiseFloorDb) {
      this._noiseFloorDb = 0.7 * this._noiseFloorDb + 0.3 * db;
    } else if (!voiced) {
      this._noiseFloorDb += 0.0005;
    }
    this._recomputeThreshold();
  }

  /**
   * Feed raw PCM16 bytes. Returns zero or more VAD events in audio order.
   * @param {Buffer|Uint8Array} pcm
   * @returns {object[]}
   */
  push(pcm) {
    if (pcm === undefined || pcm === null) return [];
    const chunk = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
    if (chunk.length === 0) return [];
    const input = this._leftover.length === 0 ? chunk : Buffer.concat([this._leftover, chunk]);
    const usable = input.length - (input.length % this.frameBytes);
    if (usable <= 0) {
      this._leftover = Buffer.from(input);
      return [];
    }
    this._leftover = input.length === usable ? EMPTY : Buffer.from(input.subarray(usable));
    const events = [];
    for (let offset = 0; offset < usable; offset += this.frameBytes) {
      const frame = input.subarray(offset, offset + this.frameBytes);
      const frameEvents = this._processFrame(frame);
      if (frameEvents.length > 0) events.push(...frameEvents);
    }
    return events;
  }

  /** Finish any in-progress utterance (used on stop / test flush). */
  flush() {
    if (this._state !== 'speech') return [];
    const endFrame = this._frameIndex - 1;
    return this._finishUtterance('flush', endFrame);
  }

  _processFrame(frame) {
    const db = rmsDbFromPcm16(frame);
    const frameIndex = this._frameIndex;
    this._frameIndex += 1;
    this._counters.frames += 1;
    this._timeMs = (frameIndex + 1) * this.frameMs;

    this._ring.push({ index: frameIndex, data: Buffer.from(frame) });
    while (this._ring.length > this.ringLimit) this._ring.shift();

    if (!this._calibrated) {
      this._calibration.push(db);
      if (this._calibration.length < this.calibrateFrames) return [];
      const sorted = this._calibration.slice().sort((left, right) => left - right);
      this._noiseFloorDb = sorted[Math.floor(sorted.length / 2)];
      this._calibrated = true;
      this._calibration = [];
      this._recomputeThreshold();
      return [{
        type: 'calibrated',
        timeMs: this._timeMs,
        noiseFloorDb: this._noiseFloorDb,
        thresholdDb: this._thresholdDb,
      }];
    }

    const suppressed = this._suspended || this._timeMs <= this._suppressedUntilMs;
    const threshold = this._thresholdDb;
    const voiced = !suppressed && db >= threshold;
    this._adaptNoise(db, voiced);

    if (this._state === 'silence') {
      this._speechRun = voiced ? this._speechRun + 1 : 0;
      if (this._speechRun < this.onsetFrames) return [];
      this._state = 'speech';
      this._silenceRun = 0;
      this._speechStartFrame = frameIndex - (this._speechRun - 1);
      this._lastVoicedFrame = frameIndex;
      this._speechMs = (frameIndex - this._speechStartFrame + 1) * this.frameMs;
      this._utteranceFrames = this._ring.map((entry) => entry.data);
      this._utteranceFirstFrame = this._ring.length > 0 ? this._ring[0].index : frameIndex;
      this._speechRun = 0;
      return [{
        type: 'speech-start',
        frameIndex: this._speechStartFrame,
        timeMs: this._speechStartFrame * this.frameMs,
        rmsDb: db,
        thresholdDb: threshold,
        noiseFloorDb: this._noiseFloorDb,
      }];
    }

    if (this._utteranceFrames !== null) this._utteranceFrames.push(Buffer.from(frame));
    if (voiced) {
      this._silenceRun = 0;
      this._lastVoicedFrame = frameIndex;
      if (this._speechStartFrame !== null) {
        this._speechMs = (frameIndex - this._speechStartFrame + 1) * this.frameMs;
      }
    } else {
      this._silenceRun += 1;
    }

    const framesInUtterance = this._utteranceFrames === null ? 0 : this._utteranceFrames.length;
    if (this._silenceRun >= this.silenceFrames) {
      return this._finishUtterance('silence', frameIndex);
    }
    if (framesInUtterance >= this.maxUtteranceFrames) {
      return this._finishUtterance('max-duration', frameIndex);
    }
    return [];
  }

  _finishUtterance(reason, endFrameIndex) {
    const frames = this._utteranceFrames === null ? [] : this._utteranceFrames;
    const speechMs = this._lastVoicedFrame === null || this._speechStartFrame === null
      ? 0
      : (this._lastVoicedFrame - this._speechStartFrame + 1) * this.frameMs;
    const pcm = frames.length === 0 ? EMPTY : Buffer.concat(frames);
    const durationMs = frames.length * this.frameMs;
    const startTimeMs = this._utteranceFirstFrame * this.frameMs;
    const endTimeMs = (endFrameIndex + 1) * this.frameMs;

    this._counters.utterances += 1;
    const tooShort = speechMs <= 0 || speechMs + 1e-6 < this.minSpeechMs;
    if (tooShort) this._counters.discarded += 1;

    const utterance = {
      type: 'utterance',
      reason,
      pcm,
      startTimeMs,
      endTimeMs,
      durationMs,
      speechMs,
      frameCount: frames.length,
    };

    this._state = 'silence';
    this._speechRun = 0;
    this._silenceRun = 0;
    this._speechStartFrame = null;
    this._lastVoicedFrame = null;
    this._utteranceFrames = null;
    this._utteranceFirstFrame = 0;
    this._speechMs = 0;
    this._ring = [];

    if (tooShort) {
      return [{
        type: 'discarded',
        reason: 'too-short',
        durationMs,
        speechMs,
      }];
    }
    return [utterance];
  }
}
