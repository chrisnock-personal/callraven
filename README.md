<p align="center"><img width="252" height="275" alt="Image" src="https://github.com/user-attachments/assets/0b4a14aa-f344-41f0-b744-44516543e04b" /></p>

# SIP Endpoint — Containerized Web Softphone

A fully containerized SIP softphone with a web UI, complete REST API for headless operation, per-call packet capture (INVITE/100/180/200/ACK/BYE + RTP), dual-channel (remote/local) call recording, WAV file playback into the RTP stream, live audio relay to the browser, on-demand call recording, and on-device Whisper transcription with speaker diarization — both live during a call and post-call on demand.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│              Docker / Podman Container (root, --privileged)      │
│                                                                    │
│  ┌───────────┐   ┌─────────────┐   ┌────────────────┐            │
│  │  Express  │   │ SipManager  │   │ CaptureManager  │            │
│  │  REST API │◄─►│ (JsSIP/WS,  │   │ (pure Node pcap)│            │
│  │  :3000    │   │  RTP bridge)│   └────────┬────────┘            │
│  └─────┬─────┘   └──────┬──────┘            │                     │
│        │                │            ┌───────▼────────┐           │
│        │                ├───────────►│  AudioDecoder   │           │
│        │                │            │ G.722/PCMU/PCMA │           │
│        │                │            │  → rx/tx WAV    │           │
│        │                │            └─────────────────┘           │
│        │                ├───────────►┌─────────────────┐           │
│        │                │            │ LiveTranscriber │           │
│        │                │            │ whisper-cli,    │           │
│        │                │            │ windowed (6s)   │           │
│        │                │            └─────────────────┘           │
│        │                └───────────►┌─────────────────┐           │
│        │                             │TranscribeManager│           │
│        │                             │ post-call jobs  │           │
│        │                             └─────────────────┘           │
│  ┌─────▼──────────────────────────┐                                │
│  │        WebSocket Server        │                                │
│  │  /            control events   │                                │
│  │  /audio       PCM audio relay  │                                │
│  │  /transcript  live whisper text│                                │
│  └────────────────┬────────────────┘                               │
│                    │                                                │
│  ┌─────────────────▼────────────────┐                              │
│  │    Frontend (Single-file HTML)   │                              │
│  │  Dark/light mode · Responsive    │                              │
│  └───────────────────────────────────┘                             │
└──────────────────────────────────────────────────────────────────┘
         │ SIP over WebSocket          │ UDP RTP
         ▼                             ▼
    SIP Proxy / PBX              RTP Media Stream
   (Asterisk, FreePBX,           (G.722, PCMU, PCMA)
    Kamailio, etc.)
```

**Key components:**

| File | Purpose |
|---|---|
| `backend/server.js` | Express HTTP/WS server, REST API endpoints, WebSocket hub (control/audio/transcript), audio + transcript fan-out |
| `backend/sipManager.js` | JsSIP UA, call state machine, RTP bridge, raw re-INVITE hold, WAV playback, keepalive, IP-change re-registration |
| `backend/captureManager.js` | Per-call `.pcap` writer (pure Node.js, no tcpdump) |
| `backend/audioDecoder.js` | G.722/PCMU/PCMA decoder, dual-channel (rx/tx) call WAV recorder |
| `backend/callHistory.js` | Persistent call history (JSON + CSV export) |
| `backend/transcribeManager.js` | Post-call Whisper transcription jobs on `rec_*.wav` recordings, with rx/tx diarization |
| `backend/liveTranscribe.js` | Real-time windowed Whisper transcription during an active call |
| `frontend/index.html` | Single-file softphone UI (Clarity theme) |
| `openapi.json` | OpenAPI 3.1 spec — import into Postman, Swagger, Redocly |
| `asterisk/` | Sample Asterisk config (`sip.conf`, `extensions.conf`, `http.conf`) for local testing |
| `sync.sh` | Rsync + podman-compose deploy helper for pushing local changes to a remote host |

---

## Screenshots
<img width="1335" height="1730" alt="Image" src="https://github.com/user-attachments/assets/9ef74ca0-d832-4d28-a445-fa0915b7ab70" /> <br>
<img width="1335" height="1730" alt="Image" src="https://github.com/user-attachments/assets/4a0a2073-a7c7-4cee-82e4-9370324a632b" /> <br>
<img width="309" height="230" alt="Image" src="https://github.com/user-attachments/assets/11bb850e-ec9c-40f4-a68c-8452edc965ad" /> <br>
<img width="309" height="230" alt="Image" src="https://github.com/user-attachments/assets/27afe985-fa58-4e1c-8a7a-00aec9c7f165" /> <br>
<img width="309" height="230" alt="Image" src="https://github.com/user-attachments/assets/9aff4d44-c056-4236-a9b6-8e117f2b6344" /> <br>

---

## Quick Start

### Docker / Podman Compose (recommended)

```bash
git clone <repo>
cd sip-endpoint
podman-compose up -d --build
```

Open **http://localhost:3000**

### Manual Docker run

```bash
docker build -t sip-endpoint .
docker run -d \
  --name sip-endpoint \
  --network host \
  --privileged \
  -v sip-captures:/captures \
  -v sip-wavfiles:/wavfiles \
  sip-endpoint
