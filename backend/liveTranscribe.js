'use strict';

/**
 * liveTranscribe.js
 * Buffers raw RTP payloads and transcribes each window with whisper-cli.
 *
 * G.722 payloads are collected as raw bytes and decoded with ffmpeg at flush
 * time (the same batch approach AudioWriter uses in audioDecoder.js).
 * PCMU/PCMA payloads are decoded inline to PCM16 (8kHz) and resampled to
 * 16kHz via ffmpeg at flush time. Opus payloads decode synchronously via
 * @evan/opus (see opusCodec.js) directly to 16kHz PCM16 — no ffmpeg
 * involved for that path at all, since no resample is needed.
 *
 * Emits 'text' events with each recognised phrase.
 * Window size: TRANSCRIPT_WINDOW_MS env var (default 3000 ms).
 */

const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { runFfmpeg } = require('./ffmpegUtils');
const opusCodec = require('./opusCodec');

const WHISPER_BIN   = '/usr/local/bin/whisper-cli';
const WHISPER_MODEL = '/models/ggml-small.en.bin';
const WINDOW_MS     = parseInt(process.env.TRANSCRIPT_WINDOW_MS || '6000', 10);
const MIN_G722_BYTES = 800; // ~0.5s of G.722 at 64kbps (8000 bytes/sec raw)
const MIN_PCM_SAMPLES = 4000; // ~0.5s at 8kHz
const MIN_OPUS_PCM_SAMPLES = 8000; // ~0.5s at 16kHz (Opus decodes at 16kHz — see opusCodec.js)

// ─── μ-law / A-law decode (inline, no subprocess per packet) ─────────────────
const ULAW_TABLE = new Int16Array(256);
const ALAW_TABLE = new Int16Array(256);
(function () {
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    let t = ((u & 0x0f) << 3) + 132;
    t <<= (u & 0x70) >> 4;
    ULAW_TABLE[i] = (u & 0x80) ? (132 - t) : (t - 132);
    let a = i ^ 0x55;
    let s = (a & 0x0f) << 4;
    const exp = (a & 0x70) >> 4;
    if (exp > 0) s += 0x100;
    if (exp > 1) s <<= (exp - 1);
    ALAW_TABLE[i] = (a & 0x80) ? s : -s;
  }
})();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeWav(filepath, pcm16, sampleRate) {
  const dataLen = pcm16.length;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF',                  0);
  hdr.writeUInt32LE(36 + dataLen,    4);
  hdr.write('WAVE',                  8);
  hdr.write('fmt ',                 12);
  hdr.writeUInt32LE(16,             16);
  hdr.writeUInt16LE(1,              20);
  hdr.writeUInt16LE(1,              22);
  hdr.writeUInt32LE(sampleRate,     24);
  hdr.writeUInt32LE(sampleRate * 2, 28);
  hdr.writeUInt16LE(2,              32);
  hdr.writeUInt16LE(16,             34);
  hdr.write('data',                 36);
  hdr.writeUInt32LE(dataLen,        40);
  fs.writeFileSync(filepath, Buffer.concat([hdr, pcm16]));
}

const ffmpeg = runFfmpeg;

function runWhisper(wavPath) {
  const outBase = wavPath.replace(/\.wav$/i, '');
  const txtPath = outBase + '.txt';
  return new Promise((resolve, reject) => {
    const args = [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '--output-txt',
      '--output-file', outBase,
      '--language', 'en',
      '--no-timestamps',
      '--threads', '4',
      '--prompt', process.env.TRANSCRIPT_PROMPT || 'compliance monitoring recording quality',
    ];

    execFile(WHISPER_BIN, args, { timeout: 15000 }, (err, _stdout, stderr) => {
      if (err && !fs.existsSync(txtPath))
        return reject(new Error(`whisper: ${stderr || err.message}`));
      try {
        const raw = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';
        try { fs.unlinkSync(txtPath); } catch (_) {}
        resolve(raw.trim() || null);
      } catch (e) { reject(e); }
    });
  });
}

// ─── LiveTranscriber ──────────────────────────────────────────────────────────

class LiveTranscriber extends EventEmitter {
  constructor() {
    super();
    // Inbound (remote speaker) buffers
    this._g722   = [];
    this._pcm    = [];
    this._opusPcm = []; // pre-decoded 16kHz PCM (Opus decode is synchronous — see write())
    // Outbound (local WAV playback) buffers
    this._g722tx = [];
    this._pcmtx  = [];
    this._opusPcmTx = [];
    this._opusDecoder   = null; // lazy, created on first inbound Opus payload
    this._opusDecoderTx = null; // lazy, created on first outbound Opus payload
    this._busy   = false;
    this._timer  = null;
  }

  start() {
    this._g722   = [];
    this._pcm    = [];
    this._opusPcm = [];
    this._g722tx = [];
    this._pcmtx  = [];
    this._opusPcmTx = [];
    this._busy   = false;
    this._timer  = setInterval(() => this._flush(), WINDOW_MS);
  }

