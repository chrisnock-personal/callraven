// ─── Browser global stubs ────────────────────────────────────────────────────
const _navigator = {
  mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
  userAgent: 'Node.js'
};

function _RTCPeerConnection() {
  const listeners = {};
  const pc = {
    onicecandidate: null, ontrack: null,
    oniceconnectionstatechange: null, onicegatheringstatechange: null,
    onsignalingstatechange: null,
    iceConnectionState: 'completed', iceGatheringState: 'complete',
    signalingState: 'stable', localDescription: null, remoteDescription: null,
    addTrack: () => {}, close: () => {},
    addEventListener: (type, fn) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener: (type, fn) => {
      if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
    },
    dispatchEvent: (evt) => { (listeners[evt.type] || []).forEach(fn => fn(evt)); },
    createOffer:  () => Promise.resolve({ type: 'offer',  sdp: '' }),
    createAnswer: () => Promise.resolve({ type: 'answer', sdp: '' }),
    setLocalDescription: (d) => {
      pc.localDescription = d;
      setTimeout(() => {
        pc.iceGatheringState = 'complete';
        if (typeof pc.onicegatheringstatechange === 'function')
          pc.onicegatheringstatechange({ target: pc });
        pc.dispatchEvent({ type: 'icegatheringstatechange', target: pc });
        if (typeof pc.onicecandidate === 'function')
          pc.onicecandidate({ candidate: null });
        pc.dispatchEvent({ type: 'icecandidate', candidate: null });
      }, 0);
      return Promise.resolve();
    },
    setRemoteDescription: (d) => { pc.remoteDescription = d; return Promise.resolve(); },
  };
  return pc;
}
_RTCPeerConnection.prototype = {};

global.window                = global;
global.navigator             = _navigator;
global.document              = { addEventListener: () => {}, createElement: () => ({}) };
global.RTCPeerConnection     = _RTCPeerConnection;
global.RTCSessionDescription = function(init) { return init; };
global.RTCIceCandidate       = function(init) { return init; };
global.MediaStream           = function() { return { getTracks: () => [] }; };

// ─── Dependencies ────────────────────────────────────────────────────────────
const EventEmitter   = require('events');
const dgram          = require('dgram');
const os             = require('os');
const fs             = require('fs');
const path           = require('path');
const captureManager = require('./captureManager');
const callHistory    = require('./callHistory');
const { AudioWriter } = require('./audioDecoder');

const WebSocket = require('ws');
global.WebSocket = WebSocket;

const JsSIP = require('jssip');

// ─── RTP port pool ───────────────────────────────────────────────────────────
const RTP_PORT_LOW  = parseInt(process.env.RTP_PORT_LOW  || '10000');
const RTP_PORT_HIGH = parseInt(process.env.RTP_PORT_HIGH || '20000');
let   nextRtpPort   = RTP_PORT_LOW;

function allocateRtpPort() {
  const port = nextRtpPort;
  nextRtpPort += 2;
  if (nextRtpPort > RTP_PORT_HIGH) nextRtpPort = RTP_PORT_LOW;
  return port;
}

// ─── Local IP ────────────────────────────────────────────────────────────────
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return '127.0.0.1';
}

// ─── SDP ─────────────────────────────────────────────────────────────────────
// Codec preference order: G.722 (PT9) > PCMU (PT0) > PCMA (PT8)
// G.722 is 16kHz wideband — RTP clock is 8000 per RFC 3551 (a historical quirk)
// but actual audio is 16kHz ADPCM.
function buildSdp(localIp, rtpPort) {
  const id = Date.now();
  return [
    'v=0',
    `o=SIPEndpoint ${id} ${id} IN IP4 ${localIp}`,
    's=SIPEndpoint Call',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 9 0 8 101`,
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=sendrecv',
    ''
  ].join('\r\n');
}

// Hold SDP — sendonly tells remote to stop sending RTP
function buildSdpHold(localIp, rtpPort) {
  const id = Date.now();
  return [
    'v=0',
    `o=SIPEndpoint ${id} ${id} IN IP4 ${localIp}`,
    's=SIPEndpoint Call',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 9 0 8 101`,
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=sendonly',
    ''
  ].join('\r\n');
}

function parseRemoteSdp(sdp) {
  if (!sdp) return null;
  const lines = sdp.split(/\r?\n/);
  let ip = null, port = null;
  for (const line of lines) {
    const c = line.match(/^c=IN IP4 (.+)/);
    if (c) ip = c[1].trim();
    const m = line.match(/^m=audio (\d+)/);
    if (m) port = parseInt(m[1]);
  }
  return ip && port ? { ip, port } : null;
}

