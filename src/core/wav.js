/**
 * core/wav.js - 16 kHz mono PCM16 WAV construction and validation.
 *
 * Pure module: only Buffer, no DSH imports. The STT service expects a complete
 * 16 kHz mono PCM16 WAV container (see dsh-experimental-api-speech-to-text).
 */

export const PCM_SAMPLE_RATE = 16000;
export const PCM_CHANNELS = 1;
export const PCM_BITS_PER_SAMPLE = 16;

/**
 * Duration of raw PCM bytes in milliseconds.
 * @param {number} pcmBytes byte length of PCM data.
 * @param {number} [sampleRate]
 * @param {number} [channels]
 * @param {number} [bitsPerSample]
 * @returns {number}
 */
export function pcmDurationMs(pcmBytes, sampleRate = PCM_SAMPLE_RATE, channels = PCM_CHANNELS, bitsPerSample = PCM_BITS_PER_SAMPLE) {
  const blockAlign = (bitsPerSample / 8) * channels;
  const frames = Math.floor(Math.max(0, pcmBytes) / blockAlign);
  return (frames / sampleRate) * 1000;
}

/**
 * Build a canonical RIFF/WAVE container around little-endian PCM16 data.
 * @param {Uint8Array|Buffer} pcm raw PCM bytes (odd trailing byte is dropped).
 * @param {{sampleRate?: number, channels?: number, bitsPerSample?: number}} [options]
 * @returns {Buffer} complete WAV file bytes.
 */
export function buildWav(pcm, options = {}) {
  const sampleRate = options.sampleRate ?? PCM_SAMPLE_RATE;
  const channels = options.channels ?? PCM_CHANNELS;
  const bitsPerSample = options.bitsPerSample ?? PCM_BITS_PER_SAMPLE;
  if (bitsPerSample !== 16) throw new Error('buildWav only supports 16-bit PCM');
  const source = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const blockAlign = channels * 2;
  const dataLength = source.length - (source.length % blockAlign);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, source.subarray(0, dataLength)]);
}

/**
 * Parse a WAV header, returning null for anything that is not a PCM16 WAV.
 * Used by tests and by defensive logging in the runtime.
 * @param {Buffer|Uint8Array} bytes
 * @returns {{format:number, channels:number, sampleRate:number, bitsPerSample:number, dataOffset:number, dataLength:number}|null}
 */
export function parseWavHeader(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let format;
  let channels;
  let sampleRate;
  let bitsPerSample;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || body + 16 > buffer.length) return null;
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataLength = Math.min(chunkSize, Math.max(0, buffer.length - body));
      break;
    }
    const next = body + chunkSize + (chunkSize % 2);
    if (next <= offset) return null;
    offset = next;
  }

  if (format === undefined || dataOffset < 0) return null;
  return { format, channels, sampleRate, bitsPerSample, dataOffset, dataLength };
}

/**
 * True when bytes look like a WAV the speech service accepts (16 kHz mono PCM16).
 * @param {Buffer|Uint8Array} bytes
 * @returns {boolean}
 */
export function isSupportedWav(bytes) {
  const header = parseWavHeader(bytes);
  return Boolean(header
    && header.format === 1
    && header.channels === 1
    && header.sampleRate === PCM_SAMPLE_RATE
    && header.bitsPerSample === 16
    && header.dataLength > 0);
}
