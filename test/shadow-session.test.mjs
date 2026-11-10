import assert from 'node:assert/strict';
import test from 'node:test';

import { createShadowSession } from '../src/shadow-session.js';

test('shadowSession supports start, replay, focus/tipZh metadata, and stop', async () => {
  const spoken = [];
  const changes = [];
  let micStopped = false;

  const session = createShadowSession({
    config: {},
    speaker: {
      async speak(segments) {
        spoken.push(segments.map((s) => s.text).join(' '));
      },
      async cancel() {},
    },
    createMic: () => ({
      async start() {},
      async stop() {
        micStopped = true;
      },
    }),
    subprocess: {},
    stt: () => ({
      async transcribe() {
        return { text: 'I think this is the third thing I have tried today' };
      },
    }),
    getDrills: async () => ({
      sentences: [
        {
          id: 'drill-01',
          focus: 'th 音',
          text: "I think this is the third thing I've tried today.",
          tipZh: '舌尖轻触上齿，气流从齿缝送出',
        },
      ],
    }),
    onChange: (reason) => changes.push(reason),
  });

  const started = await session.start({ count: 1 });
  assert.equal(started.ok, true);
  assert.equal(started.total, 1);

  const snap = session.getState();
  assert.equal(snap.active, true);
  assert.equal(snap.phase, 'listening');
  assert.equal(snap.focus, 'th 音');
  assert.equal(snap.tipZh, '舌尖轻触上齿，气流从齿缝送出');

  const replayed = await session.replay();
  assert.equal(replayed.ok, true);
  assert.ok(spoken.filter((line) => line.startsWith('Listen:')).length >= 2);
  assert.ok(changes.includes('replay'));

  const stopped = await session.stop('test');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.wasActive, true);
  assert.equal(micStopped, true);
  assert.equal(session.getState().active, false);
});
