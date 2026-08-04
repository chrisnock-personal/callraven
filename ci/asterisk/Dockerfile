# Minimal throwaway Asterisk registrar/proxy used only in CI to give the
# P2P call test (ci/p2p_call_test.py) a real PBX to register two callraven
# instances against and route a call between them. Not used in production.
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends asterisk && \
    rm -rf /var/lib/apt/lists/*

COPY pjsip.conf /etc/asterisk/pjsip.conf
COPY extensions.conf /etc/asterisk/extensions.conf
COPY rtp.conf /etc/asterisk/rtp.conf

EXPOSE 5060/udp
EXPOSE 19500-19999/udp

CMD ["asterisk", "-f"]
