'use strict';

// A small fixed-depth reordering/pacing buffer for inbound RTP audio.
// Sits between arrival (RtpBridge's socket 'message' handler) and
// decode/relay/recording: holds packets briefly and releases them in RTP
// sequence-number order, instead of passing each one straight through to
// decode the instant it arrives off the wire. Absorbs the reordering and
// bursty/uneven arrival timing real networks add — this project's own
// CI/loopback testing is low-jitter enough that none of this matters
// there, which is exactly why it was never noticed missing (RtpBridge
// used to have no jitter buffer at all — packets went straight from the
// socket to decode in wire order).
//
// This class is deliberately timer-agnostic — it only knows about
// sequence numbers, not wall-clock time. The caller (RtpBridge) drives
// release pacing by calling tick() on a fixed interval matching the
// stream's packetization interval (20ms for every codec this project
// negotiates), which keeps the actual reordering/loss logic here fully
// testable without any real time passing.
//
// v1 is fixed-depth rather than adaptive to the jitterMs RtpBridge already
// measures for stats — kept deliberately simple; wiring targetDepth to
// that existing measurement is a reasonable follow-up once this is proven
// out against a real deployment, not a synthetic low-jitter one.
class JitterBuffer {
  constructor({ targetDepth = 3, onRelease }) {
    if (typeof onRelease !== 'function') throw new Error('JitterBuffer requires an onRelease callback');
    this.targetDepth = Math.max(1, targetDepth);
    this.onRelease = onRelease;

    this._queue    = new Map(); // seq -> packet (opaque to the buffer)
    this._nextSeq  = null;      // next seq to release, once primed
    this._lastSsrc = null;
    this._primed   = false;     // whether targetDepth has been reached since the last idle/reset
  }

  // seq/ssrc are the packet's RTP sequence number and SSRC; packet is
  // opaque and handed back verbatim to onRelease. An SSRC change (source
  // switch mid-call, e.g. a re-INVITE) re-primes immediately rather than
  // treating the new stream's low sequence numbers as stale relative to
  // the old one's.
  push(seq, ssrc, packet) {
    if (this._nextSeq === null || ssrc !== this._lastSsrc) {
      this._queue.clear();
      this._nextSeq  = seq;
      this._lastSsrc = ssrc;
      this._primed   = false;
    } else {
      const distance = (seq - this._nextSeq) & 0xffff;
      if (distance >= 0x8000) {
        // "Behind" the current baseline in wraparound-aware terms. If
        // we've already started releasing, that slot is gone — stale or
        // duplicate, drop it. If we haven't (still filling the initial
        // cushion), this is actually an *earlier* packet than our
        // baseline that simply arrived later — pull the baseline back to
        // it rather than dropping a legitimate reordered packet.
        if (this._primed) return;
        this._nextSeq = seq;
      } else if (distance > this.targetDepth * 50) {
        // A forward jump far beyond anything a real jitter/reorder window
        // would produce (e.g. a long silence gap with no comfort noise)
        // means waiting for the hole to close would just stall forever —
        // re-prime at the new position instead.
        this._queue.clear();
        this._nextSeq = seq;
        this._primed  = false;
      }
    }
    this._queue.set(seq, packet);
  }

  // Releases at most one packet, in sequence order. No-op while empty or
  // still filling the initial cushion. Call on a fixed interval — see the
  // class comment above.
  tick() {
    if (this._nextSeq === null) return;
    if (!this._primed) {
      if (this._queue.size < this.targetDepth) return; // still filling the initial cushion
      this._primed = true;
    }

    const packet = this._queue.get(this._nextSeq);
    if (packet !== undefined) {
      this._queue.delete(this._nextSeq);
      this.onRelease(packet);
    }
    // Present or not — a missing slot is a lost packet, not something to
    // wait out indefinitely, so advance either way.
    this._nextSeq = (this._nextSeq + 1) & 0xffff;

    if (this._queue.size === 0) {
      this._nextSeq = null; // re-prime cleanly after the next gap/silence
      this._primed  = false;
    }
  }

  stop() {
    this._queue.clear();
    this._nextSeq  = null;
    this._lastSsrc = null;
    this._primed   = false;
  }
}

module.exports = { JitterBuffer };
