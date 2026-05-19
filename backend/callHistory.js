/**
 * callHistory.js
 * Persistent call history stored as JSON on disk.
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../captures/call_history.json');
const MAX_ENTRIES  = 500;

function load() {
  try {
    if (fs.existsSync(HISTORY_FILE))
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) { console.error('[HISTORY] Load error:', e.message); }
  return [];
}

function save(entries) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2)); }
  catch (e) { console.error('[HISTORY] Save error:', e.message); }
}

let entries = load();

module.exports = {
  addCall({ callId, direction, target, from, to, displayName }) {
    const entry = {
      callId,
      direction,
      target:       target || from,
      from:         from   || null,
      to:           to     || null,
      displayName:  displayName || target || from || 'Unknown',
      startTime:    new Date().toISOString(),
      endTime:      null,
      duration:     null,
      status:       'active',
      captureFile:  null,
      // RTP stats — populated on endCall
      codec:        null,
      rxPackets:    null,
      txPackets:    null,
      jitterMs:     null,
      packetLoss:   null,
      cause:        null,
    };
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
    save(entries);
    return entry;
  },

  endCall(callId, { status = 'completed', captureFile = null, stats = null, cause = null } = {}) {
    const entry = entries.find(e => e.callId === callId);
    if (!entry) return;
    entry.endTime     = new Date().toISOString();
    entry.status      = status;
    entry.captureFile = captureFile;
    entry.cause       = cause || null;
    if (entry.startTime) {
      const ms = new Date(entry.endTime) - new Date(entry.startTime);
      entry.duration = Math.round(ms / 1000);
    }
    if (stats) {
      entry.codec      = stats.codec      || null;
      entry.rxPackets  = stats.rxPackets  || 0;
      entry.txPackets  = stats.txPackets  || 0;
      entry.jitterMs   = stats.jitterMs   || 0;
      entry.packetLoss = stats.lossPercent !== undefined ? stats.lossPercent : null;
    }
    save(entries);
    return entry;
  },

  missCall(callId) {
    return module.exports.endCall(callId, { status: 'missed' });
  },

  failCall(callId, { cause = null } = {}) {
    return module.exports.endCall(callId, { status: 'failed', cause });
  },

  deleteEntry(callId) {
    entries = entries.filter(e => e.callId !== callId);
    save(entries);
  },

  getAll()  { return entries; },
  clear()   { entries = []; save(entries); },

  toCsv() {
    const header = 'Call ID,Direction,Target,From,To,Display Name,Start Time,End Time,Duration (s),Status,Codec,RX Pkts,TX Pkts,Jitter (ms),Loss (%),Capture File';
    const rows   = entries.map(e => [
      e.callId, e.direction, e.target, e.from || '', e.to || '', e.displayName,
      e.startTime, e.endTime || '', e.duration || '',
      e.status, e.codec || '', e.rxPackets || '', e.txPackets || '',
      e.jitterMs || '', e.packetLoss || '', e.captureFile || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    return [header, ...rows].join('\n');
  }
};
