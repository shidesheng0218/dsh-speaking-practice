import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { buildFfmpegArgs, createMic } from '../src/mic.js';
import { waitUntil } from './support.mjs';

function makeFakeHandle() {
  const stdout = new PassThrough();
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  return {
    stdout,
    done,
    collected: { stderr: { readFrom: () => ({ text: 'fake ffmpeg stderr' }) } },
    terminated: 0,
    terminatedFlag: false,
    terminate() {
      this.terminated += 1;
      this.terminatedFlag = true;
      resolveDone({ exitCode: 0, signal: 'SIGTERM' });
    },
    waitForExit: async () => {},
    emit(chunk) {
      stdout.write(chunk);
    },
    exit(exitCode) {
      resolveDone({ exitCode, signal: null });
    },
  };
}

function makeFakeSubprocess(options = {}) {
  const specs = [];
  const handles = [];
  return {
    specs,
    handles,
    async resolveExecutable() {
      return '/fake/ffmpeg';
    },
    spawn(spec) {
      if (options.spawnError && options.spawnError(specs.length)) throw new Error('spawn boom');
      specs.push(spec);
      const handle = makeFakeHandle();
      handles.push(handle);
      return handle;
    },
  };
}

const FAST_CONFIG = Object.freeze({
  firstChunkTimeoutMs: 200,
  ffmpegRetries: 2,
  ffmpegRetryDelayMs: 5,
  sampleRate: 16000,
});

test('buildFfmpegArgs builds the documented continuous PCM argv', () => {
  assert.deepEqual(buildFfmpegArgs('/opt/homebrew/bin/ffmpeg'), [
    '/opt/homebrew/bin/ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-i',
    ':0',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    's16le',
    '-',
  ]);
});

test('start resolves after the first chunk and stop terminates ffmpeg', async () => {
  const subprocess = makeFakeSubprocess();
  const chunks = [];
  const mic = createMic({ subprocess, config: FAST_CONFIG, log: null });
  const starting = mic.start({ onData: (chunk) => chunks.push(chunk) });
  await waitUntil(() => subprocess.specs.length === 1);
  subprocess.handles[0].emit(Buffer.from([1, 2, 3, 4]));
  await starting;
  assert.equal(mic.running, true);
  assert.equal(chunks.length, 1);
  assert.deepEqual(subprocess.specs[0].stdio, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: { maxBytes: 8192 },
  });
  await mic.stop();
  assert.equal(mic.running, false);
  assert.equal(subprocess.handles[0].terminated, 1);
});

test('start rejects when no audio arrives in time', async () => {
  const subprocess = makeFakeSubprocess();
  const mic = createMic({ subprocess, config: { firstChunkTimeoutMs: 30 }, log: null });
  await assert.rejects(mic.start({ onData() {} }), /no audio data within 30ms/);
  assert.equal(subprocess.handles[0].terminated, 1);
});

test('unexpected exit restarts ffmpeg', async () => {
  const subprocess = makeFakeSubprocess();
  const mic = createMic({ subprocess, config: FAST_CONFIG, log: null });
  const starting = mic.start({ onData() {} });
  await waitUntil(() => subprocess.specs.length === 1);
  subprocess.handles[0].emit(Buffer.from([1, 2]));
  await starting;
  subprocess.handles[0].exit(1);
  await waitUntil(() => subprocess.specs.length === 2);
  subprocess.handles[1].emit(Buffer.from([3, 4]));
  await waitUntil(() => mic.running === true);
  await mic.stop();
});

test('restarts are bounded and reported through onFatal', async () => {
  const subprocess = makeFakeSubprocess({ spawnError: (count) => count >= 1 });
  const mic = createMic({ subprocess, config: { ...FAST_CONFIG, ffmpegRetries: 1 }, log: null });
  const fatal = [];
  const starting = mic.start({ onData() {}, onFatal: (error) => fatal.push(error) });
  await waitUntil(() => subprocess.specs.length === 1);
  subprocess.handles[0].emit(Buffer.from([1, 2]));
  await starting;
  subprocess.handles[0].exit(1);
  await waitUntil(() => fatal.length === 1, { timeoutMs: 1000 });
  assert.match(fatal[0].message, /failed after 1 restart/);
});
