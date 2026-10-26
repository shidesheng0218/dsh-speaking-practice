import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad, rmsDbFromPcm16 } from '../src/core/vad.js';
import { concatPcm, silencePcm, tonePcm } from './support.mjs';

function feed(vad, pcm, chunkBytes = 1000) {
  const events = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    events.push(...vad.push(pcm.subarray(offset, offset + chunkBytes)));
  }
  return events;
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (label ?? 'value') + ' expected ~' + expected + ' +/-' + tolerance + ' but got ' + actual,
  );
}

test('rmsDbFromPcm16 measures dBFS', () => {
  assert.equal(rmsDbFromPcm16(Buffer.alloc(0)), -120);
  assert.equal(rmsDbFromPcm16(silencePcm(20)), -120);
  near(rmsDbFromPcm16(tonePcm(100, 0.1)), -20, 0.2, 'tone');
});

test('pure silence produces no utterance but does calibrate', () => {
  const vad = new EnergyVad();
  const events = feed(vad, silencePcm(2000));
  events.push(...vad.flush());
  assert.equal(events.filter((event) => event.type === 'utterance').length, 0);
  const calibrated = events.find((event) => event.type === 'calibrated');
  assert.ok(calibrated);
  assert.equal(vad.calibrated, true);
  assert.ok(vad.thresholdDb >= -45 && vad.thresholdDb <= -20);
});

test('detects one utterance with pre-roll, hangover and speech span', () => {
  const vad = new EnergyVad({ silenceMs: 600, minSpeechMs: 200 });
  const pcm = concatPcm(silencePcm(500), tonePcm(1000), silencePcm(1200));
  const events = feed(vad, pcm);
  const start = events.find((event) => event.type === 'speech-start');
  const utterance = events.find((event) => event.type === 'utterance');
  assert.ok(start, 'speech-start event');
  assert.ok(utterance, 'utterance event');
  near(start.timeMs, 500, 40, 'onset time');
  near(utterance.speechMs, 1000, 60, 'speechMs');
  assert.ok(utterance.startTimeMs <= 500, 'pre-roll included in utterance');
  assert.ok(utterance.durationMs >= 1600, 'hangover tail included in utterance');
  assert.equal(utterance.reason, 'silence');
  assert.equal(utterance.pcm.length, utterance.frameCount * 640);
  assert.equal(vad.getStats().utterances, 1);
});

test('a short click is discarded as too-short', () => {
  const vad = new EnergyVad({ silenceMs: 600, minSpeechMs: 200 });
  const events = feed(vad, concatPcm(silencePcm(500), tonePcm(60), silencePcm(1000)));
  const discarded = events.find((event) => event.type === 'discarded');
  assert.ok(discarded, 'discarded event');
  assert.equal(discarded.reason, 'too-short');
  assert.equal(events.filter((event) => event.type === 'utterance').length, 0);
  assert.equal(vad.getStats().discarded, 1);
});

test('maxUtteranceSec forces an endpoint', () => {
  const vad = new EnergyVad({ maxUtteranceSec: 1, silenceMs: 600 });
  const events = feed(vad, concatPcm(silencePcm(400), tonePcm(3000)));
  const utterance = events.find((event) => event.type === 'utterance');
  assert.ok(utterance, 'utterance event');
  assert.equal(utterance.reason, 'max-duration');
  near(utterance.durationMs, 1000, 80, 'forced duration');
});

test('flush finalizes an in-progress utterance', () => {
  const vad = new EnergyVad({ silenceMs: 600 });
  const events = feed(vad, concatPcm(silencePcm(400), tonePcm(500)));
  const utterance = events.find((event) => event.type === 'utterance');
  assert.equal(utterance, undefined);
  const flushed = vad.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].type, 'utterance');
  assert.equal(flushed[0].reason, 'flush');
  assert.ok(flushed[0].speechMs >= 400);
});

test('suppress() ignores detection for the requested window', () => {
  const vad = new EnergyVad({ silenceMs: 600 });
  feed(vad, silencePcm(500));
  vad.suppress(1000);
  const events = feed(vad, concatPcm(tonePcm(300), silencePcm(1200)));
  assert.equal(events.filter((event) => event.type === 'utterance').length, 0);
  assert.equal(vad.state, 'silence');
});

test('calibrates to a loud ambient floor and still detects louder speech', () => {
  const vad = new EnergyVad({ silenceMs: 600 });
  const events = feed(vad, concatPcm(tonePcm(400, 0.003), tonePcm(600, 0.1), silencePcm(1000)));
  const calibrated = events.find((event) => event.type === 'calibrated');
  assert.ok(calibrated);
  assert.ok(calibrated.thresholdDb > -45, 'relative threshold raised above absolute floor');
  assert.ok(events.some((event) => event.type === 'utterance'));
});

test('push tolerates odd byte chunks and empty input', () => {
  const vad = new EnergyVad();
  assert.deepEqual(vad.push(Buffer.alloc(0)), []);
  assert.doesNotThrow(() => feed(vad, silencePcm(200), 641));
});
