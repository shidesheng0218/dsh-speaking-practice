/**
 * tts.js - macOS say playback adapter.
 *
 * One say child process per language segment, sequential playback, cancellable
 * by SIGTERM (measured interrupt latency 1-6 ms in docs/audio-feasibility.md).
 * The subprocess service is injected so tests can use a fake.
 */

const SAY_FALLBACK = '/usr/bin/say';
const VOICE_LIST_TIMEOUT_MS = 8000;

/**
 * Parse the output of say -v ? into {name, locale} entries.
 * @param {string} text raw command output.
 * @returns {{name:string, locale:string}[]}
 */
export function parseVoiceList(text) {
  const voices = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const match = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/u.exec(rawLine);
    if (match === null) continue;
    const name = match[1].trim();
    const locale = match[2];
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    voices.push({ name, locale });
  }
  return voices;
}

/**
 * Rough wall-clock estimate for speaking one segment.
 * @param {string} text
 * @param {number} rate words per minute (say -r).
 * @returns {number} milliseconds.
 */
export function estimateSpeakMs(text, rate = 175) {
  const chars = String(text ?? '').length;
  const charsPerSecond = Math.max(4, (rate * 5) / 60);
  return Math.round(300 + (chars / charsPerSecond) * 1000);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

const NOOP_LOG = Object.freeze({ warn() {}, info() {}, error() {} });

export class Speaker {
  constructor(options = {}) {
    this.subprocess = options.subprocess ?? null;
    this.config = options.config ?? {};
    this.log = options.log ?? NOOP_LOG;
    this._sayExe = null;
    this._voicesPromise = null;
    this._staticVoices = Array.isArray(options.voices) ? options.voices : null;
    this._active = null;
    this._cancelRequested = false;
    this._voiceFallbackWarned = false;
  }

  get speaking() {
    return this._active !== null;
  }

  get sayExecutable() {
    return this._sayExe;
  }

  async _resolveSay() {
    if (this._sayExe !== null) return this._sayExe;
    if (this.subprocess !== null && typeof this.subprocess.resolveExecutable === 'function') {
      try {
        const resolved = await this.subprocess.resolveExecutable('say');
        if (typeof resolved === 'string' && resolved !== '') {
          this._sayExe = resolved;
          return resolved;
        }
      } catch (error) {
        this.log.warn('[tts] resolveExecutable(say) failed: ' + errorMessage(error));
      }
    }
    this._sayExe = SAY_FALLBACK;
    return SAY_FALLBACK;
  }

  _spawn(spec) {
    if (this.subprocess === null || typeof this.subprocess.spawn !== 'function') {
      throw new Error('subprocess service unavailable (ctx.subprocess missing)');
    }
    return this.subprocess.spawn(spec);
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

  /** Load the installed voice list once (cached, failure-tolerant). */
  async detectVoices() {
    if (this._staticVoices !== null) return this._staticVoices;
    if (this._voicesPromise === null) {
      this._voicesPromise = this._loadVoices().catch((error) => {
        this.log.warn('[tts] voice list unavailable: ' + errorMessage(error));
        return null;
      });
    }
    return this._voicesPromise;
  }

  async _loadVoices() {
    const sayExe = await this._resolveSay();
    const handle = this._spawn({
      argv: [sayExe, '-v', '?'],
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 4096 } },
      graceMs: 1000,
    });
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('say -v ? timed out')), VOICE_LIST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      await Promise.race([handle.done, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const output = handle?.collected?.stdout?.readFrom?.(0)?.text ?? '';
    const voices = parseVoiceList(output);
    this.log.info('[tts] detected ' + voices.length + ' system voices');
    return voices;
  }

  async _pickVoice(lang) {
    const englishVoice = typeof this.config.englishVoice === 'string' && this.config.englishVoice !== ''
      ? this.config.englishVoice
      : 'Samantha';
    const chineseVoice = typeof this.config.chineseVoice === 'string' && this.config.chineseVoice !== ''
      ? this.config.chineseVoice
      : 'Tingting';
    if (lang !== 'zh') return englishVoice;
    const voices = await this.detectVoices();
    if (voices === null) return englishVoice;
    const configured = voices.find((voice) => voice.name === chineseVoice);
    if (configured !== undefined) return configured.name;
    const chinese = voices.find((voice) => voice.locale === 'zh_CN')
      ?? voices.find((voice) => voice.locale.startsWith('zh'));
    if (chinese !== undefined) {
      if (!this._voiceFallbackWarned) {
        this._voiceFallbackWarned = true;
        this.log.warn('[tts] configured chineseVoice "' + chineseVoice
          + '" not installed; using "' + chinese.name + '"');
      }
      return chinese.name;
    }
    if (!this._voiceFallbackWarned) {
      this._voiceFallbackWarned = true;
      this.log.warn('[tts] no Chinese voice installed; Chinese segments use "' + englishVoice + '"');
    }
    return englishVoice;
  }

  async _sayOnce(sayExe, voice, text) {
    const rate = Number.isFinite(Number(this.config.rate)) ? String(this.config.rate) : '175';
    let handle = null;
    try {
      handle = this._spawn({
        argv: [sayExe, '-v', voice, '-r', rate, text],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 4096 } },
        graceMs: 1000,
      });
    } catch (error) {
      this.log.warn('[tts] say spawn failed: ' + errorMessage(error));
      return { ok: false, cancelled: false };
    }
    this._active = handle;
    const estimate = estimateSpeakMs(text, Number(rate));
    const pad = Number.isFinite(Number(this.config.sayTimeoutPadMs)) ? Number(this.config.sayTimeoutPadMs) : 5000;
    const timeoutMs = Math.max(5000, Math.min(240000, Math.round(estimate * 1.5) + pad));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        handle.terminate();
      } catch (_terminateError) {
        // terminate is idempotent; a throw here means it is already gone.
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const outcome = await handle.done;
      if (this._cancelRequested) return { ok: false, cancelled: true };
      if (timedOut) {
        this.log.warn('[tts] say timed out after ' + timeoutMs + 'ms');
        return { ok: false, cancelled: false };
      }
      const exitCode = outcome !== null && typeof outcome === 'object' ? outcome.exitCode : null;
      const signal = outcome !== null && typeof outcome === 'object' ? outcome.signal : null;
      if (exitCode !== 0) {
        const tail = this._stderrTail(handle);
        this.log.warn('[tts] say exited code=' + String(exitCode) + ' signal=' + String(signal)
          + (tail === '' ? '' : ' stderr=' + tail));
        return { ok: false, cancelled: false };
      }
      return { ok: true, cancelled: false };
    } catch (error) {
      this.log.warn('[tts] say failed: ' + errorMessage(error));
      return { ok: false, cancelled: false };
    } finally {
      clearTimeout(timer);
      if (this._active === handle) this._active = null;
    }
  }

  /**
   * Speak ordered language segments.
   * @param {{lang:'zh'|'en', text:string}[]} segments
   * @returns {Promise<{cancelled:boolean, spoken:number}>}
   */
  async speak(segments) {
    this._cancelRequested = false;
    const list = Array.isArray(segments) ? segments : [];
    if (list.length === 0) return { cancelled: false, spoken: 0 };
    const sayExe = await this._resolveSay();
    let spoken = 0;
    for (const segment of list) {
      if (this._cancelRequested) return { cancelled: true, spoken };
      const text = segment !== null && typeof segment === 'object' && typeof segment.text === 'string'
        ? segment.text.trim()
        : '';
      if (text === '') continue;
      const lang = segment.lang === 'zh' ? 'zh' : 'en';
      const voice = await this._pickVoice(lang);
      const result = await this._sayOnce(sayExe, voice, text);
      if (result.cancelled) return { cancelled: true, spoken };
      if (result.ok) spoken += 1;
    }
    return { cancelled: false, spoken };
  }

  /** Cancel the active say process; resolves once the process range settles. */
  async cancel() {
    this._cancelRequested = true;
    const handle = this._active;
    if (handle === null) return;
    try {
      handle.terminate();
    } catch (_terminateError) {
      // Idempotent by contract.
    }
    try {
      if (typeof handle.waitForExit === 'function') {
        await Promise.race([
          handle.waitForExit(),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 500);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
      }
    } catch (_waitError) {
      // The process range is already gone.
    }
  }
}

/** @returns {Speaker} */
export function createSpeaker(options) {
  return new Speaker(options);
}
