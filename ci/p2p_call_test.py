#!/usr/bin/env python3
"""CI smoke test: two callraven instances register against a throwaway
Asterisk (started separately by the CI workflow), EP1 calls EP2, EP2
answers, the call reaches "connected" on both sides, then EP1 hangs up and
both sides go idle. Exits non-zero on any failure.

Unlike Sample Scripts/sip_call_p2p_test.py (a local dev tool, gitignored,
not run in CI), this script is intentionally minimal — no WAV playback, no
transcription — since it only needs to prove register/dial/answer/hangup
works end-to-end against a real PBX.
"""

import argparse
import sys
import time

import requests


def log(msg):
    print(msg, flush=True)


def fail(msg):
    print(f"FAIL: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def wait_for(predicate, timeout, description, interval=1):
    start = time.time()
    while time.time() - start < timeout:
        if predicate():
            return
        time.sleep(interval)
    fail(f"timed out after {timeout}s waiting for {description}")


def register(ep_url, server, port, username, password):
    resp = requests.post(f"{ep_url}/api/register", timeout=15, json={
        "server": server,
        "port": port,
        "username": username,
        "password": password,
        "transport": "UDP-RAW",
    })
    if resp.status_code != 200:
        fail(f"register {username}@{ep_url} -> HTTP {resp.status_code}: {resp.text}")
    log(f"OK: {username} registered via {ep_url}")


def status(ep_url):
    resp = requests.get(f"{ep_url}/api/status", timeout=15)
    resp.raise_for_status()
    return resp.json()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ep1-url", default="http://localhost:3000")
    p.add_argument("--ep2-url", default="http://localhost:3001")
    p.add_argument("--sip-server", default="127.0.0.1")
    p.add_argument("--sip-port", type=int, default=5060)
    p.add_argument("--ep1-user", default="1112")
    p.add_argument("--ep2-user", default="1113")
    p.add_argument("--password", default="secret")
    p.add_argument("--answer-wait", type=int, default=20)
    p.add_argument("--connect-wait", type=int, default=15)
    p.add_argument("--call-hold", type=int, default=3)
    p.add_argument("--teardown-wait", type=int, default=10)
    args = p.parse_args()

    log("Step 1: Register EP1 and EP2 against Asterisk")
    register(args.ep1_url, args.sip_server, args.sip_port, args.ep1_user, args.password)
    register(args.ep2_url, args.sip_server, args.sip_port, args.ep2_user, args.password)

    log("Step 2: EP1 dials EP2")
    target = f"{args.ep2_user}@{args.sip_server}"
    resp = requests.post(f"{args.ep1_url}/api/call", timeout=15, json={"target": target})
    if resp.status_code != 200:
        fail(f"EP1 call to {target} -> HTTP {resp.status_code}: {resp.text}")
    log(f"OK: EP1 dialing {target}")

    log("Step 3: Wait for EP2 to see the incoming call")
    wait_for(
        lambda: bool(status(args.ep2_url).get("incomingCall")),
        args.answer_wait, "EP2 incoming call",
    )
    log("OK: EP2 has an incoming call")

    log("Step 4: EP2 answers")
    resp = requests.post(f"{args.ep2_url}/api/answer", timeout=15)
    if resp.status_code != 200:
        fail(f"EP2 answer -> HTTP {resp.status_code}: {resp.text}")
    log("OK: EP2 answered")

    log("Step 5: Wait for both sides to report the call as connected")

    def both_connected():
        s1 = (status(args.ep1_url).get("activeCall") or {}).get("status")
        s2 = (status(args.ep2_url).get("activeCall") or {}).get("status")
        return s1 == "connected" and s2 == "connected"

    wait_for(both_connected, args.connect_wait, "both sides connected")
    log("OK: call connected on both sides")

    log(f"Step 6: Hold call for {args.call_hold}s")
    time.sleep(args.call_hold)

    log("Step 7: EP1 hangs up")
    resp = requests.post(f"{args.ep1_url}/api/hangup", timeout=15)
    if resp.status_code != 200:
        fail(f"EP1 hangup -> HTTP {resp.status_code}: {resp.text}")
    log("OK: EP1 hung up")

    log("Step 8: Wait for both sides to go idle")

    def both_idle():
        return not status(args.ep1_url).get("activeCall") and not status(args.ep2_url).get("activeCall")

    wait_for(both_idle, args.teardown_wait, "both sides idle after hangup")
    log("OK: call torn down cleanly on both sides")

    log("\nP2P call test PASSED")


if __name__ == "__main__":
    main()
