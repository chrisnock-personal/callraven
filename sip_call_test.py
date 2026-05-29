#!/usr/bin/env python3
"""
sip_call_test.py — Single endpoint call test (manual answer on remote end)

Registers EP1, dials a target, waits for you to answer on the remote device,
then records, plays a WAV, hangs up, downloads files, and transcribes.

Usage:
  python3 sip_call_test.py [options]

Required:
  --ep1-url     URL of endpoint 1          (default: http://localhost:3000)
  --sip-server  SIP server IP              (default: 192.168.1.127)
  --ep1-user    SIP username               (default: 1112)
  --ep1-pass    SIP password               (default: secret)
  --target      Number/URI to dial         (default: 1113)

Optional:
  --wav         WAV filename to play mid-call (must be uploaded to EP1)
  --call-wait   Seconds to wait after WAV before hanging up (default: 5)
  --answer-wait Max seconds to wait for remote to answer   (default: 60)
  --tc-wait     Max seconds to wait for transcription      (default: 120)
  --out-dir     Output directory for downloads             (default: ./output)
  --debug       Print all HTTP request/response details
  --no-record   Skip recording
  --no-wav      Skip WAV playback
  --no-transcribe  Skip transcription
"""

import argparse
import json
import os
import sys
import time
import requests
from datetime import datetime

# ─── Terminal colours ─────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def log_ok(msg):    print(f"  {GREEN}✓{RESET}  {msg}")
def log_fail(msg):  print(f"  {RED}✗{RESET}  {msg}"); 
def log_info(msg):  print(f"  {CYAN}→{RESET}  {msg}")
def log_warn(msg):  print(f"  {YELLOW}⚠{RESET}  {msg}")
def log_step(n, msg): print(f"\n{BOLD}Step {n}: {msg}{RESET}")
def log_debug(msg): print(f"  {DIM}{msg}{RESET}")

# ─── Results tracker ──────────────────────────────────────────────────────────
RESULTS = {}

def record(key, passed, label=None):
    RESULTS[key] = {"passed": passed, "label": label or key}
    return passed

# ─── HTTP client ──────────────────────────────────────────────────────────────
DEBUG = False

def api(method, url, label="", **kwargs):
    """
    Make an HTTP request. Returns (success: bool, data: dict).
    Logs request/response if --debug is set.
    """
    if DEBUG:
        log_debug(f"► {method.upper()} {url}")
        if "json" in kwargs:
            log_debug(f"  Body: {json.dumps(kwargs['json'], indent=4)}")

    try:
        resp = getattr(requests, method.lower())(url, timeout=30, **kwargs)

        if DEBUG:
            log_debug(f"  ◄ HTTP {resp.status_code}")
            try:
                log_debug(f"  {json.dumps(resp.json(), indent=4)}")
            except Exception:
                log_debug(f"  {resp.text[:300]}")

        resp.raise_for_status()

        try:
            return True, resp.json()
        except Exception:
            return True, {}

    except requests.exceptions.ConnectionError:
        log_fail(f"{label or url} — connection refused (is the container running?)")
        return False, {}
    except requests.exceptions.Timeout:
        log_fail(f"{label or url} — request timed out")
        return False, {}
    except requests.exceptions.HTTPError as e:
        body = ""
        try:
            body = e.response.json().get("error", e.response.text[:120])
        except Exception:
            body = e.response.text[:120]
        log_fail(f"{label or url} — HTTP {e.response.status_code}: {body}")
        return False, {}
    except Exception as e:
        log_fail(f"{label or url} — unexpected error: {e}")
        return False, {}


def download_file(url, dest_path, label=""):
    """Download a URL to dest_path. Returns True on success."""
    if DEBUG:
        log_debug(f"► GET (download) {url}")
    try:
        resp = requests.get(url, timeout=60, stream=True)
        resp.raise_for_status()
        os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        size = os.path.getsize(dest_path)
        log_ok(f"{label or os.path.basename(dest_path)} saved ({size:,} bytes) → {dest_path}")
        return True
    except Exception as e:
        log_fail(f"Download {label or url}: {e}")
        return False


