'use strict';

// RFC 4733 telephone-event payload parsing (PT 101 in this app's SDP).
// Payload is 4 bytes: event code, end-flag+reserved+volume, 16-bit duration.
const DTMF_EVENT_MAP = '0123456789*#ABCD';

// A digit's end-of-event packet is normally retransmitted 2-3 times for
// reliability and is otherwise how DtmfEventTracker knows a keypress
// finished — but some PBXes (confirmed against a real Asterisk 20.6.0,
// relaying INFO-based DTMF to RFC 4733) never set the end bit at all and
// just keep resending mid-event packets indefinitely. Firing after this
// many ms of the same event with no end bit means a keypress still gets
// reported instead of silently vanishing, while staying well above any
// legitimate keypress duration.
const PENDING_TIMEOUT_MS = 1500;

// Returns { digit, isEnd, durationMs } or null if the payload is malformed
// or the event code isn't a recognized DTMF digit (0-9, *, #, A-D — codes
// above 15, e.g. flash/fax tones, are ignored). The RTP clock for
// telephone-event is always 8000Hz (RFC 4733 §2.2), regardless of the
// call's actual audio codec.
function parseDtmfEvent(payload) {
  if (!payload || payload.length < 4) return null;
  const event = payload[0];
  if (event >= DTMF_EVENT_MAP.length) return null;
  const isEnd    = (payload[1] & 0x80) !== 0;
  const duration = payload.readUInt16BE(2);
  return {
    digit: DTMF_EVENT_MAP[event],
    isEnd,
    durationMs: Math.round((duration / 8000) * 1000),
  };
}

// Tracks RFC 4733 events across packets for one RTP stream and decides
// when a digit is done: on its end packet, or — guarding against a peer
// that never sends one — after PENDING_TIMEOUT_MS of continuous mid-event
// packets for the same RTP timestamp. Feed it every PT 101 packet via
// `process(payload, ts, now)`; it returns `{ digit, durationMs }` the
// moment a digit should be reported, or `null` otherwise. `now` defaults
// to `Date.now()` and is only a parameter so tests don't need to sleep.
class DtmfEventTracker {
  constructor() {
    this._lastReportedTs = null;
    this._pending = null; // { ts, firstSeenAt, durationMs }
  }

  process(payload, ts, now = Date.now()) {
    const parsed = parseDtmfEvent(payload);
    if (!parsed || ts === this._lastReportedTs) return null;

    if (parsed.isEnd) {
      this._lastReportedTs = ts;
      this._pending = null;
      return { digit: parsed.digit, durationMs: parsed.durationMs };
    }

    if (!this._pending || this._pending.ts !== ts) {
      this._pending = { ts, firstSeenAt: now, digit: parsed.digit };
    }
    this._pending.durationMs = parsed.durationMs;

    if (now - this._pending.firstSeenAt >= PENDING_TIMEOUT_MS) {
      this._lastReportedTs = ts;
      const result = { digit: this._pending.digit, durationMs: this._pending.durationMs };
      this._pending = null;
      return result;
    }
    return null;
  }
}

module.exports = { parseDtmfEvent, DtmfEventTracker, PENDING_TIMEOUT_MS };
