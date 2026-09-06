'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDtmfEvent, DtmfEventTracker, PENDING_TIMEOUT_MS } = require('../dtmfEvent.js');

function makePayload({ event = 0, end = false, volume = 10, duration = 800 } = {}) {
  const buf = Buffer.alloc(4);
  buf[0] = event;
  buf[1] = (end ? 0x80 : 0x00) | (volume & 0x3f);
  buf.writeUInt16BE(duration, 2);
  return buf;
}

test('parses a mid-event (non-end) packet', () => {
  const result = parseDtmfEvent(makePayload({ event: 5, end: false, duration: 160 }));
  assert.deepEqual(result, { digit: '5', isEnd: false, durationMs: 20 });
});

test('parses an end-of-event packet with duration converted to ms at 8kHz', () => {
  const result = parseDtmfEvent(makePayload({ event: 1, end: true, duration: 1600 }));
  assert.deepEqual(result, { digit: '1', isEnd: true, durationMs: 200 });
});

test('maps all 16 RFC 4733 DTMF event codes to the right digit', () => {
  const expected = '0123456789*#ABCD';
  for (let event = 0; event < 16; event++) {
    const result = parseDtmfEvent(makePayload({ event }));
    assert.equal(result.digit, expected[event]);
  }
});

test('returns null for event codes above 15 (non-DTMF tones, e.g. flash)', () => {
  assert.equal(parseDtmfEvent(makePayload({ event: 16 })), null);
  assert.equal(parseDtmfEvent(makePayload({ event: 255 })), null);
});

test('returns null for a too-short payload', () => {
  assert.equal(parseDtmfEvent(Buffer.alloc(3)), null);
  assert.equal(parseDtmfEvent(Buffer.alloc(0)), null);
});

test('returns null for a missing payload', () => {
  assert.equal(parseDtmfEvent(null), null);
  assert.equal(parseDtmfEvent(undefined), null);
});

test('end flag is read independently of the volume bits', () => {
  const withVolume = parseDtmfEvent(makePayload({ event: 9, end: true, volume: 0x3f, duration: 80 }));
  assert.equal(withVolume.isEnd, true);
  assert.equal(withVolume.digit, '9');
});

test('DtmfEventTracker fires immediately on a well-behaved end packet', () => {
  const tracker = new DtmfEventTracker();
  const ts = 4000;
  assert.equal(tracker.process(makePayload({ event: 2, end: false, duration: 160 }), ts, 0), null);
  assert.equal(tracker.process(makePayload({ event: 2, end: false, duration: 320 }), ts, 20), null);
  const result = tracker.process(makePayload({ event: 2, end: true, duration: 480 }), ts, 40);
  assert.deepEqual(result, { digit: '2', durationMs: 60 });
});

test('DtmfEventTracker ignores retransmitted end packets for the same event', () => {
  const tracker = new DtmfEventTracker();
  const ts = 4000;
  const first = tracker.process(makePayload({ event: 4, end: true, duration: 480 }), ts, 0);
  assert.deepEqual(first, { digit: '4', durationMs: 60 });
  // RFC 4733 retransmits the end packet 2-3x with the same timestamp
  assert.equal(tracker.process(makePayload({ event: 4, end: true, duration: 480 }), ts, 20), null);
  assert.equal(tracker.process(makePayload({ event: 4, end: true, duration: 480 }), ts, 40), null);
});

test('DtmfEventTracker reports two separate digits (different timestamps) independently', () => {
  const tracker = new DtmfEventTracker();
  const first  = tracker.process(makePayload({ event: 1, end: true, duration: 160 }), 1000, 0);
  const second = tracker.process(makePayload({ event: 7, end: true, duration: 160 }), 2000, 20);
  assert.deepEqual(first,  { digit: '1', durationMs: 20 });
  assert.deepEqual(second, { digit: '7', durationMs: 20 });
});

test('DtmfEventTracker fires after the pending timeout when no end packet ever arrives', () => {
  const tracker = new DtmfEventTracker();
  const ts = 4000;
  // Mirrors a real, observed Asterisk INFO-to-RFC4733 relay quirk: mid-event
  // packets every 20ms, end bit never set.
  let lastResult = null;
  for (let elapsed = 0; elapsed <= PENDING_TIMEOUT_MS + 40; elapsed += 20) {
    const duration = 160 + Math.floor(elapsed / 20) * 160;
    lastResult = tracker.process(makePayload({ event: 3, end: false, duration }), ts, elapsed);
    if (lastResult) break;
  }
  assert.ok(lastResult, 'expected the tracker to eventually fire via the timeout path');
  assert.equal(lastResult.digit, '3');
});

test('DtmfEventTracker does not fire before the pending timeout elapses', () => {
  const tracker = new DtmfEventTracker();
  const ts = 4000;
  const result = tracker.process(makePayload({ event: 3, end: false, duration: 160 }), ts, PENDING_TIMEOUT_MS - 1);
  assert.equal(result, null);
});

test('DtmfEventTracker does not double-fire if an end packet arrives after the timeout already fired', () => {
  const tracker = new DtmfEventTracker();
  const ts = 4000;
  assert.equal(tracker.process(makePayload({ event: 6, end: false, duration: 160 }), ts, 0), null);
  const timedOut = tracker.process(makePayload({ event: 6, end: false, duration: 320 }), ts, PENDING_TIMEOUT_MS);
  assert.deepEqual(timedOut, { digit: '6', durationMs: 40 });
  const late = tracker.process(makePayload({ event: 6, end: true, duration: 2000 }), ts, PENDING_TIMEOUT_MS + 100);
  assert.equal(late, null);
});
