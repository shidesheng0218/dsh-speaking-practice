export const SAMPLE_RATE = 16000;
export const FRAME_BYTES = 640;
export function silencePcm(durationMs, sampleRate = SAMPLE_RATE) {
  return Buffer.alloc(Math.round((durationMs / 1000) * sampleRate) * 2);
}
export function tonePcm(durationMs, amplitude = 0.1, sampleRate = SAMPLE_RATE) {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const buffer = Buffer.alloc(samples * 2);
  const value = Math.max(1, Math.round(amplitude * 32767));
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(index % 2 === 0 ? value : -value, index * 2);
  }
  return buffer;
}
export function concatPcm(...buffers) {
  return Buffer.concat(buffers);
}
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
export const silentLog = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function waitUntil(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  const intervalMs = options.intervalMs ?? 5;
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil timed out');
    await sleep(intervalMs);
  }
}
