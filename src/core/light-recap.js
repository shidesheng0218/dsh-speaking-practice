/**
 * core/light-recap.js - deterministic "light" practice recap for the voice loop.
 *
 * When voice mode stops without the model having written a recap, this module
 * renders the facts collected by core/stats.js plus fixed coaching rules, and
 * writes practice/YYYY-MM-DD-HHmm-<scenario>-auto.md.
 *
 * Pure logic + fs only: no DSH imports. File-system failures are logged and
 * never thrown; the caller simply loses the fallback recap.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AUTO_SUFFIX = '-auto.md';
const MAX_EXCERPTS = 40;
const MAX_EXCERPT_CHARS = 160;
const FALLBACK_SCENARIO_ID = 'session';

// Deterministic advice thresholds (spec §2.2): a turn averaging fewer words is
// "too short"; this many errors suggests the microphone or the room, not the
// learner's English.
const SHORT_UTTERANCE_WORDS = 8;
const ERROR_ADVICE_THRESHOLD = 3;

const FILLER_ORDER = Object.freeze(['um', 'uh', 'like', 'you know', 'actually', 'basically', 'so', 'well']);

const NOOP_LOG = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickLog(log) {
  return log !== null && typeof log === 'object' ? log : NOOP_LOG;
}

/** Log through a defensive wrapper: a broken logger must not break the recap. */
function notify(log, level, message) {
  const logger = pickLog(log);
  const write = logger[level];
  if (typeof write !== 'function') return;
  try {
    write.call(logger, message);
  } catch (_error) {
    // Ignore logger failures.
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch (_error) {
    return 'unknown error';
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  return new Date();
}

/** Local calendar date, YYYY-MM-DD (matches the recap file naming). */
function formatLocalDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function formatLocalClock(date) {
  return formatLocalDate(date) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/** Local file stamp, YYYY-MM-DD-HHmm. */
function formatFileStamp(date) {
  return formatLocalDate(date) + '-' + pad2(date.getHours()) + pad2(date.getMinutes());
}

/** Human duration in Chinese; sub-minute values stay in seconds. */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return seconds + ' 秒';
  return minutes + ' 分 ' + seconds + ' 秒';
}

/** Keep user/scenario ids safe for a file name. */
function sanitizeFilePart(value) {
  const text = pickText(value).toLowerCase();
  const cleaned = text.replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+/u, '').replace(/-+$/u, '');
  return cleaned.slice(0, 40);
}

function numberField(source, key) {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Accept either a snapshot object or a createSessionStats() handle. */
function toSnapshot(stats) {
  if (stats === null || typeof stats !== 'object') return {};
  if (typeof stats.snapshot === 'function') {
    try {
      const snapshot = stats.snapshot();
      return snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
    } catch (_error) {
      return {};
    }
  }
  return stats;
}

function truncateText(text, maxChars) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…';
}

/** Bounded learner quotes for the recap (stats.js already caps; re-check here). */
function excerptTexts(snapshot) {
  const list = Array.isArray(snapshot.userTexts) ? snapshot.userTexts : [];
  const texts = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text === '') continue;
    texts.push(truncateText(text, MAX_EXCERPT_CHARS));
    if (texts.length >= MAX_EXCERPTS) break;
  }
  return texts;
}

function normalizeScenario(scenario) {
  if (typeof scenario === 'string') {
    return { id: scenario.trim(), name: '', nameZh: '', level: '' };
  }
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return { id: '', name: '', nameZh: '', level: '' };
  }
  return {
    id: pickText(scenario.id),
    name: pickText(scenario.name),
    nameZh: pickText(scenario.nameZh),
    level: pickText(scenario.level),
  };
}

function scenarioLabel(scenario) {
  if (scenario.id === '') return scenario.nameZh || scenario.name || '自由对话';
  if (scenario.nameZh !== '') return scenario.id + '（' + scenario.nameZh + '）';
  if (scenario.name !== '') return scenario.id + '（' + scenario.name + '）';
  return scenario.id;
}

function fillerRows(snapshot) {
  const counts = snapshot.fillerCounts !== null && typeof snapshot.fillerCounts === 'object'
    ? snapshot.fillerCounts
    : {};
  const rows = [];
  for (const word of FILLER_ORDER) {
    const count = numberField(counts, word);
    if (count > 0) rows.push({ word, count });
  }
  return rows;
}

function topFiller(rows) {
  let best = null;
  for (const row of rows) {
    if (best === null || row.count > best.count) best = row;
  }
  return best;
}

function formatErrorKinds(errorKinds) {
  const kinds = errorKinds !== null && typeof errorKinds === 'object' ? errorKinds : {};
  const parts = [];
  for (const key of Object.keys(kinds).sort()) {
    const count = numberField(kinds, key);
    if (count > 0) parts.push(key + ' ' + count);
  }
  return parts.join('，');
}

/**
 * Deterministic next-session advice (fixed order, no randomness):
 *   1. most frequent filler word -> pause instead of filling;
 *   2. average turn shorter than SHORT_UTTERANCE_WORDS -> expand the answer;
 *   3. ERROR_ADVICE_THRESHOLD or more errors -> check the microphone/room;
 *   4. otherwise one generic tip so the section is never empty.
 */
