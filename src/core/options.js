/**
 * core/options.js - configuration normalization and path helpers.
 *
 * Pure module: no @deepseek-ai imports, no process side effects, unit-testable
 * outside the DSH host.
 */
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_OPTIONS = Object.freeze({
  practiceRoot: '',
  englishVoice: 'Samantha',
  chineseVoice: 'Tingting',
  rate: 175,
  language: 'auto',
  silenceMs: 600,
  minSpeechMs: 200,
  maxUtteranceSec: 45,
  bargeIn: true,
  logFile: 'logs/voice-practice.log',
  selfTest: false,
});

/**
 * Internal tunables. They are NOT part of the public Config schema; tests and
 * advanced callers may override them through normalizeOptions(input, overrides).
 */
export const INTERNAL_DEFAULTS = Object.freeze({
  sampleRate: 16000,
  frameMs: 20,
  relThresholdDb: 12,
  absThresholdDb: -45,
  maxThresholdDb: -20,
  calibrateMs: 400,
  prerollMs: 300,
  onsetFrames: 3,
  ttsOnsetGuardMs: 150,
  ttsTailGuardMs: 120,
  transcribeTimeoutMs: 15000,
  replyTimeoutMs: 120000,
  firstChunkTimeoutMs: 8000,
  ffmpegRetries: 3,
  ffmpegRetryDelayMs: 1000,
  maxSpeechChars: 1200,
  maxSentenceChars: 220,
  languageThreshold: 0.3,
  sayTimeoutPadMs: 5000,
});

const INTEGER_RANGES = Object.freeze({
  sampleRate: [8000, 48000],
  frameMs: [10, 40],
  relThresholdDb: [3, 40],
  absThresholdDb: [-80, -20],
  maxThresholdDb: [-40, -5],
  calibrateMs: [0, 2000],
  prerollMs: [0, 1000],
  onsetFrames: [1, 20],
  ttsOnsetGuardMs: [0, 1000],
  ttsTailGuardMs: [0, 1000],
  transcribeTimeoutMs: [1000, 120000],
  replyTimeoutMs: [1000, 600000],
  firstChunkTimeoutMs: [500, 30000],
  ffmpegRetries: [0, 10],
  ffmpegRetryDelayMs: [0, 10000],
  maxSpeechChars: [100, 10000],
  maxSentenceChars: [40, 1000],
  sayTimeoutPadMs: [0, 60000],
});

function pickString(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function pickInteger(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(Math.max(numeric, min), max));
}

function pickFloat(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function pickBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Normalize loader-provided config plus test overrides into one frozen options
 * object. Invalid or missing values fall back to the documented defaults.
 * @param {object} [input] raw Config payload from cordis.patch.yml.
 * @param {object} [overrides] internal tunables (tests / embedded use).
 * @returns {object} frozen normalized options.
 */
export function normalizeOptions(input, overrides) {
  const source = input && typeof input === 'object' ? input : {};
  const extra = overrides && typeof overrides === 'object' ? overrides : {};

  const rootRaw = typeof source.practiceRoot === 'string' ? source.practiceRoot.trim() : '';
  const practiceRoot = rootRaw === '/' ? '/' : rootRaw.replace(/\/+$/u, '');

  const options = {
    practiceRoot,
    englishVoice: pickString(source.englishVoice, DEFAULT_OPTIONS.englishVoice),
    chineseVoice: pickString(source.chineseVoice, DEFAULT_OPTIONS.chineseVoice),
    rate: pickInteger(source.rate, DEFAULT_OPTIONS.rate, 80, 320),
    language: pickString(source.language, DEFAULT_OPTIONS.language),
    silenceMs: pickInteger(source.silenceMs, DEFAULT_OPTIONS.silenceMs, 250, 2000),
    minSpeechMs: pickInteger(source.minSpeechMs, DEFAULT_OPTIONS.minSpeechMs, 80, 2000),
    maxUtteranceSec: pickInteger(source.maxUtteranceSec, DEFAULT_OPTIONS.maxUtteranceSec, 5, 180),
    bargeIn: pickBoolean(source.bargeIn, DEFAULT_OPTIONS.bargeIn),
    logFile: pickString(source.logFile, DEFAULT_OPTIONS.logFile),
    selfTest: pickBoolean(source.selfTest, DEFAULT_OPTIONS.selfTest),
  };

  for (const key of Object.keys(INTEGER_RANGES)) {
    const fallback = INTERNAL_DEFAULTS[key];
    const range = INTEGER_RANGES[key];
    const raw = extra[key] !== undefined ? extra[key] : source[key];
    options[key] = pickInteger(raw, fallback, range[0], range[1]);
  }
  options.languageThreshold = pickFloat(
    extra.languageThreshold !== undefined ? extra.languageThreshold : source.languageThreshold,
    INTERNAL_DEFAULTS.languageThreshold,
    0,
    1,
  );

  return Object.freeze(options);
}

/**
 * True when a session cwd is allowed to run voice mode for a configured root.
 * An empty root disables the restriction. Comparison is path-boundary aware so
 * "/a/bc" does not match root "/a/b".
 * @param {string} cwd absolute session cwd.
 * @param {string} root configured practice root.
 * @returns {boolean}
 */
export function isWithinRoot(cwd, root) {
  const rootText = typeof root === 'string' ? root.trim() : '';
  if (rootText === '') return true;
  if (typeof cwd !== 'string' || cwd.trim() === '') return false;

  const normalize = (value) => {
    let text = value.trim().replace(/\/+/gu, '/');
    if (text.length > 1) text = text.replace(/\/+$/u, '');
    return text;
  };
  const target = normalize(cwd);
  const base = normalize(rootText);
  if (base === '/') return target.startsWith('/');
  return target === base || target.startsWith(base + '/');
}

/**
 * Resolve the configured log file against the practice root (or process cwd
 * when no root is configured). Absolute logFile values pass through.
 * @param {string} baseDir practice root; may be empty.
 * @param {string} logFile Config.logFile value.
 * @returns {string} absolute log path.
 */
export function resolveLogPath(baseDir, logFile) {
  const file = pickString(logFile, DEFAULT_OPTIONS.logFile);
  if (isAbsolute(file)) return file;
  const base = pickString(baseDir, '');
  return resolve(base === '' ? process.cwd() : base, file);
}
