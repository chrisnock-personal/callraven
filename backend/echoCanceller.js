'use strict';

// A line/hybrid echo canceller for the RTP receive path — NOT acoustic
// echo cancellation (CallRaven has no microphone/speaker of its own).
// The only outbound audio this project ever transmits is WAV playback
// (see RtpBridge.playWav in sipManager.js), so the only echo scenario is
// that playback signal bouncing back via an analog gateway/PBX hybrid
// elsewhere in the call path. The reference signal fed to process() is
// therefore CallRaven's own outbound playback audio, precomputed once at
// WAV-upload time (see server.js's .refpcm16k sibling file) rather than
// decoded live — RtpBridge is responsible for keeping the reference
// sample index aligned with the RX sample index it's paired against (see
// CLAUDE.md's Echo cancellation section for the full alignment story);
// this class only implements the adaptive filter itself.
//
// Standard single-channel NLMS (normalized least-mean-squares) adaptive
// filter: at each sample n, weights[k] predicts how much of x[n-k] (the
// reference, k samples ago) is present in the received signal. The tap
// count doesn't need to reach the reference's actual round-trip delay —
// the filter finds it: weights[k] for k near the true delay converge to
// the dominant values, everything else decays toward zero. tailMs=64
// (1024 taps at 16kHz) is a standard line-echo (not room-acoustic) tail
// length — hybrid/PBX echo paths are typically tens of ms, not the
// hundreds-of-ms-to-seconds acoustic reverberation tail an in-room AEC
// needs.
//
// A simple Geigel-style double-talk detector freezes adaptation when the
// received signal is much louder than the reference's recent envelope
// could plausibly explain as echo — without this, real near-end content
// arriving at the same time as reference audio (e.g. a caller talking
// over an IVR prompt) would otherwise be (wrongly) chased by the filter
// and could make it diverge.
class EchoCanceller {
  constructor({
    sampleRate = 16000,
    tailMs = 64,
    stepSize = 0.5,
    regularization = 1e-6,
    geigelThreshold = 1.5,
    envelopeDecay = 0.9995,
    enabled = true,
  } = {}) {
    this.sampleRate = sampleRate;
    this.tapCount   = Math.round(tailMs * sampleRate / 1000);
    this.stepSize   = stepSize;
    this.regularization = regularization;
    this.geigelThreshold = geigelThreshold;
    this.envelopeDecay   = envelopeDecay;
    this.enabled    = !!enabled;

    this.weights = new Float32Array(this.tapCount);
    this.history = new Float32Array(this.tapCount); // circular buffer of past reference samples
    this.histPos = 0;
    this.historyEnergy = 0; // running sum-of-squares of `history`, kept incrementally for NLMS normalization
    this.refEnvelope = 0;   // slow peak-hold-with-decay of |reference|, for double-talk detection
  }

  setEnabled(v) { this.enabled = !!v; }

  reset() {
    this.weights.fill(0);
    this.history.fill(0);
    this.histPos = 0;
    this.historyEnergy = 0;
    this.refEnvelope = 0;
  }

  // rxPcm16/refPcm16: PCM16LE Buffers. Both represent the same nominal
  // sample-index range (see class comment) — refPcm16 may be shorter
  // than rxPcm16 (reference exhausted near the end of a clip); the
  // shortfall is treated as silence rather than an error. Returns a new
  // Buffer the same length as rxPcm16.
  process(rxPcm16, refPcm16) {
    const n = rxPcm16.length >> 1;
    if (!this.enabled) return rxPcm16;

    const out = Buffer.alloc(rxPcm16.length);
    const N = this.tapCount;
    const refSamples = refPcm16.length >> 1;

    for (let i = 0; i < n; i++) {
      const refSample = i < refSamples ? refPcm16.readInt16LE(i * 2) / 32768 : 0;
      const rxSample  = rxPcm16.readInt16LE(i * 2) / 32768;

      // Push the new reference sample first, so weights[0] below lines up
      // with "this sample" (zero delay) and weights[k] with k samples ago.
      this.histPos = (this.histPos + 1) % N;
      const evicted = this.history[this.histPos];
      this.historyEnergy += refSample * refSample - evicted * evicted;
      this.history[this.histPos] = refSample;

      let echoEstimate = 0;
      for (let k = 0; k < N; k++) {
        echoEstimate += this.weights[k] * this.history[(this.histPos - k + N) % N];
      }
      const error = rxSample - echoEstimate;

      // Double-talk: freeze adaptation if the received signal is louder
      // than the reference's recent envelope could plausibly produce as
      // echo alone — a real near-end talker, not a mis-converged filter.
      this.refEnvelope = Math.max(Math.abs(refSample), this.refEnvelope * this.envelopeDecay);
      const doubleTalk = Math.abs(rxSample) > this.geigelThreshold * this.refEnvelope + 1e-4;

      if (!doubleTalk) {
        const gain = (this.stepSize / (this.historyEnergy + this.regularization)) * error;
        for (let k = 0; k < N; k++) {
          this.weights[k] += gain * this.history[(this.histPos - k + N) % N];
        }
      }

      const clamped = Math.max(-1, Math.min(1, error));
      out.writeInt16LE(Math.round(clamped * 32767), i * 2);
    }
    return out;
  }
}

module.exports = { EchoCanceller };
