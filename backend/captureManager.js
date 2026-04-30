/**
 * captureManager.js
 *
 * Pure Node.js packet capture — no tcpdump, no raw sockets, no special
 * permissions required.
 *
 * Strategy:
 *   We already have all the packets flowing through the app:
 *     - SIP messages are sent/received by JsSIP over WebSocket
 *     - RTP packets flow through our RtpBridge dgram sockets
 *
 *   This module writes those packets directly to a valid .pcap file
 *   (libpcap format, openable in Wireshark) by hooking into:
 *     1. sipManager events  → captures SIP signalling as UDP packets
 *     2. RtpBridge traffic  → captures RTP media packets
 *
 *   The pcap file uses link type 228 (Raw IPv4) so we don't need to
 *   fake Ethernet headers — just IP + UDP + payload.
 *
 * pcap file format:
 *   Global header (24 bytes)
 *   Per-packet: record header (16 bytes) + packet data
 */

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events');
const os           = require('os');

const CAPTURE_DIR = path.join(__dirname, '../captures');

if (!fs.existsSync(CAPTURE_DIR)) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
}

// ─── pcap format constants ────────────────────────────────────────────────────
const PCAP_MAGIC        = 0xa1b2c3d4;  // little-endian, microsecond timestamps
const PCAP_VERSION_MAJ  = 2;
const PCAP_VERSION_MIN  = 4;
const PCAP_LINKTYPE_RAW = 228;         // Raw IPv4 — no Ethernet header needed
const PCAP_SNAPLEN      = 65535;

// ─── IP/UDP header builder ────────────────────────────────────────────────────
function buildUdpPacket(srcIp, srcPort, dstIp, dstPort, payload) {
  const payloadBuf  = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const udpLen      = 8 + payloadBuf.length;
  const ipLen       = 20 + udpLen;
  const buf         = Buffer.alloc(ipLen);

  // IPv4 header (20 bytes)
  buf[0]  = 0x45;                          // version=4, IHL=5
  buf[1]  = 0x00;                          // DSCP/ECN
  buf.writeUInt16BE(ipLen, 2);             // total length
  buf.writeUInt16BE(0x1234, 4);            // identification
  buf.writeUInt16BE(0x4000, 6);            // flags: don't fragment
  buf[8]  = 64;                            // TTL
  buf[9]  = 17;                            // protocol: UDP
  buf.writeUInt16BE(0, 10);               // checksum (0 = unchecked, Wireshark handles it)

  // Source and dest IPs
  const srcParts = srcIp.split('.').map(Number);
  const dstParts = dstIp.split('.').map(Number);
  buf[12] = srcParts[0]; buf[13] = srcParts[1];
  buf[14] = srcParts[2]; buf[15] = srcParts[3];
  buf[16] = dstParts[0]; buf[17] = dstParts[1];
  buf[18] = dstParts[2]; buf[19] = dstParts[3];

  // UDP header (8 bytes)
  buf.writeUInt16BE(srcPort, 20);
  buf.writeUInt16BE(dstPort, 22);
  buf.writeUInt16BE(udpLen, 24);
  buf.writeUInt16BE(0, 26);               // checksum (0 = disabled)

  // Payload
  payloadBuf.copy(buf, 28);

  return buf;
}

// ─── pcap record header (16 bytes) ───────────────────────────────────────────
function buildPcapRecordHeader(packetLen) {
  const now   = Date.now();
  const secs  = Math.floor(now / 1000);
  const usecs = (now % 1000) * 1000;
  const hdr   = Buffer.alloc(16);
  hdr.writeUInt32LE(secs,      0);
  hdr.writeUInt32LE(usecs,     4);
  hdr.writeUInt32LE(packetLen, 8);   // captured length
  hdr.writeUInt32LE(packetLen, 12);  // original length
  return hdr;
}

