/**
 * audioDecoder.js
 * Decodes G.722, PCMU, PCMA RTP payloads to 16-bit PCM and writes WAV files.
 *
 * Uses ffmpeg to decode each codec correctly — called once per payload type
 * change, or we normalise everything to 8kHz PCM on the fly using lookup tables
 * so there's no subprocess overhead per packet.
 *
 * Recording strategy:
 *   - All payloads are decoded to 16-bit signed PCM at 8kHz immediately
 *   - Written sequentially to a WAV file
 *   - G.722 payloads are decoded via ffmpeg in batch at close() time
 *     to avoid the broken custom decoder
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

// ─── μ-law decode table (precomputed for speed) ───────────────────────────────
const ULAW_TABLE = new Int16Array(256);
(function() {
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    let t = ((u & 0x0f) << 3) + 132;
    t <<= (u & 0x70) >> 4;
    ULAW_TABLE[i] = (u & 0x80) ? (132 - t) : (t - 132);
  }
})();

// ─── A-law decode table ───────────────────────────────────────────────────────
const ALAW_TABLE = new Int16Array(256);
(function() {
  for (let i = 0; i < 256; i++) {
    let a = i ^ 0x55;
    let t = (a & 0x0f) << 4;
    const exp = (a & 0x70) >> 4;
    if (exp > 0) t += 0x100;
    if (exp > 1) t <<= (exp - 1);
    ALAW_TABLE[i] = (a & 0x80) ? t : -t;
  }
})();

// ─── AudioWriter ─────────────────────────────────────────────────────────────
// Accumulates decoded PCM samples from mixed codecs, writes a single WAV.
// G.722 payloads are buffered raw and decoded via ffmpeg at close().

class AudioWriter {
  constructor(filePath) {
    this.filePath     = filePath;
    this.filename     = path.basename(filePath);
    this.sampleRate   = 8000;      // normalise everything to 8kHz
    this.totalSamples = 0;
    this.closed       = false;

    // PCM chunks from PCMU/PCMA (already decoded inline)
    this.pcmChunks    = [];

    // Raw G.722 bytes buffered for ffmpeg decode at close()
    this.g722Chunks   = [];
    this.g722Bytes    = 0;

    // Track whether we have any real audio
    this.hasAudio     = false;
  }

  write(payloadType, payload) {
    if (this.closed || !payload || payload.length === 0) return;
    this.hasAudio = true;

    if (payloadType === 9) {
      // G.722 — buffer raw for ffmpeg decode at close()
      const copy = Buffer.from(payload);
      this.g722Chunks.push(copy);
      this.g722Bytes += copy.length;

    } else if (payloadType === 0) {
      // PCMU μ-law → 16-bit PCM
      const pcm = Buffer.alloc(payload.length * 2);
      for (let i = 0; i < payload.length; i++) {
        pcm.writeInt16LE(ULAW_TABLE[payload[i]], i * 2);
      }
      this.pcmChunks.push(pcm);
      this.totalSamples += payload.length;

    } else if (payloadType === 8) {
      // PCMA A-law → 16-bit PCM
      const pcm = Buffer.alloc(payload.length * 2);
      for (let i = 0; i < payload.length; i++) {
        pcm.writeInt16LE(ALAW_TABLE[payload[i]], i * 2);
      }
      this.pcmChunks.push(pcm);
      this.totalSamples += payload.length;
    }
    // Other PTs silently ignored
  }

  close() {
    if (this.closed) return { size: 0, duration: 0 };
    this.closed = true;

    if (!this.hasAudio) {
      console.log(`[AUDIO] No audio data for ${this.filename}`);
      return { size: 0, duration: 0 };
    }

    // ── Decode G.722 chunks via ffmpeg ───────────────────────────────────────
    let g722Pcm = null;
    if (this.g722Bytes > 0) {
      const rawPath = this.filePath + '.g722raw';
      try {
        const raw = Buffer.concat(this.g722Chunks);
        fs.writeFileSync(rawPath, raw);
        // G.722 → 16kHz PCM → resample to 8kHz to match PCMU
        const tmpPath = rawPath + '.raw';
        execSync(
          `ffmpeg -y -f g722 -i "${rawPath}" -ar 8000 -ac 1 -f s16le "${tmpPath}" 2>/dev/null`,
          { timeout: 30000 }
        );
        g722Pcm = fs.readFileSync(tmpPath);
        try { fs.unlinkSync(rawPath); fs.unlinkSync(tmpPath); } catch(e) {}
        const g722Samples = g722Pcm.length / 2;
        this.totalSamples += g722Samples;
        console.log(`[AUDIO] G.722 decoded: ${this.g722Bytes} bytes → ${g722Samples} samples`);
      } catch (err) {
        console.error(`[AUDIO] G.722 decode failed: ${err.message}`);
        try { fs.unlinkSync(rawPath); } catch(e) {}
        g722Pcm = null;
      }
    }

    // ── Combine all PCM chunks ────────────────────────────────────────────────
    const allChunks = [];
    if (this.pcmChunks.length > 0) allChunks.push(...this.pcmChunks);
    if (g722Pcm) allChunks.push(g722Pcm);

    if (allChunks.length === 0 || this.totalSamples === 0) {
      console.log(`[AUDIO] No decodable audio for ${this.filename}`);
      return { size: 0, duration: 0 };
    }

    // ── Write WAV file ────────────────────────────────────────────────────────
    try {
      const fd       = fs.openSync(this.filePath, 'w');
      const sr       = this.sampleRate;
      const ns       = this.totalSamples;
      const dataSize = ns * 2;

      // WAV header
      const hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0);
      hdr.writeUInt32LE(36 + dataSize, 4);
      hdr.write('WAVE', 8);
      hdr.write('fmt ', 12);
      hdr.writeUInt32LE(16, 16);
      hdr.writeUInt16LE(1, 20);        // PCM
      hdr.writeUInt16LE(1, 22);        // mono
      hdr.writeUInt32LE(sr, 24);
      hdr.writeUInt32LE(sr * 2, 28);   // byte rate
      hdr.writeUInt16LE(2, 32);        // block align
      hdr.writeUInt16LE(16, 34);       // bits per sample
      hdr.write('data', 36);
      hdr.writeUInt32LE(dataSize, 40);
      fs.writeSync(fd, hdr);

      for (const chunk of allChunks) {
        fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd);

      const stat     = fs.statSync(this.filePath);
      const duration = Math.round(ns / sr);
      console.log(`[AUDIO] Saved: ${this.filename} (${stat.size} bytes, ~${duration}s)`);
      return { size: stat.size, duration };
    } catch (err) {
      console.error(`[AUDIO] WAV write failed: ${err.message}`);
      return { size: 0, duration: 0 };
    }
  }
}

// Stub kept for any callers
class G722Decoder {
  decode(buf) { return Buffer.alloc(buf.length * 4); }
}

module.exports = { AudioWriter, G722Decoder };
