/**
 * log.js - append-only file logger mirrored to the DSH host logger.
 *
 * The GUI never shows plugin logs, so <practiceRoot>/logs/voice-practice.log is
 * the only reliable installation/debug channel. Writes are serialized and never
 * throw into the voice loop.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    try {
      return String(value);
    } catch (_textError) {
      return '<unprintable>';
    }
  }
}

export class VoiceLog {
  constructor(options = {}) {
    this.filePath = typeof options.filePath === 'string' ? options.filePath : '';
    this.ctxLogger = options.ctxLogger ?? null;
    this.scope = typeof options.scope === 'string' ? options.scope : 'voice-practice';
    this._chain = Promise.resolve();
    this._closed = false;
    this._fileErrorWarned = false;
    this._dirReady = null;
  }

  _mirror(level, text) {
    const target = this.ctxLogger;
    if (target === null || target === undefined) return;
    const method = target[level];
    if (typeof method !== 'function') return;
    try {
      method.call(target, '[' + this.scope + '] ' + text);
    } catch (_mirrorError) {
      // Logging must never break the caller.
    }
  }

  _write(level, message) {
    const text = stringify(message);
    const line = '[' + new Date().toISOString() + '] [' + level + '] ['
      + this.scope + '] ' + text + '\n';
    this._mirror(level, text);
    if (this.filePath === '' || this._closed) return;
    this._chain = this._chain.then(async () => {
      try {
        if (this._dirReady === null) this._dirReady = mkdir(dirname(this.filePath), { recursive: true });
        await this._dirReady;
        await appendFile(this.filePath, line, 'utf8');
      } catch (error) {
        if (!this._fileErrorWarned) {
          this._fileErrorWarned = true;
          this._mirror('warn', 'cannot write log file ' + this.filePath + ': ' + stringify(error));
        }
      }
    }).catch(() => {});
  }

  debug(message) {
    if (LEVELS.includes('debug')) this._write('debug', message);
  }

  info(message) {
    this._write('info', message);
  }

  warn(message) {
    this._write('warn', message);
  }

  error(message) {
    this._write('error', message);
  }

  /** Wait for queued file appends to settle. */
  async flush() {
    await this._chain;
  }

  /** Flush and stop appending (the ctx.logger mirror stays available). */
  async close() {
    await this.flush();
    this._closed = true;
  }
}

/** @returns {VoiceLog} */
export function createLog(options) {
  return new VoiceLog(options);
}