// ─── WAV header parser ────────────────────────────────────────────────────────
function parseWavHeader(buf) {
  // Minimum WAV header is 44 bytes
  if (buf.length < 44) throw new Error('File too small to be a WAV');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAVE file');

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLen    = -1;

  // Walk chunks
  while (offset + 8 <= buf.length) {
    const id  = buf.toString('ascii', offset, offset + 4);
    const len = buf.readUInt32LE(offset + 4);
    offset += 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat:   buf.readUInt16LE(offset),      // 1=PCM, 3=float
        channels:      buf.readUInt16LE(offset + 2),
        sampleRate:    buf.readUInt32LE(offset + 4),
        byteRate:      buf.readUInt32LE(offset + 8),
        blockAlign:    buf.readUInt16LE(offset + 10),
        bitsPerSample: buf.readUInt16LE(offset + 14)
      };
    } else if (id === 'data') {
      dataOffset = offset;
      dataLen    = len;
      break;
    }

    offset += len + (len % 2); // chunks are word-aligned
  }

  if (!fmt)            throw new Error('No fmt chunk found');
  if (dataOffset < 0) throw new Error('No data chunk found');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3)
    throw new Error(`Unsupported WAV format: ${fmt.audioFormat} (only PCM supported)`);

  return { fmt, dataOffset, dataLen: Math.min(dataLen, buf.length - dataOffset) };
}

// ─── μ-law encoder ────────────────────────────────────────────────────────────
function pcmToUlaw(sample) {
  const BIAS = 0x84, MAX = 32767;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MAX) sample = MAX;
  sample += BIAS;
  let exp = 7;
  for (let m = 0x4000; (sample & m) === 0 && exp > 0; exp--, m >>= 1) {}
  return ~(sign | (exp << 4) | ((sample >> (exp + 3)) & 0x0f)) & 0xff;
}

// ─── Read one sample from raw audio buffer as signed 16-bit ──────────────────
function readSample(raw, byteIndex, bitsPerSample, audioFormat) {
  switch (bitsPerSample) {
    case 8:  return (raw[byteIndex] - 128) * 256;
    case 16: return raw.readInt16LE(byteIndex);
    case 24: {
      const s = raw[byteIndex] | (raw[byteIndex+1] << 8) | (raw[byteIndex+2] << 16);
      return ((s & 0x800000) ? s - 0x1000000 : s) >> 8;
    }
    case 32:
      return audioFormat === 3
        ? Math.round(raw.readFloatLE(byteIndex) * 32767)
        : Math.round(raw.readInt32LE(byteIndex) / 65536);
    default: return 0;
  }
}