```

### docker-compose.yml

```yaml
version: "3.9"
services:
  sip-endpoint:
    build: .
    container_name: sip-endpoint
    network_mode: host
    user: root
    privileged: true
    security_opt:
      - label=disable
    volumes:
      - captures:/captures
    environment:
      PORT: 3000
      SIP_PORT: 5060
      RTP_PORT_LOW: 10000
      RTP_PORT_HIGH: 20000
volumes:
  captures:
    driver: local
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket server port |
| `SIP_PORT` | `5060` | Used only for the pcap BPF capture filter |
| `RTP_PORT_LOW` | `10000` | RTP UDP port pool start |
| `RTP_PORT_HIGH` | `20000` | RTP UDP port pool end |
| `CAPTURE_INTERFACE` | `any` | libpcap capture interface |
| `MEDIA_IP` | auto-detect | Override NIC selection for the SDP `c=` line |
| `TRANSCRIPT_WINDOW_MS` | `6000` | Live transcription flush interval (ms) |
| `TRANSCRIPT_PROMPT` | `"compliance monitoring recording quality"` | Whisper prompt string, biases the model toward telephony vocabulary |
| `NODE_ENV` | `production` | Node environment |

The container runs as **root** with `--privileged` and `--network host` — required for raw packet capture (pure Node.js libpcap writes, no tcpdump) and UDP socket binding.

---

## REST API Reference

All endpoints accept and return JSON unless stated otherwise. A full **OpenAPI 3.1 spec** is included at `openapi.json` — importable into Postman, Swagger Editor, and Redocly.

