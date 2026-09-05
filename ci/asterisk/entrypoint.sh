#!/bin/bash
# This Ubuntu-packaged Asterisk build loads the deprecated chan_sip module
# by default alongside chan_pjsip. chan_sip has its own older SIP-over-
# WebSocket support and registers the shared "sip" protocol name with
# res_http_websocket before res_pjsip_transport_websocket gets a chance to
# — so PJSIP's WS transport silently loses that registration and never
# comes up (no error at the point of failure; only a generic "declined to
# load" in the loader's post-boot summary). A static `noload => chan_sip.so`
# in modules.conf does not prevent this on this build (verified: chan_sip
# still loads regardless — the underlying reason wasn't tracked down
# further), so instead we unload chan_sip and load the PJSIP transport
# explicitly, right after Asterisk finishes booting. Confirmed manually:
# `module unload chan_sip.so` immediately followed by
# `module load res_pjsip_transport_websocket.so` succeeds every time.
set -e

asterisk -f &
ASTERISK_PID=$!
trap 'kill "$ASTERISK_PID" 2>/dev/null' TERM INT

for i in $(seq 1 30); do
  if asterisk -rx "core show version" >/dev/null 2>&1; then break; fi
  sleep 1
done

asterisk -rx "module unload chan_sip.so" >/dev/null 2>&1 || true
asterisk -rx "module load res_pjsip_transport_websocket.so" >/dev/null 2>&1 || true

wait "$ASTERISK_PID"