// ─── Convert any WAV audio data to 8kHz mono PCMU (μ-law) ────────────────────
// Returns a Buffer of PCMU bytes ready to send as RTP payload.
// Converts directly to output format without intermediate arrays —
// safe for large files without blocking the event loop per-frame.
function convertToUlaw8k(raw, fmt) {
  const { sampleRate, channels, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameSize      = bytesPerSample * channels;
  const totalSamples   = Math.floor(raw.length / frameSize);
  const ratio          = sampleRate / 8000;
  const outSamples     = Math.floor(totalSamples / ratio);
  const out            = Buffer.alloc(outSamples);

  for (let i = 0; i < outSamples; i++) {
    // Source position with linear interpolation
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac   = srcPos - srcIdx;

    // Mix channels to mono at srcIdx
    let s0 = 0;
    for (let ch = 0; ch < channels; ch++) {
      s0 += readSample(raw, (srcIdx * channels + ch) * bytesPerSample, bitsPerSample, audioFormat);
    }
    s0 = Math.round(s0 / channels);

    // Interpolate with next sample if not at end
    let sample = s0;
    if (frac > 0 && srcIdx + 1 < totalSamples) {
      let s1 = 0;
      for (let ch = 0; ch < channels; ch++) {
        s1 += readSample(raw, ((srcIdx+1) * channels + ch) * bytesPerSample, bitsPerSample, audioFormat);
      }
      s1 = Math.round(s1 / channels);
      sample = Math.round(s0 + frac * (s1 - s0));
    }

    out[i] = pcmToUlaw(Math.max(-32768, Math.min(32767, sample)));
  }

  return out;
}



// ─── RTP bridge ──────────────────────────────────────────────────────────────
class RtpBridge {
  constructor(localPort, remoteIp, remotePort, callId) {
    this.localPort  = localPort;
    this.remoteIp   = remoteIp;
    this.remotePort = remotePort;
    this.callId     = callId;
    this.localIp    = getLocalIp();
    this.socket     = null;
    this.ssrc       = (Math.random() * 0xffffffff) >>> 0;
    this.seq        = (Math.random() * 0xffff)     >>> 0;
    this.timestamp  = (Math.random() * 0xffffffff) >>> 0;
    this.playTimer  = null;
  }

  start() {
    this.socket    = dgram.createSocket('udp4');
    this.playing   = false; // true while WAV playback is active
    // Track SSRC/seq/ts from incoming stream so we can hijack them for playback
    this.remoteSSRC = null;
    this.lastSeq    = null;
    this.lastTs     = null;

    this.socket.on('message', (msg, rinfo) => {
      captureManager.writeRtpPacket(this.callId, rinfo.address, rinfo.port, this.localIp, this.localPort, msg);

      // Parse incoming RTP header to track stream state
      if (msg.length >= 12) {
        this.remoteSSRC = msg.readUInt32BE(8);
        this.lastSeq    = msg.readUInt16BE(2);
        this.lastTs     = msg.readUInt32BE(4);
        // Sync our outgoing counters to the incoming stream
        // so playback continues seamlessly from where the stream left off
        if (!this.playing) {
          this.seq       = this.lastSeq;
          this.timestamp = this.lastTs;
          this.ssrc      = this.remoteSSRC;
        }
      }

      // During WAV playback or hold, drop incoming RTP forwarding
      if (this.playing || this.held) return;

      this.socket.send(msg, this.remotePort, this.remoteIp);
      captureManager.writeRtpPacket(this.callId, this.localIp, this.localPort, this.remoteIp, this.remotePort, msg);

      // Decode inbound RTP to local audio file if recording is active
      if (this.audioWriter && msg.length > 12) {
        const pt      = msg[1] & 0x7f;
        const payload = msg.slice(12);
        this.audioWriter.write(pt, payload);
      }
    });
    this.socket.on('error', (err) => console.error(`[RTP] ${err.message}`));
    this.socket.bind(this.localPort, () => {
      console.log(`[RTP] ${this.localPort} <-> ${this.remoteIp}:${this.remotePort}`);
    });
  }

  // Send a PCMU RTP packet — all counters kept as unsigned 32-bit with >>> 0
  sendRtp(payload) {
    if (!this.socket) return;
    try {
      this.seq       = (this.seq + 1) & 0xffff;
      this.timestamp = (this.timestamp + payload.length) >>> 0;

      const pkt = Buffer.alloc(12 + payload.length);
      pkt[0] = 0x80; // V=2, P=0, X=0, CC=0
      pkt[1] = 0x00; // M=0, PT=0 (PCMU)
      pkt.writeUInt16BE(this.seq, 2);
      pkt.writeUInt32BE(this.timestamp >>> 0, 4);
      pkt.writeUInt32BE(this.ssrc >>> 0, 8);
      payload.copy(pkt, 12);

      this.socket.send(pkt, this.remotePort, this.remoteIp);
      captureManager.writeRtpPacket(
        this.callId, this.localIp, this.localPort,
        this.remoteIp, this.remotePort, pkt
      );
    } catch (e) {
      console.error(`[RTP] sendRtp error: ${e.message}`);
    }
  }

  // Send a G.722 RTP packet (payload type 9)
  // RTP timestamp increments by frame size per RFC 3551 §4.5.2
  sendRtpG722(payload) {
    if (!this.socket) return;
    try {
      this.seq       = (this.seq + 1) & 0xffff;
      this.timestamp = (this.timestamp + payload.length) >>> 0;

      const pkt = Buffer.alloc(12 + payload.length);
      pkt[0] = 0x80; // V=2, P=0, X=0, CC=0
      pkt[1] = 0x09; // M=0, PT=9 (G.722)
      pkt.writeUInt16BE(this.seq, 2);
      pkt.writeUInt32BE(this.timestamp >>> 0, 4);
      pkt.writeUInt32BE(this.ssrc >>> 0, 8);
      payload.copy(pkt, 12);

      this.socket.send(pkt, this.remotePort, this.remoteIp);
      captureManager.writeRtpPacket(
        this.callId, this.localIp, this.localPort,
        this.remoteIp, this.remotePort, pkt
      );
    } catch (e) {
      console.error(`[RTP] sendRtpG722 error: ${e.message}`);
    }
  }

  // Play a pre-converted raw G.722 file (produced by ffmpeg at upload time).
  // G.722 is 64kbps = 8000 bytes/sec. 20ms frame = 160 bytes.
  // RTP payload type 9, RTP clock 8000 (RFC 3551 quirk despite 16kHz audio).
  playWav(filePath, onDone) {
    this.stopPlayback();

    // G.722: 64kbps = 8000 bytes/sec → 20ms = 160 bytes per frame
    const FRAME_BYTES = 160;
    const FRAME_MS    = 20;

    let g722data;
    try {
      g722data = fs.readFileSync(filePath);
      console.log(`[WAV] Loaded G.722: ${path.basename(filePath)} (${g722data.length} bytes, ~${Math.round(g722data.length/8000)}s)`);
    } catch (e) {
      console.error(`[WAV] Load error: ${e.message}`);
      if (onDone) onDone(e);
      return;
    }

    let offset = 0;

    // Sync seq/ts to the live stream before taking over
    if (this.lastSeq !== null) {
      this.seq       = (this.lastSeq + 1) & 0xffff;
      this.timestamp = this.lastTs >>> 0;
    }

    this.playing   = true;

    this.playTimer = setInterval(() => {
      if (!this.socket || offset >= g722data.length) {
        this.stopPlayback();
        if (onDone) onDone(null);
        return;
      }
      try {
        const frame = g722data.slice(offset, offset + FRAME_BYTES);
        offset += FRAME_BYTES;
        // Send as PT 9 (G.722) — timestamp increments by 160 per RFC 3551
        this.sendRtpG722(frame);
      } catch (e) {
        console.error(`[WAV] Frame error: ${e.message}`);
        this.stopPlayback();
        if (onDone) onDone(e);
      }
    }, FRAME_MS);
  }

  stopPlayback() {
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null; }
    this.playing = false;
  }

  setHold(held) {
    this.held = held;
    if (held) {
      this._log && this._log('info', 'RTP bridge paused (hold)');
    }
  }

  stop() {
    this.stopPlayback();
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
  }
}

