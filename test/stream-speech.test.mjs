import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamSpeaker, findSentenceBoundary } from '../src/core/stream-speech.js';
import { deferred, silentLog, waitUntil } from './support.mjs';

/** Fake TTS adapter that records speak() calls and can gate/flake playback. */
function makeFakeTts(options = {}) {
  const calls = { speak: [], metas: [], cancel: 0 };
  const gate = options.gate ?? null;
  const hook = typeof options.speak === 'function' ? options.speak : null;
  let active = 0;
  const tts = {
    calls,
    get speaking() {
      return active > 0;
    },
    async speak(segments, meta) {
      calls.speak.push(segments);
      calls.metas.push(meta);
      active += 1;
      try {
        if (hook !== null) await hook(segments, calls.speak.length);
        if (gate !== null) await gate.promise;
        return { cancelled: false, spoken: segments.length };
      } finally {
        active -= 1;
      }
    },
    async cancel() {
      calls.cancel += 1;
      if (gate !== null) gate.resolve();
    },
  };
  return tts;
}

function spoken(calls) {
  return calls.speak.map((segments) => segments.map((segment) => segment.text).join(' '));
}

test('findSentenceBoundary splits at punctuation followed by whitespace or end', () => {
  assert.equal(findSentenceBoundary('Hello there. How'), 12);
  assert.equal(findSentenceBoundary('Wait!'), 5);
  assert.equal(findSentenceBoundary('Line one\nMore'), 9);
  assert.equal(findSentenceBoundary('你好。世界'), 3);
  assert.equal(findSentenceBoundary('No boundary yet'), null);
  assert.equal(findSentenceBoundary('Value 3.14 is pi'), null);
  assert.equal(findSentenceBoundary(''), null);
});

test('pushText speaks each completed sentence before the rest arrives', async () => {
  const tts = makeFakeTts();
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('Hello there.');
  assert.deepEqual(spoken(tts.calls), ['Hello there.']);
  speaker.pushText(' How are');
  assert.equal(tts.calls.speak.length, 1, 'partial sentence is buffered, not spoken');
  const flushed = speaker.flush();
  await flushed;
  assert.deepEqual(spoken(tts.calls), ['Hello there.', 'How are']);
  assert.ok(speaker.spokenText.includes('Hello there.'));
  assert.ok(speaker.spokenText.includes('How are'));
  assert.equal(speaker.speaking, false);
});

test('a sentence dot needs whitespace or end-of-buffer to start playback', async () => {
  const tts = makeFakeTts();
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('This costs 3.14');
  assert.equal(tts.calls.speak.length, 0);
  speaker.pushText(' dollars. ');
  assert.equal(tts.calls.speak.length, 1);
  assert.match(spoken(tts.calls)[0], /^This costs 3\./);
  assert.match(spoken(tts.calls)[0], /dollars\.$/);
  assert.equal(tts.calls.speak[0][0].lang, 'en');
  await speaker.flush();
});

test('long unpunctuated text is hard-cut near maxSentenceChars', async () => {
  const tts = makeFakeTts();
  const speaker = createStreamSpeaker({ tts, log: silentLog, maxSentenceChars: 40 });
  speaker.pushText('word '.repeat(20));
  await speaker.flush();
  assert.ok(tts.calls.speak.length >= 2, 'long buffer was split');
  const pieces = tts.calls.speak.map((segments) => segments.map((segment) => segment.text).join(' '));
  for (const piece of pieces) {
    assert.ok(piece.length <= 40, 'piece stays within maxSentenceChars: ' + piece.length);
  }
  assert.equal(pieces.join(' ').split(/\s+/).filter((word) => word === 'word').length, 20);
});

test('short fragments are held back and merged into the next segment', async () => {
  const tts = makeFakeTts();
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('OK. ');
  assert.equal(tts.calls.speak.length, 0, 'short sentence waits for a partner');
  speaker.pushText('That is interesting. ');
  assert.equal(tts.calls.speak.length, 1);
  assert.match(spoken(tts.calls)[0], /OK\. That is interesting\./);
  await speaker.flush();
});

