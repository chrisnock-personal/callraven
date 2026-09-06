'use strict';

const { Encoder, Decoder } = require('@evan/opus');

// RTP PT 111 (dynamic — this app's own convention, not a PBX-assigned
// value), 16kHz mono internally (matches G.722's existing wideband
// quality tier). Per RFC 7587, Opus's RTP clock is *always* 48000
// regardless of the actual DSP sample rate used here — OPUS_TS_INCREMENT
// is what RtpBridge._sendRtpPacket needs to advance the RTP timestamp by
// per 20ms frame; it has no relationship to a compressed packet's byte
// length (unlike G.722, where the two happen to coincide).
const OPUS_PT            = 111;
const OPUS_SAMPLE_RATE   = 16000;
const OPUS_FRAME_MS      = 20;
const OPUS_FRAME_SAMPLES = OPUS_SAMPLE_RATE * OPUS_FRAME_MS / 1000; // 320
const OPUS_FRAME_BYTES   = OPUS_FRAME_SAMPLES * 2;                  // 640 (16-bit PCM)
const OPUS_RTP_CLOCK     = 48000;
const OPUS_TS_INCREMENT  = OPUS_RTP_CLOCK * OPUS_FRAME_MS / 1000;   // 960

function createEncoder() {
  const enc = new Encoder({ channels: 1, sample_rate: OPUS_SAMPLE_RATE, application: 'voip' });
  enc.inband_fec = true; // matches the useinbandfec=1 this app advertises in SDP
  return enc;
}

function createDecoder() {
  return new Decoder({ channels: 1, sample_rate: OPUS_SAMPLE_RATE });
}

// Encodes 16kHz mono 16-bit PCM into a sequence of Opus packets, stored as
// [uint16LE packet length][packet bytes] records — a minimal, internal-only
// container. Needed because (unlike G.722's fixed-size ADPCM frames) Opus
// packets are variable-length, so a bare concatenation can't be re-chunked
// at playback time without knowing where each packet ends.
function encodePcmToFrameFile(pcm16Buffer) {
  const encoder = createEncoder();
  const parts = [];
  for (let offset = 0; offset + OPUS_FRAME_BYTES <= pcm16Buffer.length; offset += OPUS_FRAME_BYTES) {
    const frame = pcm16Buffer.subarray(offset, offset + OPUS_FRAME_BYTES);
    const packet = encoder.encode(frame);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(packet.length, 0);
    parts.push(lenBuf, Buffer.from(packet.buffer, packet.byteOffset, packet.length));
  }
  return Buffer.concat(parts);
}

// Parses encodePcmToFrameFile's format back into an array of raw Opus
// packets, in order. Stops at the first malformed/truncated record rather
// than throwing, returning whatever complete packets were parsed so far.
function readFrameFile(buf) {
  const packets = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const len = buf.readUInt16LE(offset);
    offset += 2;
    if (offset + len > buf.length) break;
    packets.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  return packets;
}

module.exports = {
  OPUS_PT,
  OPUS_SAMPLE_RATE,
  OPUS_FRAME_MS,
  OPUS_FRAME_SAMPLES,
  OPUS_FRAME_BYTES,
  OPUS_RTP_CLOCK,
  OPUS_TS_INCREMENT,
  createEncoder,
  createDecoder,
  encodePcmToFrameFile,
  readFrameFile,
};
