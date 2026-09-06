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
const { clamp16 }    = require('./pcmUtils');
const callHistory    = require('./callHistory');
const { AudioWriter } = require('./audioDecoder');
const { NoiseSuppressor } = require('./noiseSuppressor');
const srtp = require('./srtp');
const { DtmfEventTracker } = require('./dtmfEvent');
const opusCodec = require('./opusCodec');
const { OPUS_PT, OPUS_SAMPLE_RATE, OPUS_TS_INCREMENT } = opusCodec;
const siprec = require('./siprec');

const WebSocket = require('ws');
global.WebSocket = WebSocket;

const JsSIP = require('jssip');
const UdpSocketInterface = require('./udpSipSocket');
const TcpSocketInterface = require('./tcpSipSocket');
const WsSocketInterface  = require('./wsSipSocket');

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

// Shared PT → display-name map, used both for the codec detected from
// actually-received packets (RtpBridge.start()) and the codec seeded from
// the remote SDP answer before any packet has arrived (parseRemoteSdp()).
const PT_CODEC_MAP = { 0: 'PCMU/8kHz', 8: 'PCMA/8kHz', 9: 'G722/16kHz', 18: 'G729/8kHz', [OPUS_PT]: 'Opus/16kHz' };

// ─── SDP ─────────────────────────────────────────────────────────────────────
// Codec preference order: Opus (PT111) > G.722 (PT9) > PCMU (PT0) > PCMA (PT8)
// G.722 is 16kHz wideband — RTP clock is 8000 per RFC 3551 (a historical quirk)
// but actual audio is 16kHz ADPCM. Opus's RTP clock is always 48000
// regardless of its actual (16kHz here) DSP rate — see opusCodec.js.
// `hold: true` sends sendonly (tells the remote to stop sending RTP) instead
// of the normal sendrecv.
// `srtp: {key, salt}` offers SDES-SRTP exclusively for this leg (RTP/SAVP +
// an a=crypto line) instead of plain RTP/AVP — see SipManager.secureMediaEnabled.
function buildSdp(localIp, rtpPort, { hold = false, srtp: localSrtp = null } = {}) {
  const id = Date.now();
  const proto = localSrtp ? 'RTP/SAVP' : 'RTP/AVP';
  const lines = [
    'v=0',
    `o=CallRaven ${id} ${id} IN IP4 ${localIp}`,
    's=CallRaven Call',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${rtpPort} ${proto} ${OPUS_PT} 9 0 8 101`,
    // RFC 7587: the rtpmap channel count is fixed at 2 for historical
    // reasons regardless of actual channel count; fmtp pins this app down
    // to mono. useinbandfec=1 matches opusCodec.js's encoder configuration.
    `a=rtpmap:${OPUS_PT} opus/48000/2`,
    `a=fmtp:${OPUS_PT} useinbandfec=1;stereo=0;sprop-stereo=0`,
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
  ];
  if (localSrtp) lines.push(srtp.buildCryptoAttr(1, localSrtp));
  lines.push(hold ? 'a=sendonly' : 'a=sendrecv', '');
  return lines.join('\r\n');
}

// Matches an a=rtpmap codec name (case-insensitively) to this app's
// PT_CODEC_MAP display names. G.722/PCMU/PCMA/telephone-event have
// IANA-fixed static payload types (RFC 3551) essentially never renumbered
// in practice, but Opus has no static assignment — it's always a dynamic
// PT (registered 96-127), and a B2BUA/proxy in the path (confirmed: this
// project's own CI Asterisk) is free to assign a *different* dynamic PT
// number per leg than what either endpoint originally offered. So the
// wire PT that means "Opus" must be read from each SDP's own rtpmap, not
// assumed to be a fixed constant, or packets renumbered in transit are
// silently unrecognized as any known codec.
const RTPMAP_NAME_TO_CODEC = { g722: 'G722/16kHz', pcmu: 'PCMU/8kHz', pcma: 'PCMA/8kHz', opus: 'Opus/16kHz' };

function parseRemoteSdp(sdp) {
  if (!sdp) return null;
  const lines = sdp.split(/\r?\n/);
  let ip = null, port = null, secure = false, firstPt = null;
  const ptCodecMap = {}; // built from this specific SDP's own rtpmap lines
  for (const line of lines) {
    const c = line.match(/^c=IN IP4 (.+)/);
    if (c) ip = c[1].trim();
    const m = line.match(/^m=audio (\d+) (\S+) (\d+)/);
    if (m) { port = parseInt(m[1]); secure = m[2] === 'RTP/SAVP'; firstPt = parseInt(m[3]); }
    const r = line.match(/^a=rtpmap:(\d+) (\w+)\//i);
    if (r) {
      const codec = RTPMAP_NAME_TO_CODEC[r[2].toLowerCase()];
      if (codec) ptCodecMap[parseInt(r[1])] = codec;
    }
  }
  if (!ip || !port) return null;
  const remoteCrypto = secure ? srtp.parseCryptoAttr(sdp) : null;
  // First PT listed is the far end's preferred choice from the negotiated
  // set — used to seed RtpBridge.stats.codec before any packet has
  // actually arrived (see RtpBridge constructor and SipManager.playWav),
  // since e.g. an IVR-style greeting can play before the caller has sent
  // any audio of their own to detect from.
  const negotiatedCodec = ptCodecMap[firstPt] || null;
  // The PT this specific peer uses for Opus, if any — see RTPMAP_NAME_TO_CODEC
  // comment above for why this can't just be the OPUS_PT constant.
  const remoteOpusPt = Object.keys(ptCodecMap).map(Number).find(pt => ptCodecMap[pt] === 'Opus/16kHz') ?? null;
  return { ip, port, remoteCrypto, negotiatedCodec, remoteOpusPt };
}

// Minimal SIP response parse: status code + top Via branch, used to
// correlate an inbound response with the raw re-INVITE _sendRawReInvite
// sent (JsSIP's own transaction table doesn't know about that request, so
// it can't do this matching for us — see _sendRawReInvite for why).
function parseSipResponse(text) {
  const statusMatch = text.match(/^SIP\/2\.0\s+(\d{3})/);
  if (!statusMatch) return null;
  const viaMatch    = text.match(/^Via:\s*([^\r\n]+)/mi);
  const branchMatch = viaMatch ? viaMatch[1].match(/;branch=([^;,\s]+)/i) : null;
  return { status: parseInt(statusMatch[1], 10), branch: branchMatch ? branchMatch[1] : null };
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
  // eslint-disable-next-line no-empty -- counting loop, work is in the header
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

    out[i] = pcmToUlaw(clamp16(sample));
  }

  return out;
}



// ─── RTP bridge ──────────────────────────────────────────────────────────────
class RtpBridge {
  constructor(localPort, remoteIp, remotePort, callId, nsEnabled = true, srtpOpts = null, negotiatedCodec = null, remoteOpusPt = null) {
    this.localPort   = localPort;
    this.remoteIp    = remoteIp;
    this.remotePort  = remotePort;
    this.callId      = callId;
    this.localIp     = getLocalIp();
    // Seeded from the remote SDP answer's first-listed codec (see
    // parseRemoteSdp) so SipManager.playWav can pick the right pre-converted
    // file even before any packet has actually arrived to auto-detect from
    // (stats.codec below stays the source of truth once real traffic
    // starts — this is only a fallback for the gap before that).
    this._negotiatedCodec = negotiatedCodec;
    // The wire PT this specific peer uses for Opus (may differ from
    // OPUS_PT — see parseRemoteSdp's RTPMAP_NAME_TO_CODEC comment). Used
    // in start()'s receive handler to normalize incoming packets to
    // OPUS_PT before any codec-specific dispatch runs.
    this._remoteOpusPt = remoteOpusPt;
    // SDES-SRTP contexts, one per direction — both present or both absent
    // (negotiation happened before this bridge was constructed; see
    // SipManager._startRtp/conference()). Derived once here since key
    // derivation rate 0 means the session keys never change mid-call.
    this._txCrypto = (srtpOpts && srtpOpts.localSrtp && srtpOpts.remoteSrtp)
      ? { sessionKeys: srtp.deriveSessionKeys(srtpOpts.localSrtp.key, srtpOpts.localSrtp.salt), roc: 0, lastSeq: null }
      : null;
    this._rxCrypto = (srtpOpts && srtpOpts.localSrtp && srtpOpts.remoteSrtp)
      ? { sessionKeys: srtp.deriveSessionKeys(srtpOpts.remoteSrtp.key, srtpOpts.remoteSrtp.salt), roc: 0, lastSeq: null }
      : null;
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
    // SIPREC relay hooks — separate from onRawAudio/onRawOutboundAudio
    // (which live transcription owns) so SIPREC can tap the same raw
    // payloads without disturbing that existing wiring; set by
    // SipManager._startSiprec, alongside whatever onRawAudio is doing.
    this.onSiprecAudio = null;
    this.onSiprecOutboundAudio = null;
    // Inbound RFC 4733 DTMF (telephone-event, PT 101): fn(digit, {durationMs})
    this.onDtmf = null;
    this._dtmfTracker = new DtmfEventTracker();
    // On-demand recording flag (distinct from always-on audioWriter)
    this.recording  = false;
    this.audioWriter = null;  // inbound (remote) recorder
    this.txWriter    = null;  // outbound (local WAV playback) recorder
    this._g722dec   = null;
    // Noise suppression on decoded inbound PCM (browser /audio relay only —
    // recordings and live transcription read raw/undecoded audio upstream
    // of this, so they're unaffected). One instance per sample rate, created
    // lazily on first use and keyed by sample rate since 8kHz (PCMU/PCMA)
    // and 16kHz (G.722) are the only rates ever seen.
    this.nsEnabled = nsEnabled;
    this._ns = {};
  }

  setNoiseSuppression(enabled) {
    this.nsEnabled = !!enabled;
    for (const ns of Object.values(this._ns)) ns.setEnabled(this.nsEnabled);
  }

  _suppressNoise(sampleRate, pcm16) {
    if (!this._ns[sampleRate]) this._ns[sampleRate] = new NoiseSuppressor(sampleRate, { enabled: this.nsEnabled });
    return this._ns[sampleRate].process(pcm16);
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
        // SRTP: header stays in the clear, only the payload is encrypted —
        // seq/ts/ssrc/pt below still read straight off `msg` either way.
        // A failed auth/decrypt drops the packet entirely (no stats, relay,
        // recording, or forwarding) rather than risk processing tampered
        // audio — see srtp.js's decryptVerify for why rxCrypto state is
        // only advanced on success.
        let payload = msg.slice(12);
        if (this._rxCrypto) {
          const result = srtp.decryptVerify(this._rxCrypto, msg);
          if (!result) {
            if (!this._loggedSrtpAuthFail) {
              console.warn('[SRTP] Inbound packet failed auth/decrypt — dropping (further failures logged silently)');
              this._loggedSrtpAuthFail = true;
            }
            return;
          }
          payload = result.payload;
        }

        const seq  = msg.readUInt16BE(2);
        const ts   = msg.readUInt32BE(4);
        const ssrc = msg.readUInt32BE(8);
        // Normalize the wire PT to OPUS_PT if it matches this peer's own
        // (possibly renumbered) Opus assignment — see parseRemoteSdp's
        // RTPMAP_NAME_TO_CODEC comment — so every codec-specific branch
        // below (and onAudio/onRawAudio/recording, further down) can keep
        // comparing against the fixed OPUS_PT constant.
        const wirePt = msg[1] & 0x7f;
        const pt = (this._remoteOpusPt !== null && wirePt === this._remoteOpusPt) ? OPUS_PT : wirePt;

        // Codec detection
        if (!this.stats.codec) {
          this.stats.codec = PT_CODEC_MAP[pt] || `PT${pt}`;
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
          this._relayAudio(pt, payload);
        }
        // Raw payload relay for live transcription (fires before any decoding)
        if (this.onRawAudio && !this.held) {
          this.onRawAudio(pt, payload);
        }
        // Raw payload relay for SIPREC (independent of onRawAudio above)
        if (this.onSiprecAudio && !this.held) {
          this.onSiprecAudio(pt, payload);
        }

        // RFC 4733 DTMF (telephone-event) — not audio, handled separately
        // from the onAudio/onRawAudio relays above.
        if (pt === 101 && this.onDtmf) {
          this._handleDtmfEvent(payload, ts);
        }

        // On-demand recording — write inbound audio regardless of playback state
        if (this.recording && this.audioWriter) {
          if (!this._loggedRecordPt) {
            console.log('[REC] Recording inbound PT=' + pt + ' payload_len=' + payload.length);
            this._loggedRecordPt = true;
          }
          this.audioWriter.write(pt, payload);
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

  // Send an RTP packet for the given payload type — all counters kept as
  // unsigned 32-bit with >>> 0. RTP timestamp increments by frame size per
  // RFC 3551 §4.5.2 (applies to both PCMU, pt 0, and G.722, pt 9) — that
  // default only holds because those codecs' byte-per-frame count happens
  // to equal their RTP-clock sample count for a 20ms frame. Opus doesn't
  // share that coincidence (its RTP clock is always 48000 regardless of
  // payload byte length — see opusCodec.js), so callers for it pass
  // tsIncrement explicitly.
  _sendRtpPacket(payload, pt, tsIncrement = payload.length) {
    if (!this.socket) return;
    try {
      this.seq       = (this.seq + 1) & 0xffff;
      this.timestamp = (this.timestamp + tsIncrement) >>> 0;

      const header = Buffer.alloc(12);
      header[0] = 0x80;  // V=2, P=0, X=0, CC=0
      header[1] = pt;    // M=0, PT=pt
      header.writeUInt16BE(this.seq, 2);
      header.writeUInt32BE(this.timestamp >>> 0, 4);
      header.writeUInt32BE(this.ssrc >>> 0, 8);

      // SRTP encrypts the payload and appends an 80-bit auth tag over
      // header+ciphertext; the pcap capture below records exactly what
      // goes on the wire either way.
      const pkt = this._txCrypto
        ? srtp.encrypt(this._txCrypto, header, payload)
        : Buffer.concat([header, payload]);

      this.socket.send(pkt, this.remotePort, this.remoteIp);
      this.stats.txPackets++;
      this.stats.txBytes += pkt.length;
      captureManager.writeRtpPacket(
        this.callId, this.localIp, this.localPort,
        this.remoteIp, this.remotePort, pkt
      );
    } catch (e) {
      console.error(`[RTP] _sendRtpPacket error (pt=${pt}): ${e.message}`);
    }
  }

  // Play a pre-converted file produced at upload time: raw G.722 (fixed
  // 160-byte/20ms chunks, PT 9, RTP clock 8000 despite 16kHz audio — RFC
  // 3551 quirk) or, for a `.opusraw` file, opusCodec's length-prefixed
  // frame format (variable-length packets, PT 111, RTP clock always 48000
  // regardless of the 16kHz DSP rate — see opusCodec.js). Both share the
  // same 20ms pacing loop and _sendRtpPacket call below; only the frame
  // source, PT, and RTP timestamp increment differ.
  playWav(filePath, onDone) {
    this.stopPlayback();

    const FRAME_MS = 20;
    const isOpus   = filePath.endsWith('.opusraw');
    const pt       = isOpus ? OPUS_PT : 9;

    let frames;    // array of Buffers to send in order, one per FRAME_MS tick
    let tsPerFrame; // RTP timestamp increment per frame
    try {
      if (isOpus) {
        frames = opusCodec.readFrameFile(fs.readFileSync(filePath));
        tsPerFrame = OPUS_TS_INCREMENT;
        console.log(`[WAV] Loaded Opus: ${path.basename(filePath)} (${frames.length} frames, ~${Math.round(frames.length * FRAME_MS / 1000)}s)`);
      } else {
        const g722data = fs.readFileSync(filePath);
        const FRAME_BYTES = 160; // G.722: 64kbps = 8000 bytes/sec → 20ms = 160 bytes
        frames = [];
        for (let offset = 0; offset + FRAME_BYTES <= g722data.length; offset += FRAME_BYTES) {
          frames.push(g722data.subarray(offset, offset + FRAME_BYTES));
        }
        tsPerFrame = FRAME_BYTES; // coincides with payload.length for G.722 — see _sendRtpPacket
        console.log(`[WAV] Loaded G.722: ${path.basename(filePath)} (${g722data.length} bytes, ~${Math.round(g722data.length/8000)}s)`);
      }
    } catch (e) {
      console.error(`[WAV] Load error: ${e.message}`);
      if (onDone) onDone(e);
      return;
    }

    let frameIndex = 0;

    // Sync seq/ts to the live stream before taking over
    if (this.lastSeq !== null) {
      this.seq       = (this.lastSeq + 1) & 0xffff;
      this.timestamp = this.lastTs >>> 0;
    }

    this.playing   = true;

    this.playTimer = setInterval(() => {
      if (!this.socket || frameIndex >= frames.length) {
        this.stopPlayback();
        if (onDone) onDone(null);
        return;
      }
      try {
        const frame = frames[frameIndex++];
        this._sendRtpPacket(frame, pt, tsPerFrame);
        // Write to outbound (tx) recorder — keeps playback separate from inbound
        if (this.recording && this.txWriter) {
          this.txWriter.write(pt, frame);
        }
        // Raw outbound relay for live diarization
        if (this.onRawOutboundAudio) {
          this.onRawOutboundAudio(pt, frame);
        }
        // Raw outbound relay for SIPREC (independent of onRawOutboundAudio above)
        if (this.onSiprecOutboundAudio) {
          this.onSiprecOutboundAudio(pt, frame);
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
    const codec  = this.stats.codec || this._negotiatedCodec || '';
    const isG722 = codec.includes('G722');
    const isOpus = codec.includes('Opus');
    // G.722 is ADPCM, not a direct log-PCM table like μ-law — 0x00 is NOT
    // silence there (verified: ffmpeg's own G.722 encoder settles on 0xFA
    // for a true-silence input; feeding it 0x00 instead decodes back out
    // as a sustained near-full-scale signal, confirmed both standalone and
    // following real audio, independent of any Node-side pipe timing).
    let frame, pt, tsIncrement;
    if (isOpus) {
      // Encode one true-silent 20ms frame (320 zero samples) and reuse it —
      // same "precompute once, repeat" approach as the other codecs below.
      if (!this._opusSilenceFrame) {
        this._opusSilenceFrame = Buffer.from(opusCodec.createEncoder().encode(Buffer.alloc(opusCodec.OPUS_FRAME_BYTES)));
      }
      frame = this._opusSilenceFrame; pt = OPUS_PT; tsIncrement = OPUS_TS_INCREMENT;
    } else if (isG722) {
      frame = Buffer.alloc(160, 0xfa); pt = 9; tsIncrement = 160;
    } else {
      frame = Buffer.alloc(160, 0x7f); pt = 0; tsIncrement = 160;
    }
    this.silenceTimer = setInterval(() => {
      if (!this.socket || this.playing || this.held) { this._stopSilence(); return; }
      this._sendRtpPacket(frame, pt, tsIncrement);
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

  // Fires onDtmf once per digit — see DtmfEventTracker for the end-of-event
  // and misbehaving-peer-timeout logic.
  _handleDtmfEvent(payload, ts) {
    const result = this._dtmfTracker.process(payload, ts);
    if (result) this.onDtmf(result.digit, { durationMs: result.durationMs });
  }

  // Suppress noise on decoded PCM and relay it to onAudio, if attached.
  // Suppression buffers internally, so a hop that hasn't filled yet yields
  // an empty buffer — skip it rather than forward a zero-sample frame (the
  // browser's Web Audio API throws on a 0-length AudioBuffer).
  _emitAudio(pt, sampleRate, pcm16) {
    if (!this.onAudio) return;
    const suppressed = this._suppressNoise(sampleRate, pcm16);
    if (suppressed.length > 0) this.onAudio(pt, suppressed);
  }

  // Decode inbound RTP payload to 16-bit PCM and relay to onAudio callback
  _relayAudio(pt, payload) {
    try {
      let pcm16;
      if (pt === 9) {
        // G.722 → 16kHz 16-bit PCM, decoded asynchronously by a persistent
        // ffmpeg subprocess (see audioDecoder.js) — PCM arrives via the 'pcm'
        // event rather than as a return value, so relay it from there instead
        // of falling through to the synchronous onAudio call below.
        const { G722Decoder } = require('./audioDecoder');
        if (!this._g722dec) {
          this._g722dec = new G722Decoder();
          this._g722dec.on('pcm', (pcm) => {
            try {
              // held is re-checked here (unlike the synchronous PCMU/PCMA
              // path below) because decoding is asynchronous — this fires
              // after ffmpeg returns, by which point a hold may have started.
              if (!this.held) this._emitAudio(9, 16000, pcm);
            } catch (e) { /* non-fatal — mirrors the try/catch around the PCMU/PCMA path below */ }
          });
        }
        this._g722dec.write(payload);
        return;
      } else if (pt === OPUS_PT) {
        // Opus decode is synchronous (no subprocess, unlike G.722 above) —
        // handled inline here rather than falling through to the shared
        // 8kHz emit below, since Opus decodes at 16kHz.
        if (!this._opusDecoder) this._opusDecoder = opusCodec.createDecoder();
        this._emitAudio(OPUS_PT, OPUS_SAMPLE_RATE, Buffer.from(this._opusDecoder.decode(payload)));
        return;
      } else if (pt === 0) {
        // PCMU (μ-law) → 8kHz 16-bit PCM
        pcm16 = Buffer.alloc(payload.length * 2);
        for (let i = 0; i < payload.length; i++) {
          const u = ~payload[i] & 0xff;
          const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
          let s = ((mant << 1) + 33) << (exp + 2);
          pcm16.writeInt16LE(clamp16(sign ? -s : s), i * 2);
        }
      } else if (pt === 8) {
        // PCMA (A-law) → 8kHz 16-bit PCM
        pcm16 = Buffer.alloc(payload.length * 2);
        for (let i = 0; i < payload.length; i++) {
          const a = payload[i] ^ 0x55;
          const sign = a & 0x80, exp = (a >> 4) & 0x07, mant = a & 0x0f;
          let s = exp === 0 ? (mant << 1) + 1 : (((mant | 0x10) << 1) + 1) << (exp - 1);
          s *= 8;
          pcm16.writeInt16LE(clamp16(sign ? -s : s), i * 2);
        }
      } else { return; }
      this._emitAudio(pt, 8000, pcm16);
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
    if (this._g722dec) {
      this._g722dec.close();
      this._g722dec = null;
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
    this._transportSocket = null;  // raw UDP-RAW/TCP-RAW socket backing the current UA, if any
    // Conference: second leg
    this.confSession      = null;
    this.confBridge       = null;
    // Which session _handleNewSession is about to receive: JsSIP fires
    // 'newRTCSession' synchronously from inside ua.call() — before the
    // caller gets the returned session back to assign it anywhere — so
    // there's no way to tell "is this the primary call" from the session
    // object alone at that moment. Callers placing a secondary leg (attended
    // transfer's target, a conference third party) set this to 'secondary'
    // immediately before calling ua.call(); _handleNewSession reads and
    // resets it. See _placeSecondaryLeg.
    this._nextSessionRole = 'primary';
    this.logs             = [];
    this.keepaliveTimer   = null;
    this.ipWatchTimer     = null;
    this.lastKnownIp      = null;
    // Sole source of truth for the noise-suppression toggle — pushed live to
    // any active RtpBridge and passed to bridges created for future calls.
    // Unlike the other feature toggles (owned by server.js's `settings`
    // object, taking effect only on the next call), this one needs to be
    // readable here since it's pushed to a live bridge immediately.
    this.noiseSuppressionEnabled = true;
    // SDES-SRTP toggle. Unlike noiseSuppressionEnabled, this can't be pushed
    // to a live call — crypto is negotiated once at INVITE/answer time — so
    // it only affects calls placed/answered after being set. Lives here
    // rather than in server.js's `settings` object because the SDP-building
    // methods that need to read it (_dialOut, answerCall, _placeSecondaryLeg)
    // are on this class.
    this.secureMediaEnabled = false;
    // SIPREC (RFC 7865/7866): when enabled with a server configured, every
    // future primary call is also sent, as a separate recording session, to
    // this SRS — see _startSiprec/_stopSiprec and siprec.js. Lives here for
    // the same reason as secureMediaEnabled above (this class reads it
    // directly at call-connect time).
    this.siprecEnabled = false;
    this.siprecServerUri = null;
    this._siprecClient = null;
    // Tracks completion of the most recent raw re-INVITE (hold/resume) — see
    // _sendRawReInvite for why this needs to exist at all.
    this._reinviteAckWatcher = null; // { branch, resolve } while awaiting a response
    this._pendingReinviteAck = null; // Promise a subsequent raw re-INVITE awaits first
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
  // Builds the JsSIP Socket for a given config — the built-in WebSocketInterface
  // (UDP/TLS meaning ws://\/wss://, the original transport), our raw-UDP
  // UdpSocketInterface ('UDP-RAW'), or our raw TCP/TLS TcpSocketInterface
  // ('TCP-RAW'/'TLS-RAW'). JsSIP's Transport layer is transport-agnostic (see
  // udpSipSocket.js/tcpSipSocket.js header comments) so everything else —
  // dialogs, digest auth, REGISTER refresh, transactions — is unaffected by
  // which one is plugged in.
  // Force-release the OS port held by the transport socket built for the
  // previous UA, if any. JsSIP's own ua.stop() only calls disconnect() on
  // that socket once its graceful un-REGISTER exchange finishes — which can
  // take well over a second — leaving the port bound and unavailable to the
  // replacement socket we're about to bind for the new UA. Only UdpSocketInterface
  // needs this (it's the only transport that waits on a slow async close);
  // TcpSocketInterface.disconnect() already closes synchronously, and
  // JsSIP.WebSocketInterface doesn't bind a local port at all.
  _releasePreviousTransport() {
    if (this._transportSocket && typeof this._transportSocket.releasePort === 'function') {
      try { this._transportSocket.releasePort(); } catch (e) { /* best-effort */ }
    }
    this._transportSocket = null;
  }

  // Common prep shared by register() and makeUnregisteredCall() before
  // constructing the replacement UA: stop whatever UA is current (if any)
  // and force-release its transport's OS socket, then track the new one.
  _beginUaReplacement(socket) {
    if (this.ua) { this._log('info', 'Stopping existing UA'); this.ua.stop(); this.ua = null; }
    this._releasePreviousTransport();
    this._transportSocket = socket;
  }

  // 'disconnected'/'newRTCSession' wiring is identical between register()'s
  // UA and the anonymous-call UA — both need the same stale-UA guard
  // (isCurrent) documented on register()'s isCurrent() above.
  _wireCommonUaEvents(ua, isCurrent) {
    ua.on('disconnected', (e) => { if (isCurrent()) this._log('warn', `Transport disconnected: ${e?.cause || ''}`); });
    ua.on('newRTCSession', (data) => { if (isCurrent()) this._handleNewSession(data.session); });
  }

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
    if (config.transport === 'TCP-RAW' || config.transport === 'TLS-RAW') {
      const secure    = config.transport === 'TLS-RAW';
      const port      = config.port || 5060;
      const localPort = parseInt(process.env.SIP_PORT || '5060', 10);
      const socket    = new TcpSocketInterface(config.server, port, {
        secure, rejectUnauthorized: !config.allowSelfSigned, localPort
      });
      const scheme      = secure ? 'tls' : 'tcp';
      const contactUri  = `sip:${username}@${getLocalIp()}:${localPort};transport=${scheme}`;
      return {
        socket, sipProto: secure ? 'sips' : 'sip',
        connectLabel: `${scheme}://${config.server}:${port}`, contactUri
      };
    }
    const wsProto  = config.transport === 'TLS' ? 'wss' : 'ws';
    const sipProto = config.transport === 'TLS' ? 'sips' : 'sip';
    const wsPort   = config.transport === 'TLS' ? (config.wsPort || 8089) : (config.wsPort || 8088);
    const wsPath   = config.wsPath || '/ws';
    const wsUri    = `${wsProto}://${config.server}:${wsPort}${wsPath}`;
    return { socket: new WsSocketInterface(wsUri), sipProto, connectLabel: wsUri, contactUri: null };
  }

  // ── Registration ─────────────────────────────────────────────────────────
  register(config) {
    return new Promise((resolve, reject) => {
      this.config = config;
      const { server, username, password, displayName } = config;
      const { socket, sipProto, connectLabel, contactUri } = this._buildTransportSocket(config, username);
      this._beginUaReplacement(socket);
      this._log('info', `Connecting to ${connectLabel}`);
      const uaOptions = {
        sockets: [socket], uri: `${sipProto}:${username}@${server}`,
        password, display_name: displayName, register: true,
        register_expires: 300, user_agent: 'CallRaven/1.0',
        connection_recovery_min_interval: 2, connection_recovery_max_interval: 30,
        log: { builtinEnabled: false, level: 'warn',
          connector: (level, category, label, content) => {
            if (level === 'warn' || level === 'error') this._log(level, `[${category}] ${content}`);
          }
        }
      };
      if (contactUri) uaOptions.contact_uri = contactUri;
      const ua = this.ua = new JsSIP.UA(uaOptions);
      // Guard every handler against events from an abandoned UA. Stopping a
      // *registered* UA makes JsSIP send un-REGISTER and delay tearing down
      // its transport until that exchange settles (up to a couple seconds —
      // see UA.stop()/Registrator.onTransportClosed() in jssip's lib) — well
      // after this.ua has already moved on to a replacement (re-register,
      // IP change). Without this check, that late 'unregistered' would still
      // flip the singleton's `registered` flag to false and broadcast a
      // spurious unregistered event even though the new UA is registered.
      const isCurrent = () => this.ua === ua;
      ua.on('registered', () => {
        if (!isCurrent()) return;
        this.registered = true;
        this._log('info', `Registered as ${username}@${server}`);
        this.emit('registered', { username, server, displayName });
        this._startKeepalive();
        this._startIpWatch();
        resolve({ registered: true });
      });
      ua.on('unregistered', () => {
        if (!isCurrent()) return;
        this.registered = false;
        this._log('info', 'Unregistered');
        this.emit('unregistered', {});
      });
      ua.on('registrationFailed', (data) => {
        if (!isCurrent()) return;
        this.registered = false;
        const cause = data.cause || 'Unknown';
        this._log('error', `Registration failed: ${cause}`);
        this.emit('registrationFailed', { cause });
        reject(new Error(`Registration failed: ${cause}`));
      });
      ua.on('connected',    () => {
        if (!isCurrent()) return;
        this._log('info', `Connected to ${connectLabel}`);
        // Hook the transport's raw message stream to capture 100/180/200
        // responses (JsSIP doesn't expose these on session events for
        // outbound calls) — WS needs internal reflection, raw UDP exposes
        // a direct callback instead. See _hookTransportCapture().
        this._hookTransportCapture();
      });
      this._wireCommonUaEvents(ua, isCurrent);

      this.ua.start();
      setTimeout(() => { if (!this.registered) reject(new Error('Registration timeout after 30s')); }, 30000);
    });
  }

  // ── Transport capture hook ────────────────────────────────────────────────
  // Hooks the raw transport message stream so 100/180/200 responses (which
  // JsSIP doesn't expose on session events for outbound calls) still make it
  // into the pcap. Shared by both the registered UA and ad-hoc unregistered UAs.
  // All three transports (UdpSocketInterface, TcpSocketInterface and
  // WsSocketInterface) implement the same onRawMessage contract, so there's
  // one hook here rather than a per-transport special case.
  _hookTransportCapture() {
    const transportSocket = this.ua?._transport?.socket;
    if (!transportSocket || typeof transportSocket !== 'object') return;
    if (transportSocket._sipCaptureHooked) return;
    transportSocket._sipCaptureHooked = true;
    transportSocket.onRawMessage = (text, direction) => {
      // Complete the raw re-INVITE's transaction (see _sendRawReInvite) if
      // this is its response — independent of the capture logic below, and
      // checked first since it doesn't depend on a callId being resolvable.
      if (direction === 'in') this._checkReinviteAckWatcher(text);

      const callId = this._pendingCallId || this.activeCall?.callId;
      if (!callId) return;
      const localIp = getLocalIp();
      const server  = this.config?.server || '';
      if (direction === 'in') captureManager.writeSipMessage(callId, server, 5060, localIp, 5060, text);
      else                    captureManager.writeSipMessage(callId, localIp, 5060, server, 5060, text);
    };
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

      const rawTransports = ['UDP-RAW', 'TCP-RAW', 'TLS-RAW'];
      const transport   = opts.transport === 'TLS' ? 'TLS'
                         : rawTransports.includes(opts.transport) ? opts.transport
                         : 'UDP';
      const displayName = (opts.displayName || '').trim() || 'anonymous';
      const localUser   = displayName.replace(/[^A-Za-z0-9._-]/g, '') || 'anonymous';

      const anonConfig = {
        server: domain, transport, port: opts.port, wsPort: opts.wsPort, wsPath: opts.wsPath,
        allowSelfSigned: opts.allowSelfSigned
      };
      const { socket, sipProto, connectLabel, contactUri } = this._buildTransportSocket(anonConfig, localUser);
      const targetUri = `${sipProto}:${stripped}`;

      this._beginUaReplacement(socket);
      this._log('info', `Unregistered call — connecting to ${connectLabel}`);
      const uaOptions = {
        sockets: [socket], uri: `${sipProto}:${localUser}@${domain}`,
        display_name: displayName, register: false, user_agent: 'CallRaven/1.0',
        log: { builtinEnabled: false, level: 'warn',
          connector: (level, category, label, content) => {
            if (level === 'warn' || level === 'error') this._log(level, `[${category}] ${content}`);
          }
        }
      };
      if (contactUri) uaOptions.contact_uri = contactUri;
      const ua = this.ua = new JsSIP.UA(uaOptions);
      this.config = { server: domain, username: localUser, displayName, transport, port: opts.port, wsPort: opts.wsPort, wsPath: opts.wsPath };
      this._anonymousUa = true;

      // Same stale-UA guard as register() — ua.stop() can delay transport
      // teardown (draining an in-progress session/transaction) well past
      // the point this.ua has already moved on to a replacement.
      const isCurrent = () => this.ua === ua;
      let settled = false;
      ua.on('connected', () => {
        if (!isCurrent()) return;
        this._log('info', `Connected to ${connectLabel}`);
        this._hookTransportCapture();
        if (settled) return;
        settled = true;
        this._dialOut(targetUri, callId).then(resolve).catch(err => {
          this._teardownAnonymousUa();
          reject(err);
        });
      });
      this._wireCommonUaEvents(ua, isCurrent);

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

  // Extracts the {localUri, remoteUri, callId, localTag, remoteTag, cseq}
  // fields raw SIP request construction needs from a JsSIP dialog, using the
  // most defensive fallback chain of the three call sites this used to be
  // duplicated across (dialog.id vs dialog._id, call_id vs dialog.call_id,
  // etc. — JsSIP's dialog shape has drifted across versions/code paths).
  _dialogFields(dialog, cseqOffset = 0) {
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
    const server    = this.config?.server || '';
    const localUri  = uriToStr(dialog.local_uri) || `sip:${this.config?.username}@${server}`;
    const remoteUri = uriToStr(dialog.remote_uri) || uriToStr(dialog._remote_uri)
                   || this.activeCall?.target || `sip:unknown@${server}`;
    const dialogId  = dialog.id || dialog._id || {};
    const callId    = String(dialogId.call_id   || dialog.call_id   || '');
    const localTag  = String(dialogId.local_tag  || dialog.local_tag  || '');
    const remoteTag = String(dialogId.remote_tag || dialog.remote_tag || '');
    const cseq      = (dialog.local_seqnum || dialog._local_seqnum || 1) + cseqOffset;
    return { localUri, remoteUri, callId, localTag, remoteTag, cseq };
  }

  // Assembles a raw SIP request string (Via/Max-Forwards/From/To/Call-ID/CSeq
  // plus any extraHeaders and an optional body) from dialog-derived fields.
  // Used by _sendRawReInvite, which builds AND actually transmits the
  // message, bypassing JsSIP's own re-INVITE/WebRTC-oriented call path for
  // hold/resume — unlike ACK/BYE, there's no way to have JsSIP send this on
  // our behalf, so it has to be hand-assembled here rather than just
  // captured off the wire via _hookTransportCapture.
  _buildSipMessage(method, dialog, { cseqOffset = 0, extraHeaders = [], body = null, branch = null } = {}) {
    const { localUri, remoteUri, callId, localTag, remoteTag, cseq } = this._dialogFields(dialog, cseqOffset);
    const localIp      = this.activeCall?.localIp || getLocalIp();
    const viaTransport  = this.ua?._transport?.socket?.via_transport || 'WS';
    // A caller that needs to correlate this request's response (there's no
    // JsSIP transaction table backing this send — see _sendRawReInvite)
    // passes an explicit branch; otherwise generate one as usual.
    branch = branch || `z9hG4bK${Math.random().toString(36).slice(2)}`;
    return [
      `${method} ${remoteUri} SIP/2.0`,
      `Via: SIP/2.0/${viaTransport} ${localIp};branch=${branch}`,
      `Max-Forwards: 70`,
      `From: <${localUri}>;tag=${localTag}`,
      `To: <${remoteUri}>;tag=${remoteTag}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} ${method}`,
      ...extraHeaders,
      `Content-Length: ${body ? Buffer.byteLength(body) : 0}`,
      '',
      body || ''
    ].join('\r\n');
  }

  // ── Session wiring ────────────────────────────────────────────────────────
  _handleNewSession(session) {
    // Incoming sessions are always primary-call candidates in this app's
    // model (there's no such thing as an "incoming transfer/conference
    // leg"). Outgoing sessions default to primary too (that's the vastly
    // more common case, and _dialOut never gets a chance to set the flag
    // before this fires — see _nextSessionRole's own comment) unless a
    // caller placing a secondary leg explicitly marked the next one.
    const isPrimary = session.direction === 'incoming' || this._nextSessionRole !== 'secondary';
    this._nextSessionRole = 'primary';

    this._log('info', `New session direction=${session.direction} role=${isPrimary ? 'primary' : 'secondary'}`);
    // SIP capture itself is handled entirely by _hookTransportCapture()'s
    // onRawMessage — it sees every byte actually sent/received on the wire,
    // for every transport. A session-level capture (JsSIP 'sending'/
    // 'progress'/'confirmed' events, plus hand-reconstructing ACK/BYE
    // because "JsSIP sends them internally without exposing them") used to
    // exist alongside it and double-wrote most of the dialog into every
    // pcap — see _sendRawReInvite/_buildSipMessage's remaining use for why
    // that reconstruction approach still exists for the raw hold/resume
    // re-INVITE, which is actually transmitted, not just captured.
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
            const callId = require('crypto').randomUUID();
            this.answerCall(callId).catch(err => this._log('error', `Auto-answer failed: ${err.message}`));
          }
        }, delay);
      }
    }
    // Patch receiveRequest to log every in-dialog method, and to bridge a
    // real race confirmed via an attended-transfer test call: JsSIP only
    // accepts NOTIFY/REFER/INFO/UPDATE while the session is exactly
    // STATUS_CONFIRMED (9) — everything else gets a flat 403 "Wrong
    // Status", including while WAITING_FOR_ACK (6) for an in-dialog
    // INVITE's answer. That's normally a vanishingly narrow window, but
    // this app's headless RTCPeerConnection stub (see the top of this
    // file) still needs one real setTimeout(0) event-loop turn per
    // in-dialog INVITE to signal ICE-gathering-complete before JsSIP
    // replies — confirmed, by instrumenting session._status directly
    // across a real call, that a REFER subscription's own completion
    // NOTIFY can land in that window when Asterisk fires off a
    // back-to-back re-INVITE (its own direct_media renegotiation) right
    // around the same time. A 403 there is final — the far end won't
    // retry a rejected request on its own — so the NOTIFY carrying "your
    // transfer succeeded" was silently and permanently lost, and
    // blindTransfer/attendedTransfer's REFER-accepted handling (which
    // depends on exactly that NOTIFY reaching the ReferSubscriber) never
    // fired. Bridge the gap on our side instead: defer these methods
    // until the session returns to CONFIRMED (bounded, so a session stuck
    // for some other reason doesn't hang a request forever — it just
    // falls through to JsSIP's normal 403 at that point, same as today).
    const RETRIABLE_METHODS = new Set(['NOTIFY', 'REFER', 'INFO', 'UPDATE', 'MESSAGE']);
    const STATUS_CONFIRMED  = 9;
    const RETRY_INTERVAL_MS = 25;
    const RETRY_DEADLINE_MS = 2000;
    const _origReceiveRequest = session.receiveRequest.bind(session);
    session.receiveRequest = (request) => {
      console.log(`[IN-DIALOG] ${request.method}`);
      if (session._status !== STATUS_CONFIRMED && RETRIABLE_METHODS.has(request.method)) {
        const deadline = Date.now() + RETRY_DEADLINE_MS;
        const tryNow = () => {
          if (session._status === STATUS_CONFIRMED || Date.now() >= deadline) {
            return _origReceiveRequest(request);
          }
          setTimeout(tryNow, RETRY_INTERVAL_MS);
        };
        tryNow();
        return;
      }
      return _origReceiveRequest(request);
    };

    // Everything below mutates primary-call state (this.activeCall,
    // this.rtpBridge, call history, callConnected/Ended/Failed events) or
    // reads it to decide what to do — none of it is safe to also run for a
    // secondary leg (attended-transfer target, conference third party).
    // Those legs already have their own correctly-scoped 'confirmed'/
    // 'ended'/'failed' handlers wired by attendedTransfer()/conference()
    // themselves; this used to run unconditionally for every outgoing
    // session regardless, corrupting or outright killing the primary call
    // whenever a transfer/conference attempt so much as rang or failed.
    if (!isPrimary) return;

    // Intercept re-INVITE/UPDATE at the lowest level — JsSIP's reinvite/
    // update events don't reliably fire headlessly — to redirect
    // this.rtpBridge when the PBX re-routes media mid-call (see the
    // "PBX Media Redirection" section of the README).
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
      this._startSiprec();
    });
    session.on('ended', (e) => {
      this._log('info', `Call ended: ${e.cause || 'normal'}`);
      const callId = this.activeCall?.callId;
      // A remote BYE's bytes are already in the pcap via the transport hook
      // by the time this fires (JsSIP processes the inbound packet, then
      // dispatches this event, synchronously within the same call stack) —
      // no separate capture needed here.
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
    const localSrtp = this.activeCall?.localSrtp || null;
    if (localSrtp && !remote.remoteCrypto) {
      this._log('warn', 'Offered SRTP but remote answer had no compatible crypto — audio will not decode correctly');
    } else if (!localSrtp && remote.remoteCrypto) {
      this._log('warn', 'Remote answer offered SRTP but we did not request it — ignoring');
    }
    const srtpOpts = (localSrtp && remote.remoteCrypto) ? { localSrtp, remoteSrtp: remote.remoteCrypto } : null;
    this.rtpBridge  = new RtpBridge(localPort, remote.ip, remote.port, callId, this.noiseSuppressionEnabled, srtpOpts, remote.negotiatedCodec, remote.remoteOpusPt);
    this.rtpBridge.onDtmf = (digit, info) => {
      this._log('info', `DTMF received: ${digit}`);
      this.emit('dtmfReceived', { callId: this.activeCall?.callId, digit, durationMs: info.durationMs });
    };

    this.rtpBridge.start();
  }

  // Closes an on-demand-recording writer (audioWriter/txWriter), logs the
  // outcome, and returns the public /captures/<file> path — null if there's
  // no writer, close failed, or (when skipIfEmpty) nothing was actually
  // written (the tx writer is empty whenever no WAV was played into the call).
  _closeWriter(writer, label, { skipIfEmpty = false } = {}) {
    if (!writer) return null;
    try {
      const info = writer.close();
      if (skipIfEmpty && info.size === 0) return null;
      this._log('info', `${label} recording saved: ${writer.filename} (~${info.duration}s)`);
      return `/captures/${writer.filename}`;
    } catch (e) {
      this._log('warn', `${label} recording save error: ${e.message}`);
      return null;
    }
  }

  _teardown() {
    if (this.rtpBridge) {
      // Close on-demand recording writers if still active
      if (this.rtpBridge.recording) {
        this._closeWriter(this.rtpBridge.audioWriter, 'RX');
        this._closeWriter(this.rtpBridge.txWriter, 'TX', { skipIfEmpty: true });
        this.rtpBridge.audioWriter = null;
        this.rtpBridge.txWriter    = null;
        this.rtpBridge.recording   = false;
      }
      const stats = this.rtpBridge.getStats();
      this._log('info', `Call stats — codec:${stats.codec} rx:${stats.rxPackets}pkts tx:${stats.txPackets}pkts lost:${stats.lostPackets} jitter:${stats.jitterMs}ms`);
      this.rtpBridge.onAudio    = null;
      this.rtpBridge.onRawAudio = null;
      this.rtpBridge.onDtmf     = null;
      this.rtpBridge.onSiprecAudio         = null;
      this.rtpBridge.onSiprecOutboundAudio = null;
      this.rtpBridge.stop();
      this.rtpBridge = null;
    }
    if (this.confBridge)  { this.confBridge.stop();   this.confBridge  = null; }
    if (this.confSession) { try { this.confSession.terminate(); } catch(e){} this.confSession = null; }
    this._stopSiprec();
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

  // Toggle real-time noise suppression on decoded inbound audio (browser
  // /audio relay). Applies immediately to any live bridge, and persists as
  // the default for bridges created by future calls.
  //
  // Only rtpBridge is touched here — confBridge.onAudio is never assigned
  // (the conference second leg isn't relayed to the browser), so suppression
  // would never actually run on it; calling setNoiseSuppression on it too
  // would just be misleading dead code implying otherwise.
  setNoiseSuppression(enabled) {
    this.noiseSuppressionEnabled = !!enabled;
    if (this.rtpBridge) this.rtpBridge.setNoiseSuppression(this.noiseSuppressionEnabled);
    this._log('info', `Noise suppression ${this.noiseSuppressionEnabled ? 'enabled' : 'disabled'}`);
    return this.noiseSuppressionEnabled;
  }

  getNoiseSuppression() {
    return this.noiseSuppressionEnabled;
  }

  // Toggle SDES-SRTP for future calls. Takes effect on the next call placed
  // or answered — see this.secureMediaEnabled's constructor comment for why
  // there's nothing to push to an already-active call.
  setSecureMedia(enabled) {
    this.secureMediaEnabled = !!enabled;
    this._log('info', `Secure media (SRTP) ${this.secureMediaEnabled ? 'enabled' : 'disabled'} for future calls`);
    return this.secureMediaEnabled;
  }

  getSecureMedia() {
    return this.secureMediaEnabled;
  }

  // Configure SIPREC delivery for future calls. Takes effect on the next
  // call — an already-active call isn't retroactively sent to the SRS.
  setSiprecConfig({ enabled, serverUri } = {}) {
    if (typeof enabled === 'boolean') this.siprecEnabled = enabled;
    if (typeof serverUri === 'string') this.siprecServerUri = serverUri.trim() || null;
    this._log('info', `SIPREC ${this.siprecEnabled ? 'enabled' : 'disabled'} for future calls${this.siprecServerUri ? ` (server: ${this.siprecServerUri})` : ''}`);
    return this.getSiprecConfig();
  }

  getSiprecConfig() {
    return { enabled: this.siprecEnabled, serverUri: this.siprecServerUri };
  }

  // Places a SIPREC recording-session INVITE to the configured SRS and, on
  // success, taps the primary call's raw audio into it — see siprec.js for
  // why this is a standalone raw SIP UAC rather than a second JsSIP UA/
  // dialog. Failure here must never affect the primary call (matches how
  // an SRTP negotiation mismatch only logs a warning, not an error) — a
  // compliance recording pipe going down is not a reason to drop a call.
  async _startSiprec() {
    if (!this.siprecEnabled || !this.siprecServerUri || !this.rtpBridge) return;
    const localAor  = this.config ? `sip:${this.config.username}@${this.config.server}` : 'sip:callraven@unknown';
    const remoteAor = this.activeCall?.target || 'sip:unknown@unknown';
    const client = new siprec.SiprecClient({
      srsUri: this.siprecServerUri,
      localIp: this.activeCall?.localIp || getLocalIp(),
      localAor, localName: this.config?.displayName || null,
      remoteAor, remoteName: null,
    });
    try {
      await client.start();
      // The primary call may have already ended (or a newer SIPREC client
      // already be active) by the time this async start() resolves.
      if (!this.rtpBridge || this._siprecClient) { client.stop().catch(() => {}); return; }
      this._siprecClient = client;
      this.rtpBridge.onSiprecAudio = (pt, payload) => {
        client.feedRemote(payload, pt, pt === OPUS_PT ? OPUS_TS_INCREMENT : payload.length);
      };
      this.rtpBridge.onSiprecOutboundAudio = (pt, payload) => {
        client.feedLocal(payload, pt, pt === OPUS_PT ? OPUS_TS_INCREMENT : payload.length);
      };
      this._log('info', `SIPREC: recording session established with ${this.siprecServerUri}`);
    } catch (e) {
      this._log('warn', `SIPREC: failed to start recording session: ${e.message}`);
    }
  }

  _stopSiprec() {
    if (this._siprecClient) {
      const client = this._siprecClient;
      this._siprecClient = null;
      client.stop().catch(() => {});
    }
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

  // A bare extension/address becomes a full sip: URI against the currently
  // registered server; anything already prefixed sip:/sips: passes through.
  _normalizeUri(target) {
    if (target.startsWith('sip:') || target.startsWith('sips:')) return target;
    return target.includes('@') ? `sip:${target}` : `sip:${target}@${this.config.server}`;
  }

  // ── Outbound call ─────────────────────────────────────────────────────────
  makeCall(target, callId) {
    if (!this.ua || !this.registered) return Promise.reject(new Error('Not registered'));
    return this._dialOut(this._normalizeUri(target), callId);
  }

  // Places the INVITE on the current UA and records call bookkeeping.
  // Shared by makeCall() (registered dial) and makeUnregisteredCall() (ad-hoc dial).
  _dialOut(targetUri, callId) {
    return new Promise((resolve, reject) => {
      const localIp  = getLocalIp();
      const rtpPort  = allocateRtpPort();
      const localSrtp = this.secureMediaEnabled ? srtp.generateMasterKeySalt() : null;
      const sdp      = buildSdp(localIp, rtpPort, { srtp: localSrtp });
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
        this.activeCall = { callId, target: targetUri, direction: 'outbound', startTime: null, status: 'calling', localRtpPort: rtpPort, localIp, localSrtp };
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
      const localIp   = getLocalIp();
      const rtpPort   = allocateRtpPort();
      const localSrtp = this.secureMediaEnabled ? srtp.generateMasterKeySalt() : null;
      const sdp       = buildSdp(localIp, rtpPort, { srtp: localSrtp });
      this._log('info', `Answering ${from} | local RTP ${localIp}:${rtpPort}`);
      if (remoteSdp) captureManager.writeSipMessage(callId, this.config.server, 5060, localIp, 5060, remoteSdp);
      this._pendingCallId = callId;
      this.activeCall   = { callId, target: from, direction: 'inbound', startTime: null, status: 'connecting', localRtpPort: rtpPort, localIp, localSrtp };
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
      const audioFile = this._closeWriter(this.rtpBridge.audioWriter, 'RX');
      const txFile    = this._closeWriter(this.rtpBridge.txWriter, 'TX', { skipIfEmpty: true });
      this.rtpBridge.audioWriter = null;
      this.rtpBridge.txWriter    = null;
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
        // session.terminate() sends the real BYE synchronously (before
        // emitting 'ended'), so the transport hook has already captured it
        // by the time _teardown() (on 'ended') closes the pcap writer — no
        // separate reconstruction needed.
        try { this.session.terminate(); }
        catch (e) { this._log('warn', `Hangup error: ${e.message}`); }
      } else {
        this._teardown();
      }
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
      // Fire-and-forget: _sendRawReInvite is async (it may need to wait out
      // a still-unACKed previous re-INVITE first — see its own comment),
      // but hold() itself responds immediately without waiting on the
      // network round trip, same as before.
      this._sendRawReInvite(true).catch(e => this._log('warn', `re-INVITE failed (${e.message}) — RTP muted only`));
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
      this._sendRawReInvite(false).catch(e => this._log('warn', `re-INVITE failed (${e.message}) — RTP resumed`));
      this.emit('callResumed', { callId: this.activeCall?.callId });
      this._log('info', 'Call resumed');
      resolve({ onHold: false });
    });
  }

  // Matches an inbound response against the raw re-INVITE's response
  // watcher, if one is pending — called from _hookTransportCapture's
  // onRawMessage for every inbound message. See _sendRawReInvite for why
  // this bookkeeping exists at all (JsSIP's transaction table doesn't know
  // about that request, so it can't do this matching, or the required
  // follow-up ACK, on its own).
  _checkReinviteAckWatcher(text) {
    const watcher = this._reinviteAckWatcher;
    if (!watcher) return;
    const parsed = parseSipResponse(text);
    if (!parsed || !parsed.branch || parsed.branch !== watcher.branch) return;
    watcher.onResponse(parsed.status);
  }

  // Waits for the response to a raw re-INVITE identified by `branch`, and
  // sends the ACK it requires once it arrives — RFC 3261 17.1.1.3: a 2xx
  // gets an ACK with a fresh branch (sent, and dialog-routed, independent
  // of the original transaction); a non-2xx final response gets one that
  // reuses the INVITE's own branch instead. Normally JsSIP's dialog/
  // transaction layer does this automatically; since this request bypassed
  // that layer entirely, it doesn't know to. Resolves once ACKed, rejected,
  // or after a bounded timeout (so a far end that never responds — e.g. the
  // call already ended — can't jam every future re-INVITE forever).
  _waitForReinviteAck(branch, dialog, routeSet) {
    const REINVITE_ACK_TIMEOUT_MS = 4000;
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        if (this._reinviteAckWatcher?.branch === branch) this._reinviteAckWatcher = null;
        this._pendingReinviteAck = null;
        clearTimeout(timer);
        resolve();
      };
      // is2xx picks which flavor of ACK to build: a 2xx gets a fresh branch
      // and the dialog's Route set; a non-2xx reuses the INVITE's own
      // branch and no Route set (it's not dialog-routed).
      const sendAck = (is2xx) => {
        try {
          const ackMsg = this._buildSipMessage('ACK', dialog, {
            cseqOffset: 0,
            branch: is2xx ? null : branch,
            extraHeaders: is2xx ? routeSet : [],
          });
          this.ua?._transport?.socket?.send(ackMsg);
        } catch (e) { this._log('warn', `Failed to ACK raw re-INVITE response: ${e.message}`); }
      };

      timer = setTimeout(() => {
        this._log('warn', `No response to raw re-INVITE (branch=${branch}) after ${REINVITE_ACK_TIMEOUT_MS}ms — giving up`);
        finish();
      }, REINVITE_ACK_TIMEOUT_MS);

      this._reinviteAckWatcher = {
        branch,
        onResponse: (status) => {
          if (status < 200) return; // provisional — keep waiting
          if (status < 300) {
            sendAck(true);
            this._log('info', `Sent ACK for raw re-INVITE 2xx (branch=${branch})`);
          } else {
            sendAck(false);
            this._log('warn', `Raw re-INVITE rejected (status=${status}, branch=${branch})`);
          }
          finish();
        },
      };
    });
  }

  // ── Send raw re-INVITE via WebSocket ──────────────────────────────────────
  // Writes SIP directly to the transport WebSocket without touching any
  // JsSIP session or RTCPeerConnection methods.
  async _sendRawReInvite(hold) {
    // Wait out any previous raw re-INVITE that hasn't been ACKed yet before
    // sending a new one. RFC 3261 forbids a new in-dialog request while the
    // previous INVITE transaction on the same dialog is still open, and
    // Asterisk enforces it: without this, a resume shortly after a hold
    // (or vice versa) gets rejected with 500 "Another INVITE transaction in
    // progress" — the previous one was never actually completed, because
    // nothing had ever sent it an ACK (see _waitForReinviteAck).
    if (this._pendingReinviteAck) await this._pendingReinviteAck;

    const localIp = this.activeCall?.localIp || getLocalIp();
    const rtpPort = this.activeCall?.localRtpPort || 0;
    // Reuse the same SRTP key across hold/resume — same RtpBridge/crypto
    // context throughout, only a=sendonly/a=sendrecv changes.
    const sdp     = buildSdp(localIp, rtpPort, { hold, srtp: this.activeCall?.localSrtp || null });

    const dialog = this.session?._dialog;
    if (!dialog) throw new Error('No SIP dialog');

    const transport = this.ua?._transport;
    if (!transport || !transport.socket) throw new Error('No transport');

    const routeSet = (dialog.route_set || []).map(r => `Route: ${r}`).filter(Boolean);
    const { cseq } = this._dialogFields(dialog, 1);
    const branch = `z9hG4bK${Math.random().toString(36).slice(2)}`;
    const msg = this._buildSipMessage('INVITE', dialog, {
      cseqOffset: 1,
      branch,
      extraHeaders: [
        `Contact: <sip:${this.config.username}@${localIp}>`,
        ...routeSet,
        `Content-Type: application/sdp`,
      ],
      body: sdp,
    });

    // transport.socket is always the exact object passed to `sockets:[...]`
    // (WsSocketInterface, UdpSocketInterface or TcpSocketInterface) — its
    // send() return value tells us whether the transport is actually open,
    // for all of them alike.
    if (!transport.socket.send(msg)) throw new Error('Transport not open');

    // Write the CSeq we just used back onto the dialog. JsSIP's own
    // Dialog._createRequest() (used by session.terminate() for the real
    // BYE, session.refer(), etc.) computes its next CSeq as
    // `dialog.local_seqnum += 1` — since this raw re-INVITE bypasses that
    // entirely, JsSIP has no idea a CSeq was just consumed. Without this,
    // the next JsSIP-issued request recomputes the exact same number this
    // re-INVITE already used, and the far end/PBX can silently drop it as
    // a duplicate/out-of-order transaction (e.g. a BYE right after a
    // hold/resume never reaching the other side).
    dialog.local_seqnum = cseq;
    this._log('info', `Sent raw re-INVITE (hold=${hold}, cseq=${cseq})`);

    this._pendingReinviteAck = this._waitForReinviteAck(branch, dialog, routeSet);
    await this._pendingReinviteAck;
  }


  // Places an outgoing call for a secondary leg — an attended-transfer
  // target or a conference third party — never the primary call. Marks
  // this._nextSessionRole = 'secondary' immediately before ua.call() so
  // _handleNewSession knows not to apply primary-call side effects to it
  // (see that field's comment for why this can't just be inferred from the
  // session object). The caller wires its own 'confirmed'/'ended'/'failed'
  // handlers — this only builds the SDP, places the call, and injects the
  // SDP into the outgoing INVITE, the part both callers do identically.
  _placeSecondaryLeg(targetUri) {
    const localIp   = getLocalIp();
    const rtpPort   = allocateRtpPort();
    const localSrtp = this.secureMediaEnabled ? srtp.generateMasterKeySalt() : null;
    const sdp       = buildSdp(localIp, rtpPort, { srtp: localSrtp });
    this._nextSessionRole = 'secondary';
    const session = this.ua.call(targetUri, { mediaConstraints: { audio: false, video: false } });
    session.on('sending', (e) => { if (e.request) e.request.body = sdp; });
    return { session, localIp, rtpPort, localSrtp };
  }

  // ── Blind transfer ────────────────────────────────────────────────────────
  // Sends a REFER to the current call, telling the remote party to call
  // target. Per RFC 5589, the far end (Asterisk here) reports the
  // transfer's outcome back via NOTIFY on the REFER subscription — it does
  // NOT reliably also send a BYE to end the transferor's own leg once that
  // succeeds. Confirmed via a real call against this project's own CI
  // Asterisk config (plain Dial(), no explicit bridge/transfer feature):
  // the REFER-To target rang and answered correctly (visible in the NOTIFY
  // sipfrags — 100 Trying, 180 Ringing, final 200 OK), but no BYE ever
  // arrived — this.session stayed "connected" indefinitely. A well-behaved
  // transferor is expected to end its own leg once it learns the transfer
  // succeeded, rather than assume the PBX will do it — so that's done here
  // explicitly via the REFER subscriber's 'accepted' event, instead of
  // relying on a BYE that may never come.
  blindTransfer(target) {
    return new Promise((resolve, reject) => {
      if (!this.session || !this.session.isEstablished()) return reject(new Error('No active call'));
      const targetUri = this._normalizeUri(target);
      this._log('info', `Blind transfer -> ${targetUri}`);
      try {
        const referSubscriber = this.session.refer(targetUri);
        this._log('info', 'REFER sent');
        referSubscriber.on('accepted', () => {
          this._log('info', 'Transfer confirmed by REFER-To target — ending local leg');
          try { this.session?.terminate(); } catch (e) { /* already ending */ }
        });
        referSubscriber.on('failed', (e) => {
          this._log('warn', `Blind transfer failed per NOTIFY (status=${e?.status_line?.status_code})`);
        });
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
      const targetUri = this._normalizeUri(target);

      this._log('info', `Attended transfer: calling ${targetUri}`);

      try {
        const { session: xferSession } = this._placeSecondaryLeg(targetUri);

        xferSession.on('confirmed', () => {
          this._log('info', 'Transfer target answered — completing attended transfer');
          try {
            // REFER first session to second session
            const referSubscriber = this.session.refer(targetUri, { replaces: xferSession });
            this._log('info', 'REFER with Replaces sent');
            // Same reasoning as blindTransfer(): don't assume the PBX will
            // send a BYE to end either of this endpoint's own legs once the
            // transfer completes — end both explicitly once the REFER
            // subscription reports success. (Confirmed via real-call
            // testing: Asterisk left both PJSIP channels stuck "Up" with
            // this project's plain-Dial() CI dialplan.)
            referSubscriber.on('accepted', () => {
              this._log('info', 'Attended transfer confirmed by REFER-To target — ending both local legs');
              try { this.session?.terminate(); } catch (e) { /* already ending */ }
              try { xferSession.terminate(); } catch (e) { /* already ending */ }
            });
            referSubscriber.on('failed', (e) => {
              this._log('warn', `Attended transfer failed per NOTIFY (status=${e?.status_line?.status_code})`);
            });
            this.confSession = null;
            resolve({ target: targetUri });
          } catch (e) {
            this._log('error', `REFER failed: ${e.message}`);
            reject(e);
          }
        });

        xferSession.on('failed', (e) => {
          this._log('error', `Transfer leg failed: ${e.cause}`);
          this.confSession = null;
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

      const targetUri = this._normalizeUri(target);

      this._log('info', `Conferencing in: ${targetUri}`);

      try {
        const { session: confSession, rtpPort, localSrtp } = this._placeSecondaryLeg(targetUri);

        confSession.on('confirmed', () => {
          this._log('info', 'Conference leg connected');
          const remoteSdp = this._getRemoteSdp(confSession);
          if (remoteSdp) {
            const remote = parseRemoteSdp(remoteSdp);
            if (remote) {
              this._log('info', `Conference RTP: remote=${remote.ip}:${remote.port}`);
              if (localSrtp && !remote.remoteCrypto) {
                this._log('warn', 'Conference leg: offered SRTP but remote answer had no compatible crypto');
              }
              const srtpOpts = (localSrtp && remote.remoteCrypto) ? { localSrtp, remoteSrtp: remote.remoteCrypto } : null;
              this.confBridge = new RtpBridge(rtpPort, remote.ip, remote.port, this.activeCall?.callId, this.noiseSuppressionEnabled, srtpOpts, remote.negotiatedCodec, remote.remoteOpusPt);
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
  // `filePath` names the canonical (.g722) upload — if the active call
  // actually negotiated Opus, transparently play its .opusraw sibling
  // instead (both are produced from the same upload, see
  // POST /api/wavfiles/upload), falling back to the requested file if that
  // sibling doesn't exist (e.g. an upload made before Opus support existed).
  playWav(filePath) {
    return new Promise((resolve, reject) => {
      if (!this.rtpBridge) return reject(new Error('No active RTP bridge'));
      if ((this.rtpBridge.stats.codec || this.rtpBridge._negotiatedCodec || '').includes('Opus')) {
        const opusPath = filePath.replace(/\.(g722|opusraw)$/i, '') + '.opusraw';
        if (fs.existsSync(opusPath)) filePath = opusPath;
      }
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
