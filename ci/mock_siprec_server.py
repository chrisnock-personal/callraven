#!/usr/bin/env python3
"""Minimal mock SIPREC SRS (Session Recording Server) for testing CallRaven's
SIPREC SRC support (backend/siprec.js) — there's no real SIPREC-capable PBX
in this project's existing CI infrastructure (Asterisk has no SIPREC
support at all, confirmed empirically during the feasibility research for
this feature), so this stands in as the "real second party" to test
against.

Handles exactly the one flow CallRaven's SiprecClient produces: a single
recording-session INVITE (Require: siprec, multipart/mixed body with an SDP
part and an application/rs-metadata part), replies 200 OK with an SDP
answer allocating one local recvonly UDP port per offered stream (each
using a=rtcp-mux, matching the offer), accepts the ACK, receives RTP+RTCP
on those ports, and tears down on BYE — writing a JSON summary (parsed
metadata, per-stream packet/byte counts, RTCP CNAME/counts) plus a decoded
WAV per stream when the codec is one this script can decode without
external dependencies (PCMU/PCMA — G.722/Opus payloads are counted but not
PCM-decoded here, since decoding those needs ffmpeg/libopus which this
lightweight test harness deliberately doesn't depend on; CallRaven's own
audio-content correctness for those codecs is already covered by
ci/opus_call_test.py and the recording-decode checks used during the
SRTP/Opus work).

No third-party dependencies — standard library only.
"""

import argparse
import json
import re
import select
import socket
import struct
import sys
import time
import wave
import xml.etree.ElementTree as ET

RECORDING_XMLNS = '{urn:ietf:params:xml:ns:recording:1}'

ULAW_TABLE = []
ALAW_TABLE = []
for _i in range(256):
    _u = ~_i & 0xff
    _t = ((_u & 0x0f) << 3) + 132
    _t <<= (_u & 0x70) >> 4
    ULAW_TABLE.append((132 - _t) if (_u & 0x80) else (_t - 132))
    _a = _i ^ 0x55
    _s = (_a & 0x0f) << 4
    _exp = (_a & 0x70) >> 4
    if _exp > 0:
        _s += 0x100
    if _exp > 1:
        _s <<= (_exp - 1)
    ALAW_TABLE.append(-_s if (_a & 0x80) else _s)


def log(msg):
    print(f"[mock-siprec] {msg}", flush=True)


def clamp16(v):
    return max(-32768, min(32767, v))


def parse_sip_message(data):
    text = data.decode('utf8', errors='replace')
    header_end = text.find('\r\n\r\n')
    header_text = text[:header_end] if header_end >= 0 else text
    body = text[header_end + 4:] if header_end >= 0 else ''
    lines = header_text.split('\r\n')
    first_line = lines[0]
    headers = {}
    for line in lines[1:]:
        m = re.match(r'^([^:]+):\s*(.*)$', line)
        if m:
            headers[m.group(1).strip().lower()] = m.group(2).strip()
    return first_line, headers, body


def parse_multipart(content_type, body):
    m = re.search(r'boundary=("?)([^"; ]+)\1', content_type)
    if not m:
        return []
    boundary = m.group(2)
    parts = body.split(f'--{boundary}')
    result = []
    for part in parts:
        part = part.strip('\r\n')
        if not part or part == '--':
            continue
        header_end = part.find('\r\n\r\n')
        if header_end < 0:
            continue
        header_text = part[:header_end]
        part_body = part[header_end + 4:]
        headers = {}
        for line in header_text.split('\r\n'):
            hm = re.match(r'^([^:]+):\s*(.*)$', line)
            if hm:
                headers[hm.group(1).strip().lower()] = hm.group(2).strip()
        result.append({'headers': headers, 'body': part_body})
    return result


def parse_sdp_streams(sdp):
    streams = []
    for line in sdp.split('\r\n'):
        m = re.match(r'^m=audio (\d+)', line)
        if m:
            streams.append({'port': int(m.group(1)), 'label': None})
        lm = re.match(r'^a=label:(\S+)', line)
        if lm and streams:
            streams[-1]['label'] = lm.group(1)
    return streams


