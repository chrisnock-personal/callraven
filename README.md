<!-- a <p align="center"><img width="252" height="275" alt="Image" src="https://github.com/user-attachments/assets/0b4a14aa-f344-41f0-b744-44516543e04b" /></p> -->

# SIP Endpoint — Containerized Web Softphone

A fully containerized SIP softphone with a web UI, complete REST API for headless operation, SIP over WebSocket **or raw UDP** (no WS transport module required on the PBX), calling without ever registering, per-call packet capture (INVITE/100/180/200/ACK/BYE + RTP), dual-channel (remote/local) call recording, WAV file playback into the RTP stream, live audio relay to the browser, on-demand call recording (with an auto-record option), and on-device Whisper transcription with speaker diarization — both live during a call and post-call on demand. Automatic pcap capture and live transcription can each be toggled off if not needed.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│        Docker / Podman Container (root, --privileged)            │
│                                                                  │
│  ┌───────────┐   ┌─────────────┐   ┌───────────── ───┐           │
│  │  Express  │   │ SipManager  │   │ CaptureManager  │           │
│  │  REST API │◄─►│ (JsSIP/WS,  │   │ (pure Node pcap)│           │
│  │  :3000    │   │  RTP bridge)│   └────────┬────────┘           │
│  └─────┬─────┘   └──────┬──────┘            │                    │
│        │                │            ┌──────▼──  ──────┐         │
│        │                ├───────────►│  AudioDecoder   │         │
│        │                │            │ G.722/PCMU/PCMA │         │
│        │                │            │  → rx/tx WAV    │         │
│        │                │            └─────────────────┘         │
│        │                ├───────────►┌─────────────────┐         │
│        │                │            │ LiveTranscriber │         │
│        │                │            │ whisper-cli,    │         │
│        │                │            │ windowed (6s)   │         │
│        │                │            └─────────────────┘         │
│        │                └───────────►┌─────────────────┐         │
│        │                             │TranscribeManager│         │
│        │                             │ post-call jobs  │         │
│        │                             └─────────────────┘         │
│  ┌─────▼──────────────────────────┐                              │
│  │        WebSocket Server        │                              │
│  │  /            control events   │                              │
│  │  /audio       PCM audio relay  │                              │
│  │  /transcript  live whisper text│                              │
│  └────────────────┬───────────────┘                              │
│                   │                                              │
│  ┌────────────────▼────────────────┐                             │
│  │    Frontend (Single-file HTML)  │                             │
│  │  Dark/light mode · Responsive   │                             │
│  └─────────────────────────────────┘                             │
└──────────────────────────────────────────────────────────────────┘
         │ SIP over WebSocket or UDP   │ UDP RTP
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
| `backend/udpSipSocket.js` | Raw UDP `Socket` implementation for JsSIP (`transport: 'UDP-RAW'`), with its own RFC 3261-style retransmission |
| `backend/captureManager.js` | Per-call `.pcap` writer (pure Node.js, no tcpdump) |
| `backend/audioDecoder.js` | G.722/PCMU/PCMA decoder, dual-channel (rx/tx) call WAV recorder |
| `backend/callHistory.js` | Persistent call history (JSON + CSV export) |
| `backend/transcribeManager.js` | Post-call Whisper transcription jobs on `rec_*.wav` recordings, with rx/tx diarization |
| `backend/liveTranscribe.js` | Real-time windowed Whisper transcription during an active call |
| `frontend/index.html` | Single-file softphone UI (Clarity theme) |
| `openapi.json` | OpenAPI 3.1 spec — import into Postman, Swagger, Redocly |
| `sync.sh` | Rsync + podman-compose deploy helper for pushing local changes to a remote host |

---

## Screenshots
<img width="1114" height="1098" alt="Image" src="https://github.com/user-attachments/assets/c3c639a6-1326-41dd-84f4-2ec1bc85b520" />
<br><br>
<img width="1109" height="1080" alt="Image" src="https://github.com/user-attachments/assets/97db004f-3b0c-4808-a593-de76836c994a" />
<br><br>
<img width="296" height="484" alt="Image" src="https://github.com/user-attachments/assets/4d3b9d91-f7eb-401f-9e02-8850cdcbc1af" />
<br><br>
<img width="296" height="484" alt="Image" src="https://github.com/user-attachments/assets/cf4da6b0-f25c-4565-8c66-4742857ac13a" />
<br><br>
<img width="288" height="602" alt="Image" src="https://github.com/user-attachments/assets/eca4dbc6-7075-4af4-9228-d8e7da3a5e82" />
<br><br>

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
| `SIP_PORT` | `5060` | pcap BPF capture filter, and the local bind port for the raw-UDP SIP transport (`UDP-RAW`) |
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

