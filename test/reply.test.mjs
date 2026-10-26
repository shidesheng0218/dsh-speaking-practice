import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyTracker } from '../src/core/reply.js';

test('reply tracker binds the first turn and accumulates its assistant text', () => {
  const tracker = new ReplyTracker();
  tracker.begin('hello');
  assert.equal(tracker.active, true);
  assert.equal(tracker.onAssistantText(1, 'ignored before turn start'), false);
  assert.equal(tracker.onTurnStart(3), true);
  assert.equal(tracker.turn, 3);
  assert.equal(tracker.onAssistantText(2, 'wrong turn'), false);
  assert.equal(tracker.onAssistantText(3, 'Hello.'), true);
  assert.equal(tracker.onAssistantText(3, 'How are you?'), true);
  const result = tracker.onTurnEnd(3, 'completed');
  assert.equal(result.turn, 3);
  assert.equal(result.reasonKind, 'completed');
  assert.equal(result.text, 'Hello.\nHow are you?');
  assert.equal(result.submittedText, 'hello');
  assert.equal(tracker.active, false);
  assert.equal(tracker.onTurnEnd(3, 'completed'), null);
});

test('reply tracker expires submissions that never got a turn', () => {
  let now = 1000;
  const tracker = new ReplyTracker({ now: () => now, maxWaitMs: 1000 });
  tracker.begin('x');
  assert.equal(tracker.isExpired(), false);
  now = 2001;
  assert.equal(tracker.isExpired(), true);
  tracker.onTurnStart(1);
  assert.equal(tracker.isExpired(), false);
  tracker.reset();
  assert.equal(tracker.active, false);
});
