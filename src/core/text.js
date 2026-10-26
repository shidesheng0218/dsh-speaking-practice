/**
 * core/text.js - assistant text cleanup, sentence splitting, language segmentation
 * and spoken-command matching for the voice loop.
 *
 * Pure module: no @deepseek-ai imports, fully unit-testable.
 */

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const CJK_TEST = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const LATIN_PATTERN = /[A-Za-z]/g;
const FENCED_CODE = /(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g;
const INLINE_CODE = /`[^`]*`/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g;
const FOOTNOTE = /\[\^\d+\]/g;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const TABLE_ROW = /^\s*\|/u;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/u;
const HEADING = /^\s{0,3}#{1,6}\s+/u;
const BLOCKQUOTE = /^\s{0,3}>\s?/u;
const LIST_MARKER = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/u;
const TASK_BOX = /^\s*\[[ xX]\]\s*/u;

const ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': ' — ',
  '&ndash;': ' – ',
  '&hellip;': '…',
});

const OFF_COMMANDS = new Set([
  'stop listening',
  'stop',
  'voice off',
  'turn off voice',
  'exit voice',
  'stop voice mode',
]);
const REPEAT_COMMANDS = new Set([
  'repeat that',
  'say that again',
  'repeat',
  'say again',
  'repeat please',
  'could you repeat that',
]);

function decodeEntities(text) {
  return text.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity] ?? entity);
}

/** Count CJK ideographs in a string. */
export function countCjk(text) {
  const matches = String(text ?? '').match(CJK_PATTERN);
  return matches === null ? 0 : matches.length;
}

/**
 * CJK ratio over letters (CJK + Latin). Punctuation, digits and spaces do not
 * dilute the ratio, which classifies short mixed strings more reliably.
 * @param {string} text
 * @returns {number} 0..1
 */
export function cjkRatio(text) {
  const value = String(text ?? '');
  const cjk = countCjk(value);
  const latinMatches = value.match(LATIN_PATTERN);
  const latin = latinMatches === null ? 0 : latinMatches.length;
  const total = cjk + latin;
  return total === 0 ? 0 : cjk / total;
}

/**
 * Classify one sentence as 'zh' or 'en'.
 * @param {string} text
 * @param {number} [threshold] CJK ratio above which the text is Chinese.
 * @returns {'zh'|'en'}
 */
export function classifyLanguage(text, threshold = 0.3) {
  return cjkRatio(text) > threshold ? 'zh' : 'en';
}

/** Remove one markdown line's block syntax and inline markup. */
function cleanLine(line) {
  let value = String(line).replace(/\r/gu, '').trimEnd();
  if (value.trim() === '') return '';
  if (THEMATIC_BREAK.test(value)) return '';
  if (TABLE_ROW.test(value) || TABLE_SEPARATOR.test(value)) return '';
  value = value.replace(HEADING, '');
  value = value.replace(BLOCKQUOTE, '');
  value = value.replace(LIST_MARKER, '');
  value = value.replace(TASK_BOX, '');
  value = value.replace(FOOTNOTE, '');
  value = value.replace(/\*\*([^*]+)\*\*/gu, '$1');
  value = value.replace(/__([^_]+)__/gu, '$1');
  value = value.replace(/~~([^~]+)~~/gu, '$1');
  value = value.replace(/\*([^*\n]+)\*/gu, '$1');
  value = value.replace(/_([^_\n]+)_/gu, '$1');
  value = value.replace(/[ \t]+/gu, ' ').trim();
  return value;
}

/**
 * Strip markdown / HTML / code noise from assistant text while keeping the
 * spoken content and punctuation.
 * @param {string} text
 * @returns {string} cleaned multi-line text (lines joined with newline).
 */
export function cleanForSpeech(text) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  let value = text.replace(/\r\n?/gu, '\n');
  value = value.replace(FENCED_CODE, ' ');
  value = value.replace(INLINE_CODE, ' ');
  value = value.replace(IMAGE, ' ');
  value = value.replace(LINK, '$1');
  value = value.replace(BARE_URL, ' ');
  value = value.replace(HTML_TAG, ' ');
  value = value.replace(/[|]+/gu, ' ');
  value = decodeEntities(value);
  const lines = value.split('\n').map(cleanLine).filter((line) => line !== '');
  return lines.join('\n').replace(/\u200b|\u200c|\u200d|\ufeff/gu, '').trim();
}

function isCjkChar(char) {
  return typeof char === 'string' && char !== '' && CJK_TEST.test(char);
}

function joinSentences(left, right) {
  if (left === '') return right;
  if (right === '') return left;
  const last = left[left.length - 1];
  const first = right[0];
  return isCjkChar(last) || isCjkChar(first) ? left + right : left + ' ' + right;
}

function hardSplit(text, maxChars) {
  const chars = Array.from(text);
  const pieces = [];
  for (let index = 0; index < chars.length; index += maxChars) {
    const piece = chars.slice(index, index + maxChars).join('').trim();
    if (piece !== '') pieces.push(piece);
  }
  return pieces;
}

/**
 * Split text on sentence punctuation / newlines and merge short sentences up to
 * maxChars. Long sentences are hard-split at code-point boundaries.
 * @param {string} text
 * @param {{maxChars?: number}} [options]
 * @returns {string[]}
 */
export function splitSentences(text, options = {}) {
  const maxChars = Math.max(20, options.maxChars ?? 220);
  if (typeof text !== 'string' || text.trim() === '') return [];
  const pieces = text
    .split(/(?<=[.!?…。！？])\s*|\n+/u)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '');
  const merged = [];
  let current = '';
  const flush = () => {
    if (current !== '') {
      merged.push(current);
      current = '';
    }
  };
  for (const piece of pieces) {
    const parts = piece.length > maxChars ? hardSplit(piece, maxChars) : [piece];
    for (const part of parts) {
      if (current === '') {
        current = part;
      } else if (current.length + 1 + part.length <= maxChars) {
        current = joinSentences(current, part);
      } else {
        flush();
        current = part;
      }
    }
  }
  flush();
  return merged;
}

/**
 * Group consecutive sentences by language.
 * @param {string|string[]} input sentence array (or raw text).
 * @param {{threshold?: number}} [options]
 * @returns {{lang:'zh'|'en', text:string}[]}
 */
export function segmentByLanguage(input, options = {}) {
  const threshold = options.threshold ?? 0.3;
  const sentences = Array.isArray(input) ? input : splitSentences(String(input ?? ''));
  const segments = [];
  for (const sentence of sentences) {
    const text = String(sentence ?? '').trim();
    if (text === '') continue;
    const lang = classifyLanguage(text, threshold);
    const last = segments[segments.length - 1];
    if (last !== undefined && last.lang === lang) {
      last.text = last.lang === 'zh' ? last.text + text : last.text + ' ' + text;
    } else {
      segments.push({ lang, text });
    }
  }
  return segments;
}

/**
 * Full pipeline for assistant text: clean, truncate, split and segment.
 * @param {string} text assistant reply text.
 * @param {{maxChars?: number, maxSentenceChars?: number, threshold?: number}} [options]
 * @returns {{cleaned:string, truncated:boolean, sentences:string[], segments:{lang:'zh'|'en', text:string}[]}}
 */
export function prepareSpeechText(text, options = {}) {
  const maxChars = Math.max(100, options.maxChars ?? 1200);
  const maxSentenceChars = Math.max(40, options.maxSentenceChars ?? 220);
  const threshold = options.threshold ?? 0.3;
  let cleaned = cleanForSpeech(text);
  let truncated = false;
  if (cleaned.length > maxChars) {
    let cut = cleaned.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
    cleaned = cut.replace(/[\s,;:，；：、-]+$/u, '') + '…';
    truncated = true;
  }
  const sentences = splitSentences(cleaned, { maxChars: maxSentenceChars });
  const segments = segmentByLanguage(sentences, { threshold });
  return { cleaned, truncated, sentences, segments };
}

/** Join assistant message text blocks from a session message object. */
export function extractMessageText(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Normalize loosely-spoken text for exact command matching. */
export function normalizeSpokenText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’…—–()\[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Match one of the spoken control commands.
 * @param {string} text transcript text.
 * @returns {{kind:'off'|'repeat', normalized:string}|null}
 */
export function matchVoiceCommand(text) {
  const normalized = normalizeSpokenText(text);
  if (normalized === '') return null;
  if (OFF_COMMANDS.has(normalized)) return { kind: 'off', normalized };
  if (REPEAT_COMMANDS.has(normalized)) return { kind: 'repeat', normalized };
  return null;
}

/** One-line summary for logs (never dumps a whole reply into the log line). */
export function summarizeText(text, maxChars = 120) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, Math.max(0, maxChars - 1)) + '…';
}
