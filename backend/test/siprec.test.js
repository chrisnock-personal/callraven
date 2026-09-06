'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const siprec = require('../siprec.js');

test('generateId returns a base64-encoded 16-byte value, unique per call', () => {
  const a = siprec.generateId();
  const b = siprec.generateId();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length, 16);
});

test('buildMetadataXml produces well-formed structure with the RFC 7865 namespace', () => {
  const xml = siprec.buildMetadataXml({
    sessionId: 'sess1', localAor: 'sip:alice@example.com', localName: 'Alice',
    remoteAor: 'sip:bob@example.com', remoteName: 'Bob',
    localParticipantId: 'p1', remoteParticipantId: 'p2',
    localStreamId: 's1', remoteStreamId: 's2', localLabel: 1, remoteLabel: 2,
  });
  assert.match(xml, /xmlns='urn:ietf:params:xml:ns:recording:1'/);
  assert.match(xml, /<datamode>complete<\/datamode>/);
  assert.match(xml, /session_id="sess1"/);
  assert.match(xml, /participant_id="p1"/);
  assert.match(xml, /aor="sip:alice@example.com"/);
  assert.match(xml, /<label>1<\/label>/);
  assert.match(xml, /<label>2<\/label>/);
  assert.match(xml, /<send>s1<\/send>/);
  assert.match(xml, /<recv>s2<\/recv>/);
  // Each participant sends on its own stream and receives the other's
  const p1Block = xml.match(/<participantstreamassoc participant_id="p1">[\s\S]*?<\/participantstreamassoc>/)[0];
  assert.match(p1Block, /<send>s1<\/send>/);
  assert.match(p1Block, /<recv>s2<\/recv>/);
});

test('buildMetadataXml escapes XML-significant characters in names/AORs', () => {
  const xml = siprec.buildMetadataXml({
    sessionId: 's', localAor: 'sip:a@b.com', localName: 'A & <B>',
    remoteAor: 'sip:c@d.com', remoteName: 'C',
    localParticipantId: 'p1', remoteParticipantId: 'p2',
    localStreamId: 's1', remoteStreamId: 's2', localLabel: 1, remoteLabel: 2,
  });
  assert.match(xml, /A &amp; &lt;B&gt;/);
  assert.doesNotMatch(xml, /<name>A & <B><\/name>/);
});

test('buildSdp emits two m=audio lines, each sendonly + rtcp-mux + its own label', () => {
  const sdp = siprec.buildSdp('192.0.2.1', 20000, 20002, { localLabel: 1, remoteLabel: 2 });
  const mLines = sdp.match(/^m=audio \d+ RTP\/AVP.*$/gm);
  assert.equal(mLines.length, 2);
  assert.match(sdp, /m=audio 20000/);
  assert.match(sdp, /m=audio 20002/);
  assert.equal((sdp.match(/a=sendonly/g) || []).length, 2);
  assert.equal((sdp.match(/a=rtcp-mux/g) || []).length, 2);
  assert.match(sdp, /a=label:1/);
  assert.match(sdp, /a=label:2/);
});

test('buildSdp declares every codec the primary call could negotiate (Opus/G722/PCMU/PCMA)', () => {
  // The bytes actually forwarded to each stream depend on whatever the
  // primary call ends up negotiating, which isn't known when this SDP is
  // built — every codec sipManager.js's own buildSdp offers must already
  // be declared here, or a primary call that ends up on Opus would forward
  // PT 111 packets on a stream the SRS was never told could carry PT 111.
  const sdp = siprec.buildSdp('192.0.2.1', 20000, 20002, { localLabel: 1, remoteLabel: 2 });
  const mLines = sdp.match(/^m=audio \d+ RTP\/AVP (.+)$/gm);
  for (const line of mLines) {
    assert.match(line, /\b111\b/);
    assert.match(line, /\b0\b/);
    assert.match(line, /\b8\b/);
    assert.match(line, /\b9\b/);
  }
  assert.match(sdp, /a=rtpmap:111 opus\/48000\/2/);
});

