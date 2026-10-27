/**
 * stats.test.mjs - unit tests for the session statistics and light recap modules.
 *
 * Both modules are plain ESM with no DSH imports. File-system cases use one
 * throwaway directory under os.tmpdir() that is removed afterwards.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILLER_WORDS, createSessionStats } from '../src/core/stats.js';
import { findModelRecap, renderLightRecap, writeLightRecap } from '../src/core/light-recap.js';

const workRoot = await mkdtemp(join(tmpdir(), 'dsh-stats-test-'));
let dirCounter = 0;

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function tempDir(label) {
  dirCounter += 1;
  const dir = join(workRoot, label + '-' + dirCounter);
  await mkdir(dir, { recursive: true });
  return dir;
}

function statsFor(overrides = {}) {
  return createSessionStats({
    sessionId: 'session-1',
    scenarioId: 'daily-chat',
    level: 'B1',
    startedAt: 1000,
    now: () => 61000,
    ...overrides,
  });
}

function recordingLog() {
  const lines = [];
  const push = (level) => (message) => lines.push([level, String(message)]);
  return { lines, debug() {}, info: push('info'), warn: push('warn'), error: push('error') };
}

/** Same local naming convention as the module: YYYY-MM-DD-HHmm. */
function localFileStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes());
}

function renderFixture() {
  const stats = createSessionStats({
    sessionId: 'session-1',
    scenarioId: 'daily-chat',
    level: 'B1',
    startedAt: 1000,
    now: () => 121000,
  });
  stats.onUserText('Um, I think it was good.');
  stats.onUserText('Um, maybe yes.');
  stats.onAssistantText('Nice! Tell me more about it.');
  stats.onSpeech(30000);
  stats.onError('transcribe-failed');
  stats.onError('transcribe-failed');
  stats.onError('transcribe-failed');
  return stats;
}

test('counts filler words with word boundaries, case-insensitivity and the "you know" phrase', () => {
  const stats = statsFor();
  assert.equal(stats.onUserText(
    'Um, I think, uh, it was, you know, like, Actually it was basically so well done.',
  ), true);
  const snapshot = stats.snapshot();
  assert.deepEqual(snapshot.fillerCounts, {
    um: 1,
    uh: 1,
    like: 1,
    'you know': 1,
    actually: 1,
    basically: 1,
    so: 1,
    well: 1,
  });
  assert.equal(snapshot.fillerTotal, 8);
  assert.equal(snapshot.userWords, 16);
  assert.equal(snapshot.fillerPer100Words, 50);

  stats.onUserText('UMM, I agree.');
  const grown = stats.snapshot();
  assert.equal(grown.fillerCounts.um, 2);
  assert.equal(grown.fillerTotal, 9);
  assert.equal(grown.userWords, 19);
  assert.equal(grown.fillerPer100Words, 47.4);
});

test('filler matching ignores words that merely contain a filler', () => {
  const stats = statsFor();
  stats.onUserText('umbrella likeable somewhat wellness');
  const snapshot = stats.snapshot();
  assert.equal(snapshot.fillerTotal, 0);
  for (const word of FILLER_WORDS) assert.equal(snapshot.fillerCounts[word], 0);
});

