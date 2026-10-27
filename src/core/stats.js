/**
 * core/stats.js - per-session speaking statistics for the voice practice loop.
 *
 * Pure module: no DSH imports, timers or file I/O. Every mutator is defensive
 * and never throws; snapshot() returns a plain defensive copy that stays valid
 * after the session ends (light-recap.js renders it to Markdown).
 */

/** Filler words counted in learner speech (word-boundary, case-insensitive). */
export const FILLER_WORDS = Object.freeze([
  'um',
  'uh',
  'like',
  'you know',
  'actually',
  'basically',
  'so',
  'well',
]);

const MAX_USER_TEXTS = 40;
const MAX_USER_TEXT_CHARS = 160;

// Elongated spellings ("ummm", "uhh") count as the same filler word.
const FILLER_PATTERNS = Object.freeze({
  um: /\bum+\b/gu,
  uh: /\buh+\b/gu,
  like: /\blike\b/gu,
  'you know': /\byou\s+know\b/gu,
  actually: /\bactually\b/gu,
  basically: /\bbasically\b/gu,
  so: /\bso\b/gu,
  well: /\bwell\b/gu,
});

const WORD_CHAR = /[\p{L}\p{N}]/u;

function pickString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function countWords(text) {
  let count = 0;
  for (const token of text.trim().split(/\s+/u)) {
    if (token !== '' && WORD_CHAR.test(token)) count += 1;
  }
  return count;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Truncate to maxChars code points; the trailing ellipsis is part of the budget. */
function truncateText(text, maxChars) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…';
}

/**
 * Create the statistics collector for one voice session.
 * @param {object} [options]
 * @param {string} [options.sessionId]
 * @param {string} [options.scenarioId]
 * @param {string} [options.level]
 * @param {number} [options.startedAt] epoch ms; defaults to now.
 * @param {() => number} [options.now] clock override for tests.
 * @returns {{onUserText: Function, onAssistantText: Function, onSpeech: Function,
 *   onError: Function, snapshot: Function}}
 */
export function createSessionStats(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const nowFn = typeof source.now === 'function' ? source.now : Date.now;
  const currentTime = () => {
    try {
      const value = nowFn();
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
    } catch (_error) {
      return Date.now();
    }
  };

  const sessionId = pickString(source.sessionId);
  const scenarioId = pickString(source.scenarioId);
  const level = pickString(source.level);
  const startedAt = typeof source.startedAt === 'number' && Number.isFinite(source.startedAt)
    ? source.startedAt
    : currentTime();

  let userUtterances = 0;
  let userWords = 0;
  let longestWords = 0;
  const userTexts = [];
  let assistantMessages = 0;
  let assistantWords = 0;
  let speechMs = 0;
  let errors = 0;
  const errorKinds = new Map();
  const fillerCounts = Object.fromEntries(FILLER_WORDS.map((word) => [word, 0]));
  let fillerTotal = 0;

  /** Record one learner utterance (transcript text). */
  function onUserText(input) {
    if (typeof input !== 'string') return false;
    const text = input.trim();
    if (text === '') return false;
    const words = countWords(text);
    // Punctuation-only noise from STT is not an utterance.
    if (words === 0) return false;
    userUtterances += 1;
    userWords += words;
    if (words > longestWords) longestWords = words;
    // The recap only needs a bounded excerpt; keep the first 40 utterances.
    if (userTexts.length < MAX_USER_TEXTS) userTexts.push(text);
    const lower = text.toLowerCase();
    for (const word of FILLER_WORDS) {
      const matches = lower.match(FILLER_PATTERNS[word]);
      const count = matches === null ? 0 : matches.length;
      if (count === 0) continue;
      fillerCounts[word] += count;
      fillerTotal += count;
    }
    return true;
  }

  /** Record one non-empty assistant reply message. */
  function onAssistantText(input) {
    if (typeof input !== 'string') return false;
    const text = input.trim();
    if (text === '') return false;
    assistantMessages += 1;
    assistantWords += countWords(text);
    return true;
  }

  /** Accumulate one captured utterance duration (milliseconds). */
  function onSpeech(durationMs) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return false;
    speechMs += durationMs;
    return true;
  }

  /** Record one error by kind (e.g. "transcribe-failed"). */
  function onError(kind) {
    if (typeof kind !== 'string') return false;
    const key = kind.trim();
    if (key === '') return false;
    errors += 1;
    errorKinds.set(key, (errorKinds.get(key) ?? 0) + 1);
    return true;
  }

  /**
   * Freeze the current facts. The returned object owns its sub-objects and
   * arrays, so the caller may keep or mutate it without affecting later
   * snapshots (and vice versa).
   */
  function snapshot() {
    const endedAt = currentTime();
    const durationMs = Math.max(0, Math.round(endedAt - startedAt));
    const avgWordsPerUtterance = userUtterances === 0 ? 0 : round1(userWords / userUtterances);
    const fillerPer100Words = userWords === 0 ? 0 : round1((fillerTotal * 100) / userWords);
    return {
      sessionId,
      scenarioId,
      level,
      startedAt,
      endedAt,
      durationMs,
      userUtterances,
      userWords,
      avgWordsPerUtterance,
      longestWords,
      assistantMessages,
      assistantWords,
      speechMs: Math.round(speechMs),
      errors,
      errorKinds: Object.fromEntries(errorKinds),
      fillerCounts: { ...fillerCounts },
      fillerTotal,
      fillerPer100Words,
      userTexts: userTexts.map((text) => truncateText(text, MAX_USER_TEXT_CHARS)),
    };
  }

  return { onUserText, onAssistantText, onSpeech, onError, snapshot };
}
