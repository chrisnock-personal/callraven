'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const opusCodec = require('../opusCodec.js');

test('readFrameFile parses back records written by hand in the expected format', () => {
  const packets = [Buffer.from([1, 2, 3]), Buffer.from([4, 5]), Buffer.from([])];
  const parts = [];
  for (const p of packets) {
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(p.length, 0);
    parts.push(lenBuf, p);
  }
  const file = Buffer.concat(parts);
  const parsed = opusCodec.readFrameFile(file);
  assert.equal(parsed.length, 3);
  assert.deepEqual([...parsed[0]], [1, 2, 3]);
  assert.deepEqual([...parsed[1]], [4, 5]);
  assert.deepEqual([...parsed[2]], []);
});

test('readFrameFile returns an empty array for an empty buffer', () => {
  assert.deepEqual(opusCodec.readFrameFile(Buffer.alloc(0)), []);
});

test('readFrameFile stops cleanly at a truncated trailing record instead of throwing', () => {
  const good = Buffer.alloc(2 + 3);
  good.writeUInt16LE(3, 0);
  good.set([9, 9, 9], 2);
  // Trailing garbage: claims a 100-byte packet but only 2 bytes follow.
  const truncated = Buffer.alloc(2 + 2);
  truncated.writeUInt16LE(100, 0);
  const file = Buffer.concat([good, truncated]);
  const parsed = opusCodec.readFrameFile(file);
  assert.equal(parsed.length, 1);
  assert.deepEqual([...parsed[0]], [9, 9, 9]);
});

test('encodePcmToFrameFile -> readFrameFile round-trips to decodable Opus packets', () => {
  // Three 20ms frames (640 bytes each) of a synthesized tone.
  const totalSamples = opusCodec.OPUS_FRAME_SAMPLES * 3;
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * i * 0.05)), i * 2);
  }

  const file = opusCodec.encodePcmToFrameFile(pcm);
  const packets = opusCodec.readFrameFile(file);
  assert.equal(packets.length, 3);

  const decoder = opusCodec.createDecoder();
  for (const packet of packets) {
    const decoded = decoder.decode(packet);
    assert.equal(decoded.length, opusCodec.OPUS_FRAME_BYTES);
  }
});

test('encodePcmToFrameFile drops a trailing partial frame shorter than one full frame', () => {
  const partial = Buffer.alloc(opusCodec.OPUS_FRAME_BYTES - 2); // one frame short by 1 sample
  const file = opusCodec.encodePcmToFrameFile(partial);
  assert.equal(file.length, 0);
});

test('OPUS_TS_INCREMENT reflects the 48kHz RTP clock, not the 16kHz DSP rate', () => {
  assert.equal(opusCodec.OPUS_RTP_CLOCK, 48000);
  assert.equal(opusCodec.OPUS_TS_INCREMENT, opusCodec.OPUS_RTP_CLOCK * opusCodec.OPUS_FRAME_MS / 1000);
  assert.equal(opusCodec.OPUS_TS_INCREMENT, 960);
});

test('createEncoder/createDecoder are independently usable and match the fixed 16kHz mono config', () => {
  const encoder = opusCodec.createEncoder();
  const decoder = opusCodec.createDecoder();
  assert.equal(encoder.channels, 1);
  assert.equal(decoder.channels, 1);
  assert.equal(decoder.sample_rate, opusCodec.OPUS_SAMPLE_RATE);
});
