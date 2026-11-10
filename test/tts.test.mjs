import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSpeaker,
  estimateSpeakMs,
  parseVoiceList,
  rateToEdgePercent,
  selectBestSystemVoice,
} from '../src/tts.js';
import { deferred, waitUntil } from './support.mjs';

function makeFakeHandle(options = {}) {
  const done = deferred();
  return {
    done: done.promise,
    collected: {
      stdout: { readFrom: () => ({ text: options.stdout ?? '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: options.stderr ?? '', nextOffset: 0, lossy: false }) },
    },
    terminated: 0,
    terminate() {
      this.terminated += 1;
      done.resolve({ exitCode: null, signal: 'SIGTERM' });
    },
    waitForExit: async () => {},
    finish(exitCode, signal) {
      done.resolve({ exitCode, signal: signal ?? null });
    },
  };
}

function makeFakeSubprocess(options = {}) {
  const specs = [];
  const handles = [];
  return {
    specs,
    handles,
    async resolveExecutable(name) {
      if (options.resolveError) throw new Error('not found: ' + name);
      if (typeof options.resolve === 'function') return options.resolve(name);
      if (name === 'edge-tts') throw new Error('not found: edge-tts');
      return '/usr/bin/' + name;
    },
    spawn(spec) {
      if (options.spawnError) throw new Error('spawn failed');
      specs.push(spec);
      const handle = makeFakeHandle();
      handles.push(handle);
      return handle;
    },
  };
}

function makeLog() {
  const warnings = [];
  return {
    warnings,
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error() {},
  };
}

const VOICE_OUTPUT = [
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Daniel              en_GB    # Hello! My name is Daniel.',
  'Tingting            zh_CN    # 你好！我叫婷婷。',
  'Eddy (中文（中国大陆）)     zh_CN    # 你好！我叫Eddy。',
  'not a voice line',
].join('\n');

test('parseVoiceList extracts voice names and locales', () => {
  const voices = parseVoiceList(VOICE_OUTPUT);
  assert.equal(voices.length, 4);
  assert.equal(voices[0].name, 'Samantha');
  assert.equal(voices[0].locale, 'en_US');
  assert.equal(voices[2].name, 'Tingting');
  assert.equal(voices[3].name, 'Eddy (中文（中国大陆）)');
  assert.deepEqual(parseVoiceList(''), []);
});

test('estimateSpeakMs grows with text length and rate', () => {
  const short = estimateSpeakMs('Hi.', 175);
  const long = estimateSpeakMs('x'.repeat(200), 175);
  const fast = estimateSpeakMs('x'.repeat(200), 300);
  assert.ok(short >= 300);
  assert.ok(long > short);
  assert.ok(fast < long);
});

test('speak spawns one say process per segment with the right voices', async () => {
  const subprocess = makeFakeSubprocess();
  const log = makeLog();
  const speaker = createSpeaker({
    subprocess,
    config: { englishVoice: 'Samantha', chineseVoice: 'Tingting', rate: 175 },
    log,
    voices: parseVoiceList(VOICE_OUTPUT),
  });
  const promise = speaker.speak([{ lang: 'en', text: 'Hello.' }, { lang: 'zh', text: '你好。' }]);
  await waitUntil(() => subprocess.specs.length === 1);
  subprocess.handles[0].finish(0);
  await waitUntil(() => subprocess.specs.length === 2);
  subprocess.handles[1].finish(0);
  const result = await promise;
  assert.deepEqual(result, { cancelled: false, spoken: 2 });
  assert.equal(subprocess.specs[0].argv[0], '/usr/bin/say');
  assert.equal(subprocess.specs[0].argv[1], '-v');
  assert.equal(subprocess.specs[0].argv[2], 'Samantha');
  assert.equal(subprocess.specs[0].argv[3], '-r');
  assert.equal(subprocess.specs[0].argv[4], '175');
  assert.equal(subprocess.specs[0].argv[5], 'Hello.');
  assert.equal(subprocess.specs[1].argv[2], 'Tingting');
  assert.equal(subprocess.specs[1].argv[5], '你好。');
  assert.equal(subprocess.specs[0].cwd, '/');
  assert.equal(log.warnings.length, 0);
});

test('a failed segment is logged and later segments still play', async () => {
  const subprocess = makeFakeSubprocess();
  const log = makeLog();
  const speaker = createSpeaker({
    subprocess,
    config: { englishVoice: 'Samantha', chineseVoice: 'Tingting', rate: 175 },
    log,
    voices: parseVoiceList(VOICE_OUTPUT),
  });
  const promise = speaker.speak([{ lang: 'en', text: 'One.' }, { lang: 'en', text: 'Two.' }]);
  await waitUntil(() => subprocess.specs.length === 1);
  subprocess.handles[0].finish(1);
  await waitUntil(() => subprocess.specs.length === 2);
  subprocess.handles[1].finish(0);
  const result = await promise;
  assert.equal(result.spoken, 1);
  assert.ok(log.warnings.some((line) => line.includes('say exited code=1')));
});

test('cancel terminates the active say and stops remaining segments', async () => {
  const subprocess = makeFakeSubprocess();
  const speaker = createSpeaker({
    subprocess,
    config: { englishVoice: 'Samantha', chineseVoice: 'Tingting', rate: 175 },
    log: makeLog(),
    voices: parseVoiceList(VOICE_OUTPUT),
  });
  const promise = speaker.speak([{ lang: 'en', text: 'One.' }, { lang: 'en', text: 'Two.' }]);
  await waitUntil(() => subprocess.specs.length === 1);
  await speaker.cancel();
  assert.equal(subprocess.handles[0].terminated, 1);
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(subprocess.specs.length, 1);
});

test('missing configured Chinese voice falls back to an installed zh_CN voice', async () => {
  const subprocess = makeFakeSubprocess();
  const log = makeLog();
  const speaker = createSpeaker({
    subprocess,
    config: { englishVoice: 'Samantha', chineseVoice: 'NotInstalled', rate: 175 },
    log,
    voices: parseVoiceList(VOICE_OUTPUT),
  });
  const promise = speaker.speak([{ lang: 'zh', text: '你好。' }]);
  await waitUntil(() => subprocess.specs.length === 1);
  subprocess.handles[0].finish(0);
  await promise;
  assert.equal(subprocess.specs[0].argv[2], 'Tingting');
  assert.ok(log.warnings.some((line) => line.includes('not installed')));
});

test('speak without a subprocess service does not throw', async () => {
  const speaker = createSpeaker({
    subprocess: null,
    config: { englishVoice: 'Samantha', rate: 175 },
    log: makeLog(),
  });
  const result = await speaker.speak([{ lang: 'en', text: 'Hello.' }]);
  assert.deepEqual(result, { cancelled: false, spoken: 0 });
});

test('selectBestSystemVoice upgrades to Enhanced/Premium variants when installed', () => {
  const voices = parseVoiceList([
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Samantha (Enhanced) en_US    # Hello! My name is Samantha.',
    'Ava (Premium)       en_US    # Hello! My name is Ava.',
    'Tingting            zh_CN    # 你好！我叫婷婷。',
    'Tingting (Enhanced) zh_CN    # 你好！我叫婷婷。',
  ].join('\n'));

  const enChoice = selectBestSystemVoice(voices, 'en', 'Samantha');
  assert.equal(enChoice.voice, 'Samantha (Enhanced)');
  assert.equal(enChoice.upgraded, true);

  // If configured voice has only compact tier, a Premium voice in the same language is preferred.
  const compactSamanthaOnly = parseVoiceList([
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Ava (Premium)       en_US    # Hello! My name is Ava.',
  ].join('\n'));
  const avaChoice = selectBestSystemVoice(compactSamanthaOnly, 'en', 'Samantha');
  assert.equal(avaChoice.voice, 'Ava (Premium)');
  assert.equal(avaChoice.upgraded, true);

  const zhChoice = selectBestSystemVoice(voices, 'zh', 'Tingting');
  assert.equal(zhChoice.voice, 'Tingting (Enhanced)');
  assert.equal(zhChoice.upgraded, true);
});

test('rateToEdgePercent converts WPM to edge-tts rate percentages', () => {
  assert.equal(rateToEdgePercent(175), '+0%');
  assert.equal(rateToEdgePercent(210), '+20%');
  assert.equal(rateToEdgePercent(140), '-20%');
});

test('edge-tts backend synthesizes via edge-tts + afplay and falls back to say on error', async () => {
  const unlinked = [];
  const subprocess = makeFakeSubprocess({
    resolve: async (name) => '/opt/bin/' + name,
  });
  const speaker = createSpeaker({
    subprocess,
    config: { ttsEngine: 'edge', edgeEnglishVoice: 'en-US-JennyNeural', rate: 175 },
    log: makeLog(),
    voices: parseVoiceList(VOICE_OUTPUT),
    unlinkFile: async (path) => { unlinked.push(path); },
  });

  // Segment 1: edge-tts succeeds -> afplay plays -> temp mp3 unlinked.
  const p1 = speaker.speak([{ lang: 'en', text: 'Neural voice.' }]);
  await waitUntil(() => subprocess.specs.length === 1);
  assert.equal(subprocess.specs[0].argv[0], '/opt/bin/edge-tts');
  assert.ok(subprocess.specs[0].argv.includes('en-US-JennyNeural'));
  subprocess.handles[0].finish(0);

  await waitUntil(() => subprocess.specs.length === 2);
  assert.equal(subprocess.specs[1].argv[0], '/opt/bin/afplay');
  subprocess.handles[1].finish(0);
  const res1 = await p1;
  assert.deepEqual(res1, { cancelled: false, spoken: 1 });
  assert.equal(unlinked.length, 1);

  // Segment 2: edge-tts fails (e.g. offline) -> seamlessly falls back to `say`.
  const p2 = speaker.speak([{ lang: 'en', text: 'Offline fallback.' }]);
  await waitUntil(() => subprocess.specs.length === 3);
  assert.equal(subprocess.specs[2].argv[0], '/opt/bin/edge-tts');
  subprocess.handles[2].finish(1);

  await waitUntil(() => subprocess.specs.length === 4);
  assert.equal(subprocess.specs[3].argv[0], '/opt/bin/say');
  subprocess.handles[3].finish(0);
  const res2 = await p2;
  assert.deepEqual(res2, { cancelled: false, spoken: 1 });
});