# ─── Step functions ───────────────────────────────────────────────────────────

def step_register(ep_url, sip_server, username, password):
    """Check if registered; register if not. Returns True on success."""
    log_info(f"Checking registration status...")
    ok, data = api("GET", f"{ep_url}/api/status", label="status check")
    if not ok:
        return record("1_register", False, "Register EP1")

    registered = (data.get("state") or {}).get("registered") or data.get("registered")

    if registered:
        log_ok("EP1 already registered")
        return record("1_register", True, "Register EP1")

    log_info(f"Not registered — registering {username}@{sip_server}...")
    ok, data = api("POST", f"{ep_url}/api/register", label="register", json={
        "server":      sip_server,
        "username":    username,
        "password":    password,
        "displayName": username,
        "transport":   "UDP (ws://)",
        "wsPort":      "8088",
    })
    if not ok:
        return record("1_register", False, "Register EP1")

    # Poll for confirmation
    log_info("Waiting for registration confirmation...")
    for _ in range(15):
        time.sleep(1)
        _, status = api("GET", f"{ep_url}/api/status")
        if (status.get("state") or {}).get("registered") or status.get("registered"):
            log_ok("Registered successfully")
            return record("1_register", True, "Register EP1")

    log_fail("Registration timed out after 15s")
    return record("1_register", False, "Register EP1")


def step_dial(ep_url, target, sip_server):
    """Initiate a call. Returns callId on success, None on failure."""
    # Build full URI if just a number was given
    if "@" not in target:
        target_uri = f"{target}@{sip_server}"
    else:
        target_uri = target

    log_info(f"Dialling {target_uri}...")
    ok, data = api("POST", f"{ep_url}/api/call", label="dial",
                   json={"target": target_uri})
    if not ok:
        record("2_dial", False, "Dial target")
        return None

    call_id = data.get("callId") or data.get("call_id")
    log_ok(f"Call initiated (callId: {call_id})")
    record("2_dial", True, "Dial target")
    return call_id


def step_wait_for_answer(ep_url, timeout=60):
    """
    Poll until the call status is 'connected'. Prints a countdown so the
    user knows how long they have to answer on the remote device.
    Returns True when connected.
    """
    log_info(f"Waiting for remote end to answer (timeout: {timeout}s)...")
    print(f"  {YELLOW}↳  Please answer the call on the remote device now{RESET}")

    start = time.time()
    while True:
        elapsed = int(time.time() - start)
        if elapsed >= timeout:
            log_fail(f"Remote did not answer within {timeout}s")
            return record("3_wait_answer", False, "Remote answers call")

        _, data = api("GET", f"{ep_url}/api/status")
        active = (data.get("state") or {}).get("activeCall") or data.get("activeCall") or {}
        status = active.get("status", "")

        if status in ("connected", "confirmed", "active"):
            log_ok(f"Call connected ({elapsed}s elapsed)")
            return record("3_wait_answer", True, "Remote answers call")

        # Print a live counter every 5s
        if elapsed % 5 == 0 and elapsed > 0:
            remaining = timeout - elapsed
            log_info(f"Still waiting... {remaining}s remaining")

        time.sleep(1)


def step_start_recording(ep_url, call_id):
    """Start on-demand recording."""
    log_info("Starting recording...")
    ok, data = api("POST", f"{ep_url}/api/record/start", label="start recording",
                   json={"callId": call_id})
    if not ok:
        return record("4_record", False, "Start recording")
    log_ok(f"Recording started — {data.get('filename', '')}")
    return record("4_record", True, "Start recording")


def step_play_wav(ep_url, wav_filename):
    """Play a WAV file into the call."""
    log_info(f"Playing WAV: {wav_filename}")
    ok, data = api("POST", f"{ep_url}/api/play", label="play WAV",
                   json={"filename": wav_filename})
    if not ok:
        return record("5_play_wav", False, "Play WAV")
    log_ok(f"WAV playback started")
    return record("5_play_wav", True, "Play WAV")


