// ─── Raw UDP SIP transport for JsSIP ─────────────────────────────────────────
// JsSIP's Transport/Socket layer is transport-agnostic (see lib/Transport.js
// and lib/WebSocketInterface.js) — it just needs an object implementing
// { url, via_transport, sip_uri, connect(), disconnect(), send(message) } and
// firing onconnect/ondisconnect/ondata callbacks that Transport assigns onto it.
//
// What JsSIP does NOT do is retransmission: its transaction layer (lib/
// Transactions.js, lib/Timers.js) only implements the dead-timeout timers
// (Timer B/F/H/L/M, all 64*T1=32s) and none of the retransmit-while-waiting
// timers (Timer A/E/G don't exist in the library at all) — it assumes a
// reliable transport throughout. Since UDP isn't reliable, this class layers
// its own RFC 3261-style retransmission (doubling interval, capped at T2=4s,
// giving up at the same ~32s mark JsSIP's own dead-timeout uses) underneath.
const dgram = require('dgram');

const T1 = 500;
const T2 = 4000;
const MAX_ELAPSED = 32000;

// Defensive backstop for binding to a port that's still (briefly) held by a
// socket this process is in the middle of tearing down — e.g. a reconnect
// path that doesn't go through sipManager.register()'s explicit
// releasePreviousTransport() (see that method's comment for the primary
// fix and why this alone isn't enough: JsSIP's own graceful teardown of a
// *registered* UA can leave the old socket bound for a couple seconds, well
// past a plain OS-level close()/rebind race). Note this does NOT cover the
// OPTIONS-keepalive-failure or IP-change re-register triggers in
// sipManager.js — both call JsSIP's lightweight ua.register() (a REGISTER
// refresh on the existing transport), which never rebuilds this socket at
// all, so nothing here or in releasePreviousTransport() runs for them.
const BIND_RETRY_ATTEMPTS  = 10;
const BIND_RETRY_DELAY_MS  = 100;

function parseTopViaBranch(text) {
  const m = text.match(/^Via:\s*([^\r\n]+)/mi);
  if (!m) return null;
  const b = m[1].match(/;branch=([^;,\s]+)/i);
  return b ? b[1] : null;
}

function parseCallId(text) {
  const m = text.match(/^Call-ID:\s*([^\r\n]+)/mi);
  return m ? m[1].trim() : null;
}

function parseCSeq(text) {
  const m = text.match(/^CSeq:\s*(\d+)\s+(\S+)/mi);
  return m ? { number: m[1], method: m[2].toUpperCase() } : null;
}

