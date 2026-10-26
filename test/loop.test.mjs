import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLoop } from '../src/core/loop.js';
import { deferred, silentLog, sleep, tonePcm, waitUntil } from './support.mjs';

function makeHarness(options = {}) {
  const calls = { submit: [], speak: [], cancel: 0, off: 0, micStops: 0 };
  const vadEvents = [];
  const vad = {
    suspensions: [],
    suppressMs: 0,
    push() {
      const events = vadEvents.splice(0);
      return events;
    },
    flush() {
      return [];
    },
    getStats() {
      return { fake: true };
    },
    setSuspended(value) {
      this.suspensions.push(value);
    },
    suppress(ms) {
      this.suppressMs += ms;
    },
  };
  const mic = {
    started: 0,
    handlers: null,
    async start(handlers) {
      this.started += 1;
      this.handlers = handlers;
    },
    async stop() {
      calls.micStops += 1;
    },
  };
  const gate = options.ttsGate ?? null;
  const tts = {
    async speak(segments) {
      calls.speak.push(segments);
      if (gate !== null) await gate.promise;
      return { cancelled: false, spoken: segments.length };
    },
    async cancel() {
      calls.cancel += 1;
      if (gate !== null) gate.resolve();
    },
  };
  const stt = {
    async transcribe(wav, signal) {
      calls.wav = wav;
      if (options.stt !== undefined) return options.stt(wav, signal);
      return { text: 'hello there' };
    },
  };
  const loop = new VoiceLoop({
    sessionId: options.sessionId ?? 'session-1',
    cwd: '/work',
    config: Object.assign(
      { transcribeTimeoutMs: 500, replyTimeoutMs: options.replyTimeoutMs ?? 1000 },
      options.config ?? {},
    ),
    logger: silentLog,
    mic,
    tts,
    stt,
    submit: async (text) => {
      calls.submit.push(text);
      if (options.submit !== undefined) return options.submit(text);
      return { ok: true };
    },
    requestVoiceOff: async () => {
      calls.off += 1;
      await loop.stop('voice-command');
    },
    createVad: () => vad,
  });
  return { loop, vad, vadEvents, calls, mic, tts, stt };
}

const SPEECH_START = Object.freeze({
  type: 'speech-start',
  timeMs: 500,
  frameIndex: 25,
  rmsDb: -20,
  thresholdDb: -45,
  noiseFloorDb: -120,
});

function utterance(durationMs = 800) {
  return {
    type: 'utterance',
    reason: 'silence',
    pcm: tonePcm(400, 0.1),
    startTimeMs: 200,
    endTimeMs: 1000,
    durationMs,
    speechMs: durationMs - 300,
    frameCount: 40,
  };
}

async function driveUtterance(harness) {
  harness.vadEvents.push(SPEECH_START, utterance());
  harness.loop.handleAudio(Buffer.alloc(640));
  await harness.loop.settled();
}

async function driveReply(harness, turn, text) {
  harness.loop.onSessionEvent({ type: 'turn/start', data: { turn } });
  harness.loop.onSessionEvent({
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
  });
  harness.loop.onSessionEvent({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  await harness.loop.settled();
}

test('happy path: start, speech, transcript, submit, reply playback', async () => {
  const harness = makeHarness();
  const { loop, calls, mic } = harness;
  await loop.start();
  assert.equal(loop.state, 'listening');
  assert.equal(mic.started, 1);

  await driveUtterance(harness);
  assert.deepEqual(calls.submit, ['hello there']);
  assert.equal(loop.state, 'awaiting-reply');
  assert.ok(calls.wav.length > 44, 'WAV buffer passed to STT');

  await driveReply(harness, 4, 'Hi! **Welcome** to practice.');
  await loop.waitForState('listening');
  assert.equal(calls.speak.length, 1);
  const segments = calls.speak[0];
  assert.equal(segments[0].lang, 'en');
  assert.match(segments[0].text, /Welcome to practice/);
  assert.doesNotMatch(segments[0].text, /\*\*/);
});

test('barge-in cancels speech and transcribes the new utterance', async () => {
  const gate = deferred();
  const harness = makeHarness({ ttsGate: gate });
  const { loop, vadEvents, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  harness.loop.onSessionEvent({ type: 'turn/start', data: { turn: 1 } });
  harness.loop.onSessionEvent({
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: 'A long spoken answer.' }] } },
  });
  harness.loop.onSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await loop.waitForState('speaking');
  assert.equal(calls.cancel, 0);

  vadEvents.push(SPEECH_START);
  loop.handleAudio(Buffer.alloc(640));
  assert.equal(loop.state, 'capturing');
  assert.equal(calls.cancel, 1);
  gate.resolve();
  await loop.settled();
  assert.equal(loop.state, 'capturing');

  vadEvents.push(utterance());
  loop.handleAudio(Buffer.alloc(640));
  await loop.settled();
  assert.deepEqual(calls.submit, ['hello there', 'hello there']);
});

