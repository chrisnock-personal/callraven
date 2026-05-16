# SIP Endpoint — Containerized Web Softphone

A fully containerized SIP softphone with a web UI, complete REST API for headless operation, per-call packet capture (INVITE/100/180/200/ACK/BYE + RTP), inbound audio recording, WAV file playback into the RTP stream, live audio relay to the browser, and on-demand call recording.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Docker / Podman Container              │
│                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │  Express    │   │  SipManager  │   │ CaptureManager  │  │
│  │  REST API   │◄─►│  (JsSIP/WS)  │   │ (pure Node pcap)│  │
│  │  :3000      │   │              │   └────────┬────────┘  │
│  └──────┬──────┘   └──────┬───────┘            │           │
│         │                 │            ┌────────▼────────┐  │
│  ┌──────▼─────────────────▼──────────┐ │  AudioDecoder   │  │
│  │       WebSocket Server            │ │ G.722/PCMU/PCMA │  │
│  │  Control: ws://host:3000          │ │  → WAV file     │  │
│  │  Audio:   ws://host:3000/audio    │ └─────────────────┘  │
│  └──────────────┬────────────────────┘                      │
│                 │                                           │
│  ┌──────────────▼────────────────────┐                      │
│  │    Frontend (Single-file HTML)    │                      │
│  │  Dark/light mode · Responsive     │                      │
│  └───────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
         │ SIP over WebSocket          │ UDP RTP
         ▼                             ▼
    SIP Proxy / PBX              RTP Media Stream
   (Asterisk, FreePBX,           (G.722, PCMU, PCMA)
    Kamailio, etc.)
```

**Key components:**

| File | Purpose |
|---|---|
| `backend/server.js` | Express HTTP/WS server, REST API endpoints, audio relay |
| `backend/sipManager.js` | JsSIP UA, call handling, RTP bridge, WAV playback, keepalive |
| `backend/captureManager.js` | Per-call `.pcap` writer (pure Node.js, no tcpdump) |
| `backend/audioDecoder.js` | G.722/PCMU/PCMA decoder, inbound call WAV recorder |
| `backend/callHistory.js` | Persistent call history (JSON + CSV export) |
| `frontend/index.html` | Single-file softphone UI (Clarity theme) |
| `openapi.json` | OpenAPI 3.1 spec — import into Postman, Swagger, Redocly |

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
| `SIP_PORT` | `5060` | SIP port for capture filter |
| `RTP_PORT_LOW` | `10000` | RTP port range start |
| `RTP_PORT_HIGH` | `20000` | RTP port range end |
| `NODE_ENV` | `production` | Node environment |

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

Separate from the always-on pcap capture. Starts an audio recording at any point during a call, saves a WAV file to `/captures`, and links it in the Captures tab.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/record/start` | Begin recording inbound audio for the active call |
| `POST` | `/api/record/stop` | Stop recording and save WAV file |

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

### Logging

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/log/export` | Download current in-memory system log as `.txt` |

---

## WebSocket Events

**Control connection:** `ws://localhost:3000` — receives JSON events, current state sent on connect.

**Audio relay:** `ws://localhost:3000/audio` — receives binary frames containing decoded PCM audio from the inbound RTP stream. Frame format: `[pt:1 byte][sampleRate:4 bytes LE][pcm16 samples...]`. Used by the browser's Web Audio API for live call audio.

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
| `recordingStopped` | `{callId, audioFile}` | On-demand recording saved |
| `keepalive` | `{ok, cause?}` | OPTIONS keepalive result |
| `ipChanged` | `{oldIp, newIp}` | Container IP changed — re-registering |
| `wsDisconnected` | `{cause}` | WebSocket to PBX dropped |
| `wsConnected` | `{}` | WebSocket to PBX reconnected |
| `log` | `{level, message, timestamp}` | System log entry |

---

## Reliability Features

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

# 11. Download decoded audio recording
curl -O $BASE/captures/audio_<callid>.wav

# 12. Export call history as CSV
curl -O $BASE/api/history/export
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

## Notes

- **No tcpdump required** — packet captures are written in pure Node.js using the libpcap binary format
- **No audio hardware required** — media is handled entirely in Node.js using `dgram` UDP sockets; fully headless-capable
- **Full SIP dialog captured** — INVITE, 100 Trying, 180 Ringing, 200 OK, ACK, and BYE all appear in Wireshark
- **Inbound audio** — decoded in real time (G.722 ADPCM, μ-law, A-law) and saved as a WAV file per call
- **Hold** — implemented via RTP mute + raw SIP re-INVITE (bypasses JsSIP's WebRTC renegotiation)
- **WAV playback** — injects G.722 frames directly into the RTP stream, synchronised to the existing stream's SSRC and sequence number
- **On-demand recording** — separate from the always-on pcap; start/stop at any point during a call
- **Live audio relay** — inbound RTP is decoded and streamed to the browser via a dedicated WebSocket endpoint for real-time listening