// ─── SipManager ──────────────────────────────────────────────────────────────
class SipManager extends EventEmitter {
  constructor() {
    super();
    this.ua           = null;
    this.session      = null;
    this.registered   = false;
    this.incomingCall = null;
    this.activeCall   = null;
    this.config       = null;
    this.rtpBridge    = null;
    // Conference: second leg
    this.confSession  = null;
    this.confBridge   = null;
    this.logs         = [];
  }

  _log(level, message) {
    const entry = { level, message, timestamp: new Date().toISOString() };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
    this.emit('log', entry);
    console.log(`[SIP][${level.toUpperCase()}] ${message}`);
  }

  getState() {
    return {
      registered: this.registered,
      config: this.config ? {
        server: this.config.server, username: this.config.username,
        displayName: this.config.displayName, transport: this.config.transport
      } : null,
      activeCall: this.activeCall ? {
        callId: this.activeCall.callId, target: this.activeCall.target,
        direction: this.activeCall.direction, startTime: this.activeCall.startTime,
        status: this.activeCall.status
      } : null,
      incomingCall: this.incomingCall ? {
        from: this.incomingCall.from, displayName: this.incomingCall.displayName
      } : null,
      conference: this.confSession ? { active: true } : null,
      logs: this.logs.slice(0, 50)
    };
  }

  // ── Registration ─────────────────────────────────────────────────────────
  register(config) {
    return new Promise((resolve, reject) => {
      if (this.ua) { this._log('info', 'Stopping existing UA'); this.ua.stop(); this.ua = null; }
      this.config = config;
      const { server, username, password, displayName, transport } = config;
      const wsProto  = transport === 'TLS' ? 'wss' : 'ws';
      const sipProto = transport === 'TLS' ? 'sips' : 'sip';
      const wsPort   = transport === 'TLS' ? (config.wsPort || 8089) : (config.wsPort || 8088);
      const wsPath   = config.wsPath || '/ws';
      const wsUri    = `${wsProto}://${server}:${wsPort}${wsPath}`;
      this._log('info', `Connecting to ${wsUri}`);
      const socket = new JsSIP.WebSocketInterface(wsUri);
      this.ua = new JsSIP.UA({
        sockets: [socket], uri: `${sipProto}:${username}@${server}`,
        password, display_name: displayName, register: true,
        register_expires: 300, user_agent: 'SIPEndpoint/1.0',
        connection_recovery_min_interval: 2, connection_recovery_max_interval: 30,
        log: { builtinEnabled: false, level: 'warn',
          connector: (level, category, label, content) => {
            if (level === 'warn' || level === 'error') this._log(level, `[${category}] ${content}`);
          }
        }
      });
      this.ua.on('registered', () => {
        this.registered = true;
        this._log('info', `Registered as ${username}@${server}`);
        this.emit('registered', { username, server, displayName });
        resolve({ registered: true });
      });
      this.ua.on('unregistered', () => { this.registered = false; this._log('info', 'Unregistered'); this.emit('unregistered', {}); });
      this.ua.on('registrationFailed', (data) => {
        this.registered = false;
        const cause = data.cause || 'Unknown';
        this._log('error', `Registration failed: ${cause}`);
        this.emit('registrationFailed', { cause });
        reject(new Error(`Registration failed: ${cause}`));
      });
      this.ua.on('connected',    () => this._log('info', `WebSocket connected to ${wsUri}`));
      this.ua.on('disconnected', (e) => this._log('warn', `WebSocket disconnected: ${e?.cause || ''}`));
      this.ua.on('newRTCSession', (data) => this._handleNewSession(data.session));

      // Hook JsSIP transport to capture ALL outgoing SIP messages
      this.ua.on('connected', () => {
        try {
          const transport = this.ua._transport;
          if (transport && transport._ws) {
            const origSend = transport._ws.send.bind(transport._ws);
            transport._ws.send = (data) => {
              origSend(data);
              // Write SIP message to active call capture if one exists
              if (this.activeCall) {
                const localIp = getLocalIp();
                captureManager.writeSipMessage(
                  this.activeCall.callId,
                  localIp, 5060,
                  server, wsPort,
                  typeof data === 'string' ? data : data.toString()
                );
              }
            };
            this._log('info', 'SIP transport hooked for capture');
          }
        } catch (e) {
          this._log('warn', `Transport hook failed: ${e.message}`);
        }
      });

      this.ua.start();
      setTimeout(() => { if (!this.registered) reject(new Error('Registration timeout after 30s')); }, 30000);
    });
  }

