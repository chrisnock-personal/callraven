# Minimal throwaway Asterisk registrar/proxy used only in CI to give the
# P2P call test (ci/p2p_call_test.py) a real PBX to register two callraven
# instances against and route a call between them. Not used in production.
# Debian's default apt sources don't carry an "asterisk" package at all
# (dropped from stable's default component set) — Ubuntu's universe
# component does, so that's the base here instead.
FROM ubuntu:24.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends software-properties-common && \
    add-apt-repository -y universe && \
    apt-get update && \
    apt-get install -y --no-install-recommends asterisk && \
    rm -rf /var/lib/apt/lists/* && \
    # This package ships the deprecated chan_sip module loaded by default
    # alongside chan_pjsip. chan_sip has its own older SIP-over-WebSocket
    # support and registers the shared "sip" protocol name with
    # res_http_websocket before res_pjsip_transport_websocket (the module
    # our WS transport below actually needs) gets a chance to — so PJSIP's
    # WS transport silently loses that registration and never comes up (no
    # error at the point of failure, only a generic "declined to load" in
    # the loader's post-boot summary). Deleting the module file entirely
    # is simpler and more reliable than a modules.conf `noload` (which
    # didn't take effect on this build for an untracked reason) or an
    # unload-then-reload dance after boot (which left the WS transport
    # module in a subtly broken state — registration worked, but routing
    # an actual call to a WS-registered contact failed with a spurious
    # "busy/congested", confirmed to go away once chan_sip is out of the
    # picture from the very first module-load pass).
    rm -f /usr/lib/*/asterisk/modules/chan_sip.so

COPY pjsip.conf /etc/asterisk/pjsip.conf
COPY extensions.conf /etc/asterisk/extensions.conf
COPY rtp.conf /etc/asterisk/rtp.conf
COPY http.conf /etc/asterisk/http.conf

EXPOSE 5060/udp
EXPOSE 8088/tcp
EXPOSE 19500-19999/udp

CMD ["asterisk", "-f"]
