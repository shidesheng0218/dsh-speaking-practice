import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceStateMachine, VOICE_STATES } from '../src/core/state.js';

test('voice state machine allows the documented loop', () => {
  const sm = new VoiceStateMachine();
  assert.equal(sm.state, 'idle');
  sm.transition('listening');
  sm.transition('capturing');
  sm.transition('transcribing');
  sm.transition('awaiting-reply');
  sm.transition('speaking');
  sm.transition('listening');
  assert.deepEqual(VOICE_STATES, ['idle', 'listening', 'capturing', 'transcribing', 'awaiting-reply', 'speaking']);
  assert.equal(sm.snapshot().history.length, 6);
});

test('voice state machine rejects illegal transitions', () => {
  const sm = new VoiceStateMachine();
  assert.throws(() => sm.transition('speaking'), /invalid voice state transition/);
  assert.equal(sm.can('listening'), true);
  assert.equal(sm.can('speaking'), false);
  assert.throws(() => sm.transition('nope'), /unknown voice state/);
});

test('force reaches idle from anywhere and notifies listeners', () => {
  const sm = new VoiceStateMachine();
  const seen = [];
  const off = sm.onChange((entry) => seen.push(entry.from + '>' + entry.to));
  sm.transition('listening');
  sm.transition('capturing');
  sm.transition('idle', { force: true, reason: 'test' });
  assert.equal(sm.state, 'idle');
  assert.deepEqual(seen, ['idle>listening', 'listening>capturing', 'capturing>idle']);
  off();
  sm.transition('listening');
  assert.equal(seen.length, 3);
});

test('same-state transition is a no-op', () => {
  const sm = new VoiceStateMachine();
  assert.equal(sm.transition('idle'), 'idle');
  assert.equal(sm.snapshot().history.length, 0);
});