test('buildInviteBody assembles a valid multipart/mixed body with both parts', () => {
  const { boundary, body } = siprec.buildInviteBody({
    localIp: '192.0.2.1', localPortLocal: 20000, localPortRemote: 20002,
    labels: { localLabel: 1, remoteLabel: 2 }, metadataXml: '<recording/>',
  });
  assert.ok(body.includes(`--${boundary}`));
  assert.ok(body.includes(`--${boundary}--`));
  assert.match(body, /Content-Type: application\/sdp/);
  assert.match(body, /Content-Type: application\/rs-metadata/);
  assert.match(body, /Content-Disposition: recording-session/);
  assert.ok(body.includes('<recording/>'));
});

test('parseAnswerSdp extracts ip:port per m=audio line in order', () => {
  const sdp = [
    'v=0', 'o=- 1 1 IN IP4 203.0.113.5', 's=-', 'c=IN IP4 203.0.113.5', 't=0 0',
    'm=audio 30000 RTP/AVP 0', 'a=recvonly', 'a=label:1',
    'm=audio 30002 RTP/AVP 0', 'a=recvonly', 'a=label:2',
    '',
  ].join('\r\n');
  const streams = siprec.parseAnswerSdp(sdp);
  assert.equal(streams.length, 2);
  assert.deepEqual(streams[0], { ip: '203.0.113.5', port: 30000 });
  assert.deepEqual(streams[1], { ip: '203.0.113.5', port: 30002 });
});

test('parseAnswerSdp honors a per-media c= line override', () => {
  const sdp = [
    'v=0', 'o=- 1 1 IN IP4 203.0.113.5', 's=-', 'c=IN IP4 203.0.113.5', 't=0 0',
    'm=audio 30000 RTP/AVP 0', 'c=IN IP4 203.0.113.9', 'a=recvonly',
    'm=audio 30002 RTP/AVP 0', 'a=recvonly',
    '',
  ].join('\r\n');
  const streams = siprec.parseAnswerSdp(sdp);
  assert.equal(streams[0].ip, '203.0.113.9');
  assert.equal(streams[1].ip, '203.0.113.5');
});

test('parseAnswerSdp returns an empty array for a missing/empty SDP', () => {
  assert.deepEqual(siprec.parseAnswerSdp(''), []);
  assert.deepEqual(siprec.parseAnswerSdp(null), []);
});

test('buildRtcpSr produces a well-formed SR+SDES packet pair', () => {
  const pkt = siprec.buildRtcpSr({ ssrc: 0xdeadbeef, rtpTimestamp: 12345, packetCount: 10, octetCount: 1600, cname: 'callraven-abc123' });
  // SR header
  assert.equal(pkt[0], 0x80);
  assert.equal(pkt[1], 200);
  assert.equal(pkt.readUInt16BE(2), 6);
  assert.equal(pkt.readUInt32BE(4) >>> 0, 0xdeadbeef);
  assert.equal(pkt.readUInt32BE(16), 12345);
  assert.equal(pkt.readUInt32BE(20), 10);
  assert.equal(pkt.readUInt32BE(24), 1600);
  // SDES header starts right after the 28-byte SR
  const sdesOffset = 28;
  assert.equal(pkt[sdesOffset], 0x81);
  assert.equal(pkt[sdesOffset + 1], 202);
  assert.equal(pkt.readUInt32BE(sdesOffset + 4) >>> 0, 0xdeadbeef);
  assert.equal(pkt[sdesOffset + 8], 1); // CNAME item type
  const cnameLen = pkt[sdesOffset + 9];
  const cname = pkt.slice(sdesOffset + 10, sdesOffset + 10 + cnameLen).toString('utf8');
  assert.equal(cname, 'callraven-abc123');
});

test('buildRtcpSr NTP timestamp round-trips to approximately Date.now()', () => {
  const before = Date.now();
  const pkt = siprec.buildRtcpSr({ ssrc: 1, rtpTimestamp: 0, packetCount: 0, octetCount: 0, cname: 'x' });
  const ntpSeconds = pkt.readUInt32BE(8);
  const unixSeconds = ntpSeconds - 2208988800;
  assert.ok(Math.abs(unixSeconds * 1000 - before) < 2000);
});