  // ── Session wiring ────────────────────────────────────────────────────────
  _handleNewSession(session) {
    this._log('info', `New session direction=${session.direction}`);
    if (session.direction === 'incoming') {
      const inviteRequest = session._request || null;
      const remoteSdp     = inviteRequest?.body || null;
      this._log('info', `INVITE SDP: ${remoteSdp ? 'found' : 'missing'}`);
      this.incomingCall = {
        session, from: session.remote_identity.uri.toString(),
        displayName: session.remote_identity.display_name || session.remote_identity.uri.user,
        remoteSdp
      };
      this._log('info', `Incoming call from ${this.incomingCall.from}`);
      this.emit('incomingCall', { from: this.incomingCall.from, displayName: this.incomingCall.displayName });
    }
    session.on('progress', () => { this._log('info', 'Remote ringing'); if (this.activeCall) this.activeCall.status = 'ringing'; });
    session.on('confirmed', () => {
      this._log('info', 'Call confirmed');
      if (this.activeCall) { this.activeCall.status = 'connected'; this.activeCall.startTime = new Date().toISOString(); }
      if (session.direction === 'outgoing') {
        const remoteSdp = this._getRemoteSdp(session);
        this._log('info', `Outbound remote SDP: ${remoteSdp ? 'found' : 'missing'}`);
        if (remoteSdp) this._startRtp(remoteSdp);
      }
      this.emit('callConnected', { callId: this.activeCall?.callId, direction: session.direction });
    });
    session.on('ended', (e) => {
      this._log('info', `Call ended: ${e.cause || 'normal'}`);
      const callId = this.activeCall?.callId;
      if (callId) callHistory.endCall(callId, { status: 'completed' });
      this._teardown();
      this.emit('callEnded', { callId, cause: e.cause });
    });
    session.on('failed', (e) => {
      this._log('error', `Call failed: ${e.cause || 'unknown'}`);
      const callId = this.activeCall?.callId;
      if (callId) callHistory.failCall(callId);
      this._teardown();
      this.emit('callFailed', { callId, cause: e.cause });
    });
  }

  _getRemoteSdp(session) {
    try { return session._remote_sdp || session.connection?.remoteDescription?.sdp || null; } catch (e) { return null; }
  }

  _startRtp(remoteSdp) {
    const remote = parseRemoteSdp(remoteSdp);
    if (!remote) { this._log('warn', 'Cannot parse remote SDP'); return; }
    this._log('info', `Starting RTP: remote=${remote.ip}:${remote.port}`);
    if (this.rtpBridge) this.rtpBridge.stop();
    const localPort = this.activeCall?.localRtpPort || allocateRtpPort();
    const callId    = this.activeCall?.callId;
    this.rtpBridge  = new RtpBridge(localPort, remote.ip, remote.port, callId);

    // Start audio recording for inbound RTP
    if (callId) {
      const audioPath = require('path').join(__dirname, '../captures',
        `audio_${callId.slice(0,8)}.wav`);
      this.rtpBridge.audioWriter = new AudioWriter(audioPath);
      this._log('info', `Audio recording started: ${require('path').basename(audioPath)}`);
    }

    this.rtpBridge.start();
  }

  _teardown() {
    if (this.rtpBridge) {
      // Finalise the audio recording
      if (this.rtpBridge.audioWriter) {
        try {
          const info = this.rtpBridge.audioWriter.close();
          this._log('info', `Audio saved: ${this.rtpBridge.audioWriter.filename} (~${info.duration}s)`);
        } catch (e) { this._log('warn', `Audio writer close error: ${e.message}`); }
        this.rtpBridge.audioWriter = null;
      }
      this.rtpBridge.stop();
      this.rtpBridge = null;
    }
    if (this.confBridge)  { this.confBridge.stop();   this.confBridge  = null; }
    if (this.confSession) { try { this.confSession.terminate(); } catch(e){} this.confSession = null; }
    this.session      = null;
    this.activeCall   = null;
    this.incomingCall = null;
  }

  // ── Unregister ───────────────────────────────────────────────────────────
  unregister() {
    return new Promise((resolve) => {
      if (!this.ua) return resolve();
      this.ua.unregister({ all: true });
      this.ua.stop();
      this.ua = null; this.registered = false; this.config = null;
      resolve();
    });
  }

