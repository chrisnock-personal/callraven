'use strict';

const { execFile, execFileSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;

// Runs ffmpeg with the given args, resolving on success and rejecting with
// a consistent `ffmpeg: <stderr or message>` error otherwise. Shared by
// every one-shot ffmpeg invocation in the backend (WAV upload conversion,
// live-transcription resampling/G.722 decode, post-call transcription
// resampling) so they don't each reimplement the same spawn/collect-stderr/
// format-error logic slightly differently.
function runFfmpeg(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg: ${stderr || err.message}`));
      resolve();
    });
  });
}

// Synchronous counterpart for the one call site (audioDecoder.js's close())
// that can't go async without changing its caller's synchronous contract.
// Uses execFileSync (no shell) instead of building a shell command string,
// avoiding shell-interpolation entirely rather than just avoiding injection
// in practice.
function runFfmpegSync(args, { timeout = 30000 } = {}) {
  try {
    execFileSync('ffmpeg', args, { timeout, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`ffmpeg: ${stderr || err.message}`, { cause: err });
  }
}

module.exports = { runFfmpeg, runFfmpegSync };