def parse_metadata(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        return {'error': str(e)}
    ns = RECORDING_XMLNS
    participants = []
    for p in root.findall(f'{ns}participant'):
        name_id = p.find(f'{ns}nameID')
        aor = name_id.get('aor') if name_id is not None else None
        name_el = name_id.find(f'{ns}name') if name_id is not None else None
        participants.append({'participant_id': p.get('participant_id'), 'aor': aor,
                              'name': name_el.text if name_el is not None else None})
    streams = []
    for s in root.findall(f'{ns}stream'):
        label_el = s.find(f'{ns}label')
        streams.append({'stream_id': s.get('stream_id'),
                         'label': label_el.text if label_el is not None else None})
    assocs = []
    for a in root.findall(f'{ns}participantstreamassoc'):
        send_el = a.find(f'{ns}send')
        recv_el = a.find(f'{ns}recv')
        assocs.append({'participant_id': a.get('participant_id'),
                        'send': send_el.text if send_el is not None else None,
                        'recv': recv_el.text if recv_el is not None else None})
    session_el = root.find(f'{ns}session')
    return {
        'session_id': session_el.get('session_id') if session_el is not None else None,
        'participants': participants,
        'streams': streams,
        'participantstreamassoc': assocs,
    }


def is_rtcp(data):
    return len(data) >= 2 and data[1] in (200, 201, 202, 203, 204)


def parse_rtcp_sr_sdes(data):
    info = {}
    offset = 0
    while offset + 4 <= len(data):
        length_words = struct.unpack('>H', data[offset + 2:offset + 4])[0]
        pkt_len = (length_words + 1) * 4
        pt = data[offset + 1]
        if pt == 200 and offset + 28 <= len(data):
            ssrc, ntp_sec, ntp_frac, rtp_ts, pkt_cnt, oct_cnt = struct.unpack(
                '>IIIIII', data[offset + 4:offset + 28])
            info['sr'] = {'ssrc': ssrc, 'rtp_timestamp': rtp_ts, 'packet_count': pkt_cnt, 'octet_count': oct_cnt}
        elif pt == 202 and offset + pkt_len <= len(data):
            chunk = data[offset + 4:offset + pkt_len]
            if len(chunk) >= 6 and chunk[4] == 1:
                cname_len = chunk[5]
                info['cname'] = chunk[6:6 + cname_len].decode('utf8', errors='replace')
        offset += pkt_len
        if pkt_len == 0:
            break
    return info


def decode_pcmu_pcma(payload, table):
    samples = bytearray(len(payload) * 2)
    for i, b in enumerate(payload):
        v = clamp16(table[b])
        struct.pack_into('<h', samples, i * 2, v)
    return bytes(samples)


class StreamState:
    def __init__(self, label, sock):
        self.label = label
        self.sock = sock
        self.rtp_packets = 0
        self.rtp_bytes = 0
        self.pt_seen = set()
        self.pcm_chunks = []
        self.rtcp_info = {}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bind-ip', default='0.0.0.0')
    p.add_argument('--advertise-ip', default='127.0.0.1',
                    help='IP put in the SDP answer\'s c= line — must be reachable from the SRC, unlike '
                         '--bind-ip (0.0.0.0) which is not a valid destination to send RTP to')
    p.add_argument('--sip-port', type=int, default=15060)
    p.add_argument('--out-dir', default='.')
    p.add_argument('--idle-timeout', type=float, default=30.0,
                    help='Exit if no SIP activity for this many seconds after the first INVITE')
    args = p.parse_args()

    sip_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sip_sock.bind((args.bind_ip, args.sip_port))
    log(f"Listening for SIPREC INVITE on {args.bind_ip}:{args.sip_port}")

    streams = {}       # label -> StreamState
    dialog = None      # {call_id, from_tag, to_tag, remote_addr}
    metadata = None
    last_activity = time.time()

    def send_response(status_line, headers, remote_addr):
        msg = status_line + '\r\n' + '\r\n'.join(f'{k}: {v}' for k, v in headers.items()) + '\r\n\r\n'
        sip_sock.sendto(msg.encode('utf8'), remote_addr)

    while True:
        sockets = [sip_sock] + [s.sock for s in streams.values()]
        readable, _, _ = select.select(sockets, [], [], 1.0)
        if not readable:
            if dialog and time.time() - last_activity > args.idle_timeout:
                log("Idle timeout waiting for BYE — exiting")
                break
            continue

        for sock in readable:
            data, addr = sock.recvfrom(65535)
            last_activity = time.time()

            if sock is sip_sock:
                first_line, headers, body = parse_sip_message(data)
                method = first_line.split(' ')[0]
                log(f"Received {first_line}")

                if method == 'INVITE':
                    if 'siprec' not in headers.get('require', ''):
                        log("WARN: INVITE missing Require: siprec")
                    parts = parse_multipart(headers.get('content-type', ''), body)
                    sdp_part = next((pt for pt in parts if 'sdp' in pt['headers'].get('content-type', '')), None)
                    meta_part = next((pt for pt in parts if 'rs-metadata' in pt['headers'].get('content-type', '')), None)
                    if not sdp_part or not meta_part:
                        log("ERROR: multipart body missing sdp or rs-metadata part")
                        continue
                    metadata = parse_metadata(meta_part['body'])
                    offered = parse_sdp_streams(sdp_part['body'])
                    log(f"Metadata parsed: {json.dumps(metadata)}")
                    log(f"Offered streams: {offered}")

                    answer_lines = ['v=0', f'o=mockSRS 1 1 IN IP4 {args.advertise_ip}', 's=-',
                                     f'c=IN IP4 {args.advertise_ip}', 't=0 0']
                    for stream in offered:
                        rtp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        rtp_sock.bind((args.bind_ip, 0))
                        local_port = rtp_sock.getsockname()[1]
                        streams[stream['label']] = StreamState(stream['label'], rtp_sock)
                        answer_lines += [
                            f"m=audio {local_port} RTP/AVP 111 0 8 9",
                            'a=recvonly', 'a=rtcp-mux', f"a=label:{stream['label']}",
                        ]
                    answer_sdp = '\r\n'.join(answer_lines) + '\r\n'

                    call_id = headers.get('call-id', '')
                    from_hdr = headers.get('from', '')
                    to_tag = f'srs{int(time.time())}'
                    dialog = {'call_id': call_id, 'from': from_hdr, 'to_tag': to_tag, 'remote_addr': addr}
                    resp_headers = {
                        'Via': headers.get('via', ''),
                        'From': from_hdr,
                        'To': f"{headers.get('to', '')};tag={to_tag}",
                        'Call-ID': call_id,
                        'CSeq': headers.get('cseq', ''),
                        'Content-Type': 'application/sdp',
                        'Content-Length': str(len(answer_sdp.encode('utf8'))),
                    }
                    msg = 'SIP/2.0 200 OK\r\n' + '\r\n'.join(f'{k}: {v}' for k, v in resp_headers.items()) + f'\r\n\r\n{answer_sdp}'
                    sip_sock.sendto(msg.encode('utf8'), addr)
                    log(f"Answered with {len(offered)} stream(s), sent 200 OK")

                elif method == 'ACK':
                    log("Received ACK — recording session established")

                elif method == 'BYE':
                    resp_headers = {
                        'Via': headers.get('via', ''),
                        'From': headers.get('from', ''),
                        'To': headers.get('to', ''),
                        'Call-ID': headers.get('call-id', ''),
                        'CSeq': headers.get('cseq', ''),
                        'Content-Length': '0',
                    }
                    msg = 'SIP/2.0 200 OK\r\n' + '\r\n'.join(f'{k}: {v}' for k, v in resp_headers.items()) + '\r\n\r\n'
                    sip_sock.sendto(msg.encode('utf8'), addr)
                    log("Received BYE, replied 200 OK — session ending")
                    finalize(streams, metadata, args.out_dir)
                    return

            else:
                state = next((s for s in streams.values() if s.sock is sock), None)
                if state is None:
                    continue
                if is_rtcp(data):
                    state.rtcp_info = parse_rtcp_sr_sdes(data)
                else:
                    if len(data) < 12:
                        continue
                    pt = data[1] & 0x7f
                    payload = data[12:]
                    state.rtp_packets += 1
                    state.rtp_bytes += len(payload)
                    state.pt_seen.add(pt)
                    if pt == 0:
                        state.pcm_chunks.append(decode_pcmu_pcma(payload, ULAW_TABLE))
                    elif pt == 8:
                        state.pcm_chunks.append(decode_pcmu_pcma(payload, ALAW_TABLE))
                    # PT 9 (G.722) / 111 (Opus): counted above, not PCM-decoded here — see module docstring.


def finalize(streams, metadata, out_dir):
    summary = {'metadata': metadata, 'streams': {}}
    for label, state in streams.items():
        pcm = b''.join(state.pcm_chunks)
        wav_path = None
        if pcm:
            wav_path = f'{out_dir}/mock_siprec_stream_{label}.wav'
            with wave.open(wav_path, 'wb') as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(8000)
                w.writeframes(pcm)
        summary['streams'][label] = {
            'rtp_packets': state.rtp_packets,
            'rtp_bytes': state.rtp_bytes,
            'payload_types_seen': sorted(state.pt_seen),
            'rtcp': state.rtcp_info,
            'decoded_wav': wav_path,
            'decoded_pcm_bytes': len(pcm),
        }
        state.sock.close()
        log(f"Stream {label}: {state.rtp_packets} RTP packets, {state.rtp_bytes} bytes, "
            f"PTs={sorted(state.pt_seen)}, rtcp={state.rtcp_info}")

    summary_path = f'{out_dir}/mock_siprec_summary.json'
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    log(f"Wrote summary: {summary_path}")


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