test('tracks utterance lengths, assistant text, speech duration and errors', () => {
  const stats = statsFor();
  stats.onUserText('I went to the park with my friends yesterday afternoon');
  stats.onUserText('Yes');
  stats.onAssistantText('Nice! Tell me more about it.');
  stats.onSpeech(1200);
  stats.onSpeech(800);
  stats.onError('transcribe-failed');
  stats.onError('transcribe-failed');
  stats.onError('tts');
  const snapshot = stats.snapshot();
  assert.equal(snapshot.sessionId, 'session-1');
  assert.equal(snapshot.scenarioId, 'daily-chat');
  assert.equal(snapshot.level, 'B1');
  assert.equal(snapshot.startedAt, 1000);
  assert.equal(snapshot.endedAt, 61000);
  assert.equal(snapshot.durationMs, 60000);
  assert.equal(snapshot.userUtterances, 2);
  assert.equal(snapshot.userWords, 11);
  assert.equal(snapshot.avgWordsPerUtterance, 5.5);
  assert.equal(snapshot.longestWords, 10);
  assert.equal(snapshot.assistantMessages, 1);
  assert.equal(snapshot.assistantWords, 6);
  assert.equal(snapshot.speechMs, 2000);
  assert.equal(snapshot.errors, 3);
  assert.deepEqual(snapshot.errorKinds, { 'transcribe-failed': 2, tts: 1 });
  assert.deepEqual(snapshot.userTexts, [
    'I went to the park with my friends yesterday afternoon',
    'Yes',
  ]);
});

test('invalid input is ignored and never throws', () => {
  const stats = statsFor();
  assert.equal(stats.onUserText(null), false);
  assert.equal(stats.onUserText('   '), false);
  assert.equal(stats.onUserText('...'), false);
  assert.equal(stats.onAssistantText(undefined), false);
  assert.equal(stats.onSpeech(-1), false);
  assert.equal(stats.onSpeech(Number.NaN), false);
  assert.equal(stats.onSpeech('100'), false);
  assert.equal(stats.onError(''), false);
  assert.equal(stats.onError(null), false);
  const snapshot = stats.snapshot();
  assert.equal(snapshot.userUtterances, 0);
  assert.equal(snapshot.userWords, 0);
  assert.equal(snapshot.avgWordsPerUtterance, 0);
  assert.equal(snapshot.longestWords, 0);
  assert.equal(snapshot.speechMs, 0);
  assert.equal(snapshot.fillerTotal, 0);
  assert.equal(snapshot.fillerPer100Words, 0);
  assert.deepEqual(snapshot.userTexts, []);
  assert.deepEqual(snapshot.errorKinds, {});
});

test('snapshot is a defensive copy and does not drift without new events', () => {
  const stats = statsFor();
  stats.onUserText('I like it');
  const first = stats.snapshot();
  const second = stats.snapshot();
  assert.deepEqual(first, second);
  first.userTexts.push('leak');
  first.fillerCounts.like = 999;
  first.errorKinds.injected = 1;
  first.userWords = -1;
  const third = stats.snapshot();
  assert.deepEqual(third, second);
  stats.onUserText('One more sentence');
  const fourth = stats.snapshot();
  assert.equal(fourth.userUtterances, 2);
  assert.equal(first.userUtterances, 1);
});

test('caps excerpts at 40 utterances and 160 characters each', () => {
  const stats = statsFor();
  for (let index = 0; index < 45; index += 1) {
    stats.onUserText('utterance ' + index + ' ' + 'x'.repeat(200));
  }
  const snapshot = stats.snapshot();
  assert.equal(snapshot.userUtterances, 45);
  assert.equal(snapshot.userWords, 135);
  assert.equal(snapshot.userTexts.length, 40);
  assert.ok(snapshot.userTexts[0].startsWith('utterance 0 '));
  assert.ok(snapshot.userTexts[39].startsWith('utterance 39 '));
  for (const text of snapshot.userTexts) {
    assert.equal(Array.from(text).length, 160);
    assert.ok(text.endsWith('…'));
  }
});

