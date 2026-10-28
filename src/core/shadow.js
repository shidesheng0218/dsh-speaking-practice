/**
 * core/shadow.js - word-level diff, scoring and feedback for the v0.4
 * shadowing (跟读) mode.
 *
 * Pure module: no DSH imports, no I/O, no timers. The client shows the target
 * sentence, the learner's transcript, per-word highlighting and a 0-100 score;
 * the voice host can read feedbackLine() aloud or render it next to the score.
 *
 * Normalization decisions (shared by diffWords / feedbackLine):
 * - Unicode NFKC (full-width -> ASCII), lowercase, curly quotes -> straight
 *   apostrophes, then drop punctuation. Hyphens, dashes and slashes split
 *   words, so "thirty-three" == "thirty three".
 * - Word-internal apostrophes are kept ("i've" stays one token) but LCS
 *   equality ignores them, so a transcript that drops the apostrophe ("ive")
 *   still matches. Contractions are NOT expanded: "I'm" is one token and
 *   "I am" is two, per the v0.4 spec.
 * - Hesitation fillers (um, uh, erm, ...) are dropped from both sides before
 *   comparison. Content words that can be fillers in speech ("like", "so",
 *   "well") are kept because a drill sentence may really use them.
 *
 * Scoring: score = round(100 * matched / targetWords.length), i.e. target-word
 * coverage from the LCS alignment. Extra transcript words are reported as
 * tokens (for highlighting/feedback) but do not lower the score; an empty
 * target scores 0.
 *
 * tokens is one aligned stream in reading order: 'match' words, target words
 * the learner missed ('missing'), and transcript words with no target
 * counterpart ('extra').
 */
const WORD_CAP = 500;

// Conservative hesitation-only filler pattern (um, umm, uh, uhh, hm, hmm,
// erm, er, eh, ah, mmm). Never matches real content words: "like", "so",
// "well", "her", "am", "me" and friends are kept.
const HESITATION_PATTERN = /^(?:u+m+|u+h+|h+m+|h+u+h+|m+|e+r+m?|e+h+|a+h+)$/u;

/**
 * Normalize one sentence into comparable words.
 * @param {string} text target sentence or transcript.
 * @returns {string[]} lowercased words without punctuation/fillers.
 */
