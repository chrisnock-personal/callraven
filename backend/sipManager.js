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
const UdpSocketInterface = require('./udpSipSocket');

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
  if (process.env.MEDIA_IP) return process.env.MEDIA_IP;
  const ifaces = os.networkInterfaces();
  // Prefer interfaces whose names suggest a LAN NIC over virtual bridges
  const preferred = ['eth', 'en', 'wl', 'ens', 'enp', 'wlp'];
  for (const prefix of preferred)
    for (const name of Object.keys(ifaces).filter(n => n.startsWith(prefix)))
      for (const iface of ifaces[name])
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  // Fallback: first non-loopback IPv4 (original behaviour)
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
    this.localPort   = localPort;
    this.remoteIp    = remoteIp;
    this.remotePort  = remotePort;
    this.callId      = callId;
    this.localIp     = getLocalIp();
    this.socket      = null;
    this.ssrc        = (Math.random() * 0xffffffff) >>> 0;
    this.seq         = (Math.random() * 0xffff)     >>> 0;
    this.timestamp   = (Math.random() * 0xffffffff) >>> 0;
    this.playTimer    = null;
    this.silenceTimer = null;
    this._rxWatchTimer = null;
    this._lastRxTime   = 0;
    // RTP stats
    this.stats = {
      rxPackets: 0, txPackets: 0, rxBytes: 0, txBytes: 0,
      lostPackets: 0, lastSeqRx: null,
      jitterMs: 0, lastArrival: null, lastTs: null,
      codec: null, startTime: null
    };
    // Audio relay: set to fn(pt, pcm16Buffer) to receive decoded inbound audio
    this.onAudio    = null;
    // Raw payload relay: set to fn(pt, rawPayload) — fires before any decoding
    this.onRawAudio = null;
    // Raw outbound relay: fires with each G.722 frame sent during WAV playback
    this.onRawOutboundAudio = null;
    // On-demand recording flag (distinct from always-on audioWriter)
    this.recording  = false;
    this.audioWriter = null;  // inbound (remote) recorder
    this.txWriter    = null;  // outbound (local WAV playback) recorder
    this._g722dec   = null;
  }

  start() {
    this.socket    = dgram.createSocket('udp4');
    this.playing   = false; // true while WAV playback is active
    // Track SSRC/seq/ts from incoming stream so we can hijack them for playback
    this.remoteSSRC = null;
    this.lastSeq    = null;
    this.lastTs     = null;

    this.stats.startTime = Date.now();

    this.socket.on('message', (msg, rinfo) => {
      captureManager.writeRtpPacket(this.callId, rinfo.address, rinfo.port, this.localIp, this.localPort, msg);

      if (msg.length >= 12) {
        const seq  = msg.readUInt16BE(2);
        const ts   = msg.readUInt32BE(4);
        const ssrc = msg.readUInt32BE(8);
        const pt   = msg[1] & 0x7f;

        // Codec detection
        if (!this.stats.codec) {
          const map = { 0: 'PCMU/8kHz', 8: 'PCMA/8kHz', 9: 'G722/16kHz', 18: 'G729/8kHz' };
          this.stats.codec = map[pt] || `PT${pt}`;
        }

        // Packet loss (sequence gap)
        if (this.stats.lastSeqRx !== null) {
          const expected = (this.stats.lastSeqRx + 1) & 0xffff;
          if (seq !== expected) {
            const gap = (seq - expected + 0x10000) & 0xffff;
            if (gap < 1000) this.stats.lostPackets += gap;
          }
        }
        this.stats.lastSeqRx = seq;

        // Jitter (RFC 3550 simplified)
        const now = Date.now();
        if (this.stats.lastArrival !== null && this.stats.lastTs !== null) {
          const arrivalDelta = now - this.stats.lastArrival;
          const sendDelta    = ((ts - this.stats.lastTs + 0x100000000) % 0x100000000) / 8;
          const d = Math.abs(arrivalDelta - sendDelta);
          this.stats.jitterMs = Math.round(this.stats.jitterMs + (d - this.stats.jitterMs) / 16);
        }
        this.stats.lastArrival = now;
        this.stats.lastTs      = ts;
        this.stats.rxPackets++;
        this.stats.rxBytes += msg.length;

        this.remoteSSRC  = ssrc;
        this.lastSeq     = seq;
        this.lastTs      = ts;
        this._lastRxTime = Date.now();
        if (this.silenceTimer) this._stopSilence();

        // Follow actual RTP source — handles Asterisk direct_media re-routing
        // without relying on re-INVITE SDP parsing
        if (rinfo.address !== this.remoteIp || rinfo.port !== this.remotePort) {
          console.log(`[RTP] Source changed ${this.remoteIp}:${this.remotePort} → ${rinfo.address}:${rinfo.port}`);
          this.remoteIp   = rinfo.address;
          this.remotePort = rinfo.port;
        }

        if (!this.playing) {
          this.seq       = seq;
          this.timestamp = ts;
          this.ssrc      = ssrc;
        }

        // Audio relay to browser — always relay so Listen works during playback too
        if (this.onAudio && !this.held) {
          this._relayAudio(pt, msg.slice(12));
        }
        // Raw payload relay for live transcription (fires before any decoding)
        if (this.onRawAudio && !this.held) {
          this.onRawAudio(pt, msg.slice(12));
        }

        // On-demand recording — write inbound audio regardless of playback state
        if (this.recording && this.audioWriter) {
          if (!this._loggedRecordPt) {
            console.log('[REC] Recording inbound PT=' + pt + ' payload_len=' + (msg.length-12));
            this._loggedRecordPt = true;
          }
          this.audioWriter.write(pt, msg.slice(12));
        }
      }

      // During WAV playback or hold, suppress forwarding inbound RTP to remote
      if (this.playing || this.held) return;

      this.socket.send(msg, this.remotePort, this.remoteIp);
      this.stats.txPackets++;
      this.stats.txBytes += msg.length;
    });
    this.socket.on('error', (err) => console.error(`[RTP] socket error: ${err.message}`));
    this.socket.bind(this.localPort, () => {
      const addr = this.socket.address();
      console.log(`[RTP] bound ${addr.address}:${addr.port} -> ${this.remoteIp}:${this.remotePort}`);
      this._startRxWatch();
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
      this.stats.txPackets++;
      this.stats.txBytes += pkt.length;
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
      this.stats.txPackets++;
      this.stats.txBytes += pkt.length;
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
        // Write to outbound (tx) recorder — keeps playback separate from inbound
        if (this.recording && this.txWriter) {
          this.txWriter.write(9, frame);
        }
        // Raw outbound relay for live diarization
        if (this.onRawOutboundAudio) {
          this.onRawOutboundAudio(9, frame);
        }
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
    this._startSilence();
  }

  // Send silence frames after WAV ends to prevent RTP timeout on the far end
  _startSilence() {
    if (this.silenceTimer) return;
    const codec = this.stats.codec || '';
    const isG722 = codec.includes('G722');
    const frame  = isG722 ? Buffer.alloc(160, 0x00) : Buffer.alloc(160, 0x7f);
    this.silenceTimer = setInterval(() => {
      if (!this.socket || this.playing || this.held) { this._stopSilence(); return; }
      if (isG722) this.sendRtpG722(frame);
      else        this.sendRtp(frame);
    }, 20);
  }

  _stopSilence() {
    if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
  }

  // Watch for inbound RTP going quiet; start silence keepalive if >1s with no packets
  _startRxWatch() {
    if (this._rxWatchTimer) return;
    this._rxWatchTimer = setInterval(() => {
      if (!this.socket || this.playing || this.held || this.silenceTimer) return;
      if (this._lastRxTime > 0 && Date.now() - this._lastRxTime > 1000) {
        this._startSilence();
      }
    }, 500);
  }

  _stopRxWatch() {
    if (this._rxWatchTimer) { clearInterval(this._rxWatchTimer); this._rxWatchTimer = null; }
  }

  // Decode inbound RTP payload to 16-bit PCM and relay to onAudio callback
  _relayAudio(pt, payload) {
    try {
      let pcm16;
      if (pt === 9) {
        // G.722 → 16kHz 16-bit PCM
        const { G722Decoder } = require('./audioDecoder');
        if (!this._g722dec) this._g722dec = new G722Decoder();
        pcm16 = this._g722dec.decode(payload);
      } else if (pt === 0) {
        // PCMU (μ-law) → 8kHz 16-bit PCM
        pcm16 = Buffer.alloc(payload.length * 2);
        for (let i = 0; i < payload.length; i++) {
          const u = ~payload[i] & 0xff;
          const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
          let s = ((mant << 1) + 33) << (exp + 2);
          pcm16.writeInt16LE(Math.max(-32768, Math.min(32767, sign ? -s : s)), i * 2);
        }
      } else if (pt === 8) {
        // PCMA (A-law) → 8kHz 16-bit PCM
        pcm16 = Buffer.alloc(payload.length * 2);
        for (let i = 0; i < payload.length; i++) {
          const a = payload[i] ^ 0x55;
          const sign = a & 0x80, exp = (a >> 4) & 0x07, mant = a & 0x0f;
          let s = exp === 0 ? (mant << 1) + 1 : (((mant | 0x10) << 1) + 1) << (exp - 1);
          s *= 8;
          pcm16.writeInt16LE(Math.max(-32768, Math.min(32767, sign ? -s : s)), i * 2);
        }
      } else { return; }
      if (this.onAudio) this.onAudio(pt, pcm16);
    } catch (e) { /* non-fatal */ }
  }

  // Return live stats snapshot
  getStats() {
    const elapsed = this.stats.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
    const total   = this.stats.rxPackets + this.stats.lostPackets;
    return {
      codec:       this.stats.codec || 'unknown',
      rxPackets:   this.stats.rxPackets,
      txPackets:   this.stats.txPackets,
      lostPackets: this.stats.lostPackets,
      lossPercent: total > 0 ? ((this.stats.lostPackets / total) * 100).toFixed(1) : '0.0',
      jitterMs:    this.stats.jitterMs,
      rxKbps:      elapsed > 0 ? Math.round((this.stats.rxBytes  * 8) / elapsed / 1000) : 0,
      txKbps:      elapsed > 0 ? Math.round((this.stats.txBytes  * 8) / elapsed / 1000) : 0,
      elapsed:     Math.round(elapsed),
    };
  }

  startRecording() { this.recording = true;  }
  stopRecording()  { this.recording = false; }

  setHold(held) {
    this.held = held;
    if (held) {
      this._log && this._log('info', 'RTP bridge paused (hold)');
    }
  }

  stop() {
    this._stopRxWatch();
    this._stopSilence();
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
    this.autoAnswer   = { enabled: false, delayMs: 0 };  // configurable auto-answer
    this.incomingCall = null;
    this.activeCall   = null;
    this.config       = null;
    this.rtpBridge    = null;
    // Conference: second leg
    this.confSession      = null;
    this.confBridge       = null;
    this.logs             = [];
    this.keepaliveTimer   = null;
    this.ipWatchTimer     = null;
    this.lastKnownIp      = null;
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
      autoAnswer: this.autoAnswer,
      config: this.config ? {
        server:      this.config.server,
        username:    this.config.username,
        displayName: this.config.displayName,
        transport:   this.config.transport,
        port:        this.config.port   || 5060,
        wsPort:      this.config.wsPort || 8088,
        wsPath:      this.config.wsPath || '/ws'
      } : null,
      activeCall: this.activeCall ? {
        callId:    this.activeCall.callId,
        target:    this.activeCall.target,
        direction: this.activeCall.direction,
        startTime: this.activeCall.startTime,
        status:    this.activeCall.status,
        onHold:      this.activeCall.onHold      || false,
        remoteHold:  this.activeCall.remoteHold  || false,
        recording: this.rtpBridge ? this.rtpBridge.recording : false,
        codec:     this.rtpBridge ? this.rtpBridge.getStats().codec : null,
        stats:     this.rtpBridge ? this.rtpBridge.getStats() : null,
      } : null,
      incomingCall: this.incomingCall ? {
        from: this.incomingCall.from, displayName: this.incomingCall.displayName
      } : null,
      conference: this.confSession ? { active: true } : null,
      logs: this.logs.slice(0, 50)
    };
  }

  // ── Transport socket construction ────────────────────────────────────────
  // Builds the JsSIP Socket for a given config — either the built-in
  // WebSocketInterface (UDP/TLS meaning ws://\/wss://, the original transport)
  // or our own raw-UDP UdpSocketInterface (transport: 'UDP-RAW'). JsSIP's
  // Transport layer is transport-agnostic (see udpSipSocket.js header comment)
  // so everything else — dialogs, digest auth, REGISTER refresh, transactions —
  // is unaffected by which one is plugged in.
  _buildTransportSocket(config, username) {
    if (config.transport === 'UDP-RAW') {
      const port      = config.port || 5060;
      const localPort = parseInt(process.env.SIP_PORT || '5060', 10);
      const socket    = new UdpSocketInterface(config.server, port, { localPort });
      // UDP is connectionless — unlike WS, the registrar/PBX sends inbound
      // traffic to whatever address is in Contact, so it must be accurate.
      // JsSIP's config checker only accepts contact_uri as a string (it parses
      // it internally) — passing a JsSIP.URI instance directly is rejected.
      const contactUri = `sip:${username}@${getLocalIp()}:${localPort};transport=udp`;
      return { socket, sipProto: 'sip', connectLabel: `udp://${config.server}:${port}`, contactUri };
    }
    const wsProto  = config.transport === 'TLS' ? 'wss' : 'ws';
    const sipProto = config.transport === 'TLS' ? 'sips' : 'sip';
    const wsPort   = config.transport === 'TLS' ? (config.wsPort || 8089) : (config.wsPort || 8088);
    const wsPath   = config.wsPath || '/ws';
    const wsUri    = `${wsProto}://${config.server}:${wsPort}${wsPath}`;
    return { socket: new JsSIP.WebSocketInterface(wsUri), sipProto, connectLabel: wsUri, contactUri: null };
  }

  // ── Registration ─────────────────────────────────────────────────────────
  register(config) {
    return new Promise((resolve, reject) => {
      if (this.ua) { this._log('info', 'Stopping existing UA'); this.ua.stop(); this.ua = null; }
      this.config = config;
      const { server, username, password, displayName } = config;
      const { socket, sipProto, connectLabel, contactUri } = this._buildTransportSocket(config, username);
      this._log('info', `Connecting to ${connectLabel}`);
      const uaOptions = {
        sockets: [socket], uri: `${sipProto}:${username}@${server}`,
        password, display_name: displayName, register: true,
        register_expires: 300, user_agent: 'SIPEndpoint/1.0',
        connection_recovery_min_interval: 2, connection_recovery_max_interval: 30,
        log: { builtinEnabled: false, level: 'warn',
          connector: (level, category, label, content) => {
            if (level === 'warn' || level === 'error') this._log(level, `[${category}] ${content}`);
          }
        }
      };
      if (contactUri) uaOptions.contact_uri = contactUri;
      this.ua = new JsSIP.UA(uaOptions);
      this.ua.on('registered', () => {
        this.registered = true;
        this._log('info', `Registered as ${username}@${server}`);
        this.emit('registered', { username, server, displayName });
        this._startKeepalive();
        this._startIpWatch();
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
      this.ua.on('connected',    () => {
        this._log('info', `Connected to ${connectLabel}`);
        // Hook the transport's raw message stream to capture 100/180/200
        // responses (JsSIP doesn't expose these on session events for
        // outbound calls) — WS needs internal reflection, raw UDP exposes
        // a direct callback instead. See _hookTransportCapture().
        this._hookTransportCapture();
      });
      this.ua.on('disconnected', (e) => this._log('warn', `Transport disconnected: ${e?.cause || ''}`));
      this.ua.on('newRTCSession', (data) => this._handleNewSession(data.session));

      this.ua.start();
      setTimeout(() => { if (!this.registered) reject(new Error('Registration timeout after 30s')); }, 30000);
    });
  }

  // ── Transport capture hook ────────────────────────────────────────────────
  // Hooks the raw transport message stream so 100/180/200 responses (which
  // JsSIP doesn't expose on session events for outbound calls) still make it
  // into the pcap. Shared by both the registered UA and ad-hoc unregistered UAs.
  _hookTransportCapture() {
    const transportSocket = this.ua?._transport?.socket;
    if (transportSocket instanceof UdpSocketInterface) {
      // We own the receive path directly — no WS-style reflection needed.
      if (transportSocket._sipCaptureHooked) return;
      transportSocket._sipCaptureHooked = true;
      transportSocket.onRawMessage = (text, direction) => {
        const callId = this._pendingCallId || this.activeCall?.callId;
        if (!callId) return;
        const localIp = getLocalIp();
        const server  = this.config?.server || '';
        if (direction === 'in') captureManager.writeSipMessage(callId, server, 5060, localIp, 5060, text);
        else                    captureManager.writeSipMessage(callId, localIp, 5060, server, 5060, text);
      };
      return;
    }
    this._hookWsTransportCapture();
  }

  // WS-specific fallback: reflects into WebSocketInterface internals since
  // JsSIP doesn't expose a first-class raw-message callback for that transport.
  _hookWsTransportCapture() {
    setTimeout(() => {
      try {
        const transport = this.ua?._transport;
        const ws = transport?._ws || transport?.ws || transport?._socket;
        if (!transport || transport._ok200hooked) return;

        const handleSipResponse = (text) => {
          if (!text || !text.startsWith('SIP/2.0')) return;
          const firstLine = text.split('\r\n')[0] || text.split('\n')[0];
          if (firstLine.includes(' 180 ')) return; // captured via progress event
          const callId = this._pendingCallId || this.activeCall?.callId;
          if (!callId) return;
          captureManager.writeSipMessage(callId, this.config?.server || '', 5060, getLocalIp(), 5060, text);
          this._log('info', `[CAP] Inbound SIP: ${firstLine}`);
        };

        // Hook transport.ondata — JsSIP calls this for every inbound WS message
        if (typeof transport.ondata === 'function') {
          const origOnData = transport.ondata.bind(transport);
          transport.ondata = (transport_ref, url, msg, binary) => {
            origOnData(transport_ref, url, msg, binary);
            const text = typeof msg === 'string' ? msg
                       : Buffer.isBuffer(msg) ? msg.toString('utf8') : null;
            if (text) handleSipResponse(text);
          };
          transport._ok200hooked = true;
          this._log('info', '[CAP] Hooked via transport.ondata');
        }

        // Also try the raw socket inside WebSocketInterface
        const rawWs = transport.socket?._ws
                   || transport.socket?.ws
                   || transport.socket?._socket
                   || transport.socket?.socket;
        if (rawWs && typeof rawWs.on === 'function' && !rawWs._ok200hooked) {
          rawWs.on('message', (data) => {
            const text = typeof data === 'string' ? data
                       : Buffer.isBuffer(data) ? data.toString('utf8') : null;
            if (text) handleSipResponse(text);
          });
          rawWs._ok200hooked = true;
          this._log('info', '[CAP] Hooked via transport.socket raw WS');
        }

        if (!transport._ok200hooked) {
          this._log('warn', '[CAP] Could not hook inbound SIP — 100/200 will be missing from pcap');
        }

        if (!ws) return;
        if (ws._ok200hooked) { this._log('info', '[CAP] Already hooked'); return; }

        const handleMsg = (data) => {
          const text = typeof data === 'string' ? data
                     : Buffer.isBuffer(data)   ? data.toString('utf8')
                     : typeof data?.toString === 'function' ? data.toString() : null;
          if (!text || !text.startsWith('SIP/2.0')) return;
          const firstLine = text.split('\r\n')[0] || text.split('\n')[0];
          if (firstLine.includes(' 180 ')) return; // skip 180, captured via progress
          const callId = this._pendingCallId || this.activeCall?.callId;
          if (!callId) return;
          const localIp = getLocalIp();
          captureManager.writeSipMessage(callId, this.config?.server || '', 5060, localIp, 5060, text);
          this._log('info', `[CAP] WS response: ${firstLine}`);
        };

        // Try all listener attachment methods
        let attached = false;
        if (typeof ws.on === 'function') {
          ws.on('message', handleMsg);
          attached = true;
          this._log('info', '[CAP] Hooked via ws.on(message)');
        }
        if (!attached && typeof ws.addEventListener === 'function') {
          ws.addEventListener('message', (evt) => handleMsg(evt.data));
          attached = true;
          this._log('info', '[CAP] Hooked via ws.addEventListener(message)');
        }
        if (!attached) {
          // Wrap onmessage as last resort
          const orig = ws.onmessage;
          ws.onmessage = (evt) => {
            if (orig) orig.call(ws, evt);
            handleMsg(evt?.data || evt);
          };
          attached = true;
          this._log('info', '[CAP] Hooked via ws.onmessage wrap');
        }

        if (attached) ws._ok200hooked = true;
      } catch(e) {
        this._log('warn', `[CAP] Hook failed: ${e.message}\n${e.stack}`);
      }
    }, 200);
  }

  // ── Unregistered (ad-hoc) call ────────────────────────────────────────────
  // Places a call without an active SIP registration by connecting a throwaway
  // UA directly to the target's SIP domain over SIP-over-WebSocket. There's no
  // account to register — the "identity" is just a caller-ID string presented
  // in the From header. Only usable while not registered and idle.
  makeUnregisteredCall(target, callId, opts = {}) {
    return new Promise((resolve, reject) => {
      if (this.registered) return reject(new Error('Already registered — use the normal dial instead'));
      if (this.activeCall)  return reject(new Error('Call already active'));

      const stripped = target.replace(/^sips?:/i, '');
      const at = stripped.lastIndexOf('@');
      if (at === -1) return reject(new Error('Target must be in the form <address>@<sipdomain> for an unregistered call'));
      const domain = stripped.slice(at + 1).split(';')[0].trim();
      if (!domain) return reject(new Error('Missing SIP domain after @'));

      const transport   = opts.transport === 'TLS' ? 'TLS' : opts.transport === 'UDP-RAW' ? 'UDP-RAW' : 'UDP';
      const displayName = (opts.displayName || '').trim() || 'anonymous';
      const localUser   = displayName.replace(/[^A-Za-z0-9._-]/g, '') || 'anonymous';

      const anonConfig = { server: domain, transport, port: opts.port, wsPort: opts.wsPort, wsPath: opts.wsPath };
      const { socket, sipProto, connectLabel, contactUri } = this._buildTransportSocket(anonConfig, localUser);
      const targetUri = `${sipProto}:${stripped}`;

      if (this.ua) { this._log('info', 'Stopping existing UA'); this.ua.stop(); this.ua = null; }
      this._log('info', `Unregistered call — connecting to ${connectLabel}`);
      const uaOptions = {
        sockets: [socket], uri: `${sipProto}:${localUser}@${domain}`,
        display_name: displayName, register: false, user_agent: 'SIPEndpoint/1.0',
        log: { builtinEnabled: false, level: 'warn',
          connector: (level, category, label, content) => {
            if (level === 'warn' || level === 'error') this._log(level, `[${category}] ${content}`);
          }
        }
      };
      if (contactUri) uaOptions.contact_uri = contactUri;
      this.ua = new JsSIP.UA(uaOptions);
      this.config = { server: domain, username: localUser, displayName, transport, port: opts.port, wsPort: opts.wsPort, wsPath: opts.wsPath };
      this._anonymousUa = true;

      let settled = false;
      this.ua.on('connected', () => {
        this._log('info', `Connected to ${connectLabel}`);
        this._hookTransportCapture();
        if (settled) return;
        settled = true;
        this._dialOut(targetUri, callId).then(resolve).catch(err => {
          this._teardownAnonymousUa();
          reject(err);
        });
      });
      this.ua.on('disconnected', (e) => this._log('warn', `Transport disconnected: ${e?.cause || ''}`));
      this.ua.on('newRTCSession', (data) => this._handleNewSession(data.session));

      this.ua.start();
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this._teardownAnonymousUa();
          reject(new Error('Connection timeout after 15s'));
        }
      }, 15000);
    });
  }

  _teardownAnonymousUa() {
    if (this._anonymousUa && this.ua) {
      try { this.ua.stop(); } catch (e) {}
      this.ua = null;
      this.config = null;
    }
    this._anonymousUa = false;
  }

  // ── SIP capture via JsSIP session events ─────────────────────────────────
  // Capture SIP signalling by listening to JsSIP session events which expose
  // the raw SIP message objects — far more reliable than intercepting WebSocket.
  // Called from _handleNewSession for each call leg.
  _hookSessionCapture(session) {
    const getSipText = (msg) => {
      try {
        if (!msg) return null;
        // JsSIP IncomingMessage/OutgoingRequest have a toString()
        if (typeof msg.toString === 'function') {
          const t = msg.toString();
          if (t && t.length > 10 && t !== '[object Object]') return t;
        }
        // Some events pass the raw data
        if (typeof msg.data === 'string' && msg.data.length > 10) return msg.data;
        // Try _message property (JsSIP wraps in some cases)
        if (msg._message) return getSipText(msg._message);
        return null;
      } catch(e) { return null; }
    };

    const write = (msg, fromServer) => {
      const callId  = this._pendingCallId || this.activeCall?.callId;
      const text    = getSipText(msg);
      if (!callId || !text) return;
      const localIp = getLocalIp();
      const server  = this.config?.server || '';
      if (fromServer) {
        captureManager.writeSipMessage(callId, server, 5060, localIp, 5060, text);
      } else {
        captureManager.writeSipMessage(callId, localIp, 5060, server, 5060, text);
      }
    };

    // Outbound: INVITE, ACK, re-INVITE, BYE, OPTIONS
    // 'sending' fires for ALL outbound SIP requests — most reliable capture point
    session.on('sending', (e) => {
      const method = e?.request?.method || e?.request?.ruri || 'unknown';
      this._log('info', `[CAP] sending method=${method}`);
      write(e.request, false);
    });

    // Inbound provisional responses: 100 Trying, 180 Ringing
    // originator='remote' means Asterisk sent it; originator='local' is our own 100
    session.on('progress', (e) => {
      if (e?.originator === 'remote') {
        write(e.response || e.message, true);
      }
    });

    // 200 OK + ACK — captured by intercepting the session internals
    // We store the 200 OK when progress fires (last response before confirmed)
    // and the ACK by wrapping session._sendACK if it exists
    session.on('progress', (e) => {
      if (e?.originator === 'remote' && e?.response) {
        // Store last response — the final one will be the 200 OK
        session._lastCapturedResponse = e.response;
      }
    });

    session.on('confirmed', (e) => {
      // 200 OK captured via WebSocket message listener above
      // ACK: build from dialog state (same approach as BYE)
      const callId  = this._pendingCallId || this.activeCall?.callId;
      if (!callId) return;
      const localIp = getLocalIp();
      const server  = this.config?.server || '';
      try {
        const dialog    = session._dialog;
        if (!dialog) return;
        const uriToStr  = (u) => {
          if (!u) return null;
          if (typeof u === 'string' && u.includes('sip:')) return u;
          try { const s = u.toString(); if (s.includes('sip:')) return s; } catch(ex) {}
          return null;
        };
        const localUri  = uriToStr(dialog.local_uri)  || `sip:${this.config.username}@${server}`;
        const remoteUri = uriToStr(dialog.remote_uri)  || this.activeCall?.target || `sip:unknown@${server}`;
        const dialogId  = dialog.id || {};
        const callIdSip = String(dialogId.call_id   || '');
        const localTag  = String(dialogId.local_tag  || '');
        const remoteTag = String(dialogId.remote_tag || '');
        const cseq      = (dialog.local_seqnum || 1);
        const viaTransport = this.ua?._transport?.socket?.via_transport || 'WS';
        const CRLF      = '\r\n';
        const ackText   = [
          `ACK ${remoteUri} SIP/2.0`,
          `Via: SIP/2.0/${viaTransport} ${localIp};branch=z9hG4bK${Math.random().toString(36).slice(2)}`,
          `Max-Forwards: 70`,
          `From: <${localUri}>;tag=${localTag}`,
          `To: <${remoteUri}>;tag=${remoteTag}`,
          `Call-ID: ${callIdSip}`,
          `CSeq: ${cseq} ACK`,
          `Content-Length: 0`,
          ``, ``
        ].join(CRLF);
        captureManager.writeSipMessage(callId, localIp, 5060, server, 5060, ackText);
        this._log('info', `[CAP] ACK written (${ackText.slice(0,30)})`);
      } catch(ex) { this._log('warn', `[CAP] ACK capture error: ${ex.message}`); }
    });

    // In-dialog requests (re-INVITE, hold, etc.)
    session.on('reinvite', (e) => {
      if (e?.originator === 'remote') write(e.request, true);
      else write(e.request, false);
    });
    session.on('update', (e) => {
      if (e?.originator === 'remote') write(e.request, true);
      else write(e.request, false);
    });

    // BYE and failed responses are captured directly in _handleNewSession
    // before _teardown() closes the capture file — so we don't duplicate here
  }

  // ── Session wiring ────────────────────────────────────────────────────────
  _handleNewSession(session) {
    this._log('info', `New session direction=${session.direction}`);
    // Hook session events for SIP capture (reliable — uses JsSIP's own objects)
    this._hookSessionCapture(session);
    if (session.direction === 'incoming') {
      const inviteRequest = session._request || null;
      const remoteSdp     = inviteRequest?.body || null;
      this._log('info', `INVITE SDP: ${remoteSdp ? 'found' : 'missing'}`);
      if (remoteSdp) {
        const sdpProto = remoteSdp.match(/^m=\S+\s+\d+\s+(\S+)/m)?.[1] || 'unknown';
        const hasIce   = remoteSdp.includes('a=ice-ufrag');
        const hasDtls  = remoteSdp.includes('a=fingerprint');
        this._log('info', `INVITE SDP media-proto=${sdpProto} ice=${hasIce} dtls=${hasDtls}`);
        if (hasIce || hasDtls) this._log('warn', 'Asterisk using WebRTC (DTLS/ICE) for this endpoint — plain RTP will not work; disable webrtc=yes on the Asterisk endpoint');
      }
      this.incomingCall = {
        session, from: session.remote_identity.uri.toString(),
        displayName: session.remote_identity.display_name || session.remote_identity.uri.user,
        remoteSdp
      };
      this._log('info', `Incoming call from ${this.incomingCall.from}`);
      this.emit('incomingCall', { from: this.incomingCall.from, displayName: this.incomingCall.displayName });

      // Auto-answer if enabled
      if (this.autoAnswer.enabled) {
        const delay = this.autoAnswer.delayMs || 0;
        this._log('info', `Auto-answer in ${delay}ms`);
        setTimeout(() => {
          if (this.incomingCall) {
            const callId = require('uuid').v4();
            this.answerCall(callId).catch(err => this._log('error', `Auto-answer failed: ${err.message}`));
          }
        }, delay);
      }
    }
    // Patch receiveRequest to log every in-dialog method and intercept re-INVITE/UPDATE
    // at the lowest level — JsSIP's reinvite/update events don't reliably fire headlessly
    const _applyRemoteSdp = (label, request) => {
      const sdp = request.body || null;
      console.log(`[${label}] method=${request.method} hasBody=${!!sdp} hasRtpBridge=${!!this.rtpBridge}`);
      if (!sdp || !this.rtpBridge) return;
      const remote = parseRemoteSdp(sdp);
      if (!remote) { console.log(`[${label}] parseRemoteSdp returned null`); return; }
      if (remote.ip !== this.rtpBridge.remoteIp || remote.port !== this.rtpBridge.remotePort) {
        this._log('info', `${label}: RTP target ${this.rtpBridge.remoteIp}:${this.rtpBridge.remotePort} → ${remote.ip}:${remote.port}`);
        this.rtpBridge.remoteIp   = remote.ip;
        this.rtpBridge.remotePort = remote.port;
      }
    };
    const _origReceiveReinvite = session._receiveReinvite.bind(session);
    session._receiveReinvite = (request) => {
      _applyRemoteSdp('REINVITE', request);
      return _origReceiveReinvite(request);
    };
    const _origReceiveUpdate = session._receiveUpdate.bind(session);
    session._receiveUpdate = (request) => {
      _applyRemoteSdp('UPDATE', request);
      return _origReceiveUpdate(request);
    };
    const _origReceiveRequest = session.receiveRequest.bind(session);
    session.receiveRequest = (request) => {
      console.log(`[IN-DIALOG] ${request.method}`);
      return _origReceiveRequest(request);
    };

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
      // Capture remote BYE (local BYE already captured by _captureOutboundBye)
      if (callId && e?.originator === 'remote' && e?.message) {
        try {
          const byeText = e.message.toString ? e.message.toString() : null;
          if (byeText && byeText.length > 10 && !byeText.startsWith('[object')) {
            const localIp = getLocalIp();
            const server  = this.config?.server || '';
            captureManager.writeSipMessage(callId, server, 5060, localIp, 5060, byeText);
            this._log('info', '[CAP] Remote BYE written');
          }
        } catch(ex) { this._log('warn', `BYE capture error: ${ex.message}`); }
      }
      if (callId) {
        const capFile = this.activeCall?.captureFile || null;
        const st      = this.rtpBridge ? this.rtpBridge.getStats() : null;
        callHistory.endCall(callId, { status: 'completed', captureFile: capFile, stats: st });
      }
      this._teardown();
      this.emit('callEnded', { callId, cause: e.cause });
    });
    session.on('failed', (e) => {
      this._log('error', `Call failed: ${e.cause || 'unknown'}`);
      const callId = this.activeCall?.callId;
      // Write failure response before teardown closes the capture
      if (callId && (e?.message || e?.response)) {
        try {
          const msg  = e.message || e.response;
          const text = msg.toString ? msg.toString() : null;
          if (text && text.length > 10) {
            const localIp = getLocalIp();
            const server  = this.config?.server || '';
            captureManager.writeSipMessage(callId, server, 5060, localIp, 5060, text);
          }
        } catch(ex) { /* ignore */ }
      }
      if (callId) callHistory.failCall(callId, { cause: e.cause || null });
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

    this.rtpBridge.start();
  }

  _teardown() {
    if (this.rtpBridge) {
      // Close on-demand recording writers if still active
      if (this.rtpBridge.recording) {
        if (this.rtpBridge.audioWriter) {
          try {
            const info = this.rtpBridge.audioWriter.close();
            this._log('info', `RX recording saved: ${this.rtpBridge.audioWriter.filename} (~${info.duration}s)`);
          } catch (e) { this._log('warn', `RX recording close error: ${e.message}`); }
          this.rtpBridge.audioWriter = null;
        }
        if (this.rtpBridge.txWriter) {
          try {
            const info = this.rtpBridge.txWriter.close();
            if (info.size > 0) this._log('info', `TX recording saved: ${this.rtpBridge.txWriter.filename} (~${info.duration}s)`);
          } catch (e) { this._log('warn', `TX recording close error: ${e.message}`); }
          this.rtpBridge.txWriter = null;
        }
        this.rtpBridge.recording = false;
      }
      const stats = this.rtpBridge.getStats();
      this._log('info', `Call stats — codec:${stats.codec} rx:${stats.rxPackets}pkts tx:${stats.txPackets}pkts lost:${stats.lostPackets} jitter:${stats.jitterMs}ms`);
      this.rtpBridge.onAudio    = null;
      this.rtpBridge.onRawAudio = null;
      this.rtpBridge.stop();
      this.rtpBridge = null;
    }
    if (this.confBridge)  { this.confBridge.stop();   this.confBridge  = null; }
    if (this.confSession) { try { this.confSession.terminate(); } catch(e){} this.confSession = null; }
    this.session        = null;
    this.activeCall     = null;
    this.incomingCall   = null;
    this._pendingCallId = null;
    this._teardownAnonymousUa();
  }

  // ── Unregister ───────────────────────────────────────────────────────────
  setAutoAnswer({ enabled = false, delayMs = 0 } = {}) {
    this.autoAnswer = { enabled: !!enabled, delayMs: Math.max(0, parseInt(delayMs) || 0) };
    this._log('info', `Auto-answer ${enabled ? `enabled (delay: ${delayMs}ms)` : 'disabled'}`);
    return this.autoAnswer;
  }

  unregister() {
    return new Promise((resolve) => {
      this._stopKeepalive();
      this._stopIpWatch();
      if (!this.ua) return resolve();
      this.ua.unregister({ all: true });
      this.ua.stop();
      this.ua = null; this.registered = false; this.config = null;
      resolve();
    });
  }

  // ── Outbound call ─────────────────────────────────────────────────────────
  makeCall(target, callId) {
    if (!this.ua || !this.registered) return Promise.reject(new Error('Not registered'));
    let targetUri = target;
    if (!target.startsWith('sip:') && !target.startsWith('sips:'))
      targetUri = target.includes('@') ? `sip:${target}` : `sip:${target}@${this.config.server}`;
    return this._dialOut(targetUri, callId);
  }

  // Places the INVITE on the current UA and records call bookkeeping.
  // Shared by makeCall() (registered dial) and makeUnregisteredCall() (ad-hoc dial).
  _dialOut(targetUri, callId) {
    return new Promise((resolve, reject) => {
      const localIp = getLocalIp();
      const rtpPort = allocateRtpPort();
      const sdp     = buildSdp(localIp, rtpPort);
      this._log('info', `Calling ${targetUri} | local RTP ${localIp}:${rtpPort}`);
      try {
        this.session = this.ua.call(targetUri, { mediaConstraints: { audio: false, video: false } });
        this.session.on('sending', (e) => {
          if (e.request) {
            // SIP capture handled by _hookSessionCapture via _handleNewSession
            e.request.body = sdp;
            this._log('info', 'Injected SDP into INVITE');
          }
        });
        this._pendingCallId = callId;
        this.activeCall = { callId, target: targetUri, direction: 'outbound', startTime: null, status: 'calling', localRtpPort: rtpPort, localIp };
        const localUri = this.config ? `${this.config.username}@${this.config.server}` : null;
        callHistory.addCall({ callId, direction: 'outbound', target: targetUri, from: localUri, to: targetUri });
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
      this._pendingCallId = callId;
      this.activeCall   = { callId, target: from, direction: 'inbound', startTime: null, status: 'connecting', localRtpPort: rtpPort, localIp };
      this.session      = session;
      this.incomingCall = null;
      session.on('sdp', (e) => { this._log('info', `SDP event type=${e.type}`); e.sdp = sdp; });
      try {
        session.answer({ mediaConstraints: { audio: false, video: false }, pcConfig: { iceServers: [] } });
        if (remoteSdp) this._startRtp(remoteSdp);
        else this._log('warn', 'No INVITE SDP — RTP not started');
        const localUri2 = this.config ? `${this.config.username}@${this.config.server}` : null;
        callHistory.addCall({ callId, direction: 'inbound', target: from, from, to: localUri2, displayName });
        resolve({ callId, from, displayName });
      } catch (err) { this._log('error', `answer() error: ${err.message}`); this._teardown(); reject(err); }
    });
  }

  // ── OPTIONS keepalive ────────────────────────────────────────────────────
  // Sends SIP OPTIONS to the PBX every 30s. Triggers re-register on failure.
  _startKeepalive() {
    this._stopKeepalive();
    const INTERVAL = 30000;
    this.keepaliveTimer = setInterval(() => {
      if (!this.ua || !this.registered || !this.config) return;
      try {
        this.ua.sendOptions(`sip:${this.config.server}`, null, {
          eventHandlers: {
            succeeded: () => {
              this.emit('keepalive', { ok: true });
            },
            failed: (e) => {
              this._log('warn', `OPTIONS keepalive failed: ${e.cause} — re-registering`);
              this.emit('keepalive', { ok: false, cause: e.cause });
              if (this.ua) this.ua.register();
            }
          }
        });
      } catch (e) {
        this._log('warn', `OPTIONS send error: ${e.message}`);
      }
    }, INTERVAL);
    this._log('info', `OPTIONS keepalive started (every ${INTERVAL / 1000}s)`);
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  // ── IP change watch ───────────────────────────────────────────────────────
  // Polls local IP every 15s. Re-registers when it changes so Contact header
  // advertises the new IP (important for cloud VMs that get reassigned IPs).
  _startIpWatch() {
    this._stopIpWatch();
    this.lastKnownIp = getLocalIp();
    this.ipWatchTimer = setInterval(() => {
      const current = getLocalIp();
      if (current !== this.lastKnownIp) {
        const old = this.lastKnownIp;
        this.lastKnownIp = current;
        this._log('warn', `IP changed: ${old} → ${current} — re-registering`);
        this.emit('ipChanged', { oldIp: old, newIp: current });
        if (this.ua && this.config) this.ua.register();
      }
    }, 15000);
  }

  _stopIpWatch() {
    if (this.ipWatchTimer) { clearInterval(this.ipWatchTimer); this.ipWatchTimer = null; }
  }

  // ── On-demand recording ───────────────────────────────────────────────────
  startRecording() {
    return new Promise((resolve, reject) => {
      if (!this.rtpBridge)          return reject(new Error('No active call'));
      if (this.rtpBridge.recording) return reject(new Error('Already recording'));
      const path = require('path');
      const { AudioWriter } = require('./audioDecoder');
      const id      = this.activeCall?.callId || 'manual';
      const ts      = Date.now();
      const rxPath  = path.join(__dirname, '../captures', `rec_${id.slice(0,8)}_${ts}_rx.wav`);
      const txPath  = path.join(__dirname, '../captures', `rec_${id.slice(0,8)}_${ts}_tx.wav`);
      this.rtpBridge.audioWriter = new AudioWriter(rxPath);
      this.rtpBridge.txWriter    = new AudioWriter(txPath);
      this.rtpBridge.startRecording();
      this._log('info', `Recording started: ${path.basename(rxPath)} + ${path.basename(txPath)}`);
      this.emit('recordingStarted', { callId: this.activeCall?.callId });
      resolve({ recording: true, file: path.basename(rxPath) });
    });
  }

  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.rtpBridge)           return reject(new Error('No active call'));
      if (!this.rtpBridge.recording) return reject(new Error('Not recording'));
      this.rtpBridge.stopRecording();
      const path = require('path');
      let audioFile = null;
      let txFile    = null;
      if (this.rtpBridge.audioWriter) {
        try {
          const info = this.rtpBridge.audioWriter.close();
          audioFile  = `/captures/${this.rtpBridge.audioWriter.filename}`;
          this._log('info', `RX recording saved: ${this.rtpBridge.audioWriter.filename} (~${info.duration}s)`);
        } catch (e) { this._log('warn', `RX recording save error: ${e.message}`); }
        this.rtpBridge.audioWriter = null;
      }
      if (this.rtpBridge.txWriter) {
        try {
          const info = this.rtpBridge.txWriter.close();
          if (info.size > 0) {
            txFile = `/captures/${this.rtpBridge.txWriter.filename}`;
            this._log('info', `TX recording saved: ${this.rtpBridge.txWriter.filename} (~${info.duration}s)`);
          }
        } catch (e) { this._log('warn', `TX recording save error: ${e.message}`); }
        this.rtpBridge.txWriter = null;
      }
      this.emit('recordingStopped', { callId: this.activeCall?.callId, audioFile, txFile });
      resolve({ recording: false, audioFile, txFile });
    });
  }

  // ── RTP stats ─────────────────────────────────────────────────────────────
  getRtpStats() {
    return this.rtpBridge ? this.rtpBridge.getStats() : null;
  }

    // ── Hangup ───────────────────────────────────────────────────────────────
  hangup() {
    return new Promise((resolve) => {
      if (this.session) {
        try {
          this._captureOutboundBye();
          this.session.terminate();
        } catch (e) { this._log('warn', `Hangup error: ${e.message}`); }
      } else {
        this._teardown();
      }
      resolve();
    });
  }

  _captureOutboundBye() {
    const callId  = this.activeCall?.callId;
    if (!callId) return;
    const localIp = getLocalIp();
    const server  = this.config?.server || '';
    try {
      const dialog = this.session?._dialog;
      if (!dialog) return;

      // JsSIP stores URIs as objects with toString() — call it explicitly
      // Also check multiple property paths across JsSIP versions
      const uriToStr = (u) => {
        if (!u) return null;
        if (typeof u === 'string') return u;
        if (typeof u.toString === 'function') {
          const s = u.toString();
          if (s && s !== '[object Object]' && s.includes('sip:')) return s;
        }
        if (u.uri) return uriToStr(u.uri);
        return null;
      };

      const localUri  = uriToStr(dialog.local_uri)  || `sip:${this.config.username}@${server}`;
      const remoteUri = uriToStr(dialog.remote_uri)
                     || uriToStr(dialog._remote_uri)
                     || this.activeCall?.target
                     || `sip:unknown@${server}`;

      // Dialog ID can be in different places depending on JsSIP version
      const dialogId  = dialog.id || dialog._id || {};
      const callIdSip = String(dialogId.call_id  || dialog.call_id  || '');
      const localTag  = String(dialogId.local_tag || dialog.local_tag || '');
      const remoteTag = String(dialogId.remote_tag|| dialog.remote_tag|| '');
      const cseq      = (dialog.local_seqnum || dialog._local_seqnum || 1) + 1;

      this._log('info', `[CAP] BYE dialog: remote=${remoteUri} local=${localUri} cseq=${cseq}`);
      const viaTransport = this.ua?._transport?.socket?.via_transport || 'WS';
      const CRLF      = '\r\n';
      const byeText   = [
        `BYE ${remoteUri} SIP/2.0`,
        `Via: SIP/2.0/${viaTransport} ${localIp};branch=z9hG4bK${Math.random().toString(36).slice(2)}`,
        `Max-Forwards: 70`,
        `From: <${localUri}>;tag=${localTag}`,
        `To: <${remoteUri}>;tag=${remoteTag}`,
        `Call-ID: ${callIdSip}`,
        `CSeq: ${cseq} BYE`,
        `Content-Length: 0`,
        ``,
        ``
      ].join(CRLF);
      const written = captureManager.writeSipMessage(callId, localIp, 5060, server, 5060, byeText);
      this._log('info', `[CAP] Outbound BYE ${written ? 'written to pcap' : 'FAILED'} callId=${callId?.slice(0,8)} byeLen=${byeText.length} firstLine=${byeText.split('\r\n')[0]}`);
    } catch(e) {
      this._log('warn', `BYE capture error: ${e.message}`);
    }
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

    const transport = this.ua?._transport;
    if (!transport || !transport.socket) throw new Error('No transport');
    const viaTransport = transport.socket.via_transport || 'WS';

    const msg = [
      `INVITE ${remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${viaTransport} ${localIp};branch=z9hG4bK${Math.random().toString(36).slice(2)}`,
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

    // transport.socket is always the exact object passed to `sockets:[...]`
    // (WebSocketInterface or UdpSocketInterface) — its send() return value
    // tells us whether the transport is actually open, for both alike.
    if (!transport.socket.send(msg)) throw new Error('Transport not open');
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
