#!/usr/bin/env python3
"""CI smoke test for SRTP: two callraven instances enable secureMediaEnabled,
register against the dedicated SRTP-only Asterisk endpoints (1115/1116,
media_encryption=sdes — see ci/asterisk/pjsip.conf), EP1 calls EP2, EP2
answers, EP2 plays a WAV file into the call, and EP1 is checked for actual
RTP packets arriving with zero loss.

Checking real packet flow (not just SIP-level connect/hangup, which is all
ci/p2p_call_test.py checks) matters here specifically: the SRTP encrypt/
decrypt math failing silently is exactly the kind of bug that still lets
the SIP call connect normally while leaving the RTP audio path dead — see
the commit that added SRTP for the two crypto bugs that caused this before
they were caught by testing against a real call, not just unit tests.

Assumes EP1/EP2 are the same two callraven instances used by
ci/p2p_call_test.py, run immediately after it in the same CI job (so this
script re-registers them under different credentials rather than needing
its own containers). Exits non-zero on any failure.
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


def unregister(ep_url):
    # Best-effort — fine if already unregistered or never registered.
    try:
        requests.post(f"{ep_url}/api/unregister", timeout=15)
    except requests.RequestException:
        pass


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


def set_secure_media(ep_url, enabled):
    resp = requests.post(f"{ep_url}/api/settings", timeout=15, json={"secureMediaEnabled": enabled})
    if resp.status_code != 200:
        fail(f"POST {ep_url}/api/settings secureMediaEnabled={enabled} -> HTTP {resp.status_code}: {resp.text}")
    log(f"OK: secureMediaEnabled={enabled} on {ep_url}")


def status(ep_url):
    resp = requests.get(f"{ep_url}/api/status", timeout=15)
    resp.raise_for_status()
    return resp.json()


def upload_wav(ep_url, wav_path):
    with open(wav_path, "rb") as f:
        resp = requests.post(f"{ep_url}/api/wavfiles/upload", timeout=30, files={"file": f})
    if resp.status_code != 200:
        fail(f"upload {wav_path} to {ep_url} -> HTTP {resp.status_code}: {resp.text}")
    filename = resp.json()["filename"]
    log(f"OK: uploaded {wav_path} to {ep_url} as {filename}")
    return filename


def play_wav(ep_url, filename):
    resp = requests.post(f"{ep_url}/api/play", timeout=15, json={"filename": filename})
    if resp.status_code != 200:
        fail(f"play {filename} on {ep_url} -> HTTP {resp.status_code}: {resp.text}")
    log(f"OK: {ep_url} playing {filename}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ep1-url", default="http://localhost:3000")
    p.add_argument("--ep2-url", default="http://localhost:3001")
    p.add_argument("--sip-server", default="127.0.0.1")
    p.add_argument("--sip-port", type=int, default=5060)
    p.add_argument("--ep1-user", default="1115")
    p.add_argument("--ep2-user", default="1116")
    p.add_argument("--password", default="secret")
    p.add_argument("--wav-path", default="Sample WAV files/compliance_test.wav")
    p.add_argument("--answer-wait", type=int, default=20)
    p.add_argument("--connect-wait", type=int, default=15)
    p.add_argument("--rtp-wait", type=int, default=15)
    p.add_argument("--min-packets", type=int, default=50)
    p.add_argument("--teardown-wait", type=int, default=10)
    args = p.parse_args()

    log("Step 1: Unregister EP1/EP2 (in case still registered from an earlier test)")
    unregister(args.ep1_url)
    unregister(args.ep2_url)

    log("Step 2: Enable secureMediaEnabled on EP1 and EP2")
    set_secure_media(args.ep1_url, True)
    set_secure_media(args.ep2_url, True)

    log("Step 3: Register EP1 and EP2 against the dedicated SRTP endpoints")
    register(args.ep1_url, args.sip_server, args.sip_port, args.ep1_user, args.password)
    register(args.ep2_url, args.sip_server, args.sip_port, args.ep2_user, args.password)

    log("Step 4: EP1 dials EP2")
    target = f"{args.ep2_user}@{args.sip_server}"
    resp = requests.post(f"{args.ep1_url}/api/call", timeout=15, json={"target": target})
    if resp.status_code != 200:
        fail(f"EP1 call to {target} -> HTTP {resp.status_code}: {resp.text}")
    log(f"OK: EP1 dialing {target}")

    log("Step 5: Wait for EP2 to see the incoming call")
    wait_for(
        lambda: bool(status(args.ep2_url).get("incomingCall")),
        args.answer_wait, "EP2 incoming call",
    )
    log("OK: EP2 has an incoming call")

    log("Step 6: EP2 answers")
    resp = requests.post(f"{args.ep2_url}/api/answer", timeout=15)
    if resp.status_code != 200:
        fail(f"EP2 answer -> HTTP {resp.status_code}: {resp.text}")
    log("OK: EP2 answered")

    log("Step 7: Wait for both sides to report the call as connected")

    def both_connected():
        s1 = (status(args.ep1_url).get("activeCall") or {}).get("status")
        s2 = (status(args.ep2_url).get("activeCall") or {}).get("status")
        return s1 == "connected" and s2 == "connected"

    wait_for(both_connected, args.connect_wait, "both sides connected")
    log("OK: call connected on both sides")

    log("Step 8: EP2 uploads and plays a WAV file into the call")
    filename = upload_wav(args.ep2_url, args.wav_path)
    play_wav(args.ep2_url, filename)

    log("Step 9: Wait for EP1 to actually receive decrypted RTP with zero loss")

    def rtp_flowing():
        stats = (status(args.ep1_url).get("activeCall") or {}).get("stats") or {}
        return stats.get("rxPackets", 0) >= args.min_packets

    wait_for(rtp_flowing, args.rtp_wait, f"EP1 rxPackets >= {args.min_packets}")
    stats = (status(args.ep1_url).get("activeCall") or {}).get("stats") or {}
    log(f"OK: EP1 received {stats.get('rxPackets')} packets, codec={stats.get('codec')}, "
        f"lost={stats.get('lostPackets')}, loss%={stats.get('lossPercent')}")
    if stats.get("lostPackets", 0) > 0:
        fail(f"expected zero packet loss on a loopback call, got {stats.get('lostPackets')} lost")

    log("Step 10: EP1 hangs up")
    resp = requests.post(f"{args.ep1_url}/api/hangup", timeout=15)
    if resp.status_code != 200:
        fail(f"EP1 hangup -> HTTP {resp.status_code}: {resp.text}")
    log("OK: EP1 hung up")

    log("Step 11: Wait for both sides to go idle")

    def both_idle():
        return not status(args.ep1_url).get("activeCall") and not status(args.ep2_url).get("activeCall")

    wait_for(both_idle, args.teardown_wait, "both sides idle after hangup")
    log("OK: call torn down cleanly on both sides")

    log("Step 12: Disable secureMediaEnabled again — it's a global setting, and a later CI "
        "step reusing these same endpoints (e.g. a plain P2P call) would otherwise inherit "
        "SRTP-mode SDP (RTP/SAVP) against endpoints that never negotiate it, and fail with "
        "Asterisk's 'Couldn't negotiate stream ... (nothing)' for reasons that look nothing "
        "like an SRTP problem")
    set_secure_media(args.ep1_url, False)
    set_secure_media(args.ep2_url, False)

    log("\nSRTP call test PASSED")


if __name__ == "__main__":
    main()