test('segments play strictly in order, one at a time', async () => {
  const gate = deferred();
  const events = [];
  const tts = makeFakeTts({ gate, speak: () => events.push('speak') });
  const speaker = createStreamSpeaker({
    tts,
    log: silentLog,
    onBeforeSpeak: () => events.push('before'),
  });
  speaker.pushText('First sentence. ');
  speaker.pushText('Second sentence. ');
  assert.equal(tts.calls.speak.length, 1, 'second segment waits for the first');
  assert.deepEqual(events, ['before', 'speak']);
  gate.resolve();
  await waitUntil(() => tts.calls.speak.length === 2);
  await speaker.flush();
  assert.deepEqual(spoken(tts.calls), ['First sentence.', 'Second sentence.']);
  assert.deepEqual(events, ['before', 'speak', 'before', 'speak']);
});

test('cancel drops queued segments, stops the active one and invalidates late pushes', async () => {
  const gate = deferred();
  const tts = makeFakeTts({ gate });
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('First sentence. ');
  speaker.pushText('Second sentence. ');
  assert.equal(tts.calls.cancel, 0);
  const cancelled = speaker.cancel();
  await cancelled;
  assert.equal(tts.calls.cancel, 1);
  assert.equal(tts.calls.speak.length, 1, 'queued second segment never started');
  assert.equal(speaker.spokenText, '');
  speaker.pushText('Third sentence. ');
  await speaker.flush();
  assert.equal(tts.calls.speak.length, 1, 'pushes after cancel are discarded');
  assert.equal(speaker.speaking, false);
});

test('one failing segment is logged and playback continues', async () => {
  const tts = makeFakeTts({
    speak: (_segments, index) => {
      if (index === 1) throw new Error('say exploded');
    },
  });
  const warnings = [];
  const log = {
    debug() {},
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error() {},
  };
  const speaker = createStreamSpeaker({ tts, log });
  speaker.pushText('First sentence. ');
  speaker.pushText('Second sentence. ');
  await speaker.flush();
  assert.equal(tts.calls.speak.length, 2);
  assert.match(spoken(tts.calls)[1], /Second sentence\./);
  assert.ok(warnings.some((line) => /say exploded/.test(line)));
});

test('flush speaks the unpunctuated tail and resolves after playback', async () => {
  const gate = deferred();
  const tts = makeFakeTts({ gate });
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('Hello there');
  assert.equal(tts.calls.speak.length, 0);
  let settled = false;
  const flushed = speaker.flush().then(() => {
    settled = true;
  });
  await waitUntil(() => tts.calls.speak.length === 1);
  assert.equal(settled, false, 'flush waits for the queued audio');
  gate.resolve();
  await flushed;
  assert.deepEqual(spoken(tts.calls), ['Hello there']);
});

test('reset clears buffered and queued text for the next attempt', async () => {
  const tts = makeFakeTts();
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('Leftover before reset');
  speaker.reset();
  assert.equal(speaker.spokenText, '');
  await speaker.flush();
  assert.equal(tts.calls.speak.length, 0);
  speaker.pushText('Fresh attempt text.');
  await speaker.flush();
  assert.deepEqual(spoken(tts.calls), ['Fresh attempt text.']);
});

test('spokenText and speaking reflect queued work', async () => {
  const gate = deferred();
  const tts = makeFakeTts({ gate });
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('Hello there.');
  assert.equal(speaker.speaking, true);
  assert.ok(speaker.spokenText.includes('Hello there.'));
  gate.resolve();
  await speaker.flush();
  assert.equal(speaker.speaking, false);
});

test('Chinese sentences are classified for the Chinese voice', async () => {
  const tts = makeFakeTts();
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('你好，世界。');
  await speaker.flush();
  assert.equal(tts.calls.speak.length, 1);
  assert.equal(tts.calls.speak[0][0].lang, 'zh');
  assert.match(tts.calls.speak[0][0].text, /你好/);
});

test('dispose cancels an active segment and makes later calls safe', async () => {
  const gate = deferred();
  const tts = makeFakeTts({ gate });
  const speaker = createStreamSpeaker({ tts, log: silentLog });
  speaker.pushText('First sentence.');
  const disposed = speaker.dispose();
  gate.resolve();
  await disposed;
  assert.equal(tts.calls.cancel, 1);
  speaker.pushText('Late sentence. ');
  await speaker.flush();
  assert.equal(tts.calls.speak.length, 1);
  await speaker.dispose();
  assert.equal(tts.calls.cancel, 1, 'dispose is idempotent');
});

test('invalid options are rejected', () => {
  assert.throws(() => createStreamSpeaker(), TypeError);
  assert.throws(() => createStreamSpeaker({ tts: {} }), TypeError);
});