  // Inbound: receives raw RTP payload via onRawAudio hook
  write(pt, rawPayload) {
    if (pt === 9) {
      this._g722.push(Buffer.from(rawPayload));
    } else if (pt === 0 || pt === 8) {
      const tbl = pt === 0 ? ULAW_TABLE : ALAW_TABLE;
      const pcm = Buffer.alloc(rawPayload.length * 2);
      for (let i = 0; i < rawPayload.length; i++)
        pcm.writeInt16LE(tbl[rawPayload[i]], i * 2);
      this._pcm.push(pcm);
    } else if (pt === opusCodec.OPUS_PT) {
      if (!this._opusDecoder) this._opusDecoder = opusCodec.createDecoder();
      this._opusPcm.push(Buffer.from(this._opusDecoder.decode(rawPayload)));
    }
  }

  // Outbound: receives raw G.722 frames from WAV playback via onRawOutboundAudio hook
  writeOutbound(pt, rawPayload) {
    if (pt === 9) {
      this._g722tx.push(Buffer.from(rawPayload));
    } else if (pt === 0 || pt === 8) {
      const tbl = pt === 0 ? ULAW_TABLE : ALAW_TABLE;
      const pcm = Buffer.alloc(rawPayload.length * 2);
      for (let i = 0; i < rawPayload.length; i++)
        pcm.writeInt16LE(tbl[rawPayload[i]], i * 2);
      this._pcmtx.push(pcm);
    } else if (pt === opusCodec.OPUS_PT) {
      if (!this._opusDecoderTx) this._opusDecoderTx = opusCodec.createDecoder();
      this._opusPcmTx.push(Buffer.from(this._opusDecoderTx.decode(rawPayload)));
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._g722 = []; this._pcm  = []; this._opusPcm = [];
    this._g722tx = []; this._pcmtx = []; this._opusPcmTx = [];
  }

  async _flush() {
    if (this._busy) return;

    // Drain all buffers atomically
    const rxG722 = this._g722.splice(0);
    const rxPcm  = this._pcm.splice(0);
    const rxOpusPcm = this._opusPcm.splice(0);
    const txG722 = this._g722tx.splice(0);
    const txPcm  = this._pcmtx.splice(0);
    const txOpusPcm = this._opusPcmTx.splice(0);

    const rxG722Bytes  = rxG722.reduce((n, b) => n + b.length, 0);
    const rxPcmSamples = rxPcm.reduce((n, b) => n + b.length, 0) / 2;
    const rxOpusSamples = rxOpusPcm.reduce((n, b) => n + b.length, 0) / 2;
    const txG722Bytes  = txG722.reduce((n, b) => n + b.length, 0);
    const txPcmSamples = txPcm.reduce((n, b) => n + b.length, 0) / 2;
    const txOpusSamples = txOpusPcm.reduce((n, b) => n + b.length, 0) / 2;

    const hasRx = (rxG722Bytes >= MIN_G722_BYTES) || (rxOpusSamples >= MIN_OPUS_PCM_SAMPLES)
      || (rxPcmSamples >= MIN_PCM_SAMPLES && rxG722Bytes === 0 && rxOpusSamples === 0);
    const hasTx = (txG722Bytes >= MIN_G722_BYTES) || (txOpusSamples >= MIN_OPUS_PCM_SAMPLES)
      || (txPcmSamples >= MIN_PCM_SAMPLES && txG722Bytes === 0 && txOpusSamples === 0);

    if (!hasRx && !hasTx) return;

    this._busy = true;
    const tag  = Date.now();

    try {
      const jobs = [];

      if (hasRx) {
        jobs.push(_decodeAndTranscribe(tag, 'rx', rxG722, rxPcm, rxG722Bytes, rxOpusPcm)
          .then(text => text ? { speaker: 'Remote', text } : null));
      }
      if (hasTx) {
        jobs.push(_decodeAndTranscribe(tag, 'tx', txG722, txPcm, txG722Bytes, txOpusPcm)
          .then(text => text ? { speaker: 'Local', text } : null));
      }

      const results = (await Promise.all(jobs)).filter(Boolean);

      for (const r of results) {
        this.emit('text', `[${r.speaker}] ${r.text}`);
      }
    } catch (_) {
      // skip this window on any error
    } finally {
      this._busy = false;
    }
  }
}

async function _decodeAndTranscribe(tag, channel, g722Bufs, pcmBufs, g722Bytes, opusPcmBufs) {
  const tmpWav = path.join(os.tmpdir(), `lt_${tag}_${channel}.wav`);
  try {
    if (g722Bytes > 0) {
      const rawPath = path.join(os.tmpdir(), `lt_${tag}_${channel}.g722raw`);
      fs.writeFileSync(rawPath, Buffer.concat(g722Bufs));
      await ffmpeg(['-y', '-f', 'g722', '-i', rawPath,
                    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav]);
      try { fs.unlinkSync(rawPath); } catch (_) {}
    } else if (opusPcmBufs && opusPcmBufs.length > 0) {
      // Opus decodes at 16kHz already (see opusCodec.js) — write directly,
      // no ffmpeg resample step needed at all.
      writeWav(tmpWav, Buffer.concat(opusPcmBufs), 16000);
    } else {
      const pcm8kWav = path.join(os.tmpdir(), `lt_${tag}_${channel}_8k.wav`);
      writeWav(pcm8kWav, Buffer.concat(pcmBufs), 8000);
      await ffmpeg(['-y', '-i', pcm8kWav,
                    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav]);
      try { fs.unlinkSync(pcm8kWav); } catch (_) {}
    }
    return await runWhisper(tmpWav);
  } finally {
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
}

module.exports = { LiveTranscriber, WINDOW_MS };