// Classify an outbound message so we know how to detect it's been delivered:
//  - requests (other than ACK, which never gets a response) are retransmitted
//    until any response sharing their branch arrives
//  - final responses (>=200) to an inbound INVITE are retransmitted until the
//    peer's ACK arrives (JsSIP doesn't retransmit 2xx/error finals itself —
//    Timer G and the UAS 2xx-retransmit rule are both unimplemented)
//  - everything else (1xx, responses to non-INVITE) needs no retransmission
function classifyOutbound(text) {
  const statusMatch = text.match(/^SIP\/2\.0\s+(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    const cseq   = parseCSeq(text);
    if (status >= 200 && cseq && cseq.method === 'INVITE') {
      return { kind: 'invite-final-response', callId: parseCallId(text), cseqNum: cseq.number };
    }
    return null;
  }
  const cseq = parseCSeq(text);
  if (cseq && cseq.method === 'ACK') return null;
  const branch = parseTopViaBranch(text);
  if (!branch) return null;
  return { kind: 'request', branch };
}

class UdpSocketInterface {
  constructor(remoteHost, remotePort, { localPort } = {}) {
    this._remoteHost    = remoteHost;
    this._remotePort    = remotePort;
    this._localPort     = localPort || 5060;
    this._via_transport = 'UDP';
    this._sip_uri       = `sip:${remoteHost}:${remotePort};transport=udp`;
    this._socket         = null;
    this._pending         = new Map();
    this._bindRetryTimer = null;
    this._closed          = false;

    // Assigned by JsSIP's Transport.js before calling connect()
    this.onconnect    = null;
    this.ondisconnect = null;
    this.ondata       = null;

    // Optional hook for the caller (sipManager) to observe raw SIP text for
    // pcap capture, without needing to reflect into transport internals.
    this.onRawMessage = null; // (text, direction: 'in' | 'out') => void
  }

  get via_transport() { return this._via_transport; }
  set via_transport(value) { this._via_transport = value.toUpperCase(); }
  get sip_uri() { return this._sip_uri; }
  get url() { return `udp://${this._remoteHost}:${this._remotePort}`; }

  connect() {
    if (this._socket) return;
    this._bindSocket(0);
  }

  _bindSocket(attempt) {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      this._cancelMatching(text);
      if (this.onRawMessage) this.onRawMessage(text, 'in');
      if (this.ondata) this.ondata(text);
    });

    const onBindError = (err) => {
      try { socket.close(); } catch (e) {}
      if (this._closed) return;
      if (err.code === 'EADDRINUSE' && attempt < BIND_RETRY_ATTEMPTS) {
        this._bindRetryTimer = setTimeout(() => {
          this._bindRetryTimer = null;
          this._bindSocket(attempt + 1);
        }, BIND_RETRY_DELAY_MS);
        return;
      }
      console.error(`[SIP/UDP] socket error: ${err.message} (gave up after ${attempt + 1} bind attempt(s))`);
      // Tell JsSIP the connect attempt failed outright, rather than leaving
      // it waiting on onconnect() forever: Transport._onDisconnect()
      // schedules its own reconnect via connection_recovery_min/max_interval
      // (see Transport.js's _reconnect()), so this socket gets another shot
      // once the port frees up instead of the caller's register() Promise
      // just hanging silently until its own 30s timeout with no indication
      // of what actually went wrong.
      if (this.ondisconnect) this.ondisconnect(true, undefined, err.message);
    };
    socket.once('error', onBindError);

    socket.bind(this._localPort, '0.0.0.0', () => {
      socket.removeListener('error', onBindError);
      if (this._closed) { try { socket.close(); } catch (e) {} return; }
      socket.on('error', (err) => {
        console.error(`[SIP/UDP] socket error: ${err.message}`);
      });
      this._socket = socket;
      console.log(`[SIP/UDP] bound 0.0.0.0:${this._localPort} -> ${this._remoteHost}:${this._remotePort}`);
      if (this.onconnect) this.onconnect();
    });
  }

  // Stops retransmits/retry timers and releases the OS port. Shared by
  // disconnect() and releasePort() — the only difference between them is
  // whether ondisconnect() fires afterward.
  _teardownSocket() {
    this._closed = true;
    if (this._bindRetryTimer) { clearTimeout(this._bindRetryTimer); this._bindRetryTimer = null; }
    for (const entry of this._pending.values()) clearTimeout(entry.timer);
    this._pending.clear();
    if (this._socket) {
      try { this._socket.close(); } catch (e) {}
      this._socket = null;
    }
  }

  disconnect() {
    this._teardownSocket();
    if (this.ondisconnect) this.ondisconnect();
  }

  // Immediately give up the OS port, without going through the normal
  // disconnect() event flow that JsSIP interprets as a transport-state
  // transition. JsSIP itself only calls disconnect() once its own graceful
  // un-REGISTER exchange finishes (ua.stop() sends un-REGISTER and waits on
  // it before tearing down the transport) — that can take well over a
  // second, during which this socket is still bound. A caller that's
  // abandoning this instance outright to build a replacement (e.g.
  // sipManager.register()'s explicit call via releasePreviousTransport())
  // needs the port back immediately, not once that exchange eventually
  // completes; the abandoned un-REGISTER just lapses, same as any
  // registration naturally expiring after register_expires.
  releasePort() {
    this._teardownSocket();
  }

  send(message) {
    if (!this._socket) return false;
    const text = String(message);
    this._transmit(text);
    if (this.onRawMessage) this.onRawMessage(text, 'out');
    this._scheduleRetransmit(text);
    return true;
  }

  _transmit(text) {
    try {
      this._socket.send(Buffer.from(text, 'utf8'), this._remotePort, this._remoteHost);
    } catch (e) {
      console.error(`[SIP/UDP] send error: ${e.message}`);
    }
  }

  _scheduleRetransmit(text) {
    const info = classifyOutbound(text);
    if (!info) return;

    const key = info.kind === 'request'
      ? `req:${info.branch}`
      : `res:${info.callId}:${info.cseqNum}`;

    const existing = this._pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const entry = { text, ...info, interval: T1, elapsed: 0, timer: null };
    const tick = () => {
      entry.elapsed += entry.interval;
      if (entry.elapsed >= MAX_ELAPSED) { this._pending.delete(key); return; }
      this._transmit(entry.text);
      entry.interval = Math.min(entry.interval * 2, T2);
      entry.timer = setTimeout(tick, entry.interval);
    };
    entry.timer = setTimeout(tick, entry.interval);
    this._pending.set(key, entry);
  }

  // Cancel pending retransmissions correlated with an inbound message.
  _cancelMatching(inboundText) {
    if (this._pending.size === 0) return;

    if (/^SIP\/2\.0/.test(inboundText)) {
      // Inbound response — cancel the matching outbound request's retransmit.
      const branch = parseTopViaBranch(inboundText);
      if (!branch) return;
      const key = `req:${branch}`;
      const entry = this._pending.get(key);
      if (entry) { clearTimeout(entry.timer); this._pending.delete(key); }
      return;
    }

    // Inbound request — only ACK matters here (confirms our final response).
    const cseq = parseCSeq(inboundText);
    if (!cseq || cseq.method !== 'ACK') return;
    const callId = parseCallId(inboundText);
    const key = `res:${callId}:${cseq.number}`;
    const entry = this._pending.get(key);
    if (entry) { clearTimeout(entry.timer); this._pending.delete(key); }
  }
}

module.exports = UdpSocketInterface;