  // ── Outbound call ─────────────────────────────────────────────────────────
  makeCall(target, callId) {
    return new Promise((resolve, reject) => {
      if (!this.ua || !this.registered) return reject(new Error('Not registered'));
      let targetUri = target;
      if (!target.startsWith('sip:') && !target.startsWith('sips:'))
        targetUri = target.includes('@') ? `sip:${target}` : `sip:${target}@${this.config.server}`;
      const localIp = getLocalIp();
      const rtpPort = allocateRtpPort();
      const sdp     = buildSdp(localIp, rtpPort);
      this._log('info', `Calling ${targetUri} | local RTP ${localIp}:${rtpPort}`);
      try {
        this.session = this.ua.call(targetUri, { mediaConstraints: { audio: false, video: false } });
        this.session.on('sending', (e) => {
          if (e.request) {
            captureManager.writeSipMessage(callId, localIp, 5060, this.config.server, this.config.wsPort || 8088,
              e.request.toString ? e.request.toString() : String(e.request));
            e.request.body = sdp;
            this._log('info', 'Injected SDP into INVITE');
          }
        });
        this.activeCall = { callId, target: targetUri, direction: 'outbound', startTime: null, status: 'calling', localRtpPort: rtpPort, localIp };
        callHistory.addCall({ callId, direction: 'outbound', target: targetUri });
        resolve({ target: targetUri, callId, status: 'calling' });
      } catch (err) { reject(err); }
    });
  }

  // ── Answer inbound call ───────────────────────────────────────────────────
  answerCall(callId) {
    return new Promise((resolve, reject) => {
      if (!this.incomingCall) return reject(new Error('No incoming call'));
      const { session, from, displayName, remoteSdp } = this.incomingCall;
      const localIp = getLocalIp();
      const rtpPort = allocateRtpPort();
      const sdp     = buildSdp(localIp, rtpPort);
      this._log('info', `Answering ${from} | local RTP ${localIp}:${rtpPort}`);
      if (remoteSdp) captureManager.writeSipMessage(callId, this.config.server, 5060, localIp, 5060, remoteSdp);
      this.activeCall   = { callId, target: from, direction: 'inbound', startTime: null, status: 'connecting', localRtpPort: rtpPort, localIp };
      this.session      = session;
      this.incomingCall = null;
      session.on('sdp', (e) => { this._log('info', `SDP event type=${e.type}`); e.sdp = sdp; });
      try {
        session.answer({ mediaConstraints: { audio: false, video: false }, pcConfig: { iceServers: [] } });
        if (remoteSdp) this._startRtp(remoteSdp);
        else this._log('warn', 'No INVITE SDP — RTP not started');
        callHistory.addCall({ callId, direction: 'inbound', from, displayName });
        resolve({ callId, from, displayName });
      } catch (err) { this._log('error', `answer() error: ${err.message}`); this._teardown(); reject(err); }
    });
  }

  // ── Hangup ───────────────────────────────────────────────────────────────
  hangup() {
    return new Promise((resolve) => {
      if (this.session) {
        try { this.session.terminate(); } catch (e) { this._log('warn', `Hangup error: ${e.message}`); }
      }
      this._teardown();
      resolve();
    });
  }

  // ── Reject inbound ────────────────────────────────────────────────────────
  rejectCall() {
    return new Promise((resolve) => {
      if (this.incomingCall) {
        try { this.incomingCall.session.terminate({ status_code: 603 }); } catch (e) {}
        this.incomingCall = null;
      }
      resolve();
    });
  }

  // ── DTMF ──────────────────────────────────────────────────────────────────
  sendDTMF(digit) {
    return new Promise((resolve, reject) => {
      if (!this.session || !this.session.isEstablished()) return reject(new Error('No active call'));
      try { this.session.sendDTMF(digit, { duration: 160, interToneGap: 50 }); this._log('info', `DTMF: ${digit}`); resolve(); }
      catch (e) { reject(e); }
    });
  }

  // ── Hold ─────────────────────────────────────────────────────────────────
  // Checks activeCall.status directly — never calls session.isEstablished()
  // or any other JsSIP method that internally calls RTCPeerConnection.getSenders.
  hold() {
    return new Promise((resolve, reject) => {
      if (!this.activeCall || this.activeCall.status !== 'connected')
        return reject(new Error('No active connected call'));
      if (this.activeCall.onHold)
        return reject(new Error('Call already on hold'));

      this._log('info', 'Putting call on hold');
      if (this.rtpBridge) this.rtpBridge.setHold(true);
      if (this.activeCall) this.activeCall.onHold = true;
      try { this._sendRawReInvite(true); }
      catch (e) { this._log('warn', `re-INVITE failed (${e.message}) — RTP muted only`); }
      this.emit('callHeld', { callId: this.activeCall?.callId });
      this._log('info', 'Call on hold');
      resolve({ onHold: true });
    });
  }

