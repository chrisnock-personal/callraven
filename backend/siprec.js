'use strict';

/**
 * siprec.js — SIPREC (RFC 7865/7866) SRC (Session Recording Client) support.
 *
 * Sends a copy of CallRaven's own primary call to a configured external
 * SIP-REC server (SRS). This is a *separate*, brand-new SIP dialog to an
 * unrelated destination (the SRS, not the registered PBX) that must coexist
 * alongside the primary call's own JsSIP session — it can't reuse JsSIP's
 * UA/dialog machinery (see sipManager.js's _buildSipMessage/_dialogFields,
 * which are tightly coupled to an *existing* dialog and the primary call's
 * own transport), so this is a small, standalone raw SIP UAC: its own UDP
 * socket, its own Call-ID/tags/CSeq, no JsSIP involvement at all.
 *
 * Per RFC 7866, recorded media is NOT a literal duplicate of the primary
 * call's RTP packets — the SRC maps each stream to its own fresh SSRC/CNAME
 * identity, and inbound/outbound are two separate sendonly streams (not one
 * mixed stream). RTCP is REQUIRED (SR + SDES/CNAME) so the SRS can associate
 * SSRC with the metadata's participant/stream IDs. Both streams use
 * a=rtcp-mux (RTP and RTCP share one UDP socket/port) to avoid needing a
 * second port per stream.
 */

const dgram = require('dgram');
const crypto = require('crypto');
const { OPUS_PT } = require('./opusCodec');

const RECORDING_XMLNS = 'urn:ietf:params:xml:ns:recording:1';
const NTP_UNIX_EPOCH_OFFSET = 2208988800; // seconds between 1900-01-01 and 1970-01-01
const RTCP_INTERVAL_MS = 5000; // RFC 3550's recommended minimum interval

// ─── IDs ──────────────────────────────────────────────────────────────────
// RFC 7865: all IDs (session/participant/stream) are 16 random bytes,
// base64-encoded — not plain UUID strings.
function generateId() {
  return crypto.randomBytes(16).toString('base64');
}

