/**
 * noiseSuppressor.js
 * Real-time single-channel noise suppression for decoded RTP audio.
 *
 * Runs a streaming STFT: sqrt-Hann analysis/synthesis windows at 50% overlap
 * (the sqrt-Hann choice makes window-squared overlap-add sum to exactly 1,
 * so reconstruction needs no runtime normalization pass), spectral
 * subtraction against a per-bin noise floor, and temporal gain smoothing to
 * curb musical-noise artifacts. The noise floor tracker has no explicit VAD:
 * a bin is classified noise-like (and averaged in quickly) whenever its
 * magnitude stays below a multiple of the current estimate, and leaks up
 * only very slowly otherwise — a plain running minimum was tried first and
 * rejected, since it tracks the bottom of the noise's own fluctuation
 * rather than its mean and ends up barely suppressing anything.
 *
 * One instance is created per (call, sample rate) — 8kHz for PCMU/PCMA,
 * 16kHz for G.722 — inside sipManager.js's RtpBridge.
 */

'use strict';

const { clamp16 } = require('./pcmUtils');

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// In-place iterative radix-2 Cooley-Tukey FFT/IFFT. `re`/`im` length must be
// a power of 2.
function fft(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = (invert ? 2 : -2) * Math.PI / len;
    const wr0  = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + half] * curWr - im[i + j + half] * curWi;
        const vi = re[i + j + half] * curWi + im[i + j + half] * curWr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        const nWr = curWr * wr0 - curWi * wi0;
        const nWi = curWr * wi0 + curWi * wr0;
        curWr = nWr; curWi = nWi;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

const FRAME_MS = 32; // ~32ms analysis window, 50% overlap -> 16ms hop

class NoiseSuppressor {
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.frameSize  = nextPow2(Math.round(sampleRate * FRAME_MS / 1000));
    this.hop        = this.frameSize / 2;
    this.numBins    = this.frameSize / 2 + 1;

    this.overSubtraction = opts.overSubtraction ?? 2.0;  // spectral subtraction over-subtraction factor
    this.gainFloor        = opts.gainFloor ?? 0.15;        // -16.5dB floor, avoids harsh musical noise
    // Per-bin noise floor tracker: a bin only updates the estimate when its
    // current magnitude looks noise-like (below `speechThreshold` times the
    // existing estimate); a literal running minimum systematically
    // underestimates the true noise level (it chases the bottom of the
    // fluctuation, not its mean), so bins classified as noise are instead
    // averaged in — fast (`noiseSmoothing`) — while bins classified as
    // speech leak upward only very slowly (`speechLeak`), so a sustained
    // syllable can't get mistaken for a rising noise floor.
    this.speechThreshold  = opts.speechThreshold  ?? 2.0;
    this.noiseSmoothing   = opts.noiseSmoothing   ?? 0.9;
    this.speechLeak        = opts.speechLeak        ?? 0.999;
    this.gainSmoothing     = opts.gainSmoothing ?? 0.6;      // per-bin temporal gain smoothing

