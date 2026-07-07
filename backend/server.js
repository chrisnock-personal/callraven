const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const sipManager        = require('./sipManager');
const callHistory       = require('./callHistory');
const captureManager    = require('./captureManager');
const transcribeManager = require('./transcribeManager');
const { LiveTranscriber, WINDOW_MS } = require('./liveTranscribe');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/captures', express.static(path.join(__dirname, '../captures')));

// WAV uploads dir
const WAV_DIR = path.join(__dirname, '../wavfiles');
if (!fs.existsSync(WAV_DIR)) fs.mkdirSync(WAV_DIR, { recursive: true });
app.use('/wavfiles', express.static(WAV_DIR));

const storage = multer.diskStorage({
  destination: WAV_DIR,
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  cb(null, file.mimetype === 'audio/wav' || file.originalname.endsWith('.wav'));
}});

// ─── WebSocket hub ────────────────────────────────────────────────────────────
const clients           = new Set();
const transcriptClients = new Set();

// Fan-out dispatch for onAudio — supports multiple consumers (browser relay + live transcriber)
const audioListeners = new Set();
function dispatchAudio(pt, pcm16) {
  for (const fn of audioListeners) fn(pt, pcm16);
}
function addAudioListener(fn) {
  audioListeners.add(fn);
  if (sipManager.rtpBridge) sipManager.rtpBridge.onAudio = dispatchAudio;
}
function removeAudioListener(fn) {
  audioListeners.delete(fn);
  if (audioListeners.size === 0 && sipManager.rtpBridge)
    sipManager.rtpBridge.onAudio = null;
}

function broadcastTranscript(text) {
  const msg = JSON.stringify({ type: 'transcript', text, ts: Date.now() });
  for (const ws of transcriptClients)
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  broadcast('transcriptChunk', { text, ts: Date.now() });
}

wss.on('connection', (ws, req) => {
  const url = req.url || '/';

  // ── Audio relay WebSocket (/audio) ──────────────────────────────────────────
  if (url === '/audio') {
    let active = true;
    ws.binaryType = 'arraybuffer';

    const relay = (pt, pcm16) => {
      if (!active || ws.readyState !== WebSocket.OPEN) return;
      try {
        // Frame: [pt:1][sampleRate:4 LE][pcm16...]
        const sampleRate = (pt === 9) ? 16000 : 8000;
        const buf = Buffer.alloc(5 + pcm16.length);
        buf[0] = pt;
        buf.writeUInt32LE(sampleRate, 1);
        pcm16.copy(buf, 5);
        ws.send(buf);
      } catch(e) {}
    };

    addAudioListener(relay);
    ws.on('close', () => { active = false; removeAudioListener(relay); });
    return;
  }

  // ── Live transcript WebSocket (/transcript) ───────────────────────────────
  if (url === '/transcript') {
    transcriptClients.add(ws);
    ws.send(JSON.stringify({
      type:      'connected',
      whisper:   transcribeManager.isWhisperAvailable(),
      windowMs:  WINDOW_MS,
    }));
    ws.on('close', () => transcriptClients.delete(ws));
    return;
  }

  // ── Control WebSocket (/) ───────────────────────────────────────────────────
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'state', data: sipManager.getState() }));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients)
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

// ─── SIP event → WebSocket ────────────────────────────────────────────────────
sipManager.on('registered',        (d) => broadcast('registered', d));
sipManager.on('unregistered',      (d) => broadcast('unregistered', d));
sipManager.on('registrationFailed',(d) => broadcast('registrationFailed', d));
sipManager.on('incomingCall',      (d) => broadcast('incomingCall', d));
let liveTranscriber   = null;
let liveTranscriberFn = null;

