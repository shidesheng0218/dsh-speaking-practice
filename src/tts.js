/**
 * tts.js - Multi-backend speech playback adapter (macOS say + optional Edge neural TTS).
 *
 * Supports three engines via config.ttsEngine:
 *   - 'auto' (default): uses `edge-tts` + `afplay` when `edge-tts` is installed,
 *     otherwise upgrades macOS `say` to any installed Premium/Enhanced voice
 *     variant matching the configured voice before falling back to compact `say`.
 *   - 'say': strictly uses macOS `say` (still upgrading to Premium/Enhanced
 *     variants of the configured voice when available).
 *   - 'edge': prefers `edge-tts` + `afplay`, falling back seamlessly to `say`
 *     if `edge-tts` is missing, offline, or times out.
 *
 * One child process at a time, cancellable within milliseconds via SIGTERM.
 * The subprocess service is injected so unit tests stay pure and deterministic.
 */
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAY_FALLBACK = '/usr/bin/say';
const AFPLAY_FALLBACK = '/usr/bin/afplay';
const VOICE_LIST_TIMEOUT_MS = 8000;
const EDGE_SYNTH_TIMEOUT_MS = 10000;

const QUALITY_PATTERNS = [
  { tier: 3, re: /\bpremium\b|优质|高质/iu },
  { tier: 2, re: /\benhanced\b|增强/iu },
  { tier: 1, re: /\bsiri\b/iu },
];

const PREFERRED_ENGLISH_FAMILIES = ['ava', 'allison', 'samantha', 'alex', 'daniel', 'karen', 'moira'];
const PREFERRED_CHINESE_FAMILIES = ['tingting', 'ting-ting', 'yue', 'meijia', 'sinji'];

function detectVoiceTier(name) {
  for (const entry of QUALITY_PATTERNS) {
    if (entry.re.test(name)) return entry.tier;
  }
  return 0;
}

function voiceBaseFamily(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Parse the output of say -v ? into {name, locale, tier, family} entries.
 * @param {string} text raw command output.
 * @returns {{name:string, locale:string, tier:number, family:string}[]}
 */
export function parseVoiceList(text) {
  const voices = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const match = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/u.exec(rawLine);
    if (match === null) continue;
    const rawName = match[1].trim();
    const locale = match[2];
    const name = rawName.trim();
    const key = name + '|' + locale;
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    voices.push({
      name,
      locale,
      tier: detectVoiceTier(name),
      family: voiceBaseFamily(name),
    });
  }
  return voices;
}

/**
 * Convert `say` rate (words per minute, baseline 175) to `edge-tts` rate flag
 * (e.g. "+14%", "-10%", "+0%").
 * @param {number} rate
 * @returns {string}
 */
export function rateToEdgePercent(rate = 175) {
  const numeric = Number.isFinite(Number(rate)) ? Number(rate) : 175;
  const pct = Math.max(-50, Math.min(100, Math.round(((numeric - 175) / 175) * 100)));
  return (pct >= 0 ? '+' : '') + String(pct) + '%';
}

/**
 * Select the best installed system voice for a target language and configured
 * voice name, automatically preferring Premium/Enhanced variants when present.
 * @param {{name:string, locale:string, tier?:number, family?:string}[]|null} voices
 * @param {'en'|'zh'} lang
 * @param {string} configuredVoice
 * @returns {{voice: string, upgraded: boolean, fallback: boolean}}
 */
