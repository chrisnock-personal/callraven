'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EchoCanceller } = require('../echoCanceller.js');

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

// A fixed multi-tone waveform — deterministic (no PRNG, matching this
// project's noiseSuppressor.test.js convention) but spectrally rich
// enough (several incommensurate frequencies) for an adaptive filter to
// actually have something to converge against.
function makeWave(n, amp = 0.5) {
  const wave = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    wave[i] = amp * (
      0.5 * Math.sin(2 * Math.PI * i * 0.071)
    + 0.3 * Math.sin(2 * Math.PI * i * 0.133)
    + 0.2 * Math.sin(2 * Math.PI * i * 0.211)
    );
  }
  return wave;
}

function waveToBuffer(wave) {
  const buf = Buffer.alloc(wave.length * 2);
  for (let i = 0; i < wave.length; i++) {
    const clamped = Math.max(-1, Math.min(1, wave[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

// Simulates a hybrid/line echo path: a delayed, attenuated copy of the
// reference — exactly the kind of echo GH issue #11 describes (not
// acoustic reverberation, a single dominant reflection).
function makeEcho(refWave, delaySamples, gain) {
  const echo = new Float32Array(refWave.length);
  for (let i = 0; i < refWave.length; i++) {
    echo[i] = i >= delaySamples ? gain * refWave[i - delaySamples] : 0;
  }
  return echo;
}

const SAMPLE_RATE = 16000;
const TAIL_MS      = 8; // 128 taps — short tail keeps tests fast; delay below stays well inside it

test('tapCount derives from tailMs and sampleRate', () => {
  const ec = new EchoCanceller({ sampleRate: 16000, tailMs: 64 });
  assert.equal(ec.tapCount, 1024);
  const ec8 = new EchoCanceller({ sampleRate: 8000, tailMs: 64 });
  assert.equal(ec8.tapCount, 512);
});

test('process() is a no-op passthrough when disabled', () => {
  const ec = new EchoCanceller({ enabled: false });
  const rx = waveToBuffer(makeWave(500));
  const ref = waveToBuffer(makeWave(500));
  assert.equal(ec.process(rx, ref), rx);
});

test('converges to substantially reduce a delayed, attenuated echo of the reference', () => {
  const ec = new EchoCanceller({ sampleRate: SAMPLE_RATE, tailMs: TAIL_MS });
  const n = 20000;
  const refWave  = makeWave(n);
  const echoWave = makeEcho(refWave, 40, 0.35); // 2.5ms delay, -9dB — well inside the 8ms tail

  const refBuf = waveToBuffer(refWave);
  const rxBuf  = waveToBuffer(echoWave);

  const chunkSize = 160; // 10ms chunks, like a real decoded RTP packet
  let lastResidual;
  for (let off = 0; off < n; off += chunkSize) {
    const len = Math.min(chunkSize, n - off);
    const rxChunk  = rxBuf.subarray(off * 2, (off + len) * 2);
    const refChunk = refBuf.subarray(off * 2, (off + len) * 2);
    lastResidual = ec.process(rxChunk, refChunk);
  }

  // Compare RMS of the residual over the final chunk (post-convergence)
  // against the RMS of the raw echo over the same span — both measured
  // in the same int16 domain for a fair comparison.
  const finalOffset = n - chunkSize;
  const rawEchoTail = echoWave.subarray(finalOffset, n);
  const residualRms = bufferRms(lastResidual);
  const rawEchoRms   = bufferRms(waveToBuffer(rawEchoTail));

  assert.ok(residualRms < rawEchoRms * 0.3,
    `expected residual RMS (${residualRms.toFixed(1)}) to drop well below raw echo RMS (${rawEchoRms.toFixed(1)}) after convergence`);
});

test('leaves an uncorrelated near-end signal (no real echo) close to unchanged', () => {
  const ec = new EchoCanceller({ sampleRate: SAMPLE_RATE, tailMs: TAIL_MS });
  const n = 4000;
  const refWave = makeWave(n, 0.4);
  // A near-end signal with different frequencies than the reference —
  // essentially uncorrelated, i.e. not an echo of what we're sending.
  const nearEndWave = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    nearEndWave[i] = 0.4 * Math.sin(2 * Math.PI * i * 0.037) + 0.2 * Math.sin(2 * Math.PI * i * 0.29);
  }

  const refBuf = waveToBuffer(refWave);
  const rxBuf  = waveToBuffer(nearEndWave);
  const out = ec.process(rxBuf, refBuf);

  const inRms  = bufferRms(rxBuf);
  const outRms = bufferRms(out);
  assert.ok(outRms > inRms * 0.85,
    `expected uncorrelated near-end content to pass through largely unchanged (in=${inRms.toFixed(1)}, out=${outRms.toFixed(1)})`);
});

test('double-talk: a loud near-end burst does not make the filter diverge', () => {
  const ec = new EchoCanceller({ sampleRate: SAMPLE_RATE, tailMs: TAIL_MS });
  const n = 8000;
  const refWave  = makeWave(n);
  const echoWave = makeEcho(refWave, 20, 0.35);

  // Converge on echo-only content first.
  const refBuf1 = waveToBuffer(refWave.subarray(0, n / 2));
  const rxBuf1  = waveToBuffer(echoWave.subarray(0, n / 2));
  ec.process(rxBuf1, refBuf1);

  // Now inject a loud, uncorrelated near-end burst on top of the ongoing echo.
  const burst = new Float32Array(n / 2);
  for (let i = 0; i < burst.length; i++) {
    burst[i] = echoWave[n / 2 + i] + 0.6 * Math.sin(2 * Math.PI * i * 0.31);
  }
  const refBuf2 = waveToBuffer(refWave.subarray(n / 2));
  const rxBuf2  = waveToBuffer(burst);
  ec.process(rxBuf2, refBuf2);

  for (const w of ec.weights) {
    assert.ok(Number.isFinite(w), 'filter weights must stay finite through a double-talk burst');
  }
  const weightNorm = Math.sqrt(ec.weights.reduce((s, w) => s + w * w, 0));
  assert.ok(weightNorm < 10, `filter weights should stay bounded, not diverge (norm=${weightNorm.toFixed(2)})`);
});

test('reset() clears filter and history state', () => {
  const ec = new EchoCanceller({ sampleRate: SAMPLE_RATE, tailMs: TAIL_MS });
  const refWave = makeWave(2000);
  const echoWave = makeEcho(refWave, 20, 0.35);
  ec.process(waveToBuffer(echoWave), waveToBuffer(refWave));

  assert.ok(ec.weights.some((w) => w !== 0), 'sanity check: filter should have adapted before reset');
  ec.reset();
  assert.ok(ec.weights.every((w) => w === 0));
  assert.ok(ec.history.every((h) => h === 0));
  assert.equal(ec.historyEnergy, 0);
  assert.equal(ec.refEnvelope, 0);
});

test('a reference shorter than the rx chunk is treated as silence, not an error', () => {
  const ec = new EchoCanceller({ sampleRate: SAMPLE_RATE, tailMs: TAIL_MS });
  const rx  = waveToBuffer(makeWave(200));
  const ref = waveToBuffer(makeWave(50)); // shorter than rx
  assert.doesNotThrow(() => ec.process(rx, ref));
});