// ─── Metadata XML (RFC 7865) ───────────────────────────────────────────────
// Builds a minimal, valid rs-metadata document for a 2-party call recorded
// as two unidirectional streams (one per direction). Each participant is
// associated with the stream it sends on and the stream it receives
// (listens to) — the other party's stream.
function buildMetadataXml({ sessionId, localAor, localName, remoteAor, remoteName,
                             localParticipantId, remoteParticipantId,
                             localStreamId, remoteStreamId, localLabel, remoteLabel }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<recording xmlns='${RECORDING_XMLNS}'>`,
    '  <datamode>complete</datamode>',
    `  <session session_id="${sessionId}"/>`,
    `  <participant participant_id="${localParticipantId}">`,
    `    <nameID aor="${esc(localAor)}">`,
    `      <name>${esc(localName || localAor)}</name>`,
    '    </nameID>',
    '  </participant>',
    `  <participant participant_id="${remoteParticipantId}">`,
    `    <nameID aor="${esc(remoteAor)}">`,
    `      <name>${esc(remoteName || remoteAor)}</name>`,
    '    </nameID>',
    '  </participant>',
    `  <stream stream_id="${localStreamId}" session_id="${sessionId}">`,
    `    <label>${localLabel}</label>`,
    '  </stream>',
    `  <stream stream_id="${remoteStreamId}" session_id="${sessionId}">`,
    `    <label>${remoteLabel}</label>`,
    '  </stream>',
    `  <participantstreamassoc participant_id="${localParticipantId}">`,
    `    <send>${localStreamId}</send>`,
    `    <recv>${remoteStreamId}</recv>`,
    '  </participantstreamassoc>',
    `  <participantstreamassoc participant_id="${remoteParticipantId}">`,
    `    <send>${remoteStreamId}</send>`,
    `    <recv>${localStreamId}</recv>`,
    '  </participantstreamassoc>',
    '</recording>',
    '',
  ].join('\r\n');
}

// ─── Multipart INVITE body (RFC 7866 §9.1) ─────────────────────────────────
// One m=audio line per direction, each a=sendonly + a=label:N + a=rtcp-mux.
// localPort is the same port used for both streams' sockets since each is
// its own independent UDP socket bound separately — this just needs a
// value per line, the actual bind happens in SiprecStreamSender.
// The codec list here MUST match sipManager.js's buildSdp (Opus/G722/PCMU/
// PCMA) — the bytes actually forwarded to each stream are whatever raw
// payload+PT the primary call ends up negotiating (see SipManager.
// _startSiprec's onSiprecAudio/onSiprecOutboundAudio taps), and that isn't
// known at the time this SIPREC session is established, so every codec the
// primary call could possibly end up using has to already be declared here.
function _codecLines() {
  return [
    `a=rtpmap:${OPUS_PT} opus/48000/2`,
    `a=fmtp:${OPUS_PT} useinbandfec=1;stereo=0;sprop-stereo=0`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:9 G722/8000',
  ];
}

function buildSdp(localIp, localPortLocal, localPortRemote, { localLabel, remoteLabel }) {
  return [
    'v=0',
    `o=CallRaven ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
    's=CallRaven SIPREC',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${localPortLocal} RTP/AVP ${OPUS_PT} 0 8 9`,
    ..._codecLines(),
    'a=sendonly',
    'a=rtcp-mux',
    `a=label:${localLabel}`,
    `m=audio ${localPortRemote} RTP/AVP ${OPUS_PT} 0 8 9`,
    ..._codecLines(),
    'a=sendonly',
    'a=rtcp-mux',
    `a=label:${remoteLabel}`,
    '',
  ].join('\r\n');
}

function buildInviteBody({ localIp, localPortLocal, localPortRemote, labels, metadataXml }) {
  const boundary = `siprec-${crypto.randomBytes(8).toString('hex')}`;
  const sdp = buildSdp(localIp, localPortLocal, localPortRemote, labels);
  const body = [
    `--${boundary}`,
    'Content-Type: application/sdp',
    '',
    sdp,
    `--${boundary}`,
    'Content-Type: application/rs-metadata',
    'Content-Disposition: recording-session',
    '',
    metadataXml,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { boundary, body };
}

// ─── Parse the SRS's 200 OK SDP answer ─────────────────────────────────────
// Returns [{ ip, port }, { ip, port }] in m=-line order (matches the order
// buildSdp emitted its two lines in — local-stream first, remote-stream
// second), so the caller can zip this against its own stream senders.
function parseAnswerSdp(sdp) {
  if (!sdp) return [];
  const lines = sdp.split(/\r?\n/);
  let sessionIp = null;
  let seenMedia = false;
  const streams = [];
  for (const line of lines) {
    const m = line.match(/^m=audio (\d+)/);
    if (m) {
      seenMedia = true;
      streams.push({ ip: sessionIp, port: parseInt(m[1], 10) });
      continue;
    }
    const c = line.match(/^c=IN IP4 (.+)/);
    if (c) {
      // Before the first m= line, c= is session-level (applies to every
      // stream unless overridden); after it, c= applies only to the
      // current (most recently pushed) stream.
      if (!seenMedia) sessionIp = c[1].trim();
      else if (streams.length > 0) streams[streams.length - 1].ip = c[1].trim();
    }
  }
  return streams;
}

// ─── RTCP (RFC 3550) ────────────────────────────────────────────────────────
// Sender Report (§6.4.1) + SDES/CNAME (§6.5), the minimum a receiver needs
// to associate this stream's SSRC with a CNAME identity. No report blocks
// (RC=0) since this is a send-only stream with nothing to report on.
function buildRtcpSr({ ssrc, rtpTimestamp, packetCount, octetCount, cname }) {
  const now = Date.now();
  const ntpSeconds = Math.floor(now / 1000) + NTP_UNIX_EPOCH_OFFSET;
  const ntpFraction = Math.round(((now % 1000) / 1000) * 0x100000000);

  const sr = Buffer.alloc(28);
  sr[0] = 0x80; // V=2, P=0, RC=0
  sr[1] = 200;  // PT=SR
  sr.writeUInt16BE(6, 2); // length in 32-bit words - 1 (7 words total)
  sr.writeUInt32BE(ssrc >>> 0, 4);
  sr.writeUInt32BE(ntpSeconds >>> 0, 8);
  sr.writeUInt32BE(ntpFraction >>> 0, 12);
  sr.writeUInt32BE(rtpTimestamp >>> 0, 16);
  sr.writeUInt32BE(packetCount >>> 0, 20);
  sr.writeUInt32BE(octetCount >>> 0, 24);

  const cnameBuf = Buffer.from(cname, 'utf8');
  const itemLen = 2 + cnameBuf.length; // type(1) + length(1) + value
  const chunkLen = 4 + itemLen + 1;    // SSRC(4) + item + END(1)
  const padded = Math.ceil(chunkLen / 4) * 4;
  const sdes = Buffer.alloc(4 + padded);
  sdes[0] = 0x81; // V=2, P=0, SC=1
  sdes[1] = 202;  // PT=SDES
  sdes.writeUInt16BE((4 + padded) / 4 - 1, 2);
  sdes.writeUInt32BE(ssrc >>> 0, 4);
  sdes[8] = 1; // CNAME
  sdes[9] = cnameBuf.length;
  cnameBuf.copy(sdes, 10);
  sdes[10 + cnameBuf.length] = 0; // END

  return Buffer.concat([sr, sdes]);
}

// ─── One direction's RTP+RTCP stream to the SRS ────────────────────────────
class SiprecStreamSender {
  constructor(label) {
    this.label = label;
    this.ssrc = (Math.random() * 0xffffffff) >>> 0;
    this.cname = `callraven-${crypto.randomBytes(6).toString('hex')}`;
    this.seq = (Math.random() * 0xffff) >>> 0;
    this.timestamp = (Math.random() * 0xffffffff) >>> 0;
    this.packetCount = 0;
    this.octetCount = 0;
    this.socket = null;
    this.remoteIp = null;
    this.remotePort = null;
    this._rtcpTimer = null;
  }

  bind() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.once('error', reject);
      this.socket.bind(0, () => {
        this.socket.removeListener('error', reject);
        this.socket.on('error', (e) => console.error(`[SIPREC] stream ${this.label} socket error: ${e.message}`));
        resolve(this.socket.address().port);
      });
    });
  }

  connect(remoteIp, remotePort) {
    this.remoteIp = remoteIp;
    this.remotePort = remotePort;
    this._rtcpTimer = setInterval(() => this._sendRtcp(), RTCP_INTERVAL_MS);
  }

  // Re-packetizes an already-encoded codec payload (tapped from the primary
  // call's onRawAudio/onRawOutboundAudio) under this stream's own SSRC/seq/
  // timestamp identity — same RTP header shape as RtpBridge._sendRtpPacket,
  // but never the primary call's own packet bytes verbatim (RFC 7866
  // requires a fresh identity per stream, not literal duplication).
  sendRtp(payload, pt, tsIncrement = payload.length) {
    if (!this.socket || !this.remotePort) return;
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + tsIncrement) >>> 0;
    const pkt = Buffer.alloc(12 + payload.length);
    pkt[0] = 0x80;
    pkt[1] = pt;
    pkt.writeUInt16BE(this.seq, 2);
    pkt.writeUInt32BE(this.timestamp, 4);
    pkt.writeUInt32BE(this.ssrc, 8);
    payload.copy(pkt, 12);
    this.packetCount++;
    this.octetCount += payload.length;
    try { this.socket.send(pkt, this.remotePort, this.remoteIp); } catch (e) { /* non-fatal */ }
  }

  _sendRtcp() {
    if (!this.socket || !this.remotePort) return;
    const pkt = buildRtcpSr({
      ssrc: this.ssrc, rtpTimestamp: this.timestamp,
      packetCount: this.packetCount, octetCount: this.octetCount, cname: this.cname,
    });
    try { this.socket.send(pkt, this.remotePort, this.remoteIp); } catch (e) { /* non-fatal */ }
  }

  stop() {
    if (this._rtcpTimer) { clearInterval(this._rtcpTimer); this._rtcpTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch (e) {} this.socket = null; }
  }
}

// ─── Minimal raw SIP response parser ───────────────────────────────────────
// Just enough to drive a one-shot INVITE/ACK/BYE exchange: status code,
// a case-insensitive header lookup, and the body. Not a general SIP parser.
function parseSipResponse(text) {
  const statusMatch = text.match(/^SIP\/2\.0\s+(\d{3})/);
  if (!statusMatch) return null;
  const headerEnd = text.indexOf('\r\n\r\n');
  const headerText = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const body = headerEnd >= 0 ? text.slice(headerEnd + 4) : '';
  const headers = {};
  for (const line of headerText.split(/\r\n/).slice(1)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { status: parseInt(statusMatch[1], 10), headers, body };
}

function extractTag(headerValue) {
  if (!headerValue) return null;
  const m = headerValue.match(/;tag=([^;,\s]+)/);
  return m ? m[1] : null;
}

// Parses a target like "sip:recorder@203.0.113.5:5061" or "203.0.113.5:5061"
// into { userAtHost, host, port }.
function parseSrsUri(uri) {
  const stripped = uri.replace(/^sips?:/i, '');
  const at = stripped.lastIndexOf('@');
  const userAtHost = stripped;
  const hostPort = at >= 0 ? stripped.slice(at + 1) : stripped;
  const [host, portStr] = hostPort.split(':');
  return { userAtHost, host, port: portStr ? parseInt(portStr, 10) : 5060 };
}

// ─── The SIPREC dialog itself (raw SIP UAC — see file header for why) ──────
class SiprecClient {
  constructor({ srsUri, localIp, localAor, localName, remoteAor, remoteName, inviteTimeoutMs = 4000, inviteRetries = 1 }) {
    this.srsUri = srsUri;
    this.localIp = localIp;
    this.localAor = localAor;
    this.localName = localName;
    this.remoteAor = remoteAor;
    this.remoteName = remoteName;
    // Overridable only so tests don't have to wait out the real production
    // timeout (retries+1 attempts at 4s each) to exercise the no-response path.
    this.inviteTimeoutMs = inviteTimeoutMs;
    this.inviteRetries = inviteRetries;

    this.callId = `${generateId()}@${localIp}`;
    this.fromTag = crypto.randomBytes(8).toString('hex');
    this.toTag = null;
    this.cseq = 1;

    this.sipSocket = null;
    this.sipPort = null;
    this.localStream = null;  // SiprecStreamSender for our own outbound audio
    this.remoteStream = null; // SiprecStreamSender for the far end's audio
    this._active = false;
  }

  // Sends the recording-session INVITE and, on a 200 OK, connects both
  // stream senders to the SRS's negotiated ports and ACKs. Resolves on
  // success; rejects (without throwing past the caller) on any failure —
  // the caller is expected to treat SIPREC delivery failure as non-fatal
  // to the primary call (see sipManager.js's integration).
  async start() {
    const { userAtHost, host, port } = parseSrsUri(this.srsUri);

    this.localStream = new SiprecStreamSender(1);
    this.remoteStream = new SiprecStreamSender(2);
    const [localPort, remotePort] = await Promise.all([this.localStream.bind(), this.remoteStream.bind()]);

    this.sipSocket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      this.sipSocket.once('error', reject);
      this.sipSocket.bind(0, () => { this.sipSocket.removeListener('error', reject); resolve(); });
    });
    this.sipPort = this.sipSocket.address().port;

    const sessionId = generateId();
    const localStreamId = generateId();
    const remoteStreamId = generateId();
    const metadataXml = buildMetadataXml({
      sessionId,
      localAor: this.localAor, localName: this.localName,
      remoteAor: this.remoteAor, remoteName: this.remoteName,
      localParticipantId: generateId(), remoteParticipantId: generateId(),
      localStreamId, remoteStreamId, localLabel: 1, remoteLabel: 2,
    });
    const { boundary, body } = buildInviteBody({
      localIp: this.localIp, localPortLocal: localPort, localPortRemote: remotePort,
      labels: { localLabel: 1, remoteLabel: 2 }, metadataXml,
    });

    const branch = `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;
    const invite = [
      `INVITE sip:${userAtHost} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.sipPort};branch=${branch}`,
      'Max-Forwards: 70',
      `From: <sip:callraven@${this.localIp}>;tag=${this.fromTag}`,
      `To: <sip:${userAtHost}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} INVITE`,
      `Contact: <sip:callraven@${this.localIp}:${this.sipPort}>;+sip.src`,
      'Require: siprec',
      'Accept: application/sdp, application/rs-metadata',
      `Content-Type: multipart/mixed;boundary=${boundary}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n');

    const response = await this._sendAndWait(invite, host, port, { retries: this.inviteRetries, timeoutMs: this.inviteTimeoutMs });
    if (!response) throw new Error('No response from SIPREC server (timed out)');
    if (response.status >= 300) throw new Error(`SIPREC server rejected INVITE: ${response.status}`);
    if (response.status >= 200) {
      this.toTag = extractTag(response.headers['to']);
      const streams = parseAnswerSdp(response.body);
      if (streams.length < 2) throw new Error('SIPREC server answer did not include two media streams');
      this.localStream.connect(streams[0].ip || host, streams[0].port);
      this.remoteStream.connect(streams[1].ip || host, streams[1].port);

      const ackBranch = `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;
      const ack = [
        `ACK sip:${userAtHost} SIP/2.0`,
        `Via: SIP/2.0/UDP ${this.localIp}:${this.sipPort};branch=${ackBranch}`,
        'Max-Forwards: 70',
        `From: <sip:callraven@${this.localIp}>;tag=${this.fromTag}`,
        `To: <sip:${userAtHost}>;tag=${this.toTag}`,
        `Call-ID: ${this.callId}`,
        `CSeq: ${this.cseq} ACK`,
        'Content-Length: 0',
        '', '',
      ].join('\r\n');
      this.sipSocket.send(ack, port, host);
      this._active = true;
      this._srsHost = host;
      this._srsPort = port;
      this._userAtHost = userAtHost;
    }
  }

  // Forward already-encoded codec payload bytes (same pt as the primary
  // call is using) to the SRS under this session's own stream identities —
  // see SiprecStreamSender.sendRtp for why this isn't literal duplication.
  feedLocal(payload, pt, tsIncrement) { if (this._active) this.localStream.sendRtp(payload, pt, tsIncrement); }
  feedRemote(payload, pt, tsIncrement) { if (this._active) this.remoteStream.sendRtp(payload, pt, tsIncrement); }

  async stop() {
    if (this._active) {
      this.cseq++;
      const branch = `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;
      const bye = [
        `BYE sip:${this._userAtHost} SIP/2.0`,
        `Via: SIP/2.0/UDP ${this.localIp}:${this.sipPort};branch=${branch}`,
        'Max-Forwards: 70',
        `From: <sip:callraven@${this.localIp}>;tag=${this.fromTag}`,
        `To: <sip:${this._userAtHost}>;tag=${this.toTag}`,
        `Call-ID: ${this.callId}`,
        `CSeq: ${this.cseq} BYE`,
        'Content-Length: 0',
        '', '',
      ].join('\r\n');
      // dgram.send() is asynchronous — awaiting its callback here matters:
      // closing the socket immediately after firing it (as this used to do)
      // could tear the socket down before the BYE actually reached the
      // kernel's send path, silently dropping it (confirmed while testing
      // against the mock SIPREC server: RTP/RTCP arrived fine, but the BYE
      // never did, until this await was added).
      await new Promise((resolve) => {
        try { this.sipSocket.send(bye, this._srsPort, this._srsHost, () => resolve()); }
        catch (e) { resolve(); }
      });
      this._active = false;
    }
    if (this.localStream) this.localStream.stop();
    if (this.remoteStream) this.remoteStream.stop();
    if (this.sipSocket) { try { this.sipSocket.close(); } catch (e) {} this.sipSocket = null; }
  }

  // Sends `message` to host:port and resolves with the first parsed final
  // (>=200) response, skipping provisional (1xx) ones, retrying once on
  // timeout. Not full RFC 3261 transaction handling — see file header on
  // why a minimal one-shot exchange is the right scope for this feature.
  _sendAndWait(message, host, port, { retries, timeoutMs }) {
    return new Promise((resolve) => {
      let settled = false;
      let attempt = 0;
      const onMessage = (msg) => {
        const parsed = parseSipResponse(msg.toString('utf8'));
        if (!parsed || parsed.status < 200) return; // ignore provisional/garbage
        if (settled) return;
        settled = true;
        this.sipSocket.removeListener('message', onMessage);
        clearTimeout(timer);
        resolve(parsed);
      };
      this.sipSocket.on('message', onMessage);
      let timer;
      const send = () => {
        try { this.sipSocket.send(message, port, host); } catch (e) { /* handled by timeout */ }
        timer = setTimeout(() => {
          if (settled) return;
          if (attempt++ < retries) { send(); return; }
          settled = true;
          this.sipSocket.removeListener('message', onMessage);
          resolve(null);
        }, timeoutMs);
      };
      send();
    });
  }
}

module.exports = {
  RECORDING_XMLNS,
  RTCP_INTERVAL_MS,
  generateId,
  buildMetadataXml,
  buildSdp,
  buildInviteBody,
  parseAnswerSdp,
  buildRtcpSr,
  parseSipResponse,
  parseSrsUri,
  SiprecStreamSender,
  SiprecClient,
};
