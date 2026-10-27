import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLoop } from '../src/core/loop.js';
import { deferred, silentLog, sleep, tonePcm, waitUntil } from './support.mjs';

function makeHarness(options = {}) {
  const calls = { submit: [], speak: [], cancel: 0, off: 0, offReasons: [], micStops: 0 };
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
  const speakHook = typeof options.speak === 'function' ? options.speak : null;
  const tts = {
    async speak(segments, meta) {
      calls.speak.push(segments);
      if (speakHook !== null) await speakHook(segments, meta, calls);
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
    stats: options.stats,
    submit: async (text) => {
      calls.submit.push(text);
      if (options.submit !== undefined) return options.submit(text);
      return { ok: true };
    },
    requestVoiceOff: async (reason) => {
      calls.off += 1;
      calls.offReasons.push(reason === undefined ? 'unspecified' : reason);
      await loop.stop(reason === undefined ? 'voice-command' : reason);
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

// --- assistant streaming (P0 stream-tts) ---------------------------------

function streamStart(turn, attemptId = 'attempt-1', step = 0) {
  return { type: 'start', attemptId, revision: 1, turn, step };
}

/** Real host chunk frames carry attemptId but no turn/step. */
function streamChunk(text, attemptId = 'attempt-1', index = 0) {
  return {
    type: 'chunk',
    attemptId,
    revision: index + 2,
    index,
    time: 0,
    chunk: { type: 'text-delta', index: 0, text },
  };
}

function streamEnd(attemptId = 'attempt-1') {
  return {
    type: 'end',
    attemptId,
    revision: 99,
    index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
  };
}

function spokenTexts(calls) {
  return calls.speak.map((segments) => segments.map((segment) => segment.text).join(' '));
}

function endTurn(harness, turn, text, reasonKind = 'completed') {
  harness.loop.onSessionEvent({
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
  });
  harness.loop.onSessionEvent({ type: 'turn/end', data: { turn, reason: { kind: reasonKind } } });
}

test('stream frames start playback before turn/end and flush the tail once', async () => {
  const harness = makeHarness();
  const { loop, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  loop.onSessionEvent({ type: 'turn/start', data: { turn: 4 } });
  loop.onStreamFrame(streamStart(4));
  assert.equal(loop.state, 'awaiting-reply');

  loop.onStreamFrame({ ...streamChunk('Hello there. '), turn: 4 });
  assert.equal(loop.state, 'speaking', 'first sentence starts the speaking state');
  assert.equal(calls.speak.length, 1);

  loop.onStreamFrame(streamChunk('How are you'));
  assert.equal(calls.speak.length, 1, 'unpunctuated tail waits for the flush');

  endTurn(harness, 4, 'Hello there. How are you');
  await loop.settled();
  assert.equal(loop.state, 'listening');
  assert.deepEqual(spokenTexts(calls), ['Hello there.', 'How are you']);
});

test('real host chunk/end frames without turn are matched to the started attempt', async () => {
  const harness = makeHarness();
  const { loop, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  loop.onSessionEvent({ type: 'turn/start', data: { turn: 2 } });
  loop.onStreamFrame({ type: 'start', attemptId: 'session:1', revision: 1, turn: 2, step: 0 });
  loop.onStreamFrame({ type: 'chunk', attemptId: 'session:1', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'Welcome to practice.' } });
  assert.equal(calls.speak.length, 1);
  loop.onStreamFrame({
    type: 'chunk',
    attemptId: 'session:1',
    revision: 3,
    index: 1,
    chunk: { type: 'reasoning-delta', index: 1, text: 'ignored thinking' },
  });
  loop.onStreamFrame({ type: 'end', attemptId: 'session:1', revision: 4, index: 2, outcome: { kind: 'committed' } });
  assert.deepEqual(spokenTexts(calls), ['Welcome to practice.']);

  endTurn(harness, 2, 'Welcome to practice.');
  await loop.settled();
  assert.equal(loop.state, 'listening');
  assert.equal(calls.speak.length, 1);
});

test('stream frames for another turn, or before start, are ignored', async () => {
  const harness = makeHarness();
  const { loop, calls } = harness;
  await loop.start();
  loop.onStreamFrame(streamStart(6));
  loop.onStreamFrame(streamChunk('Before any reply.'));
  assert.equal(calls.speak.length, 0, 'no playback while listening');

  await driveUtterance(harness);
  loop.onSessionEvent({ type: 'turn/start', data: { turn: 7 } });
  loop.onStreamFrame(streamStart(6));
  loop.onStreamFrame(streamChunk('Wrong turn text.'));
  assert.equal(calls.speak.length, 0, 'frames for an unexpected turn are dropped');

  loop.onStreamFrame(streamStart(7, 'attempt-7'));
  loop.onStreamFrame(streamChunk('Right turn text.', 'attempt-7'));
  assert.equal(calls.speak.length, 1);
  assert.match(spokenTexts(calls)[0], /Right turn text/);

  endTurn(harness, 7, 'Right turn text.');
  await loop.settled();
  assert.equal(loop.state, 'listening');
});

test('without streamed text the whole-reply fallback still speaks once', async () => {
  const harness = makeHarness();
  const { loop, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  loop.onSessionEvent({ type: 'turn/start', data: { turn: 3 } });
  endTurn(harness, 3, 'Fallback reply text.');
  await loop.settled();
  assert.equal(loop.state, 'listening');
  assert.equal(calls.speak.length, 1);
  assert.match(spokenTexts(calls)[0], /Fallback reply text/);
});

test('barge-in cancels streamed playback and keeps capturing', async () => {
  const gate = deferred();
  const harness = makeHarness({ ttsGate: gate });
  const { loop, vadEvents, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  loop.onSessionEvent({ type: 'turn/start', data: { turn: 2 } });
  loop.onStreamFrame(streamStart(2));
  loop.onStreamFrame(streamChunk('A long spoken answer.'));
  assert.equal(loop.state, 'speaking');
  assert.equal(calls.cancel, 0);

  vadEvents.push(SPEECH_START);
  loop.handleAudio(Buffer.alloc(640));
  assert.equal(loop.state, 'capturing');
  assert.equal(calls.cancel, 1, 'barge-in cancels the stream speaker');
  await loop.settled();
  assert.equal(loop.state, 'capturing');
});

test('a streamed turn ending in error stops playback without replaying the reply', async () => {
  const gate = deferred();
  const harness = makeHarness({ ttsGate: gate });
  const { loop, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  loop.onSessionEvent({ type: 'turn/start', data: { turn: 8 } });
  loop.onStreamFrame(streamStart(8));
  loop.onStreamFrame(streamChunk('Partial spoken answer.'));
  assert.equal(calls.speak.length, 1);
  endTurn(harness, 8, 'Partial spoken answer.', 'aborted');
  await waitUntil(() => loop.state === 'listening');
  assert.equal(calls.speak.length, 1, 'whole reply is not replayed after an error');
});

test('three consecutive transcription failures explain in Chinese and leave voice mode', async () => {
  const harness = makeHarness({ stt: () => { throw new Error('stt down'); } });
  const { loop, calls } = harness;
  await loop.start();
  await driveUtterance(harness);
  assert.equal(loop.state, 'listening');
  assert.equal(loop.status().consecutiveFailures, 1);
  await driveUtterance(harness);
  assert.equal(loop.status().consecutiveFailures, 2);
  await driveUtterance(harness);
  assert.equal(calls.off, 1);
  assert.deepEqual(calls.offReasons, ['transcribe-failed']);
  assert.equal(loop.state, 'idle');
  const chinese = calls.speak.filter((segments) => segments[0].lang === 'zh');
  assert.equal(chinese.length, 1);
  assert.match(chinese[0][0].text, /麦克风/);
  assert.match(chinese[0][0].text, /voice on/);
  const english = calls.speak.filter((segments) => segments[0].lang !== 'zh');
  assert.equal(english.length, 1, 'the English apology is spoken only before the third failure');
});

test('a successful transcript resets the consecutive failure counter', async () => {
  let attempts = 0;
  const harness = makeHarness({
    stt: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
      return { text: 'hello there' };
    },
  });
  await harness.loop.start();
  await driveUtterance(harness);
  assert.equal(harness.loop.status().consecutiveFailures, 1);
  await driveUtterance(harness);
  assert.equal(harness.loop.status().consecutiveFailures, 0);
  assert.deepEqual(harness.calls.submit, ['hello there']);
  assert.equal(harness.loop.state, 'awaiting-reply');
});

test('status exposes lastActivityAt, consecutiveFailures and speaking', async () => {
  const gate = deferred();
  const harness = makeHarness({ ttsGate: gate });
  const { loop } = harness;
  await loop.start();
  const initial = loop.status();
  assert.ok(Number.isFinite(initial.lastActivityAt));
  assert.equal(initial.consecutiveFailures, 0);
  assert.equal(initial.speaking, false);

  await driveUtterance(harness);
  assert.ok(loop.status().lastActivityAt >= initial.lastActivityAt);

  loop.onSessionEvent({ type: 'turn/start', data: { turn: 1 } });
  loop.onStreamFrame(streamStart(1));
  loop.onStreamFrame(streamChunk('Status test sentence.'));
  await waitUntil(() => loop.status().speaking === true);
  assert.equal(loop.status().speaking, true);

  endTurn(harness, 1, 'Status test sentence.');
  gate.resolve();
  await loop.settled();
  assert.equal(loop.state, 'listening');
  assert.equal(loop.status().speaking, false);
});

test('announceChinese speaks a Chinese system line with VAD suspended', async () => {
  const harness = makeHarness();
  await harness.loop.start();
  await harness.loop.announceChinese('还在吗？我们可以继续。');
  assert.deepEqual(harness.calls.speak[0], [{ lang: 'zh', text: '还在吗？我们可以继续。' }]);
  assert.deepEqual(harness.vad.suspensions, [true, false]);
});

test('stats hooks receive user/assistant/speech/error events', async () => {
  const seen = { user: [], assistant: [], speech: [], errors: [] };
  const stats = {
    onUserText: (text) => seen.user.push(text),
    onAssistantText: (text) => seen.assistant.push(text),
    onSpeech: (ms) => seen.speech.push(ms),
    onError: (kind) => seen.errors.push(kind),
  };
  const harness = makeHarness({ stats });
  await harness.loop.start();
  await driveUtterance(harness);
  assert.deepEqual(seen.user, ['hello there']);
  assert.equal(seen.speech.length, 1);
  await driveReply(harness, 2, 'Assistant reply.');
  assert.deepEqual(seen.assistant, ['Assistant reply.']);

  const failing = makeHarness({ stats, stt: () => { throw new Error('stt gone'); } });
  await failing.loop.start();
  await driveUtterance(failing);
  assert.deepEqual(seen.errors, ['transcribe']);
});

test('throwing stats hooks never break the loop', async () => {
  const stats = {
    onUserText() { throw new Error('stats user failed'); },
    onAssistantText() { throw new Error('stats assistant failed'); },
    onSpeech() { throw new Error('stats speech failed'); },
    onError() { throw new Error('stats error failed'); },
  };
  let attempts = 0;
  const harness = makeHarness({
    stats,
    stt: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
      return { text: 'hello there' };
    },
  });
  await harness.loop.start();
  await driveUtterance(harness);
  await driveUtterance(harness);
  assert.deepEqual(harness.calls.submit, ['hello there']);
  assert.equal(harness.loop.state, 'awaiting-reply');
});
