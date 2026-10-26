import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OPTIONS,
  isWithinRoot,
  normalizeOptions,
  resolveLogPath,
} from '../src/core/options.js';

test('normalizeOptions applies documented defaults', () => {
  const options = normalizeOptions({});
  assert.equal(options.practiceRoot, '');
  assert.equal(options.englishVoice, DEFAULT_OPTIONS.englishVoice);
  assert.equal(options.rate, 175);
  assert.equal(options.silenceMs, 600);
  assert.equal(options.minSpeechMs, 200);
  assert.equal(options.maxUtteranceSec, 45);
  assert.equal(options.bargeIn, true);
  assert.equal(options.logFile, DEFAULT_OPTIONS.logFile);
  assert.ok(Object.isFrozen(options));
});

test('normalizeOptions clamps and validates config values', () => {
  const options = normalizeOptions({
    practiceRoot: '/work/root/',
    rate: 1000,
    silenceMs: 10,
    minSpeechMs: 5000,
    maxUtteranceSec: 999,
    bargeIn: true,
    englishVoice: '   ',
    logFile: 'logs/x.log',
  });
  assert.equal(options.practiceRoot, '/work/root');
  assert.equal(options.rate, 320);
  assert.equal(options.silenceMs, 250);
  assert.equal(options.minSpeechMs, 2000);
  assert.equal(options.maxUtteranceSec, 180);
  assert.equal(options.bargeIn, true);
  assert.equal(options.englishVoice, 'Samantha');
  assert.equal(options.logFile, 'logs/x.log');
});

test('normalizeOptions accepts internal tunable overrides', () => {
  const options = normalizeOptions({}, { transcribeTimeoutMs: 1234, replyTimeoutMs: 5678, maxSpeechChars: 300 });
  assert.equal(options.transcribeTimeoutMs, 1234);
  assert.equal(options.replyTimeoutMs, 5678);
  assert.equal(options.maxSpeechChars, 300);
});

test('isWithinRoot uses path-boundary comparison', () => {
  assert.equal(isWithinRoot('/a/b', ''), true);
  assert.equal(isWithinRoot('/a/b', '/a/b'), true);
  assert.equal(isWithinRoot('/a/b/c', '/a/b'), true);
  assert.equal(isWithinRoot('/a/bc', '/a/b'), false);
  assert.equal(isWithinRoot('/a/b', '/a/bc'), false);
  assert.equal(isWithinRoot('', '/a/b'), false);
  assert.equal(isWithinRoot('/anything', '/'), true);
});

test('resolveLogPath honors absolute and relative log files', () => {
  assert.equal(resolveLogPath('/root', '/var/log/x.log'), '/var/log/x.log');
  assert.equal(resolveLogPath('/root', 'logs/x.log'), '/root/logs/x.log');
  assert.equal(resolveLogPath('/root', 'nested/x.log'), '/root/nested/x.log');
});
