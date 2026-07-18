// ─── Raw TCP/TLS SIP transport for JsSIP ─────────────────────────────────────
// Same JsSIP Socket contract as udpSipSocket.js (see that file's header
// comment) — { url, via_transport, sip_uri, connect(), disconnect(),
// send(message) } plus onconnect/ondisconnect/ondata callbacks.
//
// Unlike UDP, TCP/TLS are stream transports: one socket 'data' event does not
// correspond to one SIP message — a message can be split across reads, or
// several messages can arrive in a single read. This class buffers incoming
// bytes and splits them into complete messages using each message's
// Content-Length header before handing them to JsSIP one at a time via
// ondata(). It also passes through bare CRLF/double-CRLF keepalive pings —
// JsSIP's own Transport._onData() already replies to those generically for
// any transport, so no special-casing is needed here beyond framing them
// correctly as their own "message".
//
// TCP/TLS are reliable transports, so — unlike udpSipSocket.js — there is no
// retransmission logic here at all; JsSIP's built-in dead-timeout timers
// (Timer B/F, ~32s) are sufficient on their own.
const net = require('net');
const tls = require('tls');

const CRLF2 = Buffer.from('\r\n\r\n');
const CRLF  = Buffer.from('\r\n');

class TcpSocketInterface {
  constructor(remoteHost, remotePort, { secure = false, rejectUnauthorized = true, localPort } = {}) {
    this._remoteHost         = remoteHost;
    this._remotePort         = remotePort;
    this._secure             = secure;
    this._rejectUnauthorized = rejectUnauthorized;
    this._localPort          = localPort;
    this._via_transport      = secure ? 'TLS' : 'TCP';
    this._sip_uri            = `sip:${remoteHost}:${remotePort};transport=${secure ? 'tls' : 'tcp'}`;
    this._socket              = null;
    this._buffer              = Buffer.alloc(0);

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
  get url() { return `${this._secure ? 'tls' : 'tcp'}://${this._remoteHost}:${this._remotePort}`; }

  connect() {
    if (this._socket) return;
    const opts = { host: this._remoteHost, port: this._remotePort };
    if (this._localPort) opts.localPort = this._localPort;

    const onReady = () => { if (this.onconnect) this.onconnect(); };
    this._socket = this._secure
      ? tls.connect({ ...opts, rejectUnauthorized: this._rejectUnauthorized }, onReady)
      : net.connect(opts, onReady);

    this._socket.on('data', (chunk) => this._handleData(chunk));
    this._socket.on('error', (err) => {
      console.error(`[SIP/${this._via_transport}] socket error: ${err.message}`);
    });
    this._socket.on('close', (hadError) => {
      if (this.ondisconnect) this.ondisconnect(hadError, undefined, hadError ? 'error' : 'closed');
    });
  }

  disconnect() {
    this._buffer = Buffer.alloc(0);
    if (this._socket) {
      try { this._socket.destroy(); } catch (e) {}
      this._socket = null;
    }
  }

  send(message) {
    if (!this._socket || this._socket.destroyed) return false;
    const text = String(message);
    try {
      this._socket.write(text, 'utf8');
    } catch (e) {
      console.error(`[SIP/${this._via_transport}] send error: ${e.message}`);
      return false;
    }
    if (this.onRawMessage) this.onRawMessage(text, 'out');
    return true;
  }

  // Split accumulated bytes into complete SIP messages (or bare keepalive
  // pings) and hand each one to JsSIP individually.
  _handleData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;

    for (;;) {
      if (this._buffer.length === 0) break;

      // Bare keepalive ping/pong — real SIP messages never start with CRLF,
      // so this is unambiguous regardless of what follows.
      if (this._buffer.length >= 4 && this._buffer.subarray(0, 4).equals(CRLF2)) {
        this._emit(this._buffer.subarray(0, 4).toString('utf8'));
        this._buffer = this._buffer.subarray(4);
        continue;
      }
      if (this._buffer.length >= 2 && this._buffer.subarray(0, 2).equals(CRLF)) {
        this._emit(this._buffer.subarray(0, 2).toString('utf8'));
        this._buffer = this._buffer.subarray(2);
        continue;
      }

      const headerEnd = this._buffer.indexOf(CRLF2);
      if (headerEnd === -1) break; // headers not fully arrived yet

      const headerText     = this._buffer.subarray(0, headerEnd).toString('utf8');
      const clMatch        = headerText.match(/^Content-Length:\s*(\d+)/mi);
      const contentLength  = clMatch ? parseInt(clMatch[1], 10) : 0;
      const totalLen       = headerEnd + 4 + contentLength;
      if (this._buffer.length < totalLen) break; // body not fully arrived yet

      const fullMessage = this._buffer.subarray(0, totalLen).toString('utf8');
      this._buffer = this._buffer.subarray(totalLen);
      this._emit(fullMessage);
    }
  }

  _emit(text) {
    if (this.onRawMessage) this.onRawMessage(text, 'in');
    if (this.ondata) this.ondata(text);
  }
}

module.exports = TcpSocketInterface;
