# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
# Build and start (recommended)
podman-compose up -d --build

# Or with Docker
docker build -t sip-endpoint .
docker run -d --name sip-endpoint --network host --privileged \
  -v sip-captures:/captures -v sip-wavfiles:/wavfiles sip-endpoint

# Local dev (backend only, no container)
cd backend && npm install && npm run dev   # nodemon auto-reload
cd backend && npm start                   # production mode
```

The container runs as **root** with `--privileged` and `--network host` — required for raw packet capture (no tcpdump, pure Node.js libpcap writes) and UDP socket binding.

## Testing

The Python test scripts in the repo root exercise the full REST API end-to-end against a running container:

```bash
# Single-call test (you answer on a remote device)
python3 sip_call_test.py --ep1-url http://localhost:3000 \
  --sip-server 192.0.2.10 --ep1-user 1112 --ep1-pass secret --target 1113

# P2P test (two local containers call each other)
python3 sip_call_p2p_test.py

# IVR/automation test
python3 sip_call_ivr_test.py
```

No automated unit tests exist — all testing is integration via the Python scripts or the REST API.

## Architecture

The container is a single Node.js process (`backend/server.js`) that acts as an Express HTTP server, a WebSocket hub, and a SIP softphone simultaneously.

```
Express REST API (:3000)
  ├── sipManager.js   — JsSIP UA, call state machine, RTP bridge, WAV playback
  ├── captureManager.js — per-call .pcap writer (pure Node libpcap format)
  ├── audioDecoder.js — G.722/PCMU/PCMA → WAV file writer per call
  ├── callHistory.js  — persistent JSON + CSV call log (/captures/call_history.json)
  ├── transcribeManager.js — post-call Whisper.cpp transcription of rec_*.wav files
  └── liveTranscribe.js   — real-time windowed transcription during active calls

WebSocket endpoints (on the same :3000 server):
  /          — control events (JSON broadcast of all SIP state changes)
  /audio     — binary PCM stream to browser (Web Audio API playback)
  /transcript — live whisper text chunks during a call
