# SIP Endpoint — Containerized Web Softphone

A fully containerized SIP softphone with a web UI, complete REST API for headless operation, per-call packet capture, inbound audio recording, and WAV file playback into the RTP stream.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Docker / Podman Container              │
│                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │  Express    │   │  SipManager  │   │ CaptureManager  │   │
│  │  REST API   │◄─►│  (JsSIP/WS)  │   │ (pure Node pcap)│   │
│  │  :3000      │   │              │   └────────┬────────┘   │
│  └──────┬──────┘   └──────┬───────┘            │            │
│         │                 │            ┌───────▼────-────┐  │
│  ┌──────▼─────────────────▼──────────┐ │  AudioDecoder   │  │
│  │       WebSocket Server            │ │ G.722/PCMU/PCMA │  │
│  └──────────────┬────────────────────┘ │  → WAV file     │  │
│                 │                      └─────────────────┘  │
│  ┌──────────────▼────────────────────┐                      │
│  │    Frontend (Single-file HTML)    │                      │
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
| `backend/server.js` | Express HTTP/WS server, REST API endpoints |
| `backend/sipManager.js` | JsSIP UA, call handling, RTP bridge, WAV playback |
| `backend/captureManager.js` | Per-call `.pcap` writer (pure Node.js, no tcpdump) |
| `backend/audioDecoder.js` | G.722/PCMU/PCMA decoder, inbound call WAV recorder |
| `backend/callHistory.js` | Persistent call history (JSON + CSV export) |
| `frontend/index.html` | Single-file softphone UI |

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

All endpoints accept and return JSON unless stated otherwise.

### Registration

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/status` | — | Full state: registration, active call, hold, conference |
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
| `POST` | `/api/call` | `{target}` | Initiate outbound call. Starts capture automatically. |
| `POST` | `/api/answer` | — | Answer incoming call. Starts capture automatically. |
| `POST` | `/api/hangup` | — | End active call. Finalises capture and audio recording. |
| `POST` | `/api/reject` | — | Reject incoming call (SIP 603 Decline) |
| `POST` | `/api/dtmf` | `{digit}` | Send DTMF tone (0-9, *, #) |

**Call target formats:**
```
"1002"                    → sip:1002@<registered server>
"1002@pbx.local"          → sip:1002@pbx.local
"sip:alice@pbx.local"     → verbatim
```

### Hold & Resume

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/hold` | Put active call on hold. Mutes RTP and sends re-INVITE with `a=sendonly`. |
| `POST` | `/api/resume` | Resume held call. Restores RTP and sends re-INVITE with `a=sendrecv`. |

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

WAV files are converted to raw G.722 at upload time using ffmpeg. During playback, G.722 frames are injected directly into the RTP stream, replacing the live audio for the duration.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/wavfiles` | — | List uploaded files |
| `POST` | `/api/wavfiles/upload` | `multipart/form-data` field `file` | Upload and convert WAV to G.722 |
| `DELETE` | `/api/wavfiles/:filename` | — | Delete a file |
| `POST` | `/api/play` | `{filename}` | Play a file into the active call |
| `POST` | `/api/play/stop` | — | Stop playback |

**WAV format note:** Any WAV format is accepted. ffmpeg converts to 16kHz mono G.722 automatically. For best quality, source files should be 16kHz mono. Convert with:
```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav
```

### Packet Captures

Per-call `.pcap` files are written in pure Node.js (no tcpdump required). Each capture contains SIP signalling and RTP packets, and is openable in Wireshark. Use **Telephony → VoIP Calls** in Wireshark to reconstruct the call.

An audio `.wav` file is also recorded per call containing the decoded inbound RTP audio (G.722 → 16kHz PCM, or PCMU/PCMA → 8kHz PCM).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/captures` | List all captures with optional audio file links |
| `DELETE` | `/api/captures/:filename` | Delete a capture |
| `GET` | `/captures/:filename` | Download a pcap file |
| `GET` | `/captures/audio_*.wav` | Download a decoded audio recording |

### Call History

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

Connect to `ws://localhost:3000`. On connect, the current state is sent immediately.

| Event | Data | Description |
|---|---|---|
| `state` | Full state object | Sent on connect |
| `registered` | `{username, server, displayName}` | Registration succeeded |
| `unregistered` | `{}` | Unregistered |
| `registrationFailed` | `{cause}` | Registration failed |
| `incomingCall` | `{from, displayName}` | Incoming call ringing |
| `callConnected` | `{callId, direction}` | Call answered/established |
| `callEnded` | `{callId, cause}` | Call ended |
| `callFailed` | `{callId, cause}` | Call failed |
| `callHeld` | `{callId}` | Call put on hold |
| `callResumed` | `{callId}` | Call resumed from hold |
| `conferenceStarted` | `{target}` | Conference leg connected |
| `conferenceEnded` | `{}` | Conference leg dropped |
| `playbackEnded` | `{file?, error?, stopped?}` | WAV playback finished |
| `captureReady` | `{callId, filename, url, size}` | Capture file ready for download |
| `log` | `{level, message, timestamp}` | System log entry |

---

## Headless / Automation Usage

The REST API is fully usable without the browser UI. Example call flow:

```bash
BASE=http://localhost:3000

# 1. Register
curl -s -X POST $BASE/api/register \
  -H "Content-Type: application/json" \
  -d '{"server":"pbx.local","username":"1001","password":"secret"}'

# 2. Make a call
curl -s -X POST $BASE/api/call \
  -H "Content-Type: application/json" \
  -d '{"target":"1002"}'

# 3. Check status
curl -s $BASE/api/status

# 4. Play a WAV file
curl -s -X POST $BASE/api/play \
  -H "Content-Type: application/json" \
  -d '{"filename":"announcement_8k.g722"}'

# 5. Put on hold
curl -s -X POST $BASE/api/hold

# 6. Resume
curl -s -X POST $BASE/api/resume

# 7. Hang up
curl -s -X POST $BASE/api/hangup

# 8. Download the capture
curl -O $BASE/captures/<filename>.pcap

# 9. Download the audio recording
curl -O $BASE/captures/audio_<callid>.wav

# 10. Export call history
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

SDP advertises G.722 as the preferred codec. If the PBX does not support G.722, it will fall back to PCMU or PCMA.

---

## Notes

- **No tcpdump required** — packet captures are written in pure Node.js using the libpcap binary format
- **No WebRTC** — media is handled entirely in Node.js using `dgram` UDP sockets, making the endpoint fully headless-capable
- **Inbound audio** — decoded in real time and saved as a WAV file per call in the `/captures` volume
- **Hold** — implemented via RTP mute + raw SIP re-INVITE (bypasses JsSIP's WebRTC renegotiation)
- **WAV playback** — injects G.722 frames directly into the RTP stream, synchronised to the existing stream's SSRC and sequence number to avoid jitter buffer issues at the far end
