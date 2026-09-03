'use strict';

// Clamp a sample to the signed 16-bit PCM range, shared by every module that
// writes int16 samples (RTP decode paths, noise suppression output).
function clamp16(sample) {
  return Math.max(-32768, Math.min(32767, sample));
}

module.exports = { clamp16 };
