/**
 * transcribeManager.js
 * Manages local Whisper.cpp transcription of WAV recordings.
 * - Resamples WAV to 16kHz mono via ffmpeg (Whisper requirement)
 * - Runs whisper-cli with the small.en model
 * - Parses SRT output into timestamped JSON segments
 * - Saves transcript as JSON alongside the recording
 */

'use strict';

const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');

const CAPTURES_DIR  = '/captures';
const WHISPER_BIN   = '/usr/local/bin/whisper-cli';
const WHISPER_MODEL = '/models/ggml-small.en.bin';
const FFMPEG_BIN    = 'ffmpeg';

// Track in-progress jobs: filename -> { status, startedAt, error? }
const jobs = new Map();

/**
 * Start transcription of a recording file.
 * @param {string} rxFilename - inbound recording, e.g. "rec_abc123_ts_rx.wav"
 * @param {string} [txFilename] - optional outbound recording, e.g. "rec_abc123_ts_tx.wav"
 * @returns {Promise<{status}>}
 */
function startTranscription(rxFilename, txFilename) {
  return new Promise((resolve, reject) => {
    const rxPath = path.join(CAPTURES_DIR, rxFilename);
    if (!fs.existsSync(rxPath)) {
      return reject(new Error(`Recording not found: ${rxFilename}`));
    }

    if (jobs.get(rxFilename)?.status === 'processing') {
      return reject(new Error('Transcription already in progress'));
    }

    // Derive transcript filename from the rx file (strip _rx suffix if present)
    const base           = rxFilename.replace(/_rx\.wav$/i, '').replace(/\.wav$/i, '');
    const transcriptPath = path.join(CAPTURES_DIR, `${base}.json`);

    // Resolve optional tx file
    const txPath = txFilename
      ? path.join(CAPTURES_DIR, txFilename)
      : null;
    const hasTx = txPath && fs.existsSync(txPath);

    jobs.set(rxFilename, { status: 'processing', startedAt: Date.now() });
    resolve({ status: 'processing', filename: rxFilename });

    _runTranscription(rxPath, txPath && hasTx ? txPath : null, transcriptPath, rxFilename)
      .then(() => {
        const job = jobs.get(rxFilename) || {};
        job.status       = 'done';
        job.finishedAt   = Date.now();
        job.transcriptFile = `${base}.json`;
        jobs.set(rxFilename, job);
        console.log(`[TRANSCRIBE] Done: ${rxFilename} -> ${base}.json`);
      })
      .catch(err => {
        const job = jobs.get(rxFilename) || {};
        job.status = 'error';
        job.error  = err.message;
        jobs.set(rxFilename, job);
        console.error(`[TRANSCRIBE] Error: ${rxFilename}: ${err.message}`);
      });
  });
}

async function _runTranscription(rxPath, txPath, transcriptPath, rxFilename) {
  // Resample inbound (remote) to 16kHz mono
  const rxTmp  = rxPath.replace(/\.wav$/i, '_16k.wav');
  await _ffmpegResample(rxPath, rxTmp);

  // Run whisper on inbound
  const rxSrt  = rxTmp.replace(/\.wav$/i, '.srt');
  await _runWhisper(rxTmp, rxSrt);
  const rxSegs = parseSrt(fs.existsSync(rxSrt) ? fs.readFileSync(rxSrt, 'utf8') : '')
    .map(s => ({ ...s, speaker: 'Remote' }));
  [rxTmp, rxSrt].forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });

  // Optionally run whisper on outbound (local WAV playback)
  let txSegs = [];
  if (txPath) {
    const txTmp = txPath.replace(/\.wav$/i, '_16k.wav');
    try {
      await _ffmpegResample(txPath, txTmp);
      const txSrt = txTmp.replace(/\.wav$/i, '.srt');
      await _runWhisper(txTmp, txSrt);
      txSegs = parseSrt(fs.existsSync(txSrt) ? fs.readFileSync(txSrt, 'utf8') : '')
        .map(s => ({ ...s, speaker: 'Local' }));
      [txTmp, txSrt].forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
    } catch (e) {
      console.warn(`[TRANSCRIBE] TX whisper failed (non-fatal): ${e.message}`);
      try { fs.unlinkSync(txTmp); } catch(_) {}
    }
  }

  // Merge and sort by start time
  const segments = [...rxSegs, ...txSegs].sort((a, b) => a.startSec - b.startSec);
  const diarized = txSegs.length > 0;

  const transcript = {
    filename:    path.basename(transcriptPath),
    recFilename: rxFilename,
    model:       'whisper-small.en',
    diarized,
    generatedAt: new Date().toISOString(),
    duration:    segments.length ? segments[segments.length - 1].endSec : 0,
    wordCount:   segments.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0),
    segments,
    text: segments.map(s => diarized ? `[${s.speaker}] ${s.text.trim()}` : s.text.trim()).join(' '),
  };

  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
}

function _ffmpegResample(input, output) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_BIN, [
      '-y', '-i', input,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      output
    ], (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg: ${stderr || err.message}`));
      resolve();
    });
  });
}

function _runWhisper(input, srtOutput) {
  return new Promise((resolve, reject) => {
    // whisper-cli outputs SRT when passed --output-srt
    // Output base path is the input without extension
    const outBase = input.replace(/\.wav$/i, '');
    execFile(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', input,
      '--output-srt',
      '--output-file', outBase,
      '--language', 'en',
      '--threads', '2',
    ], { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err && !fs.existsSync(srtOutput)) {
        return reject(new Error(`whisper-cli: ${stderr || err.message}`));
      }
      resolve();
    });
  });
}

/**
 * Parse SRT format into segments with timestamps.
 * SRT format:
 * 1
 * 00:00:00,000 --> 00:00:03,000
 * Hello there
 */
function parseSrt(srtText) {
  const segments = [];
  const blocks   = srtText.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    const match = timeLine.match(
      /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/
    );
    if (!match) continue;
    const startSec = +match[1]*3600 + +match[2]*60 + +match[3] + +match[4]/1000;
    const endSec   = +match[5]*3600 + +match[6]*60 + +match[7] + +match[8]/1000;
    const text     = lines.slice(2).join(' ').trim();
    if (text) segments.push({ startSec, endSec, text });
  }
  return segments;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Get job status for a recording filename */
function getJobStatus(recFilename) {
  return jobs.get(recFilename) || null;
}

/** List all transcript JSON files in /captures */
function listTranscripts() {
  const files = fs.readdirSync(CAPTURES_DIR);
  return files
    .filter(f => f.startsWith('rec_') && f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CAPTURES_DIR, f), 'utf8'));
        return { filename: f, ...data };
      } catch(e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

/** Delete a transcript file */
function deleteTranscript(filename) {
  const p = path.join(CAPTURES_DIR, filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Check if whisper-cli binary exists */
function isWhisperAvailable() {
  return fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
}

module.exports = {
  startTranscription,
  getJobStatus,
  listTranscripts,
  deleteTranscript,
  isWhisperAvailable,
  fmtTime,
};
