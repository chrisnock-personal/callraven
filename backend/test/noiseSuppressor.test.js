'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NoiseSuppressor } = require('../noiseSuppressor.js');

function rms(samples) {
  let sumSquares = 0;
  for (const v of samples) sumSquares += v * v;
  return Math.sqrt(sumSquares / samples.length);
}

function bufferRms(buf) {
  const samples = [];
  for (let i = 0; i < buf.length; i += 2) samples.push(buf.readInt16LE(i));
  return rms(samples);
}

// A fixed multi-tone waveform used as stand-in "stationary noise" content —
// deterministic (no PRNG) so tests are reproducible, and rich enough
// spectrally to exercise most FFT bins.
function makeWave(hop) {
  const wave = new Array(hop);
  for (let i = 0; i < hop; i++) {
    wave[i] = 0.22 * Math.sin(2 * Math.PI * i * 0.13)
            + 0.12 * Math.sin(2 * Math.PI * i * 0.071)
            + 0.08 * Math.sin(2 * Math.PI * i * 0.29);
  }
  return wave;
}

function waveToBuffer(wave) {
  const buf = Buffer.alloc(wave.length * 2);
  for (let i = 0; i < wave.length; i++) buf.writeInt16LE(Math.round(wave[i] * 32767), i * 2);
  return buf;
}

test('frame/hop sizing derives from a 32ms analysis window at the given sample rate', () => {
  const ns8 = new NoiseSuppressor(8000);
  assert.equal(ns8.frameSize, 256);
  assert.equal(ns8.hop, 128);
  assert.equal(ns8.numBins, 129);

  const ns16 = new NoiseSuppressor(16000);
  assert.equal(ns16.frameSize, 512);
  assert.equal(ns16.hop, 256);
  assert.equal(ns16.numBins, 257);
});

test('process() is a no-op passthrough when disabled', () => {
  const ns = new NoiseSuppressor(8000, { enabled: false });
  const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = ns.process(buf);
  assert.equal(out, buf);
});

test('process() buffers input shorter than one hop and emits nothing yet', () => {
  const ns = new NoiseSuppressor(8000); // hop = 128 samples
  const buf = Buffer.alloc(100 * 2); // 100 samples < hop
  const out = ns.process(buf);
  assert.equal(out.length, 0);
  assert.equal(ns._pending.length, 100);
});

test('feeding an exact multiple of the hop size drains everything in one call', () => {
  const ns = new NoiseSuppressor(8000);
  const buf = Buffer.alloc(ns.hop * 5 * 2);
  const out = ns.process(buf);
  assert.equal(out.length, buf.length);
  assert.equal(ns._pending.length, 0);
});

test('odd-length input chunks are carried across calls without sample loss or corruption', () => {
  // Mirrors the real bug: ffmpeg's G.722 decoder stdout chunks aren't
  // guaranteed to land on 2-byte sample boundaries. Feed a mix of odd- and
  // even-length chunks and verify every byte is accounted for.
  const ns = new NoiseSuppressor(8000);
  const chunkByteLengths = [257, 128, 1, 300, 2, 511, 4, 1, 1];
  let totalBytesFed = 0;
  let totalOutputBytes = 0;

  for (const len of chunkByteLengths) {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = (i * 37 + len) & 0xff;
    totalBytesFed += len;
    assert.doesNotThrow(() => {
      totalOutputBytes += ns.process(buf).length;
    });
  }

  const pendingBytes = ns._pending.length * 2;
  const oddByteBytes = ns._oddByte ? 1 : 0;
  assert.equal(totalOutputBytes + pendingBytes + oddByteBytes, totalBytesFed);
});

test('disabling clears a pending trailing odd byte instead of carrying it across the gap', () => {
  const ns = new NoiseSuppressor(8000);
  ns.process(Buffer.alloc(5)); // odd length -> leaves 1 byte pending
  assert.notEqual(ns._oddByte, null);
  ns.setEnabled(false);
  assert.equal(ns._oddByte, null);
});

test('silent input produces silent output with no NaN drift', () => {
  const ns = new NoiseSuppressor(8000);
  let out;
  for (let i = 0; i < 5; i++) {
    out = ns.process(Buffer.alloc(ns.hop * 2)); // all-zero samples
  }
  for (let i = 0; i < out.length; i += 2) {
    assert.equal(out.readInt16LE(i), 0);
  }
});

test('full-scale square-wave input never throws and stays within int16 range', () => {
  const ns = new NoiseSuppressor(8000);
  const buf = Buffer.alloc(ns.hop * 2);
  for (let i = 0; i < ns.hop; i++) buf.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);

  for (let i = 0; i < 50; i++) {
    const out = ns.process(buf);
    for (let j = 0; j < out.length; j += 2) {
      const v = out.readInt16LE(j);
      assert.ok(Number.isFinite(v));
      assert.ok(v >= -32768 && v <= 32767);
    }
  }
});

test('the first output hop is near-silent — analysis/synthesis buffering costs one hop of latency', () => {
  const ns = new NoiseSuppressor(8000);
  const buf = waveToBuffer(makeWave(ns.hop));
  const out = ns.process(buf);
  assert.ok(bufferRms(out) < 50, `expected near-silent first hop, got RMS ${bufferRms(out)}`);
});

test('sustained stationary content is suppressed toward the configured gain floor', () => {
  const gainFloor = 0.15;
  const ns = new NoiseSuppressor(8000, { gainFloor });
  const wave = makeWave(ns.hop);
  const buf = waveToBuffer(wave);
  const inputRms = rms(wave.map((v) => v * 32767));

  let out;
  for (let i = 0; i < 300; i++) out = ns.process(buf);

  const ratio = bufferRms(out) / inputRms;
  assert.ok(ratio > 0.08 && ratio < 0.28, `expected gain to converge near floor ${gainFloor}, got ratio ${ratio}`);
});

test('re-enabling after disable resumes processing without throwing', () => {
  const ns = new NoiseSuppressor(8000);
  ns.process(Buffer.alloc(5)); // leaves an odd trailing byte pending
  ns.setEnabled(false);

  const passthrough = ns.process(Buffer.alloc(10));
  assert.equal(passthrough.length, 10); // disabled: unmodified passthrough

  ns.setEnabled(true);
  assert.doesNotThrow(() => ns.process(Buffer.alloc(ns.hop * 2)));
});