def step_wait(seconds):
    """Wait mid-call."""
    log_info(f"Holding call for {seconds}s...")
    for i in range(seconds, 0, -1):
        print(f"  {DIM}  {i}s remaining...{RESET}", end="\r")
        time.sleep(1)
    print(" " * 30, end="\r")  # clear line
    log_ok(f"Waited {seconds}s")
    return record("6_wait", True, f"Wait {seconds}s mid-call")


def step_hangup(ep_url, call_id):
    """End the call."""
    log_info("Hanging up...")
    ok, _ = api("POST", f"{ep_url}/api/hangup", label="hangup",
                json={"callId": call_id})
    if not ok:
        return record("7_hangup", False, "Hang up call")
    log_ok("Call ended")
    return record("7_hangup", True, "Hang up call")


def step_get_latest_capture(ep_url):
    """
    Find the most recent capture entry. Returns (pcap_url, audio_url, audio_file)
    or (None, None, None) on failure.
    """
    log_info("Fetching latest capture...")
    ok, data = api("GET", f"{ep_url}/api/captures", label="list captures")
    if not ok or not data.get("captures"):
        log_fail("No captures found")
        record("8_download", False, "Download files")
        return None, None, None

    latest = data["captures"][0]  # newest first
    pcap_url   = latest.get("url")
    audio_url  = latest.get("audioUrl")
    audio_file = latest.get("audioFile")
    log_ok(f"Latest capture: {latest.get('filename')} | recording: {audio_file or 'none'}")
    return pcap_url, audio_url, audio_file


def step_get_latest_wav(ep_url):
    """Get the most recent WAV file entry. Returns filename or None."""
    log_info("Fetching latest WAV file...")
    ok, data = api("GET", f"{ep_url}/api/wavfiles", label="list WAV files")
    if not ok:
        return None
    files = data.get("files") or data.get("wavfiles") or []
    if not files:
        log_warn("No WAV files found on endpoint")
        return None
    latest = sorted(files, key=lambda f: f.get("created", ""), reverse=True)[0]
    name = latest.get("filename") or latest.get("name")
    log_ok(f"Latest WAV: {name}")
    return name


def step_download_files(ep_url, out_dir, pcap_url, audio_url, wav_filename):
    """Download PCAP, recording WAV, and playback WAV. Returns overall pass."""
    results = []

    if pcap_url:
        dest = os.path.join(out_dir, os.path.basename(pcap_url))
        results.append(download_file(f"{ep_url}{pcap_url}", dest, "PCAP capture"))
    else:
        log_warn("No PCAP to download")

    if audio_url:
        dest = os.path.join(out_dir, os.path.basename(audio_url))
        results.append(download_file(f"{ep_url}{audio_url}", dest, "Call recording"))
    else:
        log_warn("No call recording to download")

    if wav_filename:
        dest = os.path.join(out_dir, wav_filename)
        results.append(download_file(f"{ep_url}/wavfiles/{wav_filename}", dest, "WAV file"))
    else:
        log_warn("No WAV file to download")

    passed = bool(results) and all(results)
    return record("8_download", passed, "Download files")


def step_transcribe(ep_url, audio_file, tc_wait):
    """Start transcription and poll until done. Returns transcript filename or None."""
    log_info(f"Starting transcription of {audio_file}...")
    ok, data = api("POST", f"{ep_url}/api/transcribe/{audio_file}",
                   label="start transcription")
    if not ok:
        record("9_transcribe", False, "Transcribe recording")
        return None

    log_ok(f"Transcription queued (status: {data.get('status', 'processing')})")
    log_info(f"Polling for completion (up to {tc_wait}s)...")

    for elapsed in range(0, tc_wait, 3):
        time.sleep(3)
        _, status_data = api("GET", f"{ep_url}/api/transcribe/{audio_file}/status")
        status  = status_data.get("status")
        tc_file = status_data.get("transcriptFile")

        if status == "done":
            log_ok(f"Transcription complete ({elapsed + 3}s) — {tc_file}")
            record("9_transcribe", True, "Transcribe recording")
            return tc_file
        elif status == "error":
            log_fail(f"Transcription error: {status_data.get('error', 'unknown')}")
            record("9_transcribe", False, "Transcribe recording")
            return None
        elif elapsed % 15 == 0 and elapsed > 0:
            log_info(f"Still processing... ({elapsed}s elapsed)")

    log_fail(f"Transcription timed out after {tc_wait}s")
    record("9_transcribe", False, "Transcribe recording")
    return None


