// ─── SIP-over-WebSocket transport for JsSIP ──────────────────────────────────
// A thin subclass of JsSIP's own WebSocketInterface that adds the same
// `onRawMessage(text, direction)` contract udpSipSocket.js and tcpSipSocket.js
// already implement, so sipManager's pcap capture hook can treat all three
// transports identically.
//
// JsSIP ships WebSocketInterface itself (unlike the raw UDP/TCP transports,
// which this project implements from scratch against JsSIP's Socket contract),
// and it deliberately exposes no raw-message callback. Previously that was
// worked around by reflecting into transport internals after connect —
// guessing at `_ws`/`ws`/`_socket`/`socket`, wrapping `ondata`, and trying
// `.on('message')` / `.addEventListener` / `.onmessage` in sequence, on a
// timer, hoping one stuck. Subclassing the two methods every inbound and
// outbound message already funnels through is both smaller and reliable:
// `_onMessage()` is called for every frame JsSIP receives, and `send()` for
// every one it transmits.
'use strict';

const JsSIP = require('jssip');

class WsSocketInterface extends JsSIP.WebSocketInterface {
  constructor(url) {
    super(url);
    // Optional hook for the caller (sipManager) to observe raw SIP text for
    // pcap capture — same signature as UdpSocketInterface/TcpSocketInterface.
    this.onRawMessage = null; // (text, direction: 'in' | 'out') => void
  }

  _onMessage(event) {
    super._onMessage(event);
    if (!this.onRawMessage) return;
    const text = toText(event?.data);
    if (text) this.onRawMessage(text, 'in');
  }

  send(message) {
    const sent = super.send(message);
    // Only report what actually went out — super.send() returns false when
    // the socket isn't open, and nothing was transmitted in that case.
    if (sent && this.onRawMessage) {
      const text = toText(message);
      if (text) this.onRawMessage(text, 'out');
    }
    return sent;
  }
}

// binaryType is 'arraybuffer' (set by JsSIP), so inbound frames arrive as
// either a string or an ArrayBuffer depending on how the peer framed them.
function toText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

module.exports = WsSocketInterface;