export function normalizeWords(text) {
  if (typeof text !== 'string' || text === '') return [];
  let value = text;
  try {
    value = value.normalize('NFKC');
  } catch (_normalizeError) {
    // Keep the raw text when the runtime rejects NFKC.
  }
  value = value
    .toLowerCase()
    .replace(/[’‘´]/gu, "'")
    .replace(/["“”„«»]/gu, ' ')
    .replace(/[-\u2010-\u2015\u2212/\\]/gu, ' ');
  const words = [];
  for (const raw of value.split(/[^\p{L}\p{N}']+/u)) {
    const token = raw.replace(/^'+|'+$/gu, '');
    if (token === '' || HESITATION_PATTERN.test(token)) continue;
    words.push(token);
  }
  return words;
}

/** LCS comparison key: apostrophes never decide a match ("ive" == "i've"). */
function comparisonKey(word) {
  return word.replace(/'/gu, '');
}

/**
 * Longest-common-subsequence index pairs of two key arrays.
 * @returns {Array<[number, number]>} ascending (leftIndex, rightIndex) pairs.
 */
function lcsPairs(left, right) {
  const rows = left.length;
  const cols = right.length;
  if (rows === 0 || cols === 0) return [];
  const width = cols + 1;
  const dp = new Uint32Array((rows + 1) * width);
  for (let i = 1; i <= rows; i += 1) {
    const rowBase = i * width;
    const previousBase = rowBase - width;
    for (let j = 1; j <= cols; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        dp[rowBase + j] = dp[previousBase + j - 1] + 1;
      } else {
        const dropLeft = dp[previousBase + j];
        const dropRight = dp[rowBase + j - 1];
        dp[rowBase + j] = dropLeft >= dropRight ? dropLeft : dropRight;
      }
    }
  }
  const pairs = [];
  let i = rows;
  let j = cols;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * width + j] >= dp[i * width + j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();
  return pairs;
}

/**
 * Align a target sentence with what the learner said.
 * @param {string} target target sentence (from drills.json).
 * @param {string} said speech-to-text transcript of the learner.
 * @returns {{score: number, tokens: Array<{word: string, status: string}>,
 *   targetWords: string[], saidWords: string[], matched: number, total: number}}
 */
export function diffWords(target, said) {
  const targetWords = normalizeWords(target);
  const saidWords = normalizeWords(said);
  // Pathological inputs are capped so the LCS matrix stays small; drill
  // sentences and transcripts are far below this limit.
  const targetSide = targetWords.slice(0, WORD_CAP);
  const saidSide = saidWords.slice(0, WORD_CAP);
  const pairs = lcsPairs(targetSide.map(comparisonKey), saidSide.map(comparisonKey));

  const tokens = [];
  let targetIndex = 0;
  let saidIndex = 0;
  for (const pair of pairs) {
    const targetAt = pair[0];
    const saidAt = pair[1];
    while (targetIndex < targetAt) {
      tokens.push({ word: targetSide[targetIndex], status: 'missing' });
      targetIndex += 1;
    }
    while (saidIndex < saidAt) {
      tokens.push({ word: saidSide[saidIndex], status: 'extra' });
      saidIndex += 1;
    }
    tokens.push({ word: targetSide[targetAt], status: 'match' });
    targetIndex = targetAt + 1;
    saidIndex = saidAt + 1;
  }
  while (targetIndex < targetSide.length) {
    tokens.push({ word: targetSide[targetIndex], status: 'missing' });
    targetIndex += 1;
  }
  while (saidIndex < saidSide.length) {
    tokens.push({ word: saidSide[saidIndex], status: 'extra' });
    saidIndex += 1;
  }

  const matched = pairs.length;
  const total = targetSide.length;
  const score = total === 0 ? 0 : Math.min(100, Math.max(0, Math.round((matched / total) * 100)));
  return { score, tokens, targetWords, saidWords, matched, total };
}

/**
 * Build one short English feedback sentence for a diff result. Fits both the
 * client card and a single text-to-speech utterance.
 * @param {object} result output of diffWords().
 * @returns {string}
 */
export function feedbackLine(result) {
  const source = result !== null && typeof result === 'object' ? result : {};
  const tokens = Array.isArray(source.tokens) ? source.tokens : [];
  const targetWords = Array.isArray(source.targetWords) ? source.targetWords : [];
  const total = Number.isFinite(source.total) ? source.total : targetWords.length;
  const matched = Number.isFinite(source.matched) ? source.matched : 0;
  if (total <= 0) return 'There was no target sentence to compare. Try again.';

  let firstMissing = '';
  let extras = 0;
  for (const token of tokens) {
    if (token === null || typeof token !== 'object') continue;
    if (token.status === 'missing') {
      if (firstMissing === '' && typeof token.word === 'string' && token.word !== '') firstMissing = token.word;
    } else if (token.status === 'extra') {
      extras += 1;
    }
  }

  const unit = total === 1 ? 'word' : 'words';
  if (matched >= total) {
    return extras > 0
      ? 'All ' + total + ' ' + unit + ' matched. Skip the extra ' + (extras === 1 ? 'word' : 'words') + ' next time.'
      : 'Perfect! All ' + total + ' ' + unit + ' matched.';
  }
  const retry = firstMissing === '' ? '' : " Try '" + firstMissing + "' again.";
  const ratio = matched / total;
  if (ratio >= 0.7) return 'Good. ' + matched + ' of ' + total + ' ' + unit + ' matched.' + retry;
  if (ratio >= 0.4) return 'Almost. ' + matched + ' of ' + total + ' ' + unit + ' matched.' + retry;
  if (matched > 0) return 'Keep going. ' + matched + ' of ' + total + ' ' + unit + ' matched.' + retry;
  return "Let's try again. Listen once, then repeat the whole sentence.";
}

/** Draw one random [0, 1) number, tolerating a broken injected generator. */
function nextRandom(random) {
  const draw = typeof random === 'function' ? random : Math.random;
  try {
    const value = draw();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.min(Math.max(value, 0), 0.999999999);
    }
  } catch (_randomError) {
    // Fall through to Math.random().
  }
  return Math.random();
}

/**
 * Pick `count` distinct drill sentences at random (partial Fisher-Yates).
 * @param {object|Array} drills drills.json object ({sentences: [...]}) or a
 *   bare sentence array.
 * @param {number} count how many drills to return; clamped to the pool size.
 * @param {() => number} [random] injectable RNG in [0, 1) for tests.
 * @returns {Array} new array of the picked drill entries (source is not mutated).
 */
export function pickDrills(drills, count, random = Math.random) {
  const container = drills !== null && typeof drills === 'object' ? drills : {};
  const source = Array.isArray(drills)
    ? drills
    : Array.isArray(container.sentences) ? container.sentences : [];
  const pool = [];
  const seenObjects = new Set();
  const seenIds = new Set();
  const seenTexts = new Set();
  for (const item of source) {
    if (item !== null && typeof item === 'object') {
      if (seenObjects.has(item)) continue;
      seenObjects.add(item);
      if (typeof item.id === 'string' && item.id !== '') {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
      }
      pool.push(item);
      continue;
    }
    if (typeof item === 'string') {
      const text = item.trim();
      if (text === '' || seenTexts.has(text)) continue;
      seenTexts.add(text);
      pool.push(item);
    }
  }

  const requested = Number(count);
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.min(pool.length, Math.floor(requested)))
    : pool.length;
  for (let index = 0; index < limit; index += 1) {
    const span = pool.length - index;
    const offset = Math.floor(nextRandom(random) * span);
    const swapAt = Math.min(pool.length - 1, index + Math.max(0, offset));
    if (swapAt !== index) {
      const swap = pool[index];
      pool[index] = pool[swapAt];
      pool[swapAt] = swap;
    }
  }
  return pool.slice(0, limit);
}