def step_download_transcript(ep_url, tc_file, out_dir):
    """Download the transcript as plain text."""
    if not tc_file:
        log_warn("No transcript file to download")
        return record("10_transcript", False, "Download transcript")

    dest = os.path.join(out_dir, tc_file.replace(".json", ".txt"))
    result = download_file(
        f"{ep_url}/api/transcripts/{tc_file}/text",
        dest,
        f"Transcript ({tc_file})"
    )
    return record("10_transcript", result, "Download transcript")


# ─── Summary ──────────────────────────────────────────────────────────────────

def print_summary(out_dir):
    step_order = [
        "1_register",
        "2_dial",
        "3_wait_answer",
        "4_record",
        "5_play_wav",
        "6_wait",
        "7_hangup",
        "8_download",
        "9_transcribe",
        "10_transcript",
    ]

    print(f"\n{BOLD}{'─' * 56}")
    print("  Results")
    print(f"{'─' * 56}{RESET}")

    passed = failed = skipped = 0
    for key in step_order:
        if key not in RESULTS:
            continue
        r = RESULTS[key]
        label = r["label"]
        v = r["passed"]
        if v is True:
            print(f"  {GREEN}✓{RESET}  {label}")
            passed += 1
        elif v is False:
            print(f"  {RED}✗{RESET}  {label}")
            failed += 1
        else:
            print(f"  {DIM}—  {label} (skipped){RESET}")
            skipped += 1

    print(f"\n  {GREEN}{passed} passed{RESET}  "
          f"{RED}{failed} failed{RESET}  "
          f"{DIM}{skipped} skipped{RESET}")
    if out_dir:
        print(f"\n  Output saved to: {out_dir}")
    print(f"{BOLD}{'─' * 56}{RESET}\n")


# ─── Main ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--ep1-url",       default="http://localhost:3000",
                   help="SIP endpoint 1 URL (default: http://localhost:3000)")
    p.add_argument("--sip-server",    default="192.168.1.127",
                   help="SIP server IP")
    p.add_argument("--ep1-user",      default="1112", help="SIP username")
    p.add_argument("--ep1-pass",      default="secret", help="SIP password")
    p.add_argument("--target",        default="1113",
                   help="Number or URI to dial (e.g. 1113 or 1113@192.168.1.127)")
    p.add_argument("--wav",           default=None,
                   help="WAV filename to play mid-call (must already be uploaded to EP1)")
    p.add_argument("--call-wait",     type=int, default=5,
                   help="Seconds to hold call after WAV before hanging up (default: 5)")
    p.add_argument("--answer-wait",   type=int, default=60,
                   help="Max seconds to wait for remote to answer (default: 60)")
    p.add_argument("--tc-wait",       type=int, default=120,
                   help="Max seconds to wait for transcription (default: 120)")
    p.add_argument("--out-dir",       default="./output",
                   help="Directory for downloaded files (default: ./output)")
    p.add_argument("--debug",         action="store_true",
                   help="Print all HTTP request/response bodies")
    p.add_argument("--no-record",     action="store_true", help="Skip recording")
    p.add_argument("--no-wav",        action="store_true", help="Skip WAV playback")
    p.add_argument("--no-transcribe", action="store_true", help="Skip transcription")
    return p.parse_args()


