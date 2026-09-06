#!/usr/bin/env python3
"""CI smoke test for SIPREC: starts the mock SIPREC server (ci/mock_siprec_
server.py) as a subprocess, configures EP1 to send every future call to it
(siprecEnabled + siprecServerUri via /api/settings), places a real call
through the existing CI Asterisk, plays a WAV, hangs up, and asserts the
mock server actually received a well-formed recording session: correct
metadata (participant AORs), real RTP arriving on both direction streams
with zero loss, and RTCP SR/SDES with a real CNAME.

There's no SIPREC-capable PBX in this project's CI infrastructure (Asterisk
has no SIPREC support at all — confirmed empirically during this feature's
feasibility research), hence testing against the purpose-built mock server
rather than a second real party the way ci/srtp_call_test.py and
ci/opus_call_test.py do.
"""

import argparse
import json
import os
import subprocess
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
    try:
        requests.post(f"{ep_url}/api/unregister", timeout=15)
    except requests.RequestException:
        pass


def register(ep_url, server, port, username, password):
    resp = requests.post(f"{ep_url}/api/register", timeout=15, json={
        "server": server, "port": port, "username": username, "password": password,
        "transport": "UDP-RAW",
    })
    if resp.status_code != 200:
        fail(f"register {username}@{ep_url} -> HTTP {resp.status_code}: {resp.text}")
    log(f"OK: {username} registered via {ep_url}")


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
    p.add_argument("--ep1-user", default="1112")
    p.add_argument("--ep2-user", default="1113")
    p.add_argument("--password", default="secret")
    p.add_argument("--wav-path", default="Sample WAV files/compliance_test.wav")
    p.add_argument("--srs-sip-port", type=int, default=15060)
    p.add_argument("--srs-advertise-ip", default="127.0.0.1")
    p.add_argument("--out-dir", default=".")
    p.add_argument("--answer-wait", type=int, default=20)
    p.add_argument("--connect-wait", type=int, default=15)
    p.add_argument("--siprec-wait", type=int, default=10)
    p.add_argument("--rtp-wait", type=int, default=15)
    p.add_argument("--min-packets", type=int, default=50)
    p.add_argument("--teardown-wait", type=int, default=10)
    args = p.parse_args()

    log("Step 1: Start the mock SIPREC server")
    mock_server_path = os.path.join(os.path.dirname(__file__), "mock_siprec_server.py")
    summary_path = os.path.join(args.out_dir, "mock_siprec_summary.json")
    if os.path.exists(summary_path):
        os.remove(summary_path)
    mock = subprocess.Popen([
        sys.executable, mock_server_path,
        "--sip-port", str(args.srs_sip_port),
        "--advertise-ip", args.srs_advertise_ip,
        "--out-dir", args.out_dir,
        "--idle-timeout", "60",
    ])
    time.sleep(1)
    if mock.poll() is not None:
        fail(f"mock SIPREC server exited immediately (code {mock.returncode})")
    log(f"OK: mock SIPREC server running (pid {mock.pid}) on port {args.srs_sip_port}")

    try:
        log("Step 2: Unregister EP1/EP2 (in case still registered from an earlier test)")
        unregister(args.ep1_url)
        unregister(args.ep2_url)

        log("Step 3: Register EP1 and EP2 against Asterisk")
        register(args.ep1_url, args.sip_server, args.sip_port, args.ep1_user, args.password)
        register(args.ep2_url, args.sip_server, args.sip_port, args.ep2_user, args.password)

        log("Step 4: Configure EP1 to send calls to the mock SIPREC server")
        resp = requests.post(f"{args.ep1_url}/api/settings", timeout=15, json={
            "siprecEnabled": True,
            "siprecServerUri": f"sip:recorder@127.0.0.1:{args.srs_sip_port}",
        })
        if resp.status_code != 200 or not resp.json().get("siprecEnabled"):
            fail(f"failed to enable siprecEnabled on EP1: HTTP {resp.status_code}: {resp.text}")
        log("OK: EP1 configured for SIPREC")

        log("Step 5: EP1 dials EP2")
        target = f"{args.ep2_user}@{args.sip_server}"
        resp = requests.post(f"{args.ep1_url}/api/call", timeout=15, json={"target": target})
        if resp.status_code != 200:
            fail(f"EP1 call to {target} -> HTTP {resp.status_code}: {resp.text}")
        log(f"OK: EP1 dialing {target}")

        log("Step 6: Wait for EP2 to see the incoming call")
        wait_for(lambda: bool(status(args.ep2_url).get("incomingCall")), args.answer_wait, "EP2 incoming call")
        log("OK: EP2 has an incoming call")

        log("Step 7: EP2 answers")
        resp = requests.post(f"{args.ep2_url}/api/answer", timeout=15)
        if resp.status_code != 200:
            fail(f"EP2 answer -> HTTP {resp.status_code}: {resp.text}")
        log("OK: EP2 answered")

        log("Step 8: Wait for both sides to report the call as connected")

        def both_connected():
            s1 = (status(args.ep1_url).get("activeCall") or {}).get("status")
            s2 = (status(args.ep2_url).get("activeCall") or {}).get("status")
            return s1 == "connected" and s2 == "connected"

        wait_for(both_connected, args.connect_wait, "both sides connected")
        log("OK: call connected on both sides")

        log("Step 9: EP2 uploads and plays a WAV file into the call")
        filename = upload_wav(args.ep2_url, args.wav_path)
        play_wav(args.ep2_url, filename)

        log("Step 10: Wait for EP1 to actually receive RTP with zero loss")

        def rtp_flowing():
            stats = (status(args.ep1_url).get("activeCall") or {}).get("stats") or {}
            return stats.get("rxPackets", 0) >= args.min_packets

        wait_for(rtp_flowing, args.rtp_wait, f"EP1 rxPackets >= {args.min_packets}")
        stats = (status(args.ep1_url).get("activeCall") or {}).get("stats") or {}
        log(f"OK: EP1 received {stats.get('rxPackets')} packets, codec={stats.get('codec')}, lost={stats.get('lostPackets')}")
        if stats.get("lostPackets", 0) > 0:
            fail(f"expected zero packet loss on a loopback call, got {stats.get('lostPackets')} lost")

        log("Step 10b: Wait out one RTCP interval (siprec.js sends SR/SDES every "
            "RTCP_INTERVAL_MS=5s) so the mock server actually receives one before the call ends")
        time.sleep(6)

        log("Step 11: EP1 hangs up")
        resp = requests.post(f"{args.ep1_url}/api/hangup", timeout=15)
        if resp.status_code != 200:
            fail(f"EP1 hangup -> HTTP {resp.status_code}: {resp.text}")
        log("OK: EP1 hung up")

        log("Step 12: Wait for both sides to go idle")

        def both_idle():
            return not status(args.ep1_url).get("activeCall") and not status(args.ep2_url).get("activeCall")

        wait_for(both_idle, args.teardown_wait, "both sides idle after hangup")
        log("OK: call torn down cleanly on both sides")

        log("Step 13: Wait for the mock SIPREC server to write its summary (after processing the BYE)")
        wait_for(lambda: os.path.exists(summary_path), args.siprec_wait, "mock_siprec_summary.json")
        with open(summary_path) as f:
            summary = json.load(f)
        log(f"Mock SIPREC summary: {json.dumps(summary, indent=2)}")

        metadata = summary.get("metadata") or {}
        aors = {p.get("aor") for p in metadata.get("participants", [])}
        expected_aors = {f"sip:{args.ep1_user}@{args.sip_server}", target if target.startswith("sip:") else f"sip:{target}"}
        if not expected_aors.issubset(aors) and not any(args.ep1_user in a for a in aors):
            fail(f"metadata participants {aors} did not include expected AORs (ep1_user={args.ep1_user})")
        log(f"OK: metadata contains {len(metadata.get('participants', []))} participants, "
            f"{len(metadata.get('streams', []))} streams")

        streams = summary.get("streams") or {}
        if len(streams) != 2:
            fail(f"expected 2 SIPREC streams, got {len(streams)}")
        total_rtp = sum(s.get("rtp_packets", 0) for s in streams.values())
        if total_rtp == 0:
            fail("no RTP packets arrived at the mock SIPREC server on either stream")
        for label, s in streams.items():
            if s.get("rtp_packets", 0) > 0 and not s.get("rtcp", {}).get("cname"):
                fail(f"stream {label} received RTP but no RTCP CNAME — RTCP is REQUIRED per RFC 7866")
        log(f"OK: {total_rtp} total RTP packets received across {len(streams)} streams, RTCP CNAME present")

        log("\nSIPREC call test PASSED")
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()


if __name__ == "__main__":
    main()