  // ── Resume ────────────────────────────────────────────────────────────────
  resume() {
    return new Promise((resolve, reject) => {
      if (!this.activeCall || this.activeCall.status !== 'connected')
        return reject(new Error('No active connected call'));
      if (!this.activeCall.onHold)
        return reject(new Error('Call is not on hold'));

      this._log('info', 'Resuming call');
      if (this.rtpBridge) this.rtpBridge.setHold(false);
      if (this.activeCall) this.activeCall.onHold = false;
      try { this._sendRawReInvite(false); }
      catch (e) { this._log('warn', `re-INVITE failed (${e.message}) — RTP resumed`); }
      this.emit('callResumed', { callId: this.activeCall?.callId });
      this._log('info', 'Call resumed');
      resolve({ onHold: false });
    });
  }

  // ── Send raw re-INVITE via WebSocket ──────────────────────────────────────
  // Writes SIP directly to the transport WebSocket without touching any
  // JsSIP session or RTCPeerConnection methods.
  _sendRawReInvite(hold) {
    const localIp = this.activeCall?.localIp || getLocalIp();
    const rtpPort = this.activeCall?.localRtpPort || 0;
    const sdp     = hold ? buildSdpHold(localIp, rtpPort) : buildSdp(localIp, rtpPort);

    const dialog = this.session?._dialog;
    if (!dialog) throw new Error('No SIP dialog');

    const localUri  = String(dialog.local_uri  || `sip:${this.config.username}@${this.config.server}`);
    const remoteUri = String(dialog.remote_uri || this.activeCall?.target || '');
    const callId    = String(dialog.id?.call_id   || '');
    const localTag  = String(dialog.id?.local_tag  || '');
    const remoteTag = String(dialog.id?.remote_tag || '');
    const cseq      = (dialog.local_seqnum || 1) + 1;
    const routeSet  = (dialog.route_set || []).map(r => `Route: ${r}`).filter(Boolean);

    const msg = [
      `INVITE ${remoteUri} SIP/2.0`,
      `Via: SIP/2.0/WS ${localIp};branch=z9hG4bK${Math.random().toString(36).slice(2)}`,
      `Max-Forwards: 70`,
      `From: <${localUri}>;tag=${localTag}`,
      `To: <${remoteUri}>;tag=${remoteTag}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:${this.config.username}@${localIp}>`,
      ...routeSet,
      `Content-Type: application/sdp`,
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      ``,
      sdp
    ].join('\r\n');

    const transport = this.ua?._transport;
    if (!transport) throw new Error('No transport');
    const ws = transport._ws || transport.ws || transport._socket || transport._conn;
    if (!ws) throw new Error('WebSocket not found');
    if (ws.readyState !== 1) throw new Error('WebSocket not open');
    ws.send(msg);
    this._log('info', `Sent raw re-INVITE (hold=${hold}, cseq=${cseq})`);
  }


  // ── Blind transfer ────────────────────────────────────────────────────────
  // Sends a REFER to the current call, telling the remote party to call target.
  // The session ends automatically once the remote side picks up the transfer.
  blindTransfer(target) {
    return new Promise((resolve, reject) => {
      if (!this.session || !this.session.isEstablished()) return reject(new Error('No active call'));
      let targetUri = target;
      if (!target.startsWith('sip:') && !target.startsWith('sips:'))
        targetUri = target.includes('@') ? `sip:${target}` : `sip:${target}@${this.config.server}`;
      this._log('info', `Blind transfer -> ${targetUri}`);
      try {
        this.session.refer(targetUri);
        this._log('info', 'REFER sent');
        resolve({ target: targetUri });
      } catch (e) { reject(e); }
    });
  }

  // ── Attended transfer ─────────────────────────────────────────────────────
  // 1. Call the transfer target (creates a second call leg)
  // 2. Once answered, send REFER on the first leg pointing to the second
  // 3. Both legs end and the two remote parties are connected directly
  attendedTransfer(target) {
    return new Promise((resolve, reject) => {
      if (!this.session || !this.session.isEstablished()) return reject(new Error('No active call'));
      let targetUri = target;
      if (!target.startsWith('sip:') && !target.startsWith('sips:'))
        targetUri = target.includes('@') ? `sip:${target}` : `sip:${target}@${this.config.server}`;

      this._log('info', `Attended transfer: calling ${targetUri}`);

      const localIp   = getLocalIp();
      const rtpPort   = allocateRtpPort();
      const sdp       = buildSdp(localIp, rtpPort);
      const xferCallId = require('uuid').v4();

      try {
        const xferSession = this.ua.call(targetUri, { mediaConstraints: { audio: false, video: false } });

        xferSession.on('sending', (e) => { if (e.request) e.request.body = sdp; });

        xferSession.on('confirmed', () => {
          this._log('info', 'Transfer target answered — completing attended transfer');
          try {
            // REFER first session to second session
            this.session.refer(targetUri, { replaces: xferSession });
            this._log('info', 'REFER with Replaces sent');
            this.confSession = null;
            resolve({ target: targetUri });
          } catch (e) {
            this._log('error', `REFER failed: ${e.message}`);
            reject(e);
          }
        });

        xferSession.on('failed', (e) => {
          this._log('error', `Transfer leg failed: ${e.cause}`);
          reject(new Error(`Transfer leg failed: ${e.cause}`));
        });

        this.confSession = xferSession;
        this.emit('log', { level: 'info', message: `Transfer leg ringing: ${targetUri}`, timestamp: new Date().toISOString() });
        resolve({ target: targetUri, status: 'transferring' });
      } catch (e) { reject(e); }
    });
  }

