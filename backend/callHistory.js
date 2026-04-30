/**
 * callHistory.js
 *
 * Persistent call history stored as JSON on disk.
 * Survives container restarts via the /captures volume.
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../captures/call_history.json');
const MAX_ENTRIES  = 500;

function load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[HISTORY] Load error:', e.message);
  }
  return [];
}

function save(entries) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error('[HISTORY] Save error:', e.message);
  }
}

let entries = load();

module.exports = {
  // Add a new call entry (called when call starts)
  addCall({ callId, direction, target, from, displayName }) {
    const entry = {
      callId,
      direction,               // inbound | outbound
      target:      target || from,
      displayName: displayName || target || from || 'Unknown',
      startTime:   new Date().toISOString(),
      endTime:     null,
      duration:    null,       // seconds
      status:      'active',   // active | completed | missed | failed
      captureFile: null
    };
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
    save(entries);
    return entry;
  },

  // Update an entry when the call ends
  endCall(callId, { status = 'completed', captureFile = null } = {}) {
    const entry = entries.find(e => e.callId === callId);
    if (!entry) return;
    entry.endTime     = new Date().toISOString();
    entry.status      = status;
    entry.captureFile = captureFile;
    if (entry.startTime) {
      const ms = new Date(entry.endTime) - new Date(entry.startTime);
      entry.duration = Math.round(ms / 1000);
    }
    save(entries);
    return entry;
  },

  // Mark a call as missed (incoming, never answered)
  missCall(callId) {
    return module.exports.endCall(callId, { status: 'missed' });
  },

  // Mark a call as failed
  failCall(callId) {
    return module.exports.endCall(callId, { status: 'failed' });
  },

  getAll()  { return entries; },
  clear()   { entries = []; save(entries); },

  // Export as CSV string
  toCsv() {
    const header = 'Call ID,Direction,Target,Display Name,Start Time,End Time,Duration (s),Status,Capture File';
    const rows   = entries.map(e => [
      e.callId, e.direction, e.target, e.displayName,
      e.startTime, e.endTime || '', e.duration || '',
      e.status, e.captureFile || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    return [header, ...rows].join('\n');
  }
};
