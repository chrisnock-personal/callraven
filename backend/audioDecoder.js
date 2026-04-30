/**
 * audioDecoder.js
 *
 * Decodes inbound RTP audio payloads to PCM and writes them to a WAV file.
 * Supports G.722 (PT 9) and PCMU/PCMA (PT 0/8).
 *
 * The decoded WAV file is saved alongside the .pcap capture and is
 * accessible via GET /api/captures for download.
 *
 * G.722 decoder: ITU-T G.722 sub-band ADPCM decoder
 * PCMU decoder:  ITU-T G.711 μ-law to linear PCM
 * PCMA decoder:  ITU-T G.711 A-law to linear PCM
 */

const fs   = require('fs');
const path = require('path');

// ─── μ-law decoder ────────────────────────────────────────────────────────────
function ulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp  = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let sample = ((mant << 1) + 33) << (exp + 2);
  return sign ? -sample : sample;
}

// ─── A-law decoder ────────────────────────────────────────────────────────────
function alawToLinear(a) {
  a ^= 0x55;
  const sign = a & 0x80;
  const exp  = (a >> 4) & 0x07;
  let mant   = a & 0x0f;
  let sample;
  if (exp === 0) {
    sample = (mant << 1) + 1;
  } else {
    sample = ((mant | 0x10) << 1) + 1;
    sample <<= exp - 1;
  }
  return sign ? -sample * 8 : sample * 8;
}

// ─── G.722 decoder ────────────────────────────────────────────────────────────
// Decodes G.722 64kbps bitstream to 16kHz 16-bit PCM (2 samples per byte)
class G722Decoder {
  constructor() {
    // Lower sub-band state
    this.detl = 32; this.sl = 0; this.nbl = 0;
    this.rlt  = [0, 0]; this.al = [0, 0];
    this.dlt  = [0, 0, 0, 0, 0, 0, 0];
    this.plt  = [0, 0, 0]; this.sgl = [0, 0, 0, 0, 0, 0];
    this.zl   = 0;
    // Upper sub-band state
    this.deth = 8; this.sh = 0; this.nbh = 0;
    this.rh   = [0, 0]; this.ah = [0, 0];
    this.dh   = [0, 0]; this.sgh = [0, 0]; this.zh = 0;
    // QMF synthesis state
    this.xd   = new Array(24).fill(0);
    this.xs   = new Array(24).fill(0);
  }

  // Decode one G.722 byte to two 16kHz 16-bit PCM samples
  decodeByte(code) {
    const WL  = [-60,-30,58,172,336,520,680,836];
    const ILB = [2048,2093,2139,2186,2233,2282,2332,2383,2435,2489,2543,
                 2599,2656,2714,2774,2834,2896,2960,3025,3091,3158,3228,
                 3298,3371,3444,3520,3597,3676,3756,3838,3922,4008];
    const RL42= [0,7,6,5,4,3,2,1,7,6,5,4,3,2,1,0];
    const QM4 = [0,7,21,36,52,69,88,110,136,168,211,278,425,1865,0,0];
    const WH  = [0,-214,798];
    const RH2 = [2,1,2,1];
    const QM2 = [926,1885,3073,6554];

    const il = code & 0x3f;
    const ih = (code >> 6) & 0x03;

    // ── Lower sub-band decode ──────────────────────────────────────────────
    const ril  = il >> 2;
    const ril2 = rl42[ril] !== undefined ? rl42[ril] : RL42[ril];
    const dlt  = (QM4[ril] * this.detl) >> 15;
    const sil  = (il & 0x20) ? -1 : 1;
    const dltv = dlt * sil;

    // Log adaptation
    this.nbl = Math.max(0, Math.min(18432,
      this.nbl + WL[RL42[ril]] - (this.nbl >> 8)
    ));
    const detlp = ILB[Math.min(31, this.nbl >> 11)] * (1 + (this.nbl >> 6)) >> 15;
    this.detl = Math.max(32, detlp);

    // Predictor update
    this.dlt.unshift(dltv); this.dlt.length = 7;
    let zl = 0;
    for (let i = 0; i < 6; i++) zl += this.sgl[i] * this.dlt[i+1];
    this.zl = zl >> 15;
    this.sl = Math.max(-16384, Math.min(16383, dltv + this.zl));
    this.sgl.unshift(this.sl); this.sgl.length = 6;
    this.rlt.unshift(this.sl); this.rlt.length = 2;

    // ── Upper sub-band decode ──────────────────────────────────────────────
    const rih  = ih & 1 ? 3 : 1;
    const dh   = (QM2[rih-1] * this.deth) >> 15;
    const sih  = (ih & 0x02) ? -1 : 1;
    const dhv  = dh * sih;

    this.nbh = Math.max(0, Math.min(18432,
      this.nbh + WH[ih] - (this.nbh >> 8)
    ));
    const dethp = ILB[Math.min(31, this.nbh >> 11)] * (1 + (this.nbh >> 6)) >> 15;
    this.deth = Math.max(8, dethp);

    this.dh.unshift(dhv); this.dh.length = 2;
    let zh = 0;
    for (let i = 0; i < 2; i++) zh += this.sgh[i] * this.dh[i+1];
    this.zh = zh >> 15;
    this.sh = Math.max(-16384, Math.min(16383, dhv + this.zh));
    this.sgh.unshift(this.sh); this.sgh.length = 2;
    this.rh.unshift(this.sh); this.rh.length = 2;

    // ── QMF synthesis — combine sub-bands back to wideband ────────────────
    const QMF = [3,-11,12,32,-210,951,3876,-805,362,-156,53,-11];

    this.xd.unshift(this.sl - this.sh); this.xd.length = 12;
    this.xs.unshift(this.sl + this.sh); this.xs.length = 12;

    let xout1 = 0, xout2 = 0;
    for (let i = 0; i < 12; i++) {
      xout1 += QMF[i] * this.xd[i];
      xout2 += QMF[i] * this.xs[i];
    }

    const s1 = Math.max(-32768, Math.min(32767, xout1 >> 11));
    const s2 = Math.max(-32768, Math.min(32767, xout2 >> 11));

    return [s1, s2]; // two 16kHz samples per G.722 byte
  }