### Registration

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/status` | — | Full state: registration, active call, hold, conference, RTP stats |
| `POST` | `/api/register` | `{server, username, password, port?, wsPort?, wsPath?, displayName?, transport?}` | Register with SIP server |
| `POST` | `/api/unregister` | — | Unregister |

**Register example:**
```json
POST /api/register
{
  "server": "pbx.local",
  "username": "1001",
  "password": "secret",
  "wsPort": 8088,
  "displayName": "Alice"
}
```

### Calls

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/call` | `{target}` | Initiate outbound call. Starts pcap capture automatically. |
| `POST` | `/api/answer` | — | Answer incoming call. Starts capture automatically. |
| `POST` | `/api/hangup` | — | End active call. Sends BYE or CANCEL (pre-answer). Finalises capture. |
| `POST` | `/api/reject` | — | Reject incoming call (SIP 603 Decline) |
| `POST` | `/api/dtmf` | `{digit}` | Send DTMF tone (0–9, *, #) via RFC 2833 |

**Call target formats:**
```
"1002"                    → sip:1002@<registered server>
"1002@pbx.local"          → sip:1002@pbx.local
"sip:alice@pbx.local"     → verbatim
```

**CANCEL behaviour:** If `/api/hangup` is called before the call is answered (status `calling` or `ringing`), a SIP CANCEL is sent and the history entry is marked `cancelled`.

### Hold & Resume

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/hold` | Put active call on hold. Mutes RTP and sends re-INVITE with `a=sendonly`. |
| `POST` | `/api/resume` | Resume held call. Restores RTP and sends re-INVITE with `a=sendrecv`. |

**Remote hold:** If the far end sends a re-INVITE with `a=sendonly` or `a=inactive`, a `remoteHold` WebSocket event is emitted and the UI shows a "Remote Hold" indicator. When they resume with `a=sendrecv`, `remoteHoldReleased` is emitted.

### Transfer

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/transfer/blind` | `{target}` | Blind transfer — sends REFER, call ends immediately |
| `POST` | `/api/transfer/attended` | `{target}` | Attended transfer — dials target first, then bridges with REFER+Replaces |

### Conference

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/conference` | `{target}` | Add a third party to the call |
| `POST` | `/api/conference/end` | — | Drop the conference leg only |

### WAV Playback

WAV files are converted to raw G.722 at upload time using ffmpeg. During playback, G.722 frames are injected directly into the RTP stream, synchronised to the existing stream's SSRC and sequence number to avoid jitter buffer issues at the far end. Incoming RTP is suppressed during playback.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/wavfiles` | — | List uploaded files |
| `POST` | `/api/wavfiles/upload` | `multipart/form-data` field `file` | Upload and convert WAV to G.722 |
| `DELETE` | `/api/wavfiles/:filename` | — | Delete a file |
| `POST` | `/api/play` | `{filename}` | Play a file into the active call |
| `POST` | `/api/play/stop` | — | Stop playback |

**WAV format note:** Any WAV format is accepted. ffmpeg converts to 16kHz mono G.722 automatically. For best quality, source files should be 16kHz mono:
```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav
```

### On-Demand Call Recording

Separate from the always-on pcap capture. Starts an audio recording at any point during a call and saves **two** WAV files to `/captures`, linked in the Captures tab:

- `rec_<callId>_<ts>_rx.wav` — **Remote** channel: inbound RTP from the far end (what they said)
- `rec_<callId>_<ts>_tx.wav` — **Local** channel: outbound WAV playback frames injected into the RTP stream (empty/omitted if nothing was played)

Keeping the two channels separate is what makes speaker diarization possible in transcripts (see [Transcription](#transcription) below).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/record/start` | Begin recording both channels for the active call |
| `POST` | `/api/record/stop` | Stop recording and save both WAV files |

The `recordingStopped` WebSocket event includes both `audioFile` (rx) and `txFile` (tx).

### Live RTP Stats

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/stats` | Live RTP stats for the active call |

**Response:**
```json
{
  "codec": "G722/16kHz",
  "rxPackets": 1400,
  "txPackets": 1400,
  "lostPackets": 0,
  "lossPercent": "0.0",
  "jitterMs": 3,
  "rxKbps": 69,
  "txKbps": 68,
  "elapsed": 28
}
```

Stats are polled by the UI every 2 seconds and displayed live in the call panel.

### Packet Captures

Per-call `.pcap` files contain the full SIP dialog (INVITE → 100 Trying → 180 Ringing → 200 OK → ACK → BYE) plus all RTP packets. Written in pure Node.js — no tcpdump required.

Open in Wireshark and use **Telephony → VoIP Calls** to reconstruct the call flow. Apply the `sip` display filter to see only SIP messages.

An audio `.wav` file is also recorded per call containing the decoded inbound RTP audio (G.722 → 16kHz PCM, or PCMU/PCMA → 8kHz PCM).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/captures` | List all captures with optional audio file links |
| `DELETE` | `/api/captures/:filename` | Delete a capture |
| `GET` | `/captures/:filename` | Download a pcap file |
| `GET` | `/captures/audio_*.wav` | Download a decoded audio recording |

### Call History

History entries have a `status` field:

| Status | Meaning |
|---|---|
| `active` | Call in progress |
| `completed` | Call ended normally (BYE) |
| `missed` | Inbound call rang but was not answered |
| `cancelled` | Outbound call was hung up before answer (CANCEL) |
| `failed` | Call failed (4xx/5xx or WebSocket disconnect) |

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/history` | Full call history as JSON |
| `GET` | `/api/history/export` | Download as CSV |
| `DELETE` | `/api/history` | Clear all history |

History is persisted to `/captures/call_history.json` and survives container restarts.

### Transcription

Powered by a statically-compiled `whisper-cli` (whisper.cpp) baked into the Docker image with the `ggml-small.en` model (~465 MB). Two independent paths exist:

**Live transcription** — starts automatically on `callConnected` (if Whisper is available) and stops on `callEnded`. Every `TRANSCRIPT_WINDOW_MS` (default 6 s), the rx and tx RTP channels are decoded and run through `whisper-cli` in parallel (G.722 raw payload → ffmpeg → 16kHz WAV; PCMU/PCMA decoded inline via lookup tables → resampled). Recognised text is broadcast over the `/transcript` WebSocket and as a `transcriptChunk` event on the main control socket, prefixed `[Remote]` / `[Local]` when both channels contribute. Silence is skipped (minimum 800 bytes of G.722 or 4000 PCM samples per window), and a window is dropped rather than queued if the previous flush is still running.

**Post-call transcription** — run on demand against any `rec_*.wav` recording. ffmpeg resamples to 16kHz mono, `whisper-cli` produces an SRT, which is parsed into timestamped segments and saved as `rec_*.json` alongside the WAV. If a paired `_tx.wav` file exists (auto-detected from a `_rx.wav` filename), it's transcribed separately and the segments are merged sorted by `startSec` with `speaker: "Remote"` / `"Local"` fields — the response includes `diarized: true` when the tx channel contributed.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/transcript/status` | — | Whisper availability, whether live transcription is active, window size, connected `/transcript` clients |
| `GET` | `/api/transcripts` | — | List all saved post-call transcripts |
| `POST` | `/api/transcribe/:filename` | `{txFile?}` | Start post-call transcription of a `rec_*.wav` file (rx). `txFile` is auto-detected if omitted. Returns 503 if Whisper isn't available. |
| `GET` | `/api/transcribe/:filename/status` | — | Poll job status (`pending`/`running`/`done`/`error`) |
| `GET` | `/api/transcripts/:filename/text` | — | Download transcript as plain text (accepts `.wav` or `.json` filename) |
| `DELETE` | `/api/transcripts/:filename` | — | Delete a saved transcript |
| `DELETE` | `/api/history/:callId/transcript` | — | Delete only the transcript for a history entry, keep the entry |

`isWhisperAvailable()` checks that both `/usr/local/bin/whisper-cli` and `/models/ggml-small.en.bin` exist — transcription endpoints return HTTP 503 if either is missing (e.g. a non-Whisper build).

### Logging

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/log/export` | Download current in-memory system log as `.txt` |

---

## WebSocket Events

**Control connection:** `ws://localhost:3000` — receives JSON events, current state sent on connect.

**Audio relay:** `ws://localhost:3000/audio` — receives binary frames containing decoded PCM audio from the inbound RTP stream. Frame format: `[pt:1 byte][sampleRate:4 bytes LE][pcm16 samples...]`. Used by the browser's Web Audio API for live call audio.

**Live transcript:** `ws://localhost:3000/transcript` — sends `{type: 'connected', whisper, windowMs}` on connect, then `{type: 'transcript', text, ts}` for each recognised phrase during an active call.

### Event Reference

| Event | Data | Description |
|---|---|---|
| `state` | Full state object | Sent on connect |
| `registered` | `{username, server, displayName}` | Registration succeeded |
| `unregistered` | `{}` | Unregistered |
| `registrationFailed` | `{cause}` | Registration failed |
| `incomingCall` | `{callId, from, displayName}` | Incoming call ringing |
| `callConnected` | `{callId, direction}` | Call answered/established |
| `callEnded` | `{callId, cause}` | Call ended |
| `callFailed` | `{callId, cause}` | Call failed |
| `callMissed` | `{callId, from}` | Inbound call missed (far end cancelled) |
| `callHeld` | `{callId}` | Call put on hold |
| `callResumed` | `{callId}` | Call resumed from hold |
| `remoteHold` | `{callId}` | Far end put call on hold (a=sendonly) |
| `remoteHoldReleased` | `{callId}` | Far end resumed call (a=sendrecv) |
| `conferenceStarted` | `{target}` | Conference leg connected |
| `conferenceEnded` | `{}` | Conference leg dropped |
| `playbackEnded` | `{file?, error?, stopped?}` | WAV playback finished |
| `captureReady` | `{callId, filename, url, size}` | Capture file ready |
| `recordingStarted` | `{callId}` | On-demand recording started |
| `recordingStopped` | `{callId, audioFile, txFile}` | On-demand recording saved (rx + tx WAV files) |
| `transcriptChunk` | `{text, ts}` | Live transcription phrase recognised (also sent on `/transcript` WS) |
| `keepalive` | `{ok, cause?}` | OPTIONS keepalive result |
| `ipChanged` | `{oldIp, newIp}` | Container IP changed — re-registering |
| `wsDisconnected` | `{cause}` | WebSocket to PBX dropped |
| `wsConnected` | `{}` | WebSocket to PBX reconnected |
| `log` | `{level, message, timestamp}` | System log entry |

---

## Reliability Features

### Asterisk `direct_media` / Re-INVITE Handling

The RTP bridge tracks the actual source address/port of inbound RTP packets rather than trusting SDP alone. If Asterisk re-routes media directly between endpoints (`direct_media`) or sends a re-INVITE, the bridge detects the source change on the next received packet and updates its target instead of relying on SDP parsing to catch every case. In-dialog re-INVITE/UPDATE requests are also intercepted directly at the transaction layer (not just JsSIP's `reinvite` event, which doesn't reliably fire headlessly) so SDP changes are always applied.

### OPTIONS Keepalive

After registration, a SIP OPTIONS is sent to the PBX every 30 seconds. If it fails, a warning is logged, a `keepalive` event is emitted, and re-registration is triggered automatically.

### IP Change Detection

The container's local IP is polled every 15 seconds. If it changes (common after cloud VM restarts or container reassignment), the endpoint re-registers automatically so the SIP Contact header stays correct.

### Graceful WebSocket Reconnection

If the WebSocket connection to the PBX drops mid-call:
- The active call is torn down and marked `failed` in history
- Any unanswered inbound call is marked `missed`
- `wsDisconnected` event is broadcast to the UI
- JsSIP's built-in recovery attempts to reconnect
- On reconnect, `wsConnected` is broadcast and the SIP capture hooks are re-attached

---

## UI Features

### Clarity Theme
Single-file softphone with DM Sans + DM Mono typography, white card surfaces, and a blue/green/amber status system.

### Dark / Light Mode
Toggle between dark and light themes via the 🌙/☀️ button in the header. Preference is persisted to `localStorage`.

### Live Audio
Click **🔊 Listen** during a call to hear the inbound audio stream in the browser. Uses the Web Audio API — no plugins required. Works for G.722 (16kHz), PCMU and PCMA (8kHz) codecs.

### RTP Stats Panel
Appears automatically when a call connects. Displays codec, RX/TX packet counts, packet loss %, jitter (ms), and RX/TX kbps. Updated every 2 seconds via `GET /api/stats`.

### Live Transcript Panel
Shows recognised speech in real time during an active call (when Whisper is available in the build), streamed over the `/transcript` WebSocket.

### Transcripts Tab
Lists all post-call transcripts. Recordings in the Captures tab can be transcribed on demand with the ✍ **Transcribe** button; diarized transcripts label each line **Remote**/**Local**. Transcripts can be copied, downloaded as text, or deleted independently of the underlying recording.

### Registration Form Lock
When registered, the SIP registration form locks and displays the active credentials. Fields populate automatically from server state on page reload — even if registration was done via the API.

### Mobile Responsive
The layout adapts at 1100px (right panel drops below) and 768px (single column). Functional on tablets and large phone screens.

---

## Headless / Automation Usage

The REST API is fully usable without the browser UI:

```bash
BASE=http://localhost:3000

# 1. Register
curl -s -X POST $BASE/api/register \
  -H "Content-Type: application/json" \
  -d '{"server":"pbx.local","username":"1001","password":"secret","wsPort":8088}'

# 2. Make a call
curl -s -X POST $BASE/api/call \
  -H "Content-Type: application/json" \
  -d '{"target":"1002"}'

# 3. Check status (includes RTP stats when call is active)
curl -s $BASE/api/status | python3 -m json.tool

# 4. Poll live RTP stats
curl -s $BASE/api/stats

# 5. Play a WAV file into the call
curl -s -X POST $BASE/api/play \
  -H "Content-Type: application/json" \
  -d '{"filename":"announcement.g722"}'

# 6. Start on-demand recording
curl -s -X POST $BASE/api/record/start

# 7. Stop recording
curl -s -X POST $BASE/api/record/stop

# 8. Put on hold / resume
curl -s -X POST $BASE/api/hold
curl -s -X POST $BASE/api/resume

# 9. Hang up
curl -s -X POST $BASE/api/hangup

# 10. Download the pcap
curl -O $BASE/captures/<filename>.pcap

# 11. Download decoded on-demand recording (rx = remote, tx = local)
curl -O $BASE/captures/rec_<callid>_<ts>_rx.wav
curl -O $BASE/captures/rec_<callid>_<ts>_tx.wav

# 12. Export call history as CSV
curl -O $BASE/api/history/export

# 13. Transcribe a recording (requires a Whisper-enabled build)
curl -s -X POST $BASE/api/transcribe/rec_<callid>_<ts>_rx.wav
curl -s $BASE/api/transcribe/rec_<callid>_<ts>_rx.wav/status
curl -O $BASE/api/transcripts/rec_<callid>_<ts>_rx.wav/text
```

---

## Supported Codecs

| Codec | RTP PT | Direction | Notes |
|---|---|---|---|
| G.722 | 9 | Send + Receive | Preferred. 16kHz wideband ADPCM. WAV files converted to G.722 at upload. |
| PCMU (G.711 μ-law) | 0 | Send + Receive | 8kHz narrowband. Fallback. |
| PCMA (G.711 A-law) | 8 | Send + Receive | 8kHz narrowband. Fallback. |
| telephone-event | 101 | Send | DTMF via RFC 2833 |

SDP advertises G.722 as the preferred codec. If the PBX does not support G.722, it falls back to PCMU or PCMA automatically.

---

## File Paths (inside container)

| Path | Contents |
|---|---|
| `/captures/` | pcap files, on-demand recordings (`rec_*_rx.wav` / `rec_*_tx.wav`), transcripts (`rec_*.json`), call history JSON |
| `/wavfiles/` | Uploaded and G.722-converted playback files |
| `/models/ggml-small.en.bin` | Whisper model |
| `/usr/local/bin/whisper-cli` | Static Whisper binary |

---

## Notes

- **No tcpdump required** — packet captures are written in pure Node.js using the libpcap binary format
- **No audio hardware required** — media is handled entirely in Node.js using `dgram` UDP sockets; fully headless-capable
- **Full SIP dialog captured** — INVITE, 100 Trying, 180 Ringing, 200 OK, ACK, and BYE all appear in Wireshark
- **Dual-channel audio** — remote (rx) and local/playback (tx) RTP are decoded and recorded separately (G.722 ADPCM, μ-law, A-law), enabling speaker diarization in transcripts
- **Hold** — implemented via RTP mute + raw SIP re-INVITE (bypasses JsSIP's WebRTC renegotiation)
- **WAV playback** — injects G.722 frames directly into the RTP stream, synchronised to the existing stream's SSRC and sequence number
- **On-demand recording** — separate from the always-on pcap; start/stop at any point during a call, saves both rx and tx WAV files
- **Live audio relay** — inbound RTP is decoded and streamed to the browser via a dedicated WebSocket endpoint for real-time listening
- **Transcription** — on-device Whisper.cpp (statically compiled, no external API calls); live transcription during calls plus on-demand post-call transcription with speaker diarization
- **Direct media aware** — the RTP bridge tracks the actual source of inbound packets, so Asterisk `direct_media` re-routing and re-INVITEs are handled correctly