test('parseSipResponse extracts status, headers, and body', () => {
  const raw = [
    'SIP/2.0 200 OK',
    'Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK1',
    'From: <sip:a@b>;tag=abc',
    'To: <sip:c@d>;tag=xyz',
    'Call-ID: call1',
    'CSeq: 1 INVITE',
    'Content-Length: 5',
    '', 'hello',
  ].join('\r\n');
  const parsed = siprec.parseSipResponse(raw);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers['call-id'], 'call1');
  assert.equal(parsed.headers['to'], '<sip:c@d>;tag=xyz');
  assert.equal(parsed.body, 'hello');
});

test('parseSipResponse returns null for a non-response (e.g. a request)', () => {
  assert.equal(siprec.parseSipResponse('INVITE sip:a@b SIP/2.0\r\n\r\n'), null);
});

test('parseSrsUri handles sip: scheme, user, host, and port', () => {
  assert.deepEqual(siprec.parseSrsUri('sip:recorder@203.0.113.5:5061'), { userAtHost: 'recorder@203.0.113.5:5061', host: '203.0.113.5', port: 5061 });
});

test('parseSrsUri defaults to port 5060 when none is given', () => {
  assert.deepEqual(siprec.parseSrsUri('sip:recorder@203.0.113.5'), { userAtHost: 'recorder@203.0.113.5', host: '203.0.113.5', port: 5060 });
});

test('parseSrsUri handles a bare host:port with no scheme/user', () => {
  const result = siprec.parseSrsUri('203.0.113.5:5061');
  assert.equal(result.host, '203.0.113.5');
  assert.equal(result.port, 5061);
});

// ─── SiprecStreamSender: real local UDP sockets, no external network ──────

test('SiprecStreamSender sends RTP packets with its own SSRC and advancing seq/timestamp', async () => {
  const receiver = dgram.createSocket('udp4');
  const received = [];
  await new Promise((resolve) => receiver.bind(0, resolve));
  receiver.on('message', (msg) => received.push(msg));

  const sender = new siprec.SiprecStreamSender(1);
  const port = await sender.bind();
  assert.ok(port > 0);
  sender.connect('127.0.0.1', receiver.address().port);

  sender.sendRtp(Buffer.from([1, 2, 3, 4]), 0, 4);
  sender.sendRtp(Buffer.from([5, 6, 7, 8]), 0, 4);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(received.length, 2);
  const [p0, p1] = received;
  assert.equal(p0[0], 0x80);
  assert.equal(p0[1], 0);
  const seq0 = p0.readUInt16BE(2);
  const seq1 = p1.readUInt16BE(2);
  assert.equal((seq1 - seq0 + 0x10000) % 0x10000, 1);
  assert.equal(p0.readUInt32BE(8), sender.ssrc);
  assert.deepEqual(p0.slice(12), Buffer.from([1, 2, 3, 4]));

  sender.stop();
  receiver.close();
});

test('SiprecStreamSender.sendRtp is a no-op before connect() (no remote configured)', async () => {
  const sender = new siprec.SiprecStreamSender(1);
  await sender.bind();
  assert.doesNotThrow(() => sender.sendRtp(Buffer.from([1]), 0, 1));
  sender.stop();
});

// ─── SiprecClient: full INVITE/ACK/RTP/BYE flow against a minimal fake SRS ─
// (real local UDP sockets, no external network) — this is what caught a
// real bug during manual testing: stop() used to close the SIP socket
// immediately after firing the BYE via dgram.send(), which is async, and
// could tear the socket down before the BYE actually left — RTP/RTCP
// worked fine, but the BYE silently never arrived. These tests exist so a
// regression there fails loudly instead of only showing up against a real
// second party.

