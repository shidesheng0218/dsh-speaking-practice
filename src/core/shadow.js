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
 * - Word-internal apostrophes are kept ("i've" stays one token) and LCS
 *   equality ignores them, so a transcript that drops the apostrophe ("ive")
 *   still matches. Common English contractions and spoken reductions are also
 *   matched equivalently across 1-to-2 token boundaries ("I'm" == "I am",
 *   "I've" == "I have", "can't" == "cannot" / "can not", "wanna" == "want to").
 * - Words that are near-homophones / minimal-pair neighbours (e.g. "ship" vs
 *   "sheep", "think" vs "sink", or high character similarity) receive partial
 *   credit ('close', 0.5 weight) and targeted pronunciation hints instead of a
 *   total miss.
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

const CONTRACTION_MAP = new Map([
  ['im', [['i', 'am']]],
  ['ive', [['i', 'have']]],
  ['ill', [['i', 'will']]],
  ['id', [['i', 'would'], ['i', 'had']]],
  ['youre', [['you', 'are']]],
  ['youve', [['you', 'have']]],
  ['youll', [['you', 'will']]],
  ['youd', [['you', 'would'], ['you', 'had']]],
  ['hes', [['he', 'is'], ['he', 'has']]],
  ['shes', [['she', 'is'], ['she', 'has']]],
  ['its', [['it', 'is'], ['it', 'has']]],
  ['were', [['we', 'are']]],
  ['weve', [['we', 'have']]],
  ['well', [['we', 'will']]],
  ['wed', [['we', 'would'], ['we', 'had']]],
  ['theyre', [['they', 'are']]],
  ['theyve', [['they', 'have']]],
  ['theyll', [['they', 'will']]],
  ['theyd', [['they', 'would'], ['they', 'had']]],
  ['thats', [['that', 'is'], ['that', 'has']]],
  ['theres', [['there', 'is'], ['there', 'has']]],
  ['heres', [['here', 'is'], ['here', 'has']]],
  ['whats', [['what', 'is'], ['what', 'has']]],
  ['whos', [['who', 'is'], ['who', 'has']]],
  ['wheres', [['where', 'is'], ['where', 'has']]],
  ['hows', [['how', 'is'], ['how', 'has']]],
  ['lets', [['let', 'us']]],
  ['dont', [['do', 'not']]],
  ['doesnt', [['does', 'not']]],
  ['didnt', [['did', 'not']]],
  ['cant', [['can', 'not'], ['cannot']]],
  ['cannot', [['can', 'not'], ['cant']]],
  ['wont', [['will', 'not']]],
  ['wouldnt', [['would', 'not']]],
  ['couldnt', [['could', 'not']]],
  ['shouldnt', [['should', 'not']]],
  ['isnt', [['is', 'not']]],
  ['arent', [['are', 'not']]],
  ['wasnt', [['was', 'not']]],
  ['werent', [['were', 'not']]],
  ['havent', [['have', 'not']]],
  ['hasnt', [['has', 'not']]],
  ['hadnt', [['had', 'not']]],
  ['gonna', [['going', 'to']]],
  ['wanna', [['want', 'to']]],
  ['gotta', [['got', 'to']]],
  ['kinda', [['kind', 'of']]],
  ['sorta', [['sort', 'of']]],
  ['practising', [['practicing']]],
  ['practicing', [['practising']]],
]);

const HOMOPHONE_GROUPS = [
  ['to', 'too', 'two'],
  ['there', 'their', 'theyre'],
  ['your', 'youre'],
  ['its', 'itz'],
  ['hear', 'here'],
  ['write', 'right'],
  ['no', 'know'],
  ['knew', 'new'],
  ['sea', 'see'],
  ['week', 'weak'],
  ['meet', 'meat'],
  ['buy', 'by', 'bye'],
  ['one', 'won'],
  ['four', 'for'],
  ['eight', 'ate'],
  ['sun', 'son'],
  ['wear', 'where'],
  ['weather', 'whether'],
  ['peace', 'piece'],
  ['break', 'brake'],
];

