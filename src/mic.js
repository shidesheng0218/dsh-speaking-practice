/**
 * mic.js - resident ffmpeg avfoundation microphone capture.
 *
 * One long-lived ffmpeg process streams 16 kHz mono PCM16 to stdout; spawning
 * ffmpeg per utterance would drop the first 0.35-0.5 s while the device opens
 * (docs/audio-feasibility.md). Unexpected exits are retried with backoff, then
 * reported through onFatal.
 */
import { existsSync } from 'node:fs';

const FFMPEG_FALLBACK = '/opt/homebrew/bin/ffmpeg';
const DEFAULT_DEVICE = ':0';

/**
 * Build the ffmpeg argv for continuous 16 kHz mono PCM capture.
 * @param {string} ffmpegPath
 * @param {{sampleRate?: number, device?: string}} [options]
 * @returns {string[]}
 */
export function buildFfmpegArgs(ffmpegPath, options = {}) {
  const sampleRate = options.sampleRate ?? 16000;
  const device = typeof options.device === 'string' && options.device !== '' ? options.device : DEFAULT_DEVICE;
  return [
    ffmpegPath,
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-i',
    device,
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-f',
    's16le',
    '-',
  ];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function makeMicError(message, stderrTail) {
  const error = new Error(message);
  error.name = 'MicError';
  if (typeof stderrTail === 'string' && stderrTail !== '') error.stderrTail = stderrTail;
  return error;
}

const NOOP_LOG = Object.freeze({ info() {}, warn() {}, error() {} });

export class MicCapture {
  constructor(options = {}) {
    this.subprocess = options.subprocess ?? null;
    this.config = options.config ?? {};
    this.log = options.log ?? NOOP_LOG;
    this.device = typeof options.device === 'string' ? options.device : DEFAULT_DEVICE;
    this.ffmpegPath = typeof options.ffmpegPath === 'string' && options.ffmpegPath !== ''
      ? options.ffmpegPath
      : null;
    this.firstChunkTimeoutMs = Number.isFinite(Number(this.config.firstChunkTimeoutMs))
      ? Number(this.config.firstChunkTimeoutMs)
      : 8000;
    this.maxRetries = Number.isFinite(Number(this.config.ffmpegRetries))
      ? Math.max(0, Math.round(Number(this.config.ffmpegRetries)))
      : 3;
    this.retryDelayMs = Number.isFinite(Number(this.config.ffmpegRetryDelayMs))
      ? Math.max(0, Math.round(Number(this.config.ffmpegRetryDelayMs)))
      : 1000;
    this.sampleRate = Number.isFinite(Number(this.config.sampleRate))
      ? Number(this.config.sampleRate)
      : 16000;

    this._handle = null;
    this._onData = null;
    this._onFatal = null;
    this._stopping = false;
    this._retries = 0;
    this._retryTimer = null;
  }

  get running() {
    return this._handle !== null;
  }

  async _resolveFfmpeg() {
    if (this.ffmpegPath !== null) return this.ffmpegPath;
    if (this.subprocess !== null && typeof this.subprocess.resolveExecutable === 'function') {
      try {
        const resolved = await this.subprocess.resolveExecutable('ffmpeg');
        if (typeof resolved === 'string' && resolved !== '') {
          this.ffmpegPath = resolved;
          return resolved;
        }
      } catch (error) {
        this.log.warn('[mic] resolveExecutable(ffmpeg) failed: ' + errorMessage(error));
      }
    }
    this.ffmpegPath = existsSync(FFMPEG_FALLBACK) ? FFMPEG_FALLBACK : 'ffmpeg';
    this.log.info('[mic] using ffmpeg fallback path ' + this.ffmpegPath);
    return this.ffmpegPath;
  }

  _stderrTail(handle) {
    try {
      const reader = handle?.collected?.stderr;
      if (reader === undefined || typeof reader.readFrom !== 'function') return '';
      const snapshot = reader.readFrom(0);
      const text = snapshot !== null && typeof snapshot === 'object' && typeof snapshot.text === 'string'
        ? snapshot.text.trim()
        : '';
      return text.length > 500 ? text.slice(-500) : text;
    } catch (_readError) {
      return '';
    }
  }

  _spawnHandle(ffmpegPath) {
    if (this.subprocess === null || typeof this.subprocess.spawn !== 'function') {
      throw makeMicError('subprocess service unavailable (ctx.subprocess missing)', '');
    }
    const argv = buildFfmpegArgs(ffmpegPath, { sampleRate: this.sampleRate, device: this.device });
    let handle;
    try {
      handle = this.subprocess.spawn({
        argv,
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8192 } },
        graceMs: 1000,
      });
    } catch (error) {
      throw makeMicError('ffmpeg spawn failed: ' + errorMessage(error), '');
    }
    if (handle === null || typeof handle !== 'object') {
      throw makeMicError('ffmpeg spawn returned no handle', '');
    }
    return handle;
  }

  _wireData(handle, onData) {
    const stream = handle.stdout;
    if (stream === null || stream === undefined || typeof stream.on !== 'function') {
      throw makeMicError('ffmpeg stdout is not a readable stream', this._stderrTail(handle));
    }
    stream.on('data', (chunk) => {
      try {
        onData(chunk);
      } catch (error) {
        this.log.error('[mic] audio callback failed: ' + errorMessage(error));
      }
    });
  }

  _waitForFirstChunk(handle) {
    const self = this;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        finish(makeMicError('no audio data within ' + self.firstChunkTimeoutMs + 'ms', self._stderrTail(handle)));
      }, self.firstChunkTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        handle.stdout.once('data', () => finish(null));
      } catch (_onceError) {
        finish(makeMicError('cannot read ffmpeg stdout', self._stderrTail(handle)));
        return;
      }
      try {
        handle.done.then(
          (outcome) => {
            const code = outcome !== null && typeof outcome === 'object' ? outcome.exitCode : null;
            finish(makeMicError('ffmpeg exited before audio data (code=' + String(code) + ')', self._stderrTail(handle)));
          },
          (error) => finish(makeMicError('ffmpeg failed before audio data: ' + errorMessage(error), self._stderrTail(handle))),
        );
      } catch (_doneError) {
        finish(makeMicError('ffmpeg handle has no done promise', self._stderrTail(handle)));
      }
    });
  }

  /** Spawn ffmpeg and resolve after the first PCM chunk arrives. */
  async _openOnce() {
    const ffmpegPath = await this._resolveFfmpeg();
    const handle = this._spawnHandle(ffmpegPath);
    this._wireData(handle, (chunk) => {
      if (this._onData !== null) this._onData(chunk);
    });
    handle.done.then(
      (outcome) => this._onProcessExit(handle, outcome),
      (error) => this._onProcessExit(handle, null, error),
    );
    try {
      await this._waitForFirstChunk(handle);
    } catch (error) {
      try {
        handle.terminate();
      } catch (_terminateError) {
        // Opening failed; the process may already be gone.
      }
      throw error;
    }
    this._handle = handle;
    this._retries = 0;
    this.log.info('[mic] ffmpeg capture started (16kHz mono PCM16, device ' + this.device + ')');
    return handle;
  }

  /**
   * Start capturing. Rejects when audio does not start; the error carries the
   * last 500 characters of ffmpeg stderr when available.
   * @param {{onData:(chunk:Buffer)=>void, onFatal?:(error:Error)=>void}} handlers
   */
  async start(handlers = {}) {
    if (typeof handlers.onData !== 'function') throw new TypeError('mic.start requires onData');
    if (this._handle !== null) return;
    this._stopping = false;
    this._retries = 0;
    this._onData = handlers.onData;
    this._onFatal = typeof handlers.onFatal === 'function' ? handlers.onFatal : null;
    const handle = await this._openOnce();
    if (this._stopping) {
      try {
        handle.terminate();
      } catch (_terminateError) {
        // Stop raced the start; nothing else to release.
      }
    }
  }

  _onProcessExit(handle, outcome, error) {
    if (this._handle !== handle) return;
    this._handle = null;
    if (this._stopping) return;
    const code = outcome !== null && typeof outcome === 'object' ? outcome.exitCode : null;
    const signal = outcome !== null && typeof outcome === 'object' ? outcome.signal : null;
    this.log.warn('[mic] ffmpeg exited unexpectedly (code=' + String(code) + ' signal='
      + String(signal) + (error === undefined ? '' : ' error=' + errorMessage(error)) + ')');
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this._stopping) return;
    if (this._retries >= this.maxRetries) {
      const failure = makeMicError('microphone capture failed after ' + this.maxRetries + ' restart(s)', '');
      this.log.error('[mic] ' + failure.message + '; disabling voice mode');
      if (this._onFatal !== null) {
        try {
          this._onFatal(failure);
        } catch (error) {
          this.log.error('[mic] onFatal failed: ' + errorMessage(error));
        }
      }
      return;
    }
    this._retries += 1;
    this.log.info('[mic] restarting capture in ' + this.retryDelayMs + 'ms (attempt '
      + this._retries + '/' + this.maxRetries + ')');
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._openOnce().catch((error) => {
        this.log.warn('[mic] restart failed: ' + errorMessage(error));
        this._scheduleRestart();
      });
    }, this.retryDelayMs);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  /** Terminate the capture process and wait briefly for its exit. */
  async stop() {
    this._stopping = true;
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    const handle = this._handle;
    this._handle = null;
    if (handle !== null) {
      try {
        handle.terminate();
      } catch (_terminateError) {
        // Idempotent by contract.
      }
      try {
        await Promise.race([
          handle.done,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
      } catch (_waitError) {
        // Exit facts are irrelevant during teardown.
      }
      this.log.info('[mic] ffmpeg capture stopped');
    }
    this._onData = null;
  }
}

/** @returns {MicCapture} */
export function createMic(options) {
  return new MicCapture(options);
}