export function selectBestSystemVoice(voices, lang, configuredVoice) {
  const target = typeof configuredVoice === 'string' && configuredVoice.trim() !== ''
    ? configuredVoice.trim()
    : (lang === 'zh' ? 'Tingting' : 'Samantha');
  if (!Array.isArray(voices) || voices.length === 0) {
    return { voice: target, upgraded: false, fallback: false };
  }

  const enriched = voices.map((entry) => ({
    name: entry.name,
    locale: entry.locale,
    tier: typeof entry.tier === 'number' ? entry.tier : detectVoiceTier(entry.name),
    family: typeof entry.family === 'string' ? entry.family : voiceBaseFamily(entry.name),
  }));

  const targetLower = target.toLowerCase();
  const targetFamily = voiceBaseFamily(target);
  const langPrefix = lang === 'zh' ? 'zh' : 'en';
  const langVoices = enriched.filter((v) => v.locale.toLowerCase().startsWith(langPrefix));

  // 1. Exact match when the user explicitly specified a qualified name (e.g. "Ava (Premium)").
  const exact = enriched.find((v) => v.name.toLowerCase() === targetLower);
  const userSpecifiedVariant = /\(/.test(target);
  if (exact !== undefined && userSpecifiedVariant) {
    return { voice: exact.name, upgraded: false, fallback: false };
  }

  // 2. Same voice family (e.g. "Samantha" -> "Samantha (Enhanced)" or "Samantha"): pick highest tier.
  const sameFamily = langVoices
    .filter((v) => v.family === targetFamily || v.name.toLowerCase().startsWith(targetLower + ' ('))
    .sort((a, b) => b.tier - a.tier);
  if (sameFamily.length > 0 && sameFamily[0].tier > 0) {
    return {
      voice: sameFamily[0].name,
      upgraded: sameFamily[0].name !== target,
      fallback: false,
    };
  }

  // 3. Any other Premium/Enhanced voice installed for the same language.
  const preferredFamilies = lang === 'zh' ? PREFERRED_CHINESE_FAMILIES : PREFERRED_ENGLISH_FAMILIES;
  const highQualityInLang = langVoices
    .filter((v) => v.tier >= 2)
    .sort((a, b) => {
      if (b.tier !== a.tier) return b.tier - a.tier;
      const idxA = preferredFamilies.indexOf(a.family);
      const idxB = preferredFamilies.indexOf(b.family);
      const rankA = idxA === -1 ? 999 : idxA;
      const rankB = idxB === -1 ? 999 : idxB;
      return rankA - rankB;
    });
  if (highQualityInLang.length > 0 && !userSpecifiedVariant) {
    return {
      voice: highQualityInLang[0].name,
      upgraded: highQualityInLang[0].name !== target,
      fallback: false,
    };
  }

  // 4. Exact or same-family compact voice.
  if (exact !== undefined) {
    return { voice: exact.name, upgraded: false, fallback: false };
  }
  if (sameFamily.length > 0) {
    // Keep bare family name if user passed bare name (e.g. "Samantha" when say -v ? prints "Samantha (英语（美国）)").
    const keepBare = !userSpecifiedVariant && sameFamily[0].family === targetLower;
    return {
      voice: keepBare ? target : sameFamily[0].name,
      upgraded: false,
      fallback: false,
    };
  }

  // 5. Language fallback when configured voice is missing.
  if (lang === 'zh') {
    const zhFallback = langVoices.find((v) => v.locale === 'zh_CN') ?? langVoices[0];
    if (zhFallback !== undefined) {
      return { voice: zhFallback.name, upgraded: false, fallback: true };
    }
    return { voice: '', upgraded: false, fallback: true };
  }

  const enFallback = langVoices.find((v) => v.locale === 'en_US') ?? langVoices[0];
  if (enFallback !== undefined) {
    return { voice: enFallback.name, upgraded: false, fallback: true };
  }
  return { voice: target, upgraded: false, fallback: false };
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
    this._afplayExe = null;
    this._edgeExe = undefined; // undefined = unresolved, null = unavailable, string = path
    this._voicesPromise = null;
    this._staticVoices = Array.isArray(options.voices) ? options.voices : null;
    this._unlinkFile = typeof options.unlinkFile === 'function' ? options.unlinkFile : unlink;
    this._active = null;
    this._cancelRequested = false;
    this._voiceFallbackWarned = false;
    this._voiceUpgradeLogged = new Set();
    this._edgeWarned = false;
    this._seq = 0;
  }

  get speaking() {
    return this._active !== null;
  }

  get sayExecutable() {
    return this._sayExe;
  }

  get engineMode() {
    const raw = typeof this.config.ttsEngine === 'string' ? this.config.ttsEngine.trim().toLowerCase() : 'auto';
    return raw === 'say' || raw === 'edge' ? raw : 'auto';
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

  async _resolveAfplay() {
    if (this._afplayExe !== null) return this._afplayExe;
    if (this.subprocess !== null && typeof this.subprocess.resolveExecutable === 'function') {
      try {
        const resolved = await this.subprocess.resolveExecutable('afplay');
        if (typeof resolved === 'string' && resolved !== '') {
          this._afplayExe = resolved;
          return resolved;
        }
      } catch (_error) {
        // Fall through to standard macOS afplay path.
      }
    }
    this._afplayExe = AFPLAY_FALLBACK;
    return AFPLAY_FALLBACK;
  }

  async _resolveEdgeTts() {
    if (this._edgeExe !== undefined) return this._edgeExe;
    if (this.subprocess !== null && typeof this.subprocess.resolveExecutable === 'function') {
      try {
        const resolved = await this.subprocess.resolveExecutable('edge-tts');
        if (typeof resolved === 'string' && resolved !== '') {
          this._edgeExe = resolved;
          this.log.info('[tts] detected neural backend edge-tts at ' + resolved);
          return resolved;
        }
      } catch (_error) {
        // Not installed; handled below.
      }
    }
    this._edgeExe = null;
    if (this.engineMode === 'edge' && !this._edgeWarned) {
      this._edgeWarned = true;
      this.log.warn('[tts] ttsEngine="edge" requested but `edge-tts` executable was not found; falling back to system `say`');
    }
    return null;
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
    const voices = await this.detectVoices();
    if (lang !== 'zh') {
      const choice = selectBestSystemVoice(voices, 'en', englishVoice);
      if (choice.upgraded && !this._voiceUpgradeLogged.has('en:' + choice.voice)) {
        this._voiceUpgradeLogged.add('en:' + choice.voice);
        this.log.info('[tts] auto-upgraded English voice "' + englishVoice + '" -> "' + choice.voice + '"');
      }
      return choice.voice;
    }

    if (voices === null) return englishVoice;
    const choice = selectBestSystemVoice(voices, 'zh', chineseVoice);
    if (choice.voice === '') {
      if (!this._voiceFallbackWarned) {
        this._voiceFallbackWarned = true;
        this.log.warn('[tts] no Chinese voice installed; Chinese segments use "' + englishVoice + '"');
      }
      return englishVoice;
    }
    if (choice.fallback && !this._voiceFallbackWarned) {
      this._voiceFallbackWarned = true;
      this.log.warn('[tts] configured chineseVoice "' + chineseVoice
        + '" not installed; using "' + choice.voice + '"');
    } else if (choice.upgraded && !this._voiceUpgradeLogged.has('zh:' + choice.voice)) {
      this._voiceUpgradeLogged.add('zh:' + choice.voice);
      this.log.info('[tts] auto-upgraded Chinese voice "' + chineseVoice + '" -> "' + choice.voice + '"');
    }
    return choice.voice;
  }

  _pickEdgeVoice(lang) {
    if (lang === 'zh') {
      return typeof this.config.edgeChineseVoice === 'string' && this.config.edgeChineseVoice.trim() !== ''
        ? this.config.edgeChineseVoice.trim()
        : 'zh-CN-XiaoxiaoNeural';
    }
    return typeof this.config.edgeEnglishVoice === 'string' && this.config.edgeEnglishVoice.trim() !== ''
      ? this.config.edgeEnglishVoice.trim()
      : 'en-US-JennyNeural';
  }

  async _runManagedProcess(argv, timeoutMs, label) {
    let handle = null;
    try {
      handle = this._spawn({
        argv,
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 4096 } },
        graceMs: 1000,
      });
    } catch (error) {
      this.log.warn('[tts] ' + label + ' spawn failed: ' + errorMessage(error));
      return { ok: false, cancelled: false };
    }
    this._active = handle;
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
        this.log.warn('[tts] ' + label + ' timed out after ' + timeoutMs + 'ms');
        return { ok: false, cancelled: false };
      }
      const exitCode = outcome !== null && typeof outcome === 'object' ? outcome.exitCode : null;
      const signal = outcome !== null && typeof outcome === 'object' ? outcome.signal : null;
      if (exitCode !== 0) {
        const tail = this._stderrTail(handle);
        this.log.warn('[tts] ' + label + ' exited code=' + String(exitCode) + ' signal=' + String(signal)
          + (tail === '' ? '' : ' stderr=' + tail));
        return { ok: false, cancelled: false };
      }
      return { ok: true, cancelled: false };
    } catch (error) {
      this.log.warn('[tts] ' + label + ' failed: ' + errorMessage(error));
      return { ok: false, cancelled: false };
    } finally {
      clearTimeout(timer);
      if (this._active === handle) this._active = null;
    }
  }

  async _edgeOnce(edgeExe, lang, text) {
    const rate = Number.isFinite(Number(this.config.rate)) ? Number(this.config.rate) : 175;
    const edgeVoice = this._pickEdgeVoice(lang);
    const rateArg = '--rate=' + rateToEdgePercent(rate);
    this._seq += 1;
    const mediaPath = join(
      tmpdir(),
      'dsh-voice-edge-' + process.pid + '-' + Date.now() + '-' + this._seq + '.mp3',
    );
    try {
      const synth = await this._runManagedProcess(
        [edgeExe, '--voice', edgeVoice, rateArg, '--text', text, '--write-media', mediaPath],
        EDGE_SYNTH_TIMEOUT_MS,
        'edge-tts',
      );
      if (synth.cancelled) return { ok: false, cancelled: true };
      if (!synth.ok) return { ok: false, cancelled: false };
      if (this._cancelRequested) return { ok: false, cancelled: true };

      const afplayExe = await this._resolveAfplay();
      const estimate = estimateSpeakMs(text, rate);
      const pad = Number.isFinite(Number(this.config.sayTimeoutPadMs)) ? Number(this.config.sayTimeoutPadMs) : 5000;
      const playTimeoutMs = Math.max(5000, Math.min(240000, Math.round(estimate * 1.5) + pad));
      return await this._runManagedProcess([afplayExe, mediaPath], playTimeoutMs, 'afplay');
    } finally {
      try {
        await this._unlinkFile(mediaPath);
      } catch (_unlinkError) {
        // Temp media may never have been created if edge-tts failed early.
      }
    }
  }

  async _sayOnce(sayExe, voice, text) {
    const rate = Number.isFinite(Number(this.config.rate)) ? String(this.config.rate) : '175';
    const estimate = estimateSpeakMs(text, Number(rate));
    const pad = Number.isFinite(Number(this.config.sayTimeoutPadMs)) ? Number(this.config.sayTimeoutPadMs) : 5000;
    const timeoutMs = Math.max(5000, Math.min(240000, Math.round(estimate * 1.5) + pad));
    return this._runManagedProcess([sayExe, '-v', voice, '-r', rate, text], timeoutMs, 'say');
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
    if (this.subprocess === null || typeof this.subprocess.spawn !== 'function') {
      this.log.warn('[tts] subprocess service unavailable (ctx.subprocess missing)');
      return { cancelled: false, spoken: 0 };
    }

    const mode = this.engineMode;
    const edgeExe = mode === 'say' ? null : await this._resolveEdgeTts();
    let sayExe = null;
    let spoken = 0;

    for (const segment of list) {
      if (this._cancelRequested) return { cancelled: true, spoken };
      const text = segment !== null && typeof segment === 'object' && typeof segment.text === 'string'
        ? segment.text.trim()
        : '';
      if (text === '') continue;
      const lang = segment.lang === 'zh' ? 'zh' : 'en';

      if (edgeExe !== null) {
        const edgeResult = await this._edgeOnce(edgeExe, lang, text);
        if (edgeResult.cancelled) return { cancelled: true, spoken };
        if (edgeResult.ok) {
          spoken += 1;
          continue;
        }
        this.log.warn('[tts] edge-tts segment failed; falling back to system `say`');
      }

      if (sayExe === null) sayExe = await this._resolveSay();
      const voice = await this._pickVoice(lang);
      const result = await this._sayOnce(sayExe, voice, text);
      if (result.cancelled) return { cancelled: true, spoken };
      if (result.ok) spoken += 1;
    }
    return { cancelled: false, spoken };
  }

  /** Cancel the active say/edge/afplay process; resolves once the process range settles. */
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