const HOMOPHONE_LOOKUP = (() => {
  const map = new Map();
  for (const group of HOMOPHONE_GROUPS) {
    for (const word of group) {
      map.set(word, group);
    }
  }
  return map;
})();

function areHomophones(leftKey, rightKey) {
  if (leftKey === rightKey) return true;
  const group = HOMOPHONE_LOOKUP.get(leftKey);
  return group !== undefined && group.includes(rightKey);
}

function matchesContractionExpansion(singleWord, pairFirst, pairSecond = null) {
  const key = comparisonKey(singleWord);
  const expansions = CONTRACTION_MAP.get(key);
  if (!expansions) return false;
  const firstKey = comparisonKey(pairFirst);
  const secondKey = pairSecond === null ? null : comparisonKey(pairSecond);
  for (const exp of expansions) {
    if (exp.length === 1 && secondKey === null && exp[0] === firstKey) return true;
    if (exp.length === 2 && secondKey !== null && exp[0] === firstKey && exp[1] === secondKey) return true;
  }
  return false;
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Uint16Array(n + 1);
  const curr = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.set(curr);
  }
  return prev[n];
}

function phoneticNormalize(key) {
  return key
    .replace(/^wr/u, 'r')
    .replace(/^kn/u, 'n')
    .replace(/ph/gu, 'f')
    .replace(/th/gu, 's')
    .replace(/ee/gu, 'i')
    .replace(/ea/gu, 'i')
    .replace(/oo/gu, 'u')
    .replace(/v/gu, 'w')
    .replace(/l/gu, 'r');
}

function isNearWord(targetWord, saidWord) {
  const left = comparisonKey(targetWord);
  const right = comparisonKey(saidWord);
  if (left === '' || right === '' || left === right) return false;
  if (left.length <= 2 && right.length <= 2) return false;
  const maxLen = Math.max(left.length, right.length);
  const dist = editDistance(left, right);
  if (maxLen >= 4 && dist === 1) return true;
  if (maxLen >= 6 && dist <= 2) return true;
  if (maxLen >= 3 && phoneticNormalize(left) === phoneticNormalize(right)) return true;
  return false;
}

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

/** LCS comparison key: apostrophes and exact homophones match. */
function wordsEquivalent(leftWord, rightWord) {
  const leftKey = comparisonKey(leftWord);
  const rightKey = comparisonKey(rightWord);
  if (leftKey === rightKey) return true;
  if (areHomophones(leftKey, rightKey)) return true;
  if (matchesContractionExpansion(leftWord, rightWord, null)) return true;
  if (matchesContractionExpansion(rightWord, leftWord, null)) return true;
  return false;
}

/**
 * Longest-common-subsequence index pairs of two word arrays.
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
      if (wordsEquivalent(left[i - 1], right[j - 1])) {
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
    if (wordsEquivalent(left[i - 1], right[j - 1])) {
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

function alignGap(targetSlice, saidSlice, tokens) {
  let ti = 0;
  let si = 0;
  let exactMatched = 0;
  let closeMatched = 0;

  while (ti < targetSlice.length && si < saidSlice.length) {
    const tWord = targetSlice[ti];
    const sWord = saidSlice[si];

    // 1 target contraction <-> 2 said words (e.g. target "i'm" vs said "i" + "am")
    if (si + 1 < saidSlice.length && matchesContractionExpansion(tWord, sWord, saidSlice[si + 1])) {
      tokens.push({ word: tWord, status: 'match' });
      exactMatched += 1;
      ti += 1;
      si += 2;
      continue;
    }

    // 2 target words <-> 1 said contraction (e.g. target "i" + "am" vs said "i'm")
    if (ti + 1 < targetSlice.length && matchesContractionExpansion(sWord, tWord, targetSlice[ti + 1])) {
      tokens.push({ word: tWord, status: 'match' });
      tokens.push({ word: targetSlice[ti + 1], status: 'match' });
      exactMatched += 2;
      ti += 2;
      si += 1;
      continue;
    }

    // Near-miss / minimal pair soft match (e.g. target "think" vs said "sink")
    if (isNearWord(tWord, sWord)) {
      tokens.push({ word: tWord, status: 'close', heard: sWord });
      closeMatched += 1;
      ti += 1;
      si += 1;
      continue;
    }

    tokens.push({ word: tWord, status: 'missing' });
    ti += 1;
  }

  while (ti < targetSlice.length) {
    tokens.push({ word: targetSlice[ti], status: 'missing' });
    ti += 1;
  }
  while (si < saidSlice.length) {
    tokens.push({ word: saidSlice[si], status: 'extra' });
    si += 1;
  }

  return { exactMatched, closeMatched };
}

/**
 * Align a target sentence with what the learner said.
 * @param {string} target target sentence (from drills.json).
 * @param {string} said speech-to-text transcript of the learner.
 * @returns {{score: number, tokens: Array<{word: string, status: string, heard?: string}>,
 *   targetWords: string[], saidWords: string[], matched: number, close: number, total: number}}
 */