test('bargeIn false keeps speaking through detected speech', async () => {
  const gate = deferred();
  const harness = makeHarness({ ttsGate: gate, config: { bargeIn: false } });
  const { loop, vadEvents, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  harness.loop.onSessionEvent({ type: 'turn/start', data: { turn: 2 } });
  harness.loop.onSessionEvent({
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'text', text: 'Keep talking.' }] } },
  });
  harness.loop.onSessionEvent({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await loop.waitForState('speaking');
  vadEvents.push(SPEECH_START);
  loop.handleAudio(Buffer.alloc(640));
  assert.equal(loop.state, 'speaking');
  assert.equal(calls.cancel, 0);
  gate.resolve();
  await loop.waitForState('listening');
});

test('empty transcript returns to listening without submitting', async () => {
  const harness = makeHarness({ stt: () => ({ text: '   ' }) });
  await harness.loop.start();
  await driveUtterance(harness);
  assert.equal(harness.loop.state, 'listening');
  assert.deepEqual(harness.calls.submit, []);
});

test('transcription failure speaks an apology once and keeps listening', async () => {
  let first = true;
  const harness = makeHarness({
    stt: () => {
      if (first) {
        first = false;
        throw new Error('stt exploded');
      }
      return { text: 'second try' };
    },
  });
  await harness.loop.start();
  await driveUtterance(harness);
  await harness.loop.waitForState('listening');
  assert.equal(harness.calls.speak.length, 1);
  assert.match(harness.calls.speak[0][0].text, /Sorry/);

  await driveUtterance(harness);
  assert.deepEqual(harness.calls.submit, ['second try']);
  assert.equal(harness.calls.speak.length, 1, 'apology is only spoken once');
});

test('spoken off command asks the host to leave voice mode', async () => {
  const harness = makeHarness({ stt: () => ({ text: 'Stop listening.' }) });
  await harness.loop.start();
  await driveUtterance(harness);
  assert.equal(harness.calls.off, 1);
  assert.equal(harness.loop.state, 'idle');
  assert.deepEqual(harness.calls.submit, []);
});

test('spoken repeat command replays the last reply', async () => {
  const harness = makeHarness();
  await harness.loop.start();
  await driveUtterance(harness);
  await driveReply(harness, 3, 'Repeatable answer.');
  await harness.loop.waitForState('listening');
  assert.equal(harness.calls.speak.length, 1);

  const original = harness.stt.transcribe;
  harness.stt.transcribe = async () => ({ text: 'Say that again!' });
  await driveUtterance(harness);
  await harness.loop.waitForState('listening');
  assert.equal(harness.calls.speak.length, 2);
  assert.deepEqual(harness.calls.speak[1], harness.calls.speak[0]);
  harness.stt.transcribe = original;
});

test('turn ending with an error is not spoken', async () => {
  const harness = makeHarness();
  await harness.loop.start();
  await driveUtterance(harness);
  harness.loop.onSessionEvent({ type: 'turn/start', data: { turn: 9 } });
  harness.loop.onSessionEvent({
    type: 'assistant/message',
    data: { turn: 9, message: { content: [{ type: 'text', text: 'partial' }] } },
  });
  harness.loop.onSessionEvent({ type: 'turn/end', data: { turn: 9, reason: { kind: 'aborted' } } });
  await harness.loop.settled();
  assert.equal(harness.calls.speak.length, 0);
  assert.equal(harness.loop.state, 'listening');
});

test('reply timeout returns to listening', async () => {
  const harness = makeHarness({ replyTimeoutMs: 30 });
  await harness.loop.start();
  await driveUtterance(harness);
  assert.equal(harness.loop.state, 'awaiting-reply');
  await harness.loop.waitForState('listening', 1000);
  assert.match(harness.loop.status().lastError, /reply timeout/);
});

test('transcription timeout returns to listening', async () => {
  const harness = makeHarness({
    config: { transcribeTimeoutMs: 30 },
    stt: (_wav, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    }),
  });
  await harness.loop.start();
  await driveUtterance(harness);
  await harness.loop.waitForState('listening', 1000);
  assert.match(harness.loop.status().lastError, /timed out/);
});

test('stop releases the microphone and speech', async () => {
  const harness = makeHarness();
  await harness.loop.start();
  await harness.loop.stop('test');
  assert.equal(harness.loop.state, 'idle');
  assert.equal(harness.calls.micStops, 1);
  assert.equal(harness.calls.cancel, 1);
});

test('announce suspends and resumes VAD detection', async () => {
  const harness = makeHarness();
  await harness.loop.start();
  await harness.loop.announce('Voice mode is on.');
  assert.deepEqual(harness.vad.suspensions, [true, false]);
  assert.equal(harness.calls.speak.length, 1);
});
