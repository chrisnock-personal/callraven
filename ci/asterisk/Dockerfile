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
    rm -rf /var/lib/apt/lists/*

COPY pjsip.conf /etc/asterisk/pjsip.conf
COPY extensions.conf /etc/asterisk/extensions.conf
COPY rtp.conf /etc/asterisk/rtp.conf
COPY http.conf /etc/asterisk/http.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5060/udp
EXPOSE 8088/tcp
EXPOSE 19500-19999/udp

CMD ["/entrypoint.sh"]