// ─── pcap global header (24 bytes) ───────────────────────────────────────────
function buildPcapGlobalHeader() {
  const hdr = Buffer.alloc(24);
  hdr.writeUInt32LE(PCAP_MAGIC,       0);
  hdr.writeUInt16LE(PCAP_VERSION_MAJ, 4);
  hdr.writeUInt16LE(PCAP_VERSION_MIN, 6);
  hdr.writeInt32LE(0,                 8);   // timezone offset
  hdr.writeUInt32LE(0,                12);  // timestamp accuracy
  hdr.writeUInt32LE(PCAP_SNAPLEN,     16);  // snap length
  hdr.writeUInt32LE(PCAP_LINKTYPE_RAW, 20); // link type: raw IP
  return hdr;
}

// ─── CaptureWriter — one per call ────────────────────────────────────────────
class CaptureWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.filename = path.basename(filePath);
    this.fd       = fs.openSync(filePath, 'w');
    this.count    = 0;

    // Write global header immediately
    const hdr = buildPcapGlobalHeader();
    fs.writeSync(this.fd, hdr);
  }

  writePacket(srcIp, srcPort, dstIp, dstPort, payload) {
    try {
      const pkt = buildUdpPacket(srcIp, srcPort, dstIp, dstPort, payload);
      const rec = buildPcapRecordHeader(pkt.length);
      fs.writeSync(this.fd, rec);
      fs.writeSync(this.fd, pkt);
      this.count++;
    } catch (e) {
      console.error(`[CAPTURE] writePacket error: ${e.message}`);
    }
  }

  close() {
    try { fs.closeSync(this.fd); } catch (e) {}
    const stat = fs.statSync(this.filePath);
    console.log(`[CAPTURE] Saved: ${this.filename} (${this.count} packets, ${stat.size} bytes)`);
    return stat.size;
  }
}

// ─── CaptureManager ──────────────────────────────────────────────────────────
class CaptureManager extends EventEmitter {
  constructor() {
    super();
    this.activeCaptures = new Map(); // callId -> CaptureWriter
  }

  /**
   * Start a new capture for a call.
   * Returns the CaptureWriter so sipManager/rtpBridge can feed packets into it.
   */
  startCapture(callId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename  = `call_${timestamp}_${callId.slice(0, 8)}.pcap`;
    const filePath  = path.join(CAPTURE_DIR, filename);

    console.log(`[CAPTURE] Starting pure-Node capture: ${filename}`);

    const writer = new CaptureWriter(filePath);
    this.activeCaptures.set(callId, writer);
    return writer;
  }

  /**
   * Write a SIP message into the capture (as a fake UDP packet).
   */
  writeSipMessage(callId, srcIp, srcPort, dstIp, dstPort, sipText) {
    const writer = this.activeCaptures.get(callId);
    if (!writer) return;
    writer.writePacket(srcIp, srcPort, dstIp, dstPort, Buffer.from(sipText, 'utf8'));
  }

  /**
   * Write an RTP packet into the capture.
   */
  writeRtpPacket(callId, srcIp, srcPort, dstIp, dstPort, rtpBuf) {
    const writer = this.activeCaptures.get(callId);
    if (!writer) return;
    writer.writePacket(srcIp, srcPort, dstIp, dstPort, rtpBuf);
  }

  /**
   * Stop capture, close file, emit captureReady.
   */
  stopCapture(callId) {
    const writer = this.activeCaptures.get(callId);
    if (!writer) {
      console.warn(`[CAPTURE] No active capture for ${callId}`);
      return null;
    }

    this.activeCaptures.delete(callId);
    const size = writer.close();

    this.emit('captureReady', {
      callId,
      filename: writer.filename,
      url:      `/captures/${writer.filename}`,
      size
    });

    return writer.filePath;
  }

  /**
   * Get the active writer for a call (used by RtpBridge).
   */
  getWriter(callId) {
    return this.activeCaptures.get(callId) || null;
  }

  listCaptures() {
    return fs.readdirSync(CAPTURE_DIR)
      .filter(f => f.endsWith('.pcap') || f.endsWith('.pcapng'))
      .map(f => {
        const stat = fs.statSync(path.join(CAPTURE_DIR, f));
        return { filename: f, size: stat.size, created: stat.birthtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  }
}

module.exports = new CaptureManager();
