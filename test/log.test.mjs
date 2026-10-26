import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLog } from '../src/log.js';

const testDir = fileURLToPath(new URL('./.tmp/', import.meta.url));
let counter = 0;

async function tempFile() {
  await mkdir(testDir, { recursive: true });
  counter += 1;
  return join(testDir, 'log-' + process.pid + '-' + counter + '.log');
}

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test('writes timestamped lines to file and mirrors to ctx.logger', async () => {
  const filePath = await tempFile();
  const mirrored = [];
  const fakeLogger = {
    info: (message) => mirrored.push(['info', message]),
    warn: (message) => mirrored.push(['warn', message]),
    error: (message) => mirrored.push(['error', message]),
    debug: (message) => mirrored.push(['debug', message]),
  };
  const log = createLog({ filePath, ctxLogger: fakeLogger });
  log.info('hello world');
  log.warn('careful');
  log.error({ code: 1 });
  await log.flush();
  const content = await readFile(filePath, 'utf8');
  assert.match(content, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[info\] \[voice-practice\] hello world$/m);
  assert.match(content, /\[warn\] \[voice-practice\] careful/);
  assert.match(content, /"code":1/);
  assert.equal(mirrored.length, 3);
  assert.equal(mirrored[0][0], 'info');
  assert.ok(mirrored[0][1].includes('hello world'));
  await rm(filePath, { force: true });
});

test('log write failures never throw and warn once', async () => {
  await mkdir(testDir, { recursive: true });
  const blocker = join(testDir, 'blocker-' + process.pid);
  await writeFile(blocker, 'x');
  const warnings = [];
  const log = createLog({
    filePath: join(blocker, 'nested', 'voice.log'),
    ctxLogger: { info() {}, warn: (message) => warnings.push(message), error() {}, debug() {} },
  });
  assert.doesNotThrow(() => {
    log.info('one');
    log.info('two');
  });
  await log.flush();
  assert.equal(warnings.filter((line) => line.includes('cannot write log file')).length, 1);
  await rm(blocker, { force: true });
});

test('close flushes and stops file writes', async () => {
  const filePath = await tempFile();
  const log = createLog({ filePath, ctxLogger: null });
  log.info('before');
  await log.close();
  log.info('after');
  await log.flush();
  const content = await readFile(filePath, 'utf8');
  assert.ok(content.includes('before'));
  assert.ok(!content.includes('after'));
  await rm(filePath, { force: true });
});