function buildSuggestions(snapshot, rows) {
  const suggestions = [];
  const top = topFiller(rows);
  if (top !== null) {
    suggestions.push('本轮最常出现的填充词是 "' + top.word + '"（' + top.count
      + ' 次）：下次卡住时先停半秒，用短暂的停顿代替 ' + top.word + '。');
  }
  const turns = numberField(snapshot, 'userUtterances');
  const average = numberField(snapshot, 'avgWordsPerUtterance');
  if (turns > 0 && average < SHORT_UTTERANCE_WORDS) {
    suggestions.push('每轮平均只有 ' + average + ' 个词，回答偏短：下次先给一句结论，'
      + '再用 "because ..." 或 "for example ..." 把回答扩展成两三句。');
  }
  const errors = numberField(snapshot, 'errors');
  if (errors >= ERROR_ADVICE_THRESHOLD) {
    suggestions.push('本轮出现 ' + errors + ' 次错误，可能是麦克风或环境噪音：'
      + '下次先检查麦克风权限、靠近一点，并关掉背景音乐。');
  }
  if (suggestions.length === 0) {
    suggestions.push(turns === 0
      ? '本轮没有记录到发音：下次开麦后先说一句 "Hi, can we start?" 确认转写正常。'
      : '本轮没有明显问题：保持现在的节奏，下次试着每轮多问教练一句 "How about you?"。');
  }
  return suggestions;
}

/**
 * Render the light recap Markdown.
 * @param {object} [options]
 * @param {object} [options.stats] stats snapshot or createSessionStats() handle.
 * @param {object|string} [options.scenario] scenario card or scenario id.
 * @param {string} [options.level]
 * @param {string} [options.note] optional extra note shown at the end.
 * @returns {string} Chinese Markdown, newline-terminated.
 */
export function renderLightRecap(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const snapshot = toSnapshot(source.stats);
  const scenario = normalizeScenario(source.scenario);
  const level = pickText(source.level) || scenario.level || '未标注';
  const note = pickText(source.note);
  const startedAtValue = snapshot.startedAt;
  const startedAt = typeof startedAtValue === 'number' && Number.isFinite(startedAtValue)
    ? startedAtValue
    : Date.now();

  const turns = numberField(snapshot, 'userUtterances');
  const words = numberField(snapshot, 'userWords');
  const average = numberField(snapshot, 'avgWordsPerUtterance');
  const longest = numberField(snapshot, 'longestWords');
  const assistantMessages = numberField(snapshot, 'assistantMessages');
  const assistantWords = numberField(snapshot, 'assistantWords');
  const speechMs = numberField(snapshot, 'speechMs');
  const durationMs = numberField(snapshot, 'durationMs');
  const errors = numberField(snapshot, 'errors');
  const rows = fillerRows(snapshot);
  const derivedFillerTotal = rows.reduce((sum, row) => sum + row.count, 0);
  const recordedFillerTotal = numberField(snapshot, 'fillerTotal');
  const fillerTotal = recordedFillerTotal > 0 ? recordedFillerTotal : derivedFillerTotal;
  const fillerPer100 = numberField(snapshot, 'fillerPer100Words');
  const errorKinds = formatErrorKinds(snapshot.errorKinds);

  const lines = [];
  lines.push('# 口语练习记录 — ' + formatLocalClock(toDate(startedAt)) + ' — ' + scenarioLabel(scenario));
  lines.push('');
  lines.push('## 本次概览');
  lines.push('- 场景：' + scenarioLabel(scenario));
  lines.push('- 等级：' + level);
  lines.push('- 时长：' + formatDuration(durationMs));
  lines.push('- 你的发言：' + turns + ' 轮 / ' + words + ' 词（平均每轮 ' + average
    + ' 词，最长 ' + longest + ' 词）');
  lines.push('- 教练回复：' + assistantMessages + ' 条 / ' + assistantWords + ' 词');
  lines.push('- 语音时长：' + formatDuration(speechMs));
  lines.push('- 填充词：共 ' + fillerTotal + ' 次'
    + (words > 0 ? '（每 100 词 ' + fillerPer100 + ' 次）' : ''));
  lines.push('- 错误：' + errors + ' 次' + (errorKinds === '' ? '' : '（' + errorKinds + '）'));
  lines.push('');

  lines.push('## 你的发言摘录');
  const excerpts = excerptTexts(snapshot);
  if (excerpts.length === 0) {
    lines.push('本次没有记录到学员发言。');
  } else {
    const blocks = excerpts.map((text) => '> ' + text.split(/\r?\n/u).map((line) => line.trimEnd()).join('\n> '));
    lines.push(blocks.join('\n\n'));
    if (turns > excerpts.length) {
      lines.push('');
      lines.push('（本次共 ' + turns + ' 轮，以上只列出前 ' + excerpts.length + ' 条。）');
    }
  }
  lines.push('');

  lines.push('## 填充词统计');
  if (rows.length === 0) {
    lines.push('本次没有检测到常见填充词，表达很干净。');
  } else {
    for (const row of rows) lines.push('- ' + row.word + '：' + row.count + ' 次');
  }
  lines.push('');

  lines.push('## 下次建议');
  const suggestions = buildSuggestions(snapshot, rows);
  suggestions.forEach((suggestion, index) => {
    lines.push((index + 1) + '. ' + suggestion);
  });
  lines.push('');

  if (note !== '') {
    lines.push('## 备注');
    lines.push(note);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('这是语音模式结束时自动生成的轻量记录，只包含会话事实和简单建议。');
  lines.push('想得到逐句纠错和完整的练习复盘，下次结束时说 “end session”，教练会写完整复盘。');
  return lines.join('\n') + '\n';
}

/**
 * Find a model-written recap for this scenario inside practiceDir.
 *
 * The coach prompt asks the model to write YYYY-MM-DD-HHmm-<scenarioId>.md;
 * light recaps (*-auto.md) never count. A file whose mtime is at/after sinceMs
 * belongs to the current session.
 * @param {object} [options]
 * @param {string} [options.practiceDir]
 * @param {string} [options.scenarioId]
 * @param {number} [options.sinceMs] session start in epoch ms; defaults to 0.
 * @returns {Promise<string|null>} recap path, or null when none matches.
 */
export async function findModelRecap(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const practiceDir = pickText(source.practiceDir);
  const scenarioId = pickText(source.scenarioId).toLowerCase();
  const sinceMs = typeof source.sinceMs === 'number' && Number.isFinite(source.sinceMs) ? source.sinceMs : 0;
  if (practiceDir === '' || scenarioId === '') return null;
  const suffix = '-' + scenarioId + '.md';
  let entries;
  try {
    entries = await readdir(practiceDir, { withFileTypes: true });
  } catch (_error) {
    // A missing/unreadable directory just means "no model recap yet".
    return null;
  }
  const names = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.isFile === 'function' && !entry.isFile()) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (name !== '') names.push(name);
  }
  names.sort(); // deterministic tie-break when two files share an mtime.
  let best = null;
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(suffix)) continue;
    if (lower.endsWith(AUTO_SUFFIX)) continue;
    const candidate = join(practiceDir, name);
    let info;
    try {
      info = await stat(candidate);
    } catch (_error) {
      continue;
    }
    if (!info.isFile() || info.mtimeMs < sinceMs) continue;
    if (best === null || info.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: info.mtimeMs };
  }
  return best === null ? null : best.path;
}

