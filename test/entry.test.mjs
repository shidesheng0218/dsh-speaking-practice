import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const abs = (relativePath) => fileURLToPath(new URL(relativePath, import.meta.url));
const SOURCE_FILES = [
  '../src/index.js',
  '../src/mic.js',
  '../src/tts.js',
  '../src/log.js',
  '../src/core/vad.js',
  '../src/core/wav.js',
  '../src/core/text.js',
  '../src/core/state.js',
  '../src/core/reply.js',
  '../src/core/loop.js',
  '../src/core/options.js',
];
const PURE_FILES = SOURCE_FILES.filter((file) => file !== '../src/index.js');

test('every source file parses as ESM', () => {
  for (const relativePath of SOURCE_FILES) {
    const result = spawnSync(process.execPath, ['--check', abs(relativePath)], { encoding: 'utf8' });
    assert.equal(result.status, 0, relativePath + ' failed node --check:\n' + result.stderr);
  }
});

test('plugin entry exports the cordis host contract', () => {
  const source = readFileSync(abs('../src/index.js'), 'utf8');
  assert.match(source, /export const name = 'dsh-speaking-practice'/);
  assert.match(source, /export const inject = \[\]/);
  assert.match(source, /export const Config = z\.object\(/);
  assert.match(source, /export async function apply\(ctx, rawConfig\)/);
  for (const key of [
    'practiceRoot',
    'englishVoice',
    'chineseVoice',
    'rate',
    'language',
    'silenceMs',
    'minSpeechMs',
    'maxUtteranceSec',
    'bargeIn',
    'logFile',
  ]) {
    assert.match(source, new RegExp(key + ': z\\.'), 'missing Config field ' + key);
  }
  for (const service of ['commands', 'speechToText', 'subprocess', 'agents']) {
    assert.match(source, new RegExp("safeGet\\(ctx, '" + service + "'\\)"), 'missing defensive lookup for ' + service);
  }
});

test('the /voice command and session-event wiring are present', () => {
  const source = readFileSync(abs('../src/index.js'), 'utf8');
  assert.match(source, /name: 'voice'/);
  assert.match(source, /input: \{ hint: 'on \| off \| status' \}/);
  assert.match(source, /kind: 'success'/);
  assert.match(source, /kind: 'error'/);
  assert.match(source, /ctx\.on\('session\/event'/);
  assert.match(source, /prepare\('sensevoice-local'\)/);
  assert.match(source, /agent\.followup\(message\)/);
});

test('pure core and service modules do not import DSH packages', () => {
  for (const relativePath of PURE_FILES) {
    const source = readFileSync(abs(relativePath), 'utf8');
    assert.doesNotMatch(source, /@deepseek-ai\//, relativePath + ' must stay testable without DSH');
  }
  const entry = readFileSync(abs('../src/index.js'), 'utf8');
  assert.match(entry, /import z from '@deepseek-ai\/schemastery'/);
  assert.match(entry, /import\('@deepseek-ai\/dsh-llm'\)/);
});
