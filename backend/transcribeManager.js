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
 * @param {string} recFilename - e.g. "rec_abc123_1234567890.wav"
 * @returns {Promise<{jobId, status}>}
 */
function startTranscription(recFilename) {
  return new Promise((resolve, reject) => {
    const recPath = path.join(CAPTURES_DIR, recFilename);
    if (!fs.existsSync(recPath)) {
      return reject(new Error(`Recording not found: ${recFilename}`));
    }

    // Derive transcript filename
    const base       = recFilename.replace(/\.wav$/i, '');
    const transcriptPath = path.join(CAPTURES_DIR, `${base}.json`);

    if (jobs.get(recFilename)?.status === 'processing') {
      return reject(new Error('Transcription already in progress'));
    }

    jobs.set(recFilename, { status: 'processing', startedAt: Date.now() });
    resolve({ status: 'processing', filename: recFilename });

    // Run async
    _runTranscription(recPath, transcriptPath, recFilename)
      .then(() => {
        const job = jobs.get(recFilename) || {};
        job.status    = 'done';
        job.finishedAt = Date.now();
        job.transcriptFile = `${base}.json`;
        jobs.set(recFilename, job);
        console.log(`[TRANSCRIBE] Done: ${recFilename} -> ${base}.json`);
      })
      .catch(err => {
        const job = jobs.get(recFilename) || {};
        job.status = 'error';
        job.error  = err.message;
        jobs.set(recFilename, job);
        console.error(`[TRANSCRIBE] Error: ${recFilename}: ${err.message}`);
      });
  });
}

async function _runTranscription(recPath, transcriptPath, recFilename) {
  // Step 1: resample to 16kHz mono WAV (Whisper requirement)
  const tmpPath = recPath.replace(/\.wav$/i, '_16k.wav');
  await _ffmpegResample(recPath, tmpPath);

  // Step 2: run whisper-cli
  const srtPath = tmpPath.replace(/\.wav$/i, '.srt');
  await _runWhisper(tmpPath, srtPath);

  // Step 3: parse SRT -> JSON segments
  const srtText = fs.existsSync(srtPath)
    ? fs.readFileSync(srtPath, 'utf8')
    : '';
  const segments = parseSrt(srtText);

  // Step 4: build transcript object and save
  const stat     = fs.statSync(recPath);
  const transcript = {
    filename:    path.basename(transcriptPath),   // rec_xxx.json
    recFilename: recFilename,                     // rec_xxx.wav
    model:       'whisper-small.en',
    generatedAt: new Date().toISOString(),
    duration:    segments.length ? segments[segments.length - 1].endSec : 0,
    wordCount:   segments.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0),
    segments,
    text:        segments.map(s => s.text.trim()).join(' '),
  };

  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');

  // Cleanup temp files
  [tmpPath, srtPath].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
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