**Transport values:** `UDP` (default, SIP over plaintext WebSocket — `ws://`), `TLS` (SIP over WebSocket Secure — `wss://`), or `UDP-RAW` (raw SIP over UDP, no WebSocket — see [Raw UDP SIP Transport](#raw-udp-sip-transport) below). `wsPort`/`wsPath` apply to `UDP`/`TLS` only; `port` is the real destination UDP port for `UDP-RAW` (default `5060`).

### Raw UDP SIP Transport

Select **"UDP (raw, no WS)"** as the Transport to register and place calls over plain SIP-over-UDP — no WebSocket transport module required on the PBX side (works against a stock Asterisk/FreePBX/Kamailio `udp` binding on port 5060). The Transport dropdown hides the WebSocket-only fields (WS Port) when this option is selected, since the existing `Port` field becomes the real destination UDP port instead.

Implemented in `backend/udpSipSocket.js` as a custom JsSIP `Socket` — dialogs, digest authentication, REGISTER refresh, hold, transfer, conference, and DTMF are all unchanged from the WebSocket path (JsSIP's transaction/dialog layer is transport-agnostic). The one thing plugged in on top is retransmission: unlike SIP-over-WebSocket, UDP can drop packets, so `udpSipSocket.js` retransmits unacknowledged requests and final responses (doubling interval, ~32s timeout) — JsSIP itself doesn't do this for any transport.

`SIP_PORT` (default `5060`) sets the local UDP port this transport binds to, in addition to its existing use as the pcap BPF filter port.

Unregistered calling (below) also supports `UDP-RAW` via the same `transport` field.

### Settings

Global feature toggles (not per-call). `captureEnabled`/`liveTranscriptEnabled` default to `true`, matching the prior always-on behaviour; `autoRecordEnabled` defaults to `false`, since on-demand recording has always been opt-in. Changes take effect on the next call.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/settings` | — | Current settings: `{captureEnabled, liveTranscriptEnabled, autoRecordEnabled}` |
| `POST` | `/api/settings` | `{captureEnabled?, liveTranscriptEnabled?, autoRecordEnabled?}` | Update one or more settings |

### Calls

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/call` | `{target}` | Initiate outbound call while registered. Starts pcap capture automatically (unless disabled in Settings). |
| `POST` | `/api/call/anonymous` | `{target, displayName?, transport?, port?, wsPort?, wsPath?}` | Place a call **without** an active registration — see Unregistered Calling below. Only usable while unregistered and idle. |
| `POST` | `/api/answer` | — | Answer incoming call. Starts capture automatically (unless disabled in Settings). |
| `POST` | `/api/hangup` | — | End active call. Sends BYE or CANCEL (pre-answer). Finalises capture. |
| `POST` | `/api/reject` | — | Reject incoming call (SIP 603 Decline) |
| `POST` | `/api/dtmf` | `{digit}` | Send DTMF tone (0–9, *, #) via SIP INFO |

**Call target formats:**
```
"1002"                    → sip:1002@<registered server>
"1002@pbx.local"          → sip:1002@pbx.local
"sip:alice@pbx.local"     → verbatim
```

**CANCEL behaviour:** If `/api/hangup` is called before the call is answered (status `calling` or `ringing`), a SIP CANCEL is sent and the history entry is marked `cancelled`.

### Unregistered Calling

Places a call without ever registering, by connecting a throwaway UA directly to the target's SIP domain — there's no account, just a caller-ID string presented in the From header. Only usable while not registered and idle (returns 409 otherwise).

The target **must** be in the form `<address>@<sipdomain>` (a bare extension isn't resolvable without a registered server to fall back to). In the UI, this happens automatically: typing an `@`-containing address into the dial box while unregistered calls `/api/call/anonymous` instead of `/api/call`; an **Advanced** panel exposes `displayName` (caller ID, default `anonymous`), `transport` (`UDP`/`TLS`/`UDP-RAW`), `port`, `wsPort`, and `wsPath`.

```json
POST /api/call/anonymous
{
  "target": "alice@pbx.example.com",
  "displayName": "Front Desk",
  "transport": "UDP-RAW"
}
```

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
| `DELETE` | `/api/history/:callId` | Delete one history entry, plus its pcap, recording, and transcript files |
| `DELETE` | `/api/history/:callId/capture` | Delete only the pcap + WAV recording for an entry, keep the history entry and transcript |

(See [Transcription](#transcription) below for `DELETE /api/history/:callId/transcript`.)

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

### Live Transcript Tab
A **Live Transcript** tab in the right panel (alongside Call History and WAV Files) shows recognised speech in real time during an active call (when Whisper is available in the build), streamed over the `/transcript` WebSocket. It resets to "Waiting for speech…" when a call connects, and the last transcript stays visible after the call ends so it can still be read. Disable via the **Live transcript** toggle in Settings (left panel).

### Transcripts Tab
Lists all post-call transcripts. Recordings in the Captures tab can be transcribed on demand with the ✍ **Transcribe** button; diarized transcripts label each line **Remote**/**Local**. Transcripts can be copied, downloaded as text, or deleted independently of the underlying recording.

### Unregistered Calling
Type an `address@sipdomain` target into the dial box while unregistered and hit Call — no registration required. An **Advanced** panel exposes caller ID, transport, and port overrides. See [Unregistered Calling](#unregistered-calling) in the API reference.

### Settings Toggles
Three switches in the left panel control per-call automatic behaviour: **Auto-capture (pcap)**, **Live transcript**, and **Auto-record** (all backed by `GET`/`POST /api/settings`). Auto-capture and live transcript default on (matching the original always-on behaviour); auto-record defaults off, since on-demand recording has always been a manual Start/Stop action.

### Collapsible Side Panels
The ▤ button in the header hides/shows both the left (SIP Registration) and right (Captures/History/Transcript) panels at once, leaving just the center dialer — useful to reclaim screen space. Preference is persisted to `localStorage`.

### Collapsible API Reference
The API endpoint reference in the left panel is collapsed by default (click to expand) to keep the registration form the focus.

### System Log
An inline log panel below the dialer, collapsed by default to save screen space — click the header to expand it. Shows a badge with the count of new entries while collapsed.

### Registration Form Lock
When registered, the SIP registration form locks and displays the active credentials. Fields populate automatically from server state on page reload — even if registration was done via the API.

### Mobile Responsive
The layout adapts at 1100px (right panel drops below) and 768px (single column). Functional on tablets and large phone screens. The center dialer panel is capped at a comfortable max-width on wide desktop screens rather than stretching edge-to-edge.

---

## Roadmap

- [x] **Unregistered calling** — allow placing a call without an active SIP registration by entering `<address>@<sipdomain>` directly
- [x] **Collapsible side panels** — toggle in the header to hide/show both the SIP Registration panel and the Captures/History/Transcript panel at once, to reclaim screen space
- [x] **Vanilla SIP transport** — support raw SIP over UDP (not just SIP-over-WebSocket via JsSIP) to interoperate with PBXs/endpoints that don't offer a WS transport. Select "UDP (raw, no WS)" as the Transport. TCP is not implemented.
- [ ] **Vanilla TCP SIP support** — extend the raw SIP transport (`udpSipSocket.js`) to also support TCP, alongside the existing raw UDP option
- [ ] **Secure SIP (SIPS/TLS)** — support SIP over TLS for the raw transport (encrypted signaling to the PBX directly, distinct from the existing WSS option which is TLS at the WebSocket layer only)
- [x] **Configurable pcap capture** — toggle in the left panel (`GET`/`POST /api/settings`, `captureEnabled`) to disable automatic pcap capture on calls
- [x] **Configurable live transcript** — toggle in the left panel (`GET`/`POST /api/settings`, `liveTranscriptEnabled`) to disable automatic live transcription on calls
- [x] **Auto-record option** — toggle in the left panel (`autoRecordEnabled` via `/api/settings`) to automatically start on-demand recording when a call connects, instead of requiring a manual click each time
- [ ] **Non-containerized native client ports** — native Linux build (Rust), native macOS build, and native Windows build, as alternatives to running in a container

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
| telephone-event | 101 | Advertised only | Advertised in SDP for RFC 2833 capability, but `/api/dtmf` actually sends DTMF via SIP INFO (JsSIP's default) — see the Calls section below. |

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