export function diffWords(target, said) {
  const targetWords = normalizeWords(target);
  const saidWords = normalizeWords(said);
  const targetSide = targetWords.slice(0, WORD_CAP);
  const saidSide = saidWords.slice(0, WORD_CAP);
  const pairs = lcsPairs(targetSide, saidSide);

  const tokens = [];
  let targetIndex = 0;
  let saidIndex = 0;
  let exactMatched = pairs.length;
  let closeMatched = 0;

  for (const pair of pairs) {
    const targetAt = pair[0];
    const saidAt = pair[1];
    if (targetIndex < targetAt || saidIndex < saidAt) {
      const gap = alignGap(
        targetSide.slice(targetIndex, targetAt),
        saidSide.slice(saidIndex, saidAt),
        tokens,
      );
      exactMatched += gap.exactMatched;
      closeMatched += gap.closeMatched;
    }
    tokens.push({ word: targetSide[targetAt], status: 'match' });
    targetIndex = targetAt + 1;
    saidIndex = saidAt + 1;
  }

  if (targetIndex < targetSide.length || saidIndex < saidSide.length) {
    const tail = alignGap(
      targetSide.slice(targetIndex),
      saidSide.slice(saidIndex),
      tokens,
    );
    exactMatched += tail.exactMatched;
    closeMatched += tail.closeMatched;
  }

  const matched = exactMatched;
  const total = targetSide.length;
  const weighted = matched + closeMatched * 0.5;
  const score = total === 0 ? 0 : Math.min(100, Math.max(0, Math.round((weighted / total) * 100)));
  return { score, tokens, targetWords, saidWords, matched, close: closeMatched, total };
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
  let firstClose = null;
  let extras = 0;
  for (const token of tokens) {
    if (token === null || typeof token !== 'object') continue;
    if (token.status === 'close') {
      if (firstClose === null && typeof token.word === 'string' && token.word !== '') {
        firstClose = token;
      }
    } else if (token.status === 'missing') {
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
  const closeHint = firstClose !== null
    ? " Watch '" + firstClose.word + "'"
      + (typeof firstClose.heard === 'string' && firstClose.heard !== ''
        ? " (heard '" + firstClose.heard + "')."
        : '.')
    : '';
  const retry = closeHint !== ''
    ? closeHint
    : firstMissing === '' ? '' : " Try '" + firstMissing + "' again.";
  const closeCount = Number.isFinite(source.close) ? source.close : 0;
  const ratio = (matched + closeCount * 0.5) / total;
  if (ratio >= 0.7) return 'Good. ' + matched + ' of ' + total + ' ' + unit + ' matched.' + retry;
  if (ratio >= 0.4) return 'Almost. ' + matched + ' of ' + total + ' ' + unit + ' matched.' + retry;
  if (matched > 0 || closeCount > 0) return 'Keep going. ' + matched + ' of ' + total + ' ' + unit + ' matched.' + retry;
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
