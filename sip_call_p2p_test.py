#!/usr/bin/env python3
"""
sip_call_p2p_test.py — Peer-to-peer call test using two SIP endpoints

EP1 registers and dials EP2. EP2 registers, auto-answers, and plays a WAV
into the call. All remaining actions (record, wait, hangup, download,
transcribe) run on EP1, matching the flow in sip_call_test.py.

Usage:
  python3 sip_call_p2p_test.py [options]

Required:
  --ep1-url     URL of endpoint 1          (default: http://localhost:3000)
  --ep2-url     URL of endpoint 2          (default: http://localhost:3001)
  --sip-server  SIP server IP              (default: 192.168.1.127)
  --ep1-user    EP1 SIP username           (default: 1112)
  --ep1-pass    EP1 SIP password           (default: secret)
  --ep2-user    EP2 SIP username           (default: 1113)
  --ep2-pass    EP2 SIP password           (default: secret)

Optional:
  --target      Number/URI for EP1 to dial; defaults to ep2-user@sip-server
  --wav         WAV filename for EP2 to play (must be uploaded to EP2)
  --call-wait   Seconds to hold call after WAV before hanging up (default: 5)
  --answer-wait Max seconds to wait for EP2 to receive the call  (default: 30)
  --tc-wait     Max seconds to wait for transcription             (default: 120)
  --out-dir     Output directory for downloads                    (default: ./output)
  --debug       Print all HTTP request/response details
  --no-record   Skip recording
  --no-wav      Skip WAV playback on EP2
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

def log_ok(msg):      print(f"  {GREEN}✓{RESET}  {msg}")
def log_fail(msg):    print(f"  {RED}✗{RESET}  {msg}")
def log_info(msg):    print(f"  {CYAN}→{RESET}  {msg}")
def log_warn(msg):    print(f"  {YELLOW}⚠{RESET}  {msg}")
def log_step(n, msg): print(f"\n{BOLD}Step {n}: {msg}{RESET}")
def log_debug(msg):   print(f"  {DIM}{msg}{RESET}")

# ─── Results tracker ──────────────────────────────────────────────────────────
RESULTS = {}

def record(key, passed, label=None):
    RESULTS[key] = {"passed": passed, "label": label or key}
    return passed

# ─── HTTP client ──────────────────────────────────────────────────────────────
DEBUG = False

def api(method, url, label="", **kwargs):
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

def step_register(ep_url, sip_server, username, password, result_key, label):
    log_info(f"Checking registration status for {username}@{sip_server}...")
    ok, data = api("GET", f"{ep_url}/api/status", label="status check")
    if not ok:
        return record(result_key, False, label)

    registered = (data.get("state") or {}).get("registered") or data.get("registered")

    if registered:
        log_ok(f"{label} already registered")
        return record(result_key, True, label)

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
        return record(result_key, False, label)

    log_info("Waiting for registration confirmation...")
    for _ in range(15):
        time.sleep(1)
        _, status = api("GET", f"{ep_url}/api/status")
        if (status.get("state") or {}).get("registered") or status.get("registered"):
            log_ok(f"{label} registered successfully")
            return record(result_key, True, label)

    log_fail(f"{label} registration timed out after 15s")
    return record(result_key, False, label)


def step_dial(ep1_url, target, sip_server):
    if "@" not in target:
        target_uri = f"{target}@{sip_server}"
    else:
        target_uri = target

    log_info(f"EP1 dialling {target_uri}...")
    ok, data = api("POST", f"{ep1_url}/api/call", label="dial",
                   json={"target": target_uri})
    if not ok:
        record("3_dial", False, "EP1 dial EP2")
        return None

    call_id = data.get("callId") or data.get("call_id")
    log_ok(f"Call initiated (callId: {call_id})")
    record("3_dial", True, "EP1 dial EP2")
    return call_id


def step_ep2_answer(ep2_url, timeout=30):
    """Poll EP2 until an incoming call arrives, then answer it."""
    log_info(f"Waiting for EP2 to receive the inbound call (timeout: {timeout}s)...")
    start = time.time()
    ep2_call_id = None

    while True:
        elapsed = int(time.time() - start)
        if elapsed >= timeout:
            log_fail(f"EP2 did not receive the call within {timeout}s")
            return record("4_ep2_answer", False, "EP2 answer call"), None

        _, data = api("GET", f"{ep2_url}/api/status")
        # Incoming calls sit in data["incomingCall"], not data["activeCall"]
        incoming = data.get("incomingCall")
        if incoming:
            ep2_call_id = incoming.get("callId") or incoming.get("id")
            log_ok(f"EP2 has incoming call from {incoming.get('from', '?')} — answering...")
            break

        if elapsed % 5 == 0 and elapsed > 0:
            log_info(f"Still waiting for EP2 inbound... {timeout - elapsed}s remaining")
        time.sleep(1)

    ok, _ = api("POST", f"{ep2_url}/api/answer", label="EP2 answer")
    if not ok:
        return record("4_ep2_answer", False, "EP2 answer call"), ep2_call_id

    # Confirm EP1 shows connected
    log_info("Confirming call is connected on EP1...")
    for _ in range(10):
        time.sleep(1)
        _, data = api("GET", f"{ep2_url}/api/status")
        active = (data.get("state") or {}).get("activeCall") or data.get("activeCall") or {}
        if active.get("status") in ("connected", "confirmed", "active"):
            log_ok("Call connected")
            return record("4_ep2_answer", True, "EP2 answer call"), ep2_call_id

    log_warn("EP2 answered but could not confirm connected state — continuing anyway")
    return record("4_ep2_answer", True, "EP2 answer call"), ep2_call_id


def step_ep2_play_wav(ep2_url, wav_filename):
    log_info(f"EP2 playing WAV: {wav_filename}")
    ok, data = api("POST", f"{ep2_url}/api/play", label="EP2 play WAV",
                   json={"filename": wav_filename})
    if not ok:
        return record("5_ep2_play_wav", False, "EP2 play WAV")
    log_ok("EP2 WAV playback started")
    return record("5_ep2_play_wav", True, "EP2 play WAV")


def step_start_recording(ep1_url, call_id):
    log_info("Starting recording on EP1...")
    ok, data = api("POST", f"{ep1_url}/api/record/start", label="start recording",
                   json={"callId": call_id})
    if not ok:
        return record("6_record", False, "EP1 start recording")
    log_ok(f"Recording started — {data.get('filename', '')}")
    return record("6_record", True, "EP1 start recording")


def step_wait(seconds):
    log_info(f"Holding call for {seconds}s...")
    for i in range(seconds, 0, -1):
        print(f"  {DIM}  {i}s remaining...{RESET}", end="\r")
        time.sleep(1)
    print(" " * 30, end="\r")
    log_ok(f"Waited {seconds}s")
    return record("7_wait", True, f"Wait {seconds}s mid-call")


def step_hangup(ep1_url, call_id):
    log_info("EP1 hanging up...")
    ok, _ = api("POST", f"{ep1_url}/api/hangup", label="hangup",
                json={"callId": call_id})
    if not ok:
        return record("8_hangup", False, "EP1 hang up call")
    log_ok("Call ended")
    return record("8_hangup", True, "EP1 hang up call")


def step_get_latest_capture(ep1_url):
    log_info("Fetching latest capture from EP1...")
    ok, data = api("GET", f"{ep1_url}/api/captures", label="list captures")
    if not ok or not data.get("captures"):
        log_fail("No captures found")
        record("9_download", False, "Download files")
        return None, None, None

    latest = data["captures"][0]
    pcap_url   = latest.get("url")
    audio_url  = latest.get("audioUrl")
    audio_file = latest.get("audioFile")
    log_ok(f"Latest capture: {latest.get('filename')} | recording: {audio_file or 'none'}")
    return pcap_url, audio_url, audio_file


def step_get_latest_wav(ep1_url):
    log_info("Fetching latest WAV file from EP1...")
    ok, data = api("GET", f"{ep1_url}/api/wavfiles", label="list WAV files")
    if not ok:
        return None
    files = data.get("files") or data.get("wavfiles") or []
    if not files:
        log_warn("No WAV files found on EP1")
        return None
    latest = sorted(files, key=lambda f: f.get("created", ""), reverse=True)[0]
    name = latest.get("filename") or latest.get("name")
    log_ok(f"Latest WAV on EP1: {name}")
    return name


def step_download_files(ep1_url, out_dir, pcap_url, audio_url, wav_filename):
    results = []

    if pcap_url:
        dest = os.path.join(out_dir, os.path.basename(pcap_url))
        results.append(download_file(f"{ep1_url}{pcap_url}", dest, "PCAP capture"))
    else:
        log_warn("No PCAP to download")

    if audio_url:
        dest = os.path.join(out_dir, os.path.basename(audio_url))
        results.append(download_file(f"{ep1_url}{audio_url}", dest, "Call recording"))
    else:
        log_warn("No call recording to download")

    if wav_filename:
        dest = os.path.join(out_dir, wav_filename)
        results.append(download_file(f"{ep1_url}/wavfiles/{wav_filename}", dest, "WAV file"))
    else:
        log_warn("No WAV file to download")

    passed = bool(results) and all(results)
    return record("9_download", passed, "Download files")


def step_transcribe(ep1_url, audio_file, tc_wait):
    log_info(f"Starting transcription of {audio_file}...")
    ok, data = api("POST", f"{ep1_url}/api/transcribe/{audio_file}",
                   label="start transcription")
    if not ok:
        record("10_transcribe", False, "Transcribe recording")
        return None

    log_ok(f"Transcription queued (status: {data.get('status', 'processing')})")
    log_info(f"Polling for completion (up to {tc_wait}s)...")

    for elapsed in range(0, tc_wait, 3):
        time.sleep(3)
        _, status_data = api("GET", f"{ep1_url}/api/transcribe/{audio_file}/status")
        status  = status_data.get("status")
        tc_file = status_data.get("transcriptFile")

        if status == "done":
            log_ok(f"Transcription complete ({elapsed + 3}s) — {tc_file}")
            record("10_transcribe", True, "Transcribe recording")
            return tc_file
        elif status == "error":
            log_fail(f"Transcription error: {status_data.get('error', 'unknown')}")
            record("10_transcribe", False, "Transcribe recording")
            return None
        elif elapsed % 15 == 0 and elapsed > 0:
            log_info(f"Still processing... ({elapsed}s elapsed)")

    log_fail(f"Transcription timed out after {tc_wait}s")
    record("10_transcribe", False, "Transcribe recording")
    return None


def step_download_transcript(ep1_url, tc_file, out_dir):
    if not tc_file:
        log_warn("No transcript file to download")
        return record("11_transcript", False, "Download transcript")

    dest = os.path.join(out_dir, tc_file.replace(".json", ".txt"))
    result = download_file(
        f"{ep1_url}/api/transcripts/{tc_file}/text",
        dest,
        f"Transcript ({tc_file})"
    )
    return record("11_transcript", result, "Download transcript")


# ─── Summary ──────────────────────────────────────────────────────────────────

def print_summary(out_dir):
    step_order = [
        "1_register_ep1",
        "2_register_ep2",
        "3_dial",
        "4_ep2_answer",
        "5_ep2_play_wav",
        "6_record",
        "7_wait",
        "8_hangup",
        "9_download",
        "10_transcribe",
        "11_transcript",
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
    p.add_argument("--ep2-url",       default="http://localhost:3001",
                   help="SIP endpoint 2 URL (default: http://localhost:3001)")
    p.add_argument("--sip-server",    default="192.168.1.127",
                   help="SIP server IP")
    p.add_argument("--ep1-user",      default="1112", help="EP1 SIP username")
    p.add_argument("--ep1-pass",      default="secret", help="EP1 SIP password")
    p.add_argument("--ep2-user",      default="1113", help="EP2 SIP username")
    p.add_argument("--ep2-pass",      default="secret", help="EP2 SIP password")
    p.add_argument("--target",        default=None,
                   help="Number or URI for EP1 to dial (default: ep2-user@sip-server)")
    p.add_argument("--wav",           default=None,
                   help="WAV filename for EP2 to play mid-call (must be uploaded to EP2)")
    p.add_argument("--call-wait",     type=int, default=5,
                   help="Seconds to hold call after WAV before hanging up (default: 5)")
    p.add_argument("--answer-wait",   type=int, default=30,
                   help="Max seconds to wait for EP2 to receive the call (default: 30)")
    p.add_argument("--tc-wait",       type=int, default=120,
                   help="Max seconds to wait for transcription (default: 120)")
    p.add_argument("--out-dir",       default="./output",
                   help="Directory for downloaded files (default: ./output)")
    p.add_argument("--debug",         action="store_true",
                   help="Print all HTTP request/response bodies")
    p.add_argument("--no-record",     action="store_true", help="Skip EP1 recording")
    p.add_argument("--no-wav",        action="store_true", help="Skip EP2 WAV playback")
    p.add_argument("--no-transcribe", action="store_true", help="Skip transcription")
    return p.parse_args()


def main():
    global DEBUG
    args = parse_args()
    DEBUG = args.debug

    target = args.target or f"{args.ep2_user}@{args.sip_server}"

    ts      = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(args.out_dir, ts)
    os.makedirs(out_dir, exist_ok=True)

    print(f"\n{BOLD}{'─' * 56}")
    print("  SIP P2P Call Test")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'─' * 56}")
    print(f"  EP1      : {args.ep1_url}  ({args.ep1_user}@{args.sip_server})")
    print(f"  EP2      : {args.ep2_url}  ({args.ep2_user}@{args.sip_server})")
    print(f"  Target   : {target}")
    if args.wav:
        print(f"  WAV file : {args.wav}  (played by EP2)")
    if DEBUG:
        print(f"  {YELLOW}DEBUG mode on — all requests/responses will be logged{RESET}")
    print(f"{'─' * 56}{RESET}")

    # ── Step 1: Register EP1 ──────────────────────────────────────────────────
    log_step(1, "Check & register EP1")
    if not step_register(args.ep1_url, args.sip_server, args.ep1_user, args.ep1_pass,
                         "1_register_ep1", "Register EP1"):
        log_fail("Cannot continue without EP1 registration")
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 2: Register EP2 ──────────────────────────────────────────────────
    log_step(2, "Check & register EP2")
    if not step_register(args.ep2_url, args.sip_server, args.ep2_user, args.ep2_pass,
                         "2_register_ep2", "Register EP2"):
        log_fail("Cannot continue without EP2 registration")
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 3: EP1 dials EP2 ─────────────────────────────────────────────────
    log_step(3, f"EP1 dials {target}")
    call_id = step_dial(args.ep1_url, target, args.sip_server)
    if not call_id:
        log_fail("Cannot continue without an active call")
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 4: EP2 answers ───────────────────────────────────────────────────
    log_step(4, "EP2 auto-answers incoming call")
    answered, ep2_call_id = step_ep2_answer(args.ep2_url, timeout=args.answer_wait)
    if not answered:
        log_warn("EP2 did not answer — attempting EP1 hangup")
        step_hangup(args.ep1_url, call_id)
        print_summary(out_dir)
        sys.exit(1)

    # ── Step 5: EP2 plays WAV ─────────────────────────────────────────────────
    log_step(5, "EP2 plays WAV into call")
    if args.no_wav or not args.wav:
        msg = "--no-wav" if args.no_wav else "no --wav file specified"
        log_warn(f"Skipped ({msg})")
        RESULTS["5_ep2_play_wav"] = {"passed": None, "label": "EP2 play WAV"}
    else:
        step_ep2_play_wav(args.ep2_url, args.wav)

    # ── Step 6: EP1 starts recording ─────────────────────────────────────────
    log_step(6, "EP1 starts recording")
    if args.no_record:
        log_warn("Skipped (--no-record)")
        RESULTS["6_record"] = {"passed": None, "label": "EP1 start recording"}
    else:
        step_start_recording(args.ep1_url, call_id)

    # ── Step 7: Wait ──────────────────────────────────────────────────────────
    log_step(7, f"Hold call for {args.call_wait}s")
    step_wait(args.call_wait)

    # ── Step 8: EP1 hangs up ──────────────────────────────────────────────────
    log_step(8, "EP1 ends call")
    step_hangup(args.ep1_url, call_id)
    time.sleep(2)  # allow teardown + file writes to complete

    # ── Step 9: Download files from EP1 ───────────────────────────────────────
    log_step(9, "Download WAV + capture files from EP1")
    pcap_url, audio_url, audio_file = step_get_latest_capture(args.ep1_url)
    wav_filename = step_get_latest_wav(args.ep1_url)
    step_download_files(args.ep1_url, out_dir, pcap_url, audio_url, wav_filename)

    # ── Step 10: Transcribe ───────────────────────────────────────────────────
    log_step(10, "Transcribe EP1 recording")
    tc_file = None
    if args.no_transcribe:
        log_warn("Skipped (--no-transcribe)")
        RESULTS["10_transcribe"] = {"passed": None, "label": "Transcribe recording"}
    elif not audio_file:
        log_warn("Skipped — no recording found")
        RESULTS["10_transcribe"] = {"passed": None, "label": "Transcribe recording"}
    else:
        tc_file = step_transcribe(args.ep1_url, audio_file, args.tc_wait)

    # ── Step 11: Download transcript ──────────────────────────────────────────
    log_step(11, "Download transcript")
    if args.no_transcribe or not audio_file:
        log_warn("Skipped")
        RESULTS["11_transcript"] = {"passed": None, "label": "Download transcript"}
    else:
        step_download_transcript(args.ep1_url, tc_file, out_dir)

    # ── Summary ───────────────────────────────────────────────────────────────
    print_summary(out_dir)
    failed = sum(1 for r in RESULTS.values() if r["passed"] is False)
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