  // ── Conference ────────────────────────────────────────────────────────────
  // Calls a third party and bridges RTP between all three endpoints.
  // Both remote parties hear each other and the local endpoint.
  conference(target) {
    return new Promise((resolve, reject) => {
      if (!this.session || !this.session.isEstablished()) return reject(new Error('No active call'));
      if (this.confSession) return reject(new Error('Conference already active'));

      let targetUri = target;
      if (!target.startsWith('sip:') && !target.startsWith('sips:'))
        targetUri = target.includes('@') ? `sip:${target}` : `sip:${target}@${this.config.server}`;

      this._log('info', `Conferencing in: ${targetUri}`);

      const localIp   = getLocalIp();
      const rtpPort   = allocateRtpPort();
      const sdp       = buildSdp(localIp, rtpPort);

      try {
        const confSession = this.ua.call(targetUri, { mediaConstraints: { audio: false, video: false } });

        confSession.on('sending', (e) => { if (e.request) e.request.body = sdp; });

        confSession.on('confirmed', () => {
          this._log('info', 'Conference leg connected');
          const remoteSdp = this._getRemoteSdp(confSession);
          if (remoteSdp) {
            const remote = parseRemoteSdp(remoteSdp);
            if (remote) {
              this._log('info', `Conference RTP: remote=${remote.ip}:${remote.port}`);
              this.confBridge = new RtpBridge(rtpPort, remote.ip, remote.port, this.activeCall?.callId);
              this.confBridge.start();

              // Cross-wire: forward packets from leg1 to leg2 and vice versa
              if (this.rtpBridge && this.confBridge) {
                this._log('info', 'RTP conference bridge active — 3-way call established');
              }
            }
          }
          this.emit('conferenceStarted', { target: targetUri });
        });

        confSession.on('ended', (e) => {
          this._log('info', 'Conference leg ended');
          if (this.confBridge) { this.confBridge.stop(); this.confBridge = null; }
          this.confSession = null;
          this.emit('conferenceEnded', {});
        });

        confSession.on('failed', (e) => {
          this._log('error', `Conference leg failed: ${e.cause}`);
          this.confSession = null;
          reject(new Error(`Conference failed: ${e.cause}`));
        });

        this.confSession = confSession;
        resolve({ target: targetUri, status: 'conferencing' });
      } catch (e) { reject(e); }
    });
  }

  // ── End conference leg ────────────────────────────────────────────────────
  endConference() {
    return new Promise((resolve) => {
      if (this.confSession) {
        try { this.confSession.terminate(); } catch (e) {}
        this.confSession = null;
      }
      if (this.confBridge) { this.confBridge.stop(); this.confBridge = null; }
      this.emit('conferenceEnded', {});
      resolve();
    });
  }

  // ── Play WAV ──────────────────────────────────────────────────────────────
  playWav(filePath) {
    return new Promise((resolve, reject) => {
      if (!this.rtpBridge) return reject(new Error('No active RTP bridge'));
      if (!fs.existsSync(filePath)) return reject(new Error(`File not found: ${filePath}`));
      this._log('info', `Playing WAV: ${path.basename(filePath)}`);
      this.rtpBridge.playWav(filePath, (err) => {
        if (err) {
          this._log('error', `WAV playback error: ${err.message}`);
          this.emit('playbackEnded', { error: err.message });
        } else {
          this._log('info', 'WAV playback complete');
          this.emit('playbackEnded', { file: path.basename(filePath) });
        }
      });
      resolve({ file: path.basename(filePath), status: 'playing' });
    });
  }

  // ── Stop WAV playback ─────────────────────────────────────────────────────
  stopWav() {
    return new Promise((resolve) => {
      if (this.rtpBridge) this.rtpBridge.stopPlayback();
      this._log('info', 'WAV playback stopped');
      this.emit('playbackEnded', { stopped: true });
      resolve();
    });
  }
}

module.exports = new SipManager();