sipManager.on('callConnected', (d) => {
  broadcast('callConnected', d);
  // Attach audio dispatcher to new bridge
  if (sipManager.rtpBridge) sipManager.rtpBridge.onAudio = dispatchAudio;
  // Start live transcription if whisper is available
  if (!transcribeManager.isWhisperAvailable()) return;
  if (liveTranscriber) liveTranscriber.stop();
  liveTranscriber   = new LiveTranscriber();
  liveTranscriberFn = (pt, raw) => liveTranscriber.write(pt, raw);
  liveTranscriber.on('text', broadcastTranscript);
  // Use onRawAudio so G.722 is decoded by ffmpeg at flush, not the stub decoder
  if (sipManager.rtpBridge) {
    sipManager.rtpBridge.onRawAudio         = liveTranscriberFn;
    sipManager.rtpBridge.onRawOutboundAudio = (pt, raw) => liveTranscriber.writeOutbound(pt, raw);
  }
  liveTranscriber.start();
});
sipManager.on('callFailed',        (d) => broadcast('callFailed', d));
sipManager.on('log',               (d) => broadcast('log', d));
sipManager.on('conferenceStarted', (d) => broadcast('conferenceStarted', d));
sipManager.on('conferenceEnded',   (d) => broadcast('conferenceEnded', d));
sipManager.on('playbackEnded',     (d) => broadcast('playbackEnded', d));

sipManager.on('callEnded', (data) => {
  broadcast('callEnded', data);
  if (liveTranscriber)   { liveTranscriber.stop(); liveTranscriber = null; }
  liveTranscriberFn = null;
  if (sipManager.rtpBridge) sipManager.rtpBridge.onRawOutboundAudio = null;
  // Capture is stopped explicitly in /api/hangup for local hangups.
  // For remote hangups (far end sends BYE), stop it here after a small
  // delay so any final SIP messages (remote BYE) have time to be written.
  if (data.callId) {
    setTimeout(() => captureManager.stopCapture(data.callId), 100);
  }
});

sipManager.on('callHeld',          (d) => broadcast('callHeld', d));
sipManager.on('callResumed',       (d) => broadcast('callResumed', d));
sipManager.on('keepalive',         (d) => broadcast('keepalive', d));
sipManager.on('ipChanged',         (d) => broadcast('ipChanged', d));
sipManager.on('recordingStarted',  (d) => broadcast('recordingStarted', d));
sipManager.on('recordingStopped',  (d) => broadcast('recordingStopped', d));
sipManager.on('callMissed',        (d) => broadcast('callMissed', d));
sipManager.on('remoteHold',        (d) => broadcast('remoteHold', d));
sipManager.on('remoteHoldReleased',(d) => broadcast('remoteHoldReleased', d));
sipManager.on('wsDisconnected',    (d) => broadcast('wsDisconnected', d));
sipManager.on('wsConnected',       (d) => broadcast('wsConnected', d));

