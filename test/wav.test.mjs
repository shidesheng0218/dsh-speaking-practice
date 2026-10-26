import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PCM_SAMPLE_RATE,
  buildWav,
  isSupportedWav,
  parseWavHeader,
  pcmDurationMs,
} from '../src/core/wav.js';

test('buildWav writes a canonical 16 kHz mono PCM16 header', () => {
  const pcm = Buffer.alloc(3200);
  const wav = buildWav(pcm);
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), PCM_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 3200);
  const header = parseWavHeader(wav);
  assert.deepEqual(
    { format: header.format, channels: header.channels, sampleRate: header.sampleRate, bits: header.bitsPerSample },
    { format: 1, channels: 1, sampleRate: 16000, bits: 16 },
  );
  assert.equal(header.dataOffset, 44);
  assert.equal(header.dataLength, 3200);
  assert.equal(isSupportedWav(wav), true);
});

test('buildWav drops an odd trailing byte and supports sample-rate overrides', () => {
  const wav = buildWav(Buffer.alloc(641), { sampleRate: 8000, channels: 2 });
  const header = parseWavHeader(wav);
  assert.equal(header.sampleRate, 8000);
  assert.equal(header.channels, 2);
  assert.equal(header.dataLength, 640);
  assert.equal(isSupportedWav(wav), false);
});

test('buildWav rejects non 16-bit input', () => {
  assert.throws(() => buildWav(Buffer.alloc(4), { bitsPerSample: 8 }), /16-bit/);
});

test('pcmDurationMs converts bytes to milliseconds', () => {
  assert.equal(pcmDurationMs(32000), 1000);
  assert.equal(pcmDurationMs(3200), 100);
  assert.equal(pcmDurationMs(0), 0);
});

test('parseWavHeader rejects non-WAV input', () => {
  assert.equal(parseWavHeader(Buffer.from('not a wav')), null);
  assert.equal(parseWavHeader(Buffer.alloc(100)), null);
});