```

### Key design decisions

**JsSIP runs in Node.js with browser shims** — `sipManager.js` stubs `RTCPeerConnection`, `navigator`, `window`, and `WebSocket` at module load time before `require('jssip')`. This is how a browser SIP library works headlessly. SDP and RTP are handled entirely in Node.js, bypassing JsSIP's WebRTC layer.

**RTP is managed directly via `dgram` UDP sockets** — not through JsSIP or WebRTC. `sipManager.js` builds raw SDP in `buildSdp()`, allocates ports from a pool (`RTP_PORT_LOW`–`RTP_PORT_HIGH`), and binds a UDP socket. The `RtpBridge` class handles forwarding, decoding, and WAV playback injection.

**Hold is implemented via raw SIP re-INVITE**, not JsSIP's hold API, to bypass JsSIP's WebRTC renegotiation. The hold SDP sets `a=sendonly`; on resume, `a=sendrecv` is sent.

**WAV playback** converts uploaded WAV files to raw G.722 bitstream via ffmpeg at upload time. During playback, G.722 frames are injected directly into the existing RTP stream sharing the same SSRC and sequence numbers to avoid jitter buffer disruption.

**G.722 audio decoding for recordings** — `audioDecoder.js` buffers raw G.722 payloads and decodes them in batch via ffmpeg at close time (rather than packet-by-packet), because a custom ADPCM decoder had accuracy issues.

**Whisper.cpp** is compiled statically and included in the Docker image (stage 2 of the multi-stage Dockerfile). The `ggml-small.en` model (~465 MB) is baked in. There are two distinct transcription paths — live (during a call) and post-call (on-demand) — described below.

## Transcription

### Speaker diarization

Recordings and live transcription both produce two audio channels:

- **Remote** (`_rx.wav`) — inbound RTP from the far end (what they said)
- **Local** (`_tx.wav`) — outbound WAV playback frames injected into the RTP stream

`AudioWriter` instances for both are created in `SipManager.startRecording()` and closed in `stopRecording()` / `_teardown()`. The `recordingStopped` event includes both `audioFile` (rx) and `txFile` (tx). The tx file is empty/omitted if no WAV was played.

Post-call transcription (`POST /api/transcribe/:rxFile`) auto-detects the paired tx file by replacing `_rx.wav` with `_tx.wav`. Whisper runs on each channel separately, then segments are merged sorted by `startSec` with `speaker: "Remote"` / `speaker: "Local"` fields. The JSON transcript includes `diarized: true` when a tx channel contributed segments.

Live transcription uses the same two-channel approach via `LiveTranscriber.write()` (inbound) and `LiveTranscriber.writeOutbound()` (outbound). Whisper runs on both channels in parallel per flush window. Emitted text is prefixed `[Remote]` / `[Local]` only when outbound content exists in that window.

### Live transcription (`liveTranscribe.js`)

A `LiveTranscriber` instance is created on `callConnected` and destroyed on `callEnded`. It hooks into the RTP bridge via `rtpBridge.onRawAudio` (not `onAudio`) so it receives raw, undecoded RTP payloads before they go through `audioDecoder.js`.

Every `WINDOW_MS` (default 6 s, env: `TRANSCRIPT_WINDOW_MS`), `_flush()` runs:

1. **G.722 (PT 9):** raw payload bytes are concatenated and written to a temp `.g722raw` file, then decoded to 16 kHz PCM WAV via ffmpeg.
2. **PCMU/PCMA (PT 0/8):** decoded inline using precomputed μ-law/A-law lookup tables to 8 kHz PCM, then resampled to 16 kHz WAV via ffmpeg.
3. The WAV is passed to `whisper-cli` with `--no-timestamps --output-txt`. The result is emitted as a `'text'` event.
4. `server.js` listens for `'text'` and broadcasts `{ type: 'transcript', text, ts }` to all `/transcript` WebSocket clients, and also broadcasts `transcriptChunk` on the main control socket.

Minimum thresholds prevent whisper from running on silence: 800 bytes of G.722 (~0.5 s) or 4000 PCM samples. If a flush is already in progress (`_busy = true`), the current window is skipped rather than queued.

The `/transcript` WebSocket sends `{ type: 'connected', whisper, windowMs }` on connect, then `{ type: 'transcript', text, ts }` for each recognised phrase.

`TRANSCRIPT_PROMPT` env var sets the whisper prompt string (default: `"compliance monitoring recording quality"`), which biases the model toward telephony vocabulary.

### Post-call transcription (`transcribeManager.js`)

Triggered via `POST /api/transcribe/:filename` on any `rec_*.wav` on-demand recording. The pipeline:

1. ffmpeg resamples the recording to 16 kHz mono WAV (Whisper requirement).
2. `whisper-cli` runs with `--output-srt` to produce timestamped segments.
3. SRT is parsed into `{ startSec, endSec, text }` segments.
4. Output saved as `rec_*.json` in `/captures/` alongside the WAV, containing `{ segments, text, duration, wordCount, model, generatedAt }`.

Jobs are tracked in-memory (`filename → { status, startedAt, error? }`). Poll progress via `GET /api/transcribe/:filename/status`. Download as plain text via `GET /api/transcripts/:filename/text`.

`isWhisperAvailable()` checks that both `/usr/local/bin/whisper-cli` and `/models/ggml-small.en.bin` exist — endpoints return HTTP 503 if either is missing (e.g. in a non-Whisper build).

## Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP + WebSocket port |
| `SIP_PORT` | `5060` | Used only for pcap BPF filter |
| `RTP_PORT_LOW` / `RTP_PORT_HIGH` | `10000` / `20000` | RTP UDP port pool |
| `CAPTURE_INTERFACE` | `any` | libpcap capture interface |
| `MEDIA_IP` | auto-detect | Override NIC selection for SDP `c=` line |
| `TRANSCRIPT_WINDOW_MS` | `6000` | Live transcription flush interval |

## File Paths (inside container)

- `/captures/` — pcap files, on-demand recordings (`rec_*.wav`), transcripts (`rec_*.json`), call history JSON
- `/wavfiles/` — uploaded and converted G.722 playback files
- `/models/ggml-small.en.bin` — Whisper model
- `/usr/local/bin/whisper-cli` — static Whisper binary

## API & WebSocket Reference

The full API spec is at `openapi.json` (OpenAPI 3.1) — import into Postman or Swagger. The `PostmanCollection.json` is also included for direct Postman import.

WebSocket audio frame format: `[pt:1 byte][sampleRate:4 bytes LE][pcm16 samples...]` where `pt=9` → 16kHz (G.722), others → 8kHz.