captureManager.on('captureReady', (data) => {
  broadcast('captureReady', data);
  if (data.callId) callHistory.endCall(data.callId, { captureFile: data.url });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => res.json(sipManager.getState()));

app.get('/api/transcript/status', (req, res) => res.json({
  whisperAvailable: transcribeManager.isWhisperAvailable(),
  active:           !!liveTranscriber,
  windowMs:         WINDOW_MS,
  clients:          transcriptClients.size,
}));

app.post('/api/register', async (req, res) => {
  const { server, port, username, password, displayName, transport, wsPort, wsPath } = req.body;
  if (!server || !username || !password)
    return res.status(400).json({ error: 'server, username, and password are required' });
  try {
    const result = await sipManager.register({
      server, username, password,
      port: port || 5060, wsPort: wsPort || 8088, wsPath: wsPath || '/ws',
      displayName: displayName || username, transport: transport || 'UDP'
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/unregister', async (req, res) => {
  try { await sipManager.unregister(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/call', async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: 'target is required' });
  const state = sipManager.getState();
  if (!state.registered) return res.status(409).json({ error: 'Not registered' });
  if (state.activeCall)  return res.status(409).json({ error: 'Call already active' });
  try {
    const callId = uuidv4();
    captureManager.startCapture(callId);
    const result = await sipManager.makeCall(target, callId);
    res.json({ success: true, callId, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/answer', async (req, res) => {
  const state = sipManager.getState();
  if (!state.incomingCall) return res.status(409).json({ error: 'No incoming call' });
  try {
    const callId = uuidv4();
    captureManager.startCapture(callId);
    const result = await sipManager.answerCall(callId);
    res.json({ success: true, callId, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hangup', async (req, res) => {
  const state = sipManager.getState();
  if (!state.activeCall) return res.status(409).json({ error: 'No active call' });
  const callId = state.activeCall.callId;
  try {
    await sipManager.hangup();
    // Capture is stopped via callEnded event (with delay for final SIP messages)
    // Wait briefly then get the filename for the response
    await new Promise(r => setTimeout(r, 150));
    const writer = captureManager.getWriter ? captureManager.getWriter(callId) : null;
    // If still open (callEnded delay hasn't fired yet), stop it now
    const captureFile = captureManager.stopCapture(callId) ||
                        path.join(__dirname, '../captures',
                          `call_${new Date().toISOString().replace(/[:.]/g, '-')}_${callId.slice(0,8)}.pcap`);
    res.json({ success: true, captureFile: captureFile ? `/captures/${path.basename(String(captureFile))}` : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reject', async (req, res) => {
  try { await sipManager.rejectCall(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dtmf', async (req, res) => {
  const { digit } = req.body;
  if (!digit) return res.status(400).json({ error: 'digit is required' });
  try { await sipManager.sendDTMF(digit); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Transfer ──────────────────────────────────────────────────────────────────

/** POST /api/transfer/blind  { target } */
app.post('/api/transfer/blind', async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: 'target is required' });
  try { const result = await sipManager.blindTransfer(target); res.json({ success: true, ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/transfer/attended  { target } */
app.post('/api/transfer/attended', async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: 'target is required' });
  try { const result = await sipManager.attendedTransfer(target); res.json({ success: true, ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Conference ────────────────────────────────────────────────────────────────

/** POST /api/conference  { target } */
app.post('/api/conference', async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: 'target is required' });
  try { const result = await sipManager.conference(target); res.json({ success: true, ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/conference/end */
app.post('/api/conference/end', async (req, res) => {
  try { await sipManager.endConference(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WAV playback ──────────────────────────────────────────────────────────────

/** GET /api/wavfiles — list uploaded WAV files */
app.get('/api/wavfiles', (req, res) => {
  try {
    const files = fs.readdirSync(WAV_DIR)
      .filter(f => f.endsWith('.wav') || f.endsWith('.g722'))
      .map(f => {
        const stat = fs.statSync(path.join(WAV_DIR, f));
        return { filename: f, url: `/wavfiles/${f}`, size: stat.size };
      });
    res.json({ files });
  } catch { res.json({ files: [] }); }
});

/** POST /api/wavfiles/upload — upload and convert WAV to raw G.722 */
app.post('/api/wavfiles/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const inPath  = req.file.path;
  // Output as raw G.722 bitstream — no container, just bytes
  const outName = req.file.filename.replace(/\.wav$/i, '') + '.g722';
  const outPath = path.join(WAV_DIR, outName);

  try {
    // ffmpeg converts to raw G.722 at 16kHz mono
    // G.722 in SIP uses RTP clock 8000 but actual audio is 16kHz
    await execFileAsync('ffmpeg', [
      '-y',           // overwrite output
      '-i', inPath,   // input file
      '-ar', '16000', // resample to 16kHz (G.722 audio rate)
      '-ac', '1',     // mono
      '-c:a', 'g722', // G.722 ADPCM codec
      '-f', 'g722',   // raw G.722 bitstream output (no container)
      outPath
    ]);

    fs.unlinkSync(inPath);
    const stat = fs.statSync(outPath);
    console.log(`[WAV] Converted to G.722: ${outName} (${stat.size} bytes)`);
    res.json({ success: true, filename: outName, url: `/wavfiles/${outName}` });
  } catch (err) {
    console.error(`[WAV] ffmpeg error: ${err.message}`);
    res.status(500).json({ error: `Conversion failed: ${err.message}` });
  }
});

/** DELETE /api/wavfiles/:filename */
app.delete('/api/wavfiles/:filename', (req, res) => {
  const filePath = path.join(WAV_DIR, path.basename(req.params.filename));
  try {
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); res.json({ success: true }); }
    else res.status(404).json({ error: 'File not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/play  { filename } */
app.post('/api/play', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required' });
  const filePath = path.join(WAV_DIR, path.basename(filename));
  try { const result = await sipManager.playWav(filePath); res.json({ success: true, ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/play/stop */
app.post('/api/play/stop', async (req, res) => {
  try { await sipManager.stopWav(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Captures ──────────────────────────────────────────────────────────────────

app.get('/api/captures', (req, res) => {
  try {
    const captureDir = path.join(__dirname, '../captures');
    const allFiles = fs.readdirSync(captureDir);

    // Group pcap and audio files by call ID prefix
    const pcapFiles = allFiles
      .filter(f => f.endsWith('.pcap') || f.endsWith('.pcapng'))
      .map(f => {
        const stat = fs.statSync(path.join(captureDir, f));
        // Find matching on-demand recording (rec_ file with same call ID prefix)
        const prefix = f.match(/call_[^_]+_([a-f0-9]+)/)?.[1];
        const audio  = prefix
          ? allFiles.find(a => a.startsWith(`rec_${prefix}`) && a.endsWith('.wav'))
          : null;
        return {
          filename:    f,
          url:         `/captures/${f}`,
          size:        stat.size,
          created:     stat.birthtime,
          audioFile:   audio || null,
          audioUrl:    audio ? `/captures/${audio}` : null
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ captures: pcapFiles });
  } catch { res.json({ captures: [] }); }
});

app.delete('/api/captures/:filename', (req, res) => {
  const filePath = path.join(__dirname, '../captures', path.basename(req.params.filename));
  try {
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); res.json({ success: true }); }
    else res.status(404).json({ error: 'File not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hold / Resume ─────────────────────────────────────────────────────────────

/** POST /api/hold */
app.post('/api/hold', async (req, res) => {
  try { const r = await sipManager.hold(); res.json({ success: true, ...r }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/resume */
app.post('/api/resume', async (req, res) => {
  try { const r = await sipManager.resume(); res.json({ success: true, ...r }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Call History ──────────────────────────────────────────────────────────────

/** GET /api/history — full call history with capture info joined by callId */
app.get('/api/history', (req, res) => {
  try {
    const history = callHistory.getAll();
    const captureDir = path.join(__dirname, '../captures');
    const allFiles = fs.readdirSync(captureDir);
    // Enrich each history entry with capture/audio/transcript availability
    const enriched = history.map(h => {
      const id = h.callId ? h.callId.slice(0, 8) : null;
      const pcap  = id ? allFiles.find(f => f.includes(id) && (f.endsWith('.pcap') || f.endsWith('.pcapng'))) : null;
      const audio = id ? allFiles.find(f => f.startsWith('rec_' + id) && f.endsWith('.wav')) : null;
      const tsc   = id ? allFiles.find(f => f.startsWith('rec_' + id) && f.endsWith('.json')) : null;
      return {
        ...h,
        captureFile:   pcap  ? `/captures/${pcap}`  : (h.captureFile || null),
        audioFile:     audio || null,
        audioUrl:      audio ? `/captures/${audio}` : null,
        transcriptFile: tsc  || null,
      };
    });
    res.json({ history: enriched });
  } catch (err) { res.json({ history: callHistory.getAll() }); }
});

/** GET /api/history/export — download as CSV */
app.get('/api/history/export', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="call_history_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(callHistory.toCsv());
});

/** DELETE /api/history — clear all history */
app.delete('/api/history', (req, res) => {
  callHistory.clear();
  res.json({ success: true });
});

/** DELETE /api/history/:callId — delete single call entry + its files */
app.delete('/api/history/:callId', (req, res) => {
  const { callId } = req.params;
  const captureDir = path.join(__dirname, '../captures');
  const allFiles   = fs.readdirSync(captureDir);
  const id         = callId.slice(0, 8);
  // Delete pcap, wav recording, and transcript
  allFiles.filter(f => f.includes(id)).forEach(f => {
    try { fs.unlinkSync(path.join(captureDir, f)); } catch(e) {}
  });
  callHistory.deleteEntry(callId);
  res.json({ success: true });
});

/** DELETE /api/history/:callId/capture — delete only pcap + wav, keep history entry */
app.delete('/api/history/:callId/capture', (req, res) => {
  const id = req.params.callId.slice(0, 8);
  const captureDir = path.join(__dirname, '../captures');
  fs.readdirSync(captureDir)
    .filter(f => f.includes(id) && (f.endsWith('.pcap') || f.endsWith('.wav')))
    .forEach(f => { try { fs.unlinkSync(path.join(captureDir, f)); } catch(e) {} });
  res.json({ success: true });
});

/** DELETE /api/history/:callId/transcript — delete only transcript json */
app.delete('/api/history/:callId/transcript', (req, res) => {
  const id = req.params.callId.slice(0, 8);
  const captureDir = path.join(__dirname, '../captures');
  fs.readdirSync(captureDir)
    .filter(f => f.startsWith('rec_' + id) && f.endsWith('.json'))
    .forEach(f => { try { fs.unlinkSync(path.join(captureDir, f)); } catch(e) {} });
  res.json({ success: true });
});

/** GET /api/log/export — download system log as text file */
app.get('/api/log/export', (req, res) => {
  const state = sipManager.getState();
  const logs  = state.logs || [];
  const lines = logs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="sip_log_${new Date().toISOString().slice(0,10)}.txt"`);
  res.send(lines);
});

// ── RTP Stats ────────────────────────────────────────────────────────────────

/** GET /api/stats — live RTP stats for the active call */
app.get('/api/stats', (req, res) => {
  const stats = sipManager.getRtpStats();
  if (!stats) return res.status(409).json({ error: 'No active call' });
  res.json(stats);
});

// ── Recording toggle ──────────────────────────────────────────────────────────

/** POST /api/record/start */
app.post('/api/record/start', async (req, res) => {
  try { const r = await sipManager.startRecording(); res.json({ success: true, ...r }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/record/stop */
app.post('/api/record/stop', async (req, res) => {
  try { const r = await sipManager.stopRecording(); res.json({ success: true, ...r }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Transcription ────────────────────────────────────────────────────────────

/** GET /api/transcripts */
app.get('/api/transcripts', (req, res) => {
  res.json({ transcripts: transcribeManager.listTranscripts() });
});

/** POST /api/transcribe/:filename  — optional body: { txFile: "rec_..._tx.wav" } */
app.post('/api/transcribe/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!filename.startsWith('rec_') || !filename.endsWith('.wav'))
    return res.status(400).json({ error: 'Only rec_*.wav recordings can be transcribed' });
  if (!transcribeManager.isWhisperAvailable())
    return res.status(503).json({ error: 'Whisper not available — rebuild image with Whisper support' });
  // Auto-detect paired tx file if not provided (rx file naming: rec_id_ts_rx.wav → rec_id_ts_tx.wav)
  const txFile = req.body?.txFile || filename.replace(/_rx\.wav$/i, '_tx.wav');
  try {
    const result = await transcribeManager.startTranscription(filename, txFile !== filename ? txFile : null);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/transcribe/:filename/status */
app.get('/api/transcribe/:filename/status', (req, res) => {
  const job = transcribeManager.getJobStatus(req.params.filename);
  if (!job) return res.status(404).json({ error: 'No job found' });
  res.json(job);
});

/** DELETE /api/transcripts/:filename */
app.delete('/api/transcripts/:filename', (req, res) => {
  try {
    // Accept both rec_xxx.json and rec_xxx.wav
    const jsonName = req.params.filename.replace(/\.wav$/i, '.json');
    transcribeManager.deleteTranscript(jsonName);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/transcripts/:filename/text — download as plain text */
app.get('/api/transcripts/:filename/text', (req, res) => {
  // Accept both rec_xxx.json and rec_xxx.wav as the filename param
  const jsonName = req.params.filename.replace(/\.wav$/i, '.json');
  const p = path.join('/captures', jsonName);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found: ' + jsonName });
  try {
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    const lines = (t.segments || []).map(s =>
      '[' + transcribeManager.fmtTime(s.startSec) + '] ' + s.text.trim()
    ).join('\n') || t.text || '';
    const txtName = jsonName.replace(/\.json$/i, '.txt');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + txtName + '"');
    res.send(lines);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SIP Endpoint running on port ${PORT}`));

module.exports = { app, broadcast };