def main():
    global DEBUG
    args = parse_args()
    DEBUG = args.debug

    ts      = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(args.out_dir, ts)
    os.makedirs(out_dir, exist_ok=True)

    print(f"\n{BOLD}{'─' * 56}")
    print("  SIP Call Test")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'─' * 56}")
    print(f"  Endpoint : {args.ep1_url}")
    print(f"  SIP user : {args.ep1_user}@{args.sip_server}")
    print(f"  Target   : {args.target}")
    if args.wav:
        print(f"  WAV file : {args.wav}")
    if DEBUG:
        print(f"  {YELLOW}DEBUG mode on — all requests/responses will be logged{RESET}")
    print(f"{'─' * 56}{RESET}")

    # ── Step 1: Register ──────────────────────────────────────────────────────
    log_step(1, "Check & register EP1")
    if not step_register(args.ep1_url, args.sip_server, args.ep1_user, args.ep1_pass):
        log_fail("Cannot continue without registration")
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 2: Dial ──────────────────────────────────────────────────────────
    log_step(2, f"Dial {args.target}")
    call_id = step_dial(args.ep1_url, args.target, args.sip_server)
    if not call_id:
        log_fail("Cannot continue without an active call")
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 3: Wait for remote to answer ─────────────────────────────────────
    log_step(3, "Wait for remote to answer")
    if not step_wait_for_answer(args.ep1_url, timeout=args.answer_wait):
        log_warn("Call not confirmed — will still attempt hangup")
        step_hangup(args.ep1_url, call_id)
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 4: Start recording ───────────────────────────────────────────────
    log_step(4, "Start recording")
    if args.no_record:
        log_warn("Skipped (--no-record)")
        RESULTS["4_record"] = {"passed": None, "label": "Start recording"}
    else:
        step_start_recording(args.ep1_url, call_id)

    # ── Step 5: Play WAV ──────────────────────────────────────────────────────
    log_step(5, "Play WAV into call")
    if args.no_wav or not args.wav:
        msg = "--no-wav" if args.no_wav else "no --wav file specified"
        log_warn(f"Skipped ({msg})")
        RESULTS["5_play_wav"] = {"passed": None, "label": "Play WAV"}
    else:
        step_play_wav(args.ep1_url, args.wav)

    # ── Step 6: Wait ──────────────────────────────────────────────────────────
    log_step(6, f"Hold call for {args.call_wait}s")
    step_wait(args.call_wait)

    # ── Step 7: Hang up ───────────────────────────────────────────────────────
    log_step(7, "End call")
    step_hangup(args.ep1_url, call_id)
    time.sleep(2)  # allow teardown + file writes to complete

    # ── Step 8: Download files ────────────────────────────────────────────────
    log_step(8, "Download WAV + capture files")
    pcap_url, audio_url, audio_file = step_get_latest_capture(args.ep1_url)
    wav_filename = step_get_latest_wav(args.ep1_url)
    step_download_files(args.ep1_url, out_dir, pcap_url, audio_url, wav_filename)

    # ── Step 9: Transcribe ────────────────────────────────────────────────────
    log_step(9, "Transcribe recording")
    tc_file = None
    if args.no_transcribe:
        log_warn("Skipped (--no-transcribe)")
        RESULTS["9_transcribe"] = {"passed": None, "label": "Transcribe recording"}
    elif not audio_file:
        log_warn("Skipped — no recording found")
        RESULTS["9_transcribe"] = {"passed": None, "label": "Transcribe recording"}
    else:
        tc_file = step_transcribe(args.ep1_url, audio_file, args.tc_wait)

    # ── Step 10: Download transcript ──────────────────────────────────────────
    log_step(10, "Download transcript")
    if args.no_transcribe or not audio_file:
        log_warn("Skipped")
        RESULTS["10_transcript"] = {"passed": None, "label": "Download transcript"}
    else:
        step_download_transcript(args.ep1_url, tc_file, out_dir)

    # ── Summary ───────────────────────────────────────────────────────────────
    print_summary(out_dir)
    failed = sum(1 for r in RESULTS.values() if r["passed"] is False)
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