test('renderLightRecap renders Chinese facts, quotes and deterministic advice', () => {
  const scenario = { id: 'daily-chat', name: 'Everyday Small Talk', nameZh: '日常闲聊', level: 'B1' };
  const markdown = renderLightRecap({ stats: renderFixture().snapshot(), scenario, level: 'B1' });
  assert.match(markdown, /^# 口语练习记录 — \d{4}-\d{2}-\d{2} \d{2}:\d{2} — daily-chat（日常闲聊）/u);
  assert.ok(markdown.includes('- 等级：B1'));
  assert.ok(markdown.includes('- 时长：2 分 0 秒'));
  assert.ok(markdown.includes('- 你的发言：2 轮 / 9 词（平均每轮 4.5 词，最长 6 词）'));
  assert.ok(markdown.includes('- 教练回复：1 条 / 6 词'));
  assert.ok(markdown.includes('- 语音时长：30 秒'));
  assert.ok(markdown.includes('- 填充词：共 2 次（每 100 词 22.2 次）'));
  assert.ok(markdown.includes('- 错误：3 次（transcribe-failed 3）'));
  assert.ok(markdown.includes('## 你的发言摘录'));
  assert.ok(markdown.includes('> Um, I think it was good.'));
  assert.ok(markdown.includes('> Um, maybe yes.'));
  assert.ok(markdown.includes('## 填充词统计'));
  assert.ok(markdown.includes('- um：2 次'));
  assert.ok(markdown.includes('## 下次建议'));
  assert.ok(markdown.includes('停顿'));
  assert.ok(markdown.includes('"um"'));
  assert.ok(markdown.includes('扩展'));
  assert.ok(markdown.includes('麦克风'));
  assert.ok(markdown.includes('end session'));
  assert.ok(markdown.endsWith('\n'));
});

test('renderLightRecap gives a generic tip and optional note without false alarms', () => {
  const stats = createSessionStats({ startedAt: 1000, now: () => 61000 });
  stats.onUserText('Yesterday I visited a small coffee shop near my office.');
  const withoutNote = renderLightRecap({ stats: stats.snapshot(), scenario: 'daily-chat' });
  assert.ok(withoutNote.includes('## 下次建议'));
  assert.ok(!withoutNote.includes('麦克风'));
  assert.ok(!withoutNote.includes('## 备注'));
  assert.ok(withoutNote.includes('保持'));
  assert.ok(withoutNote.includes('- 等级：未标注'));
  assert.ok(withoutNote.includes('> Yesterday I visited a small coffee shop near my office.'));

  const withNote = renderLightRecap({
    stats,
    scenario: { id: 'daily-chat', nameZh: '日常闲聊' },
    note: '本次由 /voice off 结束。',
  });
  assert.ok(withNote.includes('## 备注'));
  assert.ok(withNote.includes('本次由 /voice off 结束。'));
  assert.ok(withNote.includes('日常闲聊'));
});

test('writeLightRecap creates the practice directory and writes the auto recap', async () => {
  const root = await tempDir('write');
  const practiceDir = join(root, 'practice', 'nested');
  const stats = statsFor();
  stats.onUserText('I really enjoyed the coffee shop yesterday.');
  const log = recordingLog();
  const now = new Date(2026, 9, 27, 9, 5);
  const result = await writeLightRecap({
    practiceDir,
    stats: stats.snapshot(),
    scenario: { id: 'daily-chat', nameZh: '日常闲聊' },
    level: 'B1',
    log,
    now,
  });
  const expectedName = localFileStamp(now) + '-daily-chat-auto.md';
  assert.equal(result.skipped, false);
  assert.equal(result.reason, '');
  assert.equal(result.path, join(practiceDir, expectedName));
  const content = await readFile(result.path, 'utf8');
  assert.ok(content.includes('# 口语练习记录'));
  assert.ok(content.includes('> I really enjoyed the coffee shop yesterday.'));
  assert.ok(content.includes('end session'));
  assert.deepEqual(await readdir(practiceDir), [expectedName]);
  assert.ok(log.lines.some(([level, message]) => level === 'info' && message.includes('light recap written')));
});

test('writeLightRecap skips when the model already wrote this session recap', async () => {
  const practiceDir = await tempDir('model');
  const modelName = '2026-10-27-0900-daily-chat.md';
  await writeFile(join(practiceDir, modelName), '# model recap\n', 'utf8');
  const stats = createSessionStats({
    sessionId: 'session-1',
    scenarioId: 'daily-chat',
    startedAt: Date.now() - 60000,
    now: () => Date.now(),
  });
  stats.onUserText('Hello there.');
  const log = recordingLog();
  const result = await writeLightRecap({
    practiceDir,
    stats: stats.snapshot(),
    scenario: { id: 'daily-chat' },
    log,
    now: new Date(2026, 9, 27, 9, 5),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'model-recap-exists');
  assert.equal(result.path, '');
  assert.deepEqual(await readdir(practiceDir), [modelName]);
  assert.ok(log.lines.some(([level, message]) => level === 'info' && message.includes('model recap already exists')));
});

test('findModelRecap finds only fresh model recaps for the scenario', async () => {
  const practiceDir = await tempDir('find');
  const modelPath = join(practiceDir, '2026-10-27-0900-daily-chat.md');
  await writeFile(modelPath, '# model\n', 'utf8');
  await writeFile(join(practiceDir, '2026-10-27-0900-daily-chat-auto.md'), '# auto\n', 'utf8');
  await writeFile(join(practiceDir, '2026-10-27-0900-job-interview.md'), '# other\n', 'utf8');
  await writeFile(join(practiceDir, 'notes.txt'), 'notes\n', 'utf8');
  const sinceMs = Date.now() - 60000;
  assert.equal(await findModelRecap({ practiceDir, scenarioId: 'daily-chat', sinceMs }), modelPath);
  assert.equal(
    await findModelRecap({ practiceDir, scenarioId: 'job-interview', sinceMs }),
    join(practiceDir, '2026-10-27-0900-job-interview.md'),
  );
  assert.equal(await findModelRecap({ practiceDir: join(practiceDir, 'missing'), scenarioId: 'daily-chat' }), null);
  assert.equal(await findModelRecap({ practiceDir, scenarioId: '' }), null);
  assert.equal(await findModelRecap({}), null);

  const autoDir = await tempDir('only-auto');
  await writeFile(join(autoDir, '2026-10-27-0900-daily-chat-auto.md'), '# auto\n', 'utf8');
  assert.equal(await findModelRecap({ practiceDir: autoDir, scenarioId: 'daily-chat', sinceMs: 0 }), null);

  const oldDir = await tempDir('find-old');
  const oldPath = join(oldDir, '2020-01-01-0900-daily-chat.md');
  await writeFile(oldPath, '# old\n', 'utf8');
  const oldDate = new Date('2020-01-01T00:00:00Z');
  await utimes(oldPath, oldDate, oldDate);
  assert.equal(await findModelRecap({ practiceDir: oldDir, scenarioId: 'daily-chat', sinceMs }), null);
  assert.equal(await findModelRecap({ practiceDir: oldDir, scenarioId: 'daily-chat', sinceMs: 0 }), oldPath);
});

test('writeLightRecap degrades to a logged skip when the path is not writable', async () => {
  const root = await tempDir('blocked');
  const blocker = join(root, 'practice');
  await writeFile(blocker, 'not a directory', 'utf8');
  const stats = statsFor();
  stats.onUserText('Hello there.');
  const log = recordingLog();
  let result = null;
  await assert.doesNotReject(async () => {
    result = await writeLightRecap({
      practiceDir: blocker,
      stats,
      scenario: 'daily-chat',
      log,
      now: new Date(2026, 9, 27, 9, 5),
    });
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'write-failed');
  assert.equal(result.path, '');
  assert.ok(log.lines.some(([level, message]) => level === 'warn' && message.includes('cannot write light recap')));
  assert.equal(await readFile(blocker, 'utf8'), 'not a directory');

  const empty = await writeLightRecap({ practiceDir: '   ', stats: stats.snapshot(), scenario: 'daily-chat' });
  assert.equal(empty.skipped, true);
  assert.equal(empty.reason, 'no-practice-dir');
});