  // Decode a buffer of G.722 bytes to 16-bit LE PCM Buffer
  decode(g722Buf) {
    const out = Buffer.alloc(g722Buf.length * 4); // 2 samples * 2 bytes each
    let outIdx = 0;
    for (let i = 0; i < g722Buf.length; i++) {
      const [s1, s2] = this.decodeByte(g722Buf[i]);
      out.writeInt16LE(s1, outIdx);     outIdx += 2;
      out.writeInt16LE(s2, outIdx);     outIdx += 2;
    }
    return out.slice(0, outIdx);
  }
}

// ─── WAV file writer ──────────────────────────────────────────────────────────
function writeWavHeader(fd, sampleRate, numChannels, numSamples) {
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = numSamples * numChannels * bitsPerSample / 8;
  const fileSize      = 36 + dataSize;

  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(fileSize, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);          // fmt chunk size
  hdr.writeUInt16LE(1, 20);           // PCM format
  hdr.writeUInt16LE(numChannels, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate, 28);
  hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitsPerSample, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(dataSize, 40);

  fs.writeSync(fd, hdr, 0, 44, 0);
}

// ─── AudioWriter — one per call ───────────────────────────────────────────────
class AudioWriter {
  constructor(filePath) {
    this.filePath    = filePath;
    this.filename    = path.basename(filePath);
    this.fd          = fs.openSync(filePath, 'w');
    this.sampleRate  = 16000; // default G.722 output rate
    this.pcmChunks   = [];
    this.totalSamples = 0;
    this.g722decoder = new G722Decoder();

    // Reserve space for WAV header — will be filled in on close()
    const placeholder = Buffer.alloc(44);
    fs.writeSync(this.fd, placeholder);
  }

  write(payloadType, payload) {
    let pcm;

    if (payloadType === 9) {
      // G.722 → 16kHz 16-bit PCM
      this.sampleRate = 16000;
      pcm = this.g722decoder.decode(payload);
    } else if (payloadType === 0) {
      // PCMU (μ-law) → 8kHz 16-bit PCM
      this.sampleRate = 8000;
      pcm = Buffer.alloc(payload.length * 2);
      for (let i = 0; i < payload.length; i++) {
        pcm.writeInt16LE(ulawToLinear(payload[i]), i * 2);
      }
    } else if (payloadType === 8) {
      // PCMA (A-law) → 8kHz 16-bit PCM
      this.sampleRate = 8000;
      pcm = Buffer.alloc(payload.length * 2);
      for (let i = 0; i < payload.length; i++) {
        pcm.writeInt16LE(alawToLinear(payload[i]), i * 2);
      }
    } else {
      return; // unsupported codec
    }

    fs.writeSync(this.fd, pcm);
    this.totalSamples += pcm.length / 2;
  }

  close() {
    // Go back and write the real WAV header now we know the size
    writeWavHeader(this.fd, this.sampleRate, 1, this.totalSamples);
    fs.closeSync(this.fd);

    const stat = fs.statSync(this.filePath);
    const dur  = Math.round(this.totalSamples / this.sampleRate);
    console.log(`[AUDIO] Saved: ${this.filename} (${stat.size} bytes, ~${dur}s)`);
    return { size: stat.size, duration: dur };
  }
}

module.exports = { AudioWriter, G722Decoder };