/**
 * Write the light recap into the practice directory.
 *
 * Skipped when a model-written recap for the same scenario already exists for
 * this session. Never rejects: failures are logged and reported in the result.
 * @param {object} [options]
 * @param {string} [options.practiceDir]
 * @param {object} [options.stats] snapshot or createSessionStats() handle.
 * @param {object|string} [options.scenario]
 * @param {string} [options.level]
 * @param {object} [options.log]
 * @param {string} [options.note]
 * @param {Date|number} [options.now] filename timestamp; defaults to new Date().
 * @returns {Promise<{path: string, skipped: boolean, reason: string}>}
 */
export async function writeLightRecap(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const practiceDir = pickText(source.practiceDir);
  const log = source.log;
  const snapshot = toSnapshot(source.stats);
  const scenario = normalizeScenario(source.scenario);
  const now = toDate(source.now);
  if (practiceDir === '') {
    notify(log, 'warn', 'light recap skipped: practice directory is unknown');
    return { path: '', skipped: true, reason: 'no-practice-dir' };
  }

  const scenarioId = sanitizeFilePart(scenario.id) || FALLBACK_SCENARIO_ID;
  const startedAtValue = snapshot.startedAt;
  const sinceMs = typeof startedAtValue === 'number' && Number.isFinite(startedAtValue) ? startedAtValue : 0;
  let modelRecap = null;
  try {
    modelRecap = await findModelRecap({ practiceDir, scenarioId: scenario.id, sinceMs });
  } catch (_error) {
    // findModelRecap is defensive, but a surprise here must not block the write.
    modelRecap = null;
  }
  if (modelRecap !== null) {
    notify(log, 'info', 'light recap skipped: model recap already exists: ' + modelRecap);
    return { path: '', skipped: true, reason: 'model-recap-exists' };
  }

  const filePath = join(practiceDir, formatFileStamp(now) + '-' + scenarioId + AUTO_SUFFIX);
  try {
    const markdown = renderLightRecap({ stats: snapshot, scenario, level: source.level, note: source.note });
    await mkdir(practiceDir, { recursive: true });
    await writeFile(filePath, markdown, 'utf8');
  } catch (error) {
    notify(log, 'warn', 'cannot write light recap ' + filePath + ': ' + errorMessage(error));
    return { path: '', skipped: true, reason: 'write-failed' };
  }
  notify(log, 'info', 'light recap written: ' + filePath);
  return { path: filePath, skipped: false, reason: '' };
}