    // Periodic sqrt-Hann: squares to a periodic Hann, whose 50%-overlap
    // sum is exactly 1 — so overlap-add reconstruction needs no normalization.
    this.window = new Float32Array(this.frameSize);
    for (let i = 0; i < this.frameSize; i++) {
      this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.frameSize));
    }

    this.inBuf    = new Float32Array(this.frameSize);  // sliding analysis window
    this.olaBuf   = new Float32Array(this.frameSize);  // overlap-add accumulator
    // Scratch FFT buffers, reused every hop (fully overwritten each call)
    // instead of allocated fresh — this runs on the RTP receive hot path.
    this._re      = new Float32Array(this.frameSize);
    this._im      = new Float32Array(this.frameSize);
    this.noiseMag = new Float32Array(this.numBins);
    this.prevGain = new Float32Array(this.numBins).fill(1);
    // Seeded from the first frame's magnitude, since starting at 0 makes
    // "mag < noiseMag * speechThreshold" false forever (0 * threshold is
    // still 0) — the fast noise-averaging branch below would never fire
    // and the estimate would be stuck crawling up on the slow speech-leak
    // branch instead. A one-frame bootstrap cost is fine in practice.
    this._seeded  = false;

    this._pending = [];  // queued incoming samples (float, [-1,1]) not yet hop-aligned
    // A trailing byte left over when a call's buffer has an odd length —
    // stdout chunks from the G.722 decoder's ffmpeg subprocess are plain
    // pipe reads and aren't guaranteed to land on 2-byte sample boundaries.
    // Carried into the next call and prepended there, rather than dropped
    // (or read out of bounds, which throws).
    this._oddByte = null;

    this.enabled = opts.enabled !== false;
  }

  setEnabled(v) {
    this.enabled = !!v;
    // Discard rather than carry across a disable — otherwise it gets
    // prepended to the next enabled call's chunk once re-enabled, which may
    // be from an unrelated point in the stream, permanently shifting every
    // subsequent sample boundary for the rest of the call.
    if (!this.enabled) this._oddByte = null;
  }

  // process(Buffer int16 LE) -> Buffer int16 LE
  // Output is hop-quantized: may be shorter or longer than the input per
  // call (buffering introduces a fixed ~1 hop of latency), but drains at
  // the same long-run rate as it's fed. Callers treat both sides as a
  // continuous PCM stream, not fixed-size packets — including across the
  // 2-byte sample boundary, per the odd-byte handling below.
  process(pcmBuf) {
    if (!this.enabled) return pcmBuf;

    if (this._oddByte !== null) {
      pcmBuf = Buffer.concat([this._oddByte, pcmBuf]);
      this._oddByte = null;
    }
    if (pcmBuf.length % 2 === 1) {
      this._oddByte = pcmBuf.slice(pcmBuf.length - 1);
      pcmBuf = pcmBuf.slice(0, pcmBuf.length - 1);
    }

    const inSamples = pcmBuf.length / 2;
    for (let i = 0; i < inSamples; i++) {
      this._pending.push(pcmBuf.readInt16LE(i * 2) / 32768);
    }

    const outChunks = [];
    while (this._pending.length >= this.hop) {
      const hopSamples = this._pending.splice(0, this.hop);
      outChunks.push(this._processHop(hopSamples));
    }
    if (outChunks.length === 0) return Buffer.alloc(0);

    let total = 0;
    for (const c of outChunks) total += c.length;
    const out = Buffer.alloc(total * 2);
    let off = 0;
    for (const chunk of outChunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = clamp16(Math.round(chunk[i] * 32768));
        out.writeInt16LE(s, off);
        off += 2;
      }
    }
    return out;
  }

  _processHop(hopSamples) {
    const N = this.frameSize, hop = this.hop;

    this.inBuf.copyWithin(0, hop);
    for (let i = 0; i < hop; i++) this.inBuf[N - hop + i] = hopSamples[i];

    const re = this._re, im = this._im;
    for (let i = 0; i < N; i++) { re[i] = this.inBuf[i] * this.window[i]; im[i] = 0; }

    fft(re, im, false);

    const halfN = N / 2;
    for (let b = 0; b < this.numBins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);

      if (!this._seeded) {
        this.noiseMag[b] = mag;
      } else if (mag < this.noiseMag[b] * this.speechThreshold) {
        this.noiseMag[b] = this.noiseMag[b] * this.noiseSmoothing + mag * (1 - this.noiseSmoothing);
      } else {
        this.noiseMag[b] = this.noiseMag[b] * this.speechLeak + mag * (1 - this.speechLeak);
      }

      let gain = 1;
      if (mag > 1e-8) {
        gain = 1 - this.overSubtraction * (this.noiseMag[b] / mag);
        if (gain < this.gainFloor) gain = this.gainFloor;
        else if (gain > 1) gain = 1;
      }
      gain = this.prevGain[b] * this.gainSmoothing + gain * (1 - this.gainSmoothing);
      this.prevGain[b] = gain;

      re[b] *= gain; im[b] *= gain;
      if (b > 0 && b < halfN) {
        const mb = N - b;
        re[mb] = re[b]; im[mb] = -im[b];
      }
    }
    this._seeded = true;

    fft(re, im, true);

    for (let i = 0; i < N; i++) this.olaBuf[i] += re[i] * this.window[i];

    const out = this.olaBuf.slice(0, hop);
    this.olaBuf.copyWithin(0, hop);
    this.olaBuf.fill(0, N - hop, N);
    return out;
  }
}

module.exports = { NoiseSuppressor };