function startFakeSrs() {
  const dgram = require('dgram');
  const sock = dgram.createSocket('udp4');
  const state = { invites: 0, acks: 0, byes: 0, rtpByLabel: {}, streamSockets: [] };
  return new Promise((resolve) => {
    sock.bind(0, () => {
      sock.on('message', (data, rinfo) => {
        const text = data.toString('utf8');
        const method = text.split(' ')[0];
        const headerEnd = text.indexOf('\r\n\r\n');
        const headerText = text.slice(0, headerEnd);
        const body = text.slice(headerEnd + 4);
        const get = (name) => {
          const m = headerText.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
          return m ? m[1].trim() : '';
        };

        if (method === 'INVITE') {
          state.invites++;
          const boundaryMatch = get('Content-Type').match(/boundary=("?)([^"; ]+)\1/);
          const parts = body.split(`--${boundaryMatch[2]}`);
          const sdpPart = parts.find((p) => /Content-Type: application\/sdp/i.test(p));
          const sdpBody = sdpPart.slice(sdpPart.indexOf('\r\n\r\n') + 4);
          const ports = [...sdpBody.matchAll(/^m=audio (\d+)/gm)].map((m) => parseInt(m[1], 10));

          const streamSocks = ports.map((offeredPort, i) => {
            const s = dgram.createSocket('udp4');
            s.bind(0);
            state.streamSockets.push(s);
            s.on('message', (rtpData) => {
              const label = i + 1;
              state.rtpByLabel[label] = (state.rtpByLabel[label] || 0) + 1;
            });
            return s;
          });

          // Wait a tick for the sockets to actually bind before reading their ports.
          setTimeout(() => {
            const answerLines = ['v=0', 'o=fake 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0'];
            streamSocks.forEach((s, i) => {
              answerLines.push(`m=audio ${s.address().port} RTP/AVP 0`, 'a=recvonly', 'a=rtcp-mux', `a=label:${i + 1}`);
            });
            const answerSdp = answerLines.join('\r\n') + '\r\n';
            const resp = [
              'SIP/2.0 200 OK',
              `Via: ${get('Via')}`,
              `From: ${get('From')}`,
              `To: ${get('To')};tag=faketag`,
              `Call-ID: ${get('Call-ID')}`,
              `CSeq: ${get('CSeq')}`,
              'Content-Type: application/sdp',
              `Content-Length: ${Buffer.byteLength(answerSdp)}`,
              '', answerSdp,
            ].join('\r\n');
            sock.send(resp, rinfo.port, rinfo.address);
          }, 20);
        } else if (method === 'ACK') {
          state.acks++;
        } else if (method === 'BYE') {
          state.byes++;
          const resp = [
            'SIP/2.0 200 OK', `Via: ${get('Via')}`, `From: ${get('From')}`, `To: ${get('To')}`,
            `Call-ID: ${get('Call-ID')}`, `CSeq: ${get('CSeq')}`, 'Content-Length: 0', '', '',
          ].join('\r\n');
          sock.send(resp, rinfo.port, rinfo.address);
        }
      });
      resolve({ port: sock.address().port, state, close: () => { sock.close(); state.streamSockets.forEach((s) => s.close()); } });
    });
  });
}

test('SiprecClient completes a full INVITE/ACK/RTP/BYE cycle against a fake SRS', async () => {
  const srs = await startFakeSrs();
  // client.stop() must run even if an assertion below throws — its sockets
  // (and the fake SRS's) would otherwise stay open and hang the whole test
  // process, exactly like the real production bug this test is guarding
  // against (see the class-level comment above).
  const client = new siprec.SiprecClient({
    srsUri: `sip:fake@127.0.0.1:${srs.port}`,
    localIp: '127.0.0.1', localAor: 'sip:a@x', remoteAor: 'sip:b@x',
  });
  try {
    await client.start();
    assert.equal(srs.state.invites, 1);
    // client.start() resolves as soon as its own ACK send() call returns,
    // which — like any dgram send — doesn't guarantee the packet has
    // actually reached the fake SRS's socket over the loopback yet.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(srs.state.acks, 1);

    client.feedLocal(Buffer.alloc(160), 0, 160);
    client.feedRemote(Buffer.alloc(160), 0, 160);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(srs.state.rtpByLabel[1], 1);
    assert.equal(srs.state.rtpByLabel[2], 1);

    await client.stop();
    // Give the fake SRS's own socket a moment to process the BYE it was sent.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srs.state.byes, 1, 'BYE must actually reach the SRS before the client tears its socket down');
  } finally {
    await client.stop();
    srs.close();
  }
});

test('SiprecClient.start() rejects (without throwing past the caller) when the SRS never responds', async () => {
  const client = new siprec.SiprecClient({
    srsUri: 'sip:nobody@127.0.0.1:1', // nothing listens on port 1
    localIp: '127.0.0.1', localAor: 'sip:a@x', remoteAor: 'sip:b@x',
    inviteTimeoutMs: 200, inviteRetries: 0, // avoid waiting out the real 4s/1-retry production timeout
  });
  await assert.rejects(() => client.start());
  await client.stop(); // must not throw even though start() never completed
});
