'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const srtp = require('../srtp.js');

function makeHeader({ seq = 1, ssrc = 0x11223344, pt = 9, ts = 1000 } = {}) {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(ts, 4);
  h.writeUInt32BE(ssrc, 8);
  return h;
}

function freshCtx(masterKey, masterSalt) {
  return { sessionKeys: srtp.deriveSessionKeys(masterKey, masterSalt), roc: 0, lastSeq: null };
}

test('deriveSessionKeys is deterministic for a fixed key/salt', () => {
  const key  = Buffer.alloc(16, 0x42);
  const salt = Buffer.alloc(14, 0x7a);
  const a = srtp.deriveSessionKeys(key, salt);
  const b = srtp.deriveSessionKeys(key, salt);
  assert.deepEqual(a.encKey, b.encKey);
  assert.deepEqual(a.authKey, b.authKey);
  assert.deepEqual(a.saltKey, b.saltKey);
  assert.equal(a.encKey.length, 16);
  assert.equal(a.authKey.length, 20);
  assert.equal(a.saltKey.length, 14);
});

test('deriveSessionKeys produces distinct keys for enc/auth/salt', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const { encKey, authKey, saltKey } = srtp.deriveSessionKeys(key, salt);
  assert.notEqual(encKey.toString('hex'), authKey.slice(0, 16).toString('hex'));
  assert.notEqual(encKey.toString('hex'), saltKey.slice(0, 14).toString('hex'));
});

test('buildCryptoAttr / parseCryptoAttr round-trip', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const line = srtp.buildCryptoAttr(1, { key, salt });
  const sdp  = `v=0\r\nm=audio 5000 RTP/SAVP 9\r\n${line}\r\n`;
  const parsed = srtp.parseCryptoAttr(sdp);
  assert.ok(parsed);
  assert.equal(parsed.tag, 1);
  assert.deepEqual(parsed.key, key);
  assert.deepEqual(parsed.salt, salt);
});

test('parseCryptoAttr rejects an unsupported suite', () => {
  const sdp = 'a=crypto:1 AES_CM_128_HMAC_SHA1_32 inline:' + Buffer.alloc(30, 1).toString('base64');
  assert.equal(srtp.parseCryptoAttr(sdp), null);
});

test('parseCryptoAttr returns null when absent', () => {
  assert.equal(srtp.parseCryptoAttr('v=0\r\nm=audio 5000 RTP/AVP 0\r\n'), null);
});

test('encrypt -> decryptVerify round-trips to the original plaintext', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const tx = freshCtx(key, salt);
  const rx = freshCtx(key, salt);

  for (const len of [0, 1, 20, 160, 320]) {
    const payload = crypto_randomBuffer(len);
    const header  = makeHeader({ seq: 100 + len, ssrc: 0xaabbccdd });
    const packet  = srtp.encrypt(tx, header, payload);
    const result  = srtp.decryptVerify(rx, packet);
    assert.ok(result, `decrypt failed for payload length ${len}`);
    assert.deepEqual(result.header, header);
    assert.deepEqual(result.payload, payload);
  }
});

test('a flipped ciphertext byte fails verification', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const tx = freshCtx(key, salt);
  const rx = freshCtx(key, salt);

  const header  = makeHeader({ seq: 5 });
  const packet  = srtp.encrypt(tx, header, Buffer.from('hello world!!!!!'));
  packet[15] ^= 0xff; // inside the ciphertext region
  assert.equal(srtp.decryptVerify(rx, packet), null);
});

test('a flipped auth tag byte fails verification', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const tx = freshCtx(key, salt);
  const rx = freshCtx(key, salt);

  const header = makeHeader({ seq: 6 });
  const packet = srtp.encrypt(tx, header, Buffer.from('payload'));
  packet[packet.length - 1] ^= 0xff; // inside the 10-byte tag
  assert.equal(srtp.decryptVerify(rx, packet), null);
});

test('a too-short packet is rejected without throwing', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const rx = freshCtx(key, salt);
  assert.equal(srtp.decryptVerify(rx, Buffer.alloc(10)), null);
});

test('ROC increments across a sequence-number wraparound and stays consistent', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const tx = freshCtx(key, salt);
  const rx = freshCtx(key, salt);

  const seqs = [65533, 65534, 65535, 0, 1, 2];
  for (const seq of seqs) {
    const header  = makeHeader({ seq });
    const packet  = srtp.encrypt(tx, header, Buffer.from('x'.repeat(20)));
    const result  = srtp.decryptVerify(rx, packet);
    assert.ok(result, `decrypt failed at seq ${seq}`);
  }
  assert.equal(tx.roc, 1);
  assert.equal(rx.roc, 1);
});

test('a stale packet from before a rollover is rejected once ROC has advanced', () => {
  const { key, salt } = srtp.generateMasterKeySalt();
  const tx = freshCtx(key, salt);
  const rx = freshCtx(key, salt);

  // Encrypt (and deliver) a packet just before the wrap, then one just after —
  // this advances rx's ROC to 1. Encrypting a "replayed" seq=65534 packet
  // now (with tx.roc long past 0) does not match the ciphertext/tag rx would
  // expect for an old ROC=0 packet at that seq, so it must fail to verify.
  const before = srtp.encrypt(tx, makeHeader({ seq: 65534 }), Buffer.from('aaaaaaaaaaaaaaaa'));
  assert.ok(srtp.decryptVerify(rx, before));
  const after = srtp.encrypt(tx, makeHeader({ seq: 1 }), Buffer.from('aaaaaaaaaaaaaaaa'));
  assert.ok(srtp.decryptVerify(rx, after));
  assert.equal(rx.roc, 1);

  // A stale ROC=0 packet, replayed with today's tx context: since tx.roc is
  // now 1, encrypting seq=65534 again produces ROC=1-tagged ciphertext (tx
  // won't roll back), which does NOT match what an actual ROC=0 packet at
  // that seq (already consumed above) would have looked like — simulate the
  // real attack by building the old-ROC packet directly against a snapshot.
  const staleTx = freshCtx(key, salt); // fresh ctx == ROC 0, same keys
  const stale = srtp.encrypt(staleTx, makeHeader({ seq: 65534 }), Buffer.from('aaaaaaaaaaaaaaaa'));
  assert.deepEqual(stale, before); // sanity: identical to the original first packet
  // rx has already moved to ROC=1/lastSeq=1; replaying the ROC=0 packet's
  // bytes now computes ROC=1 for verification (seq 65534 vs lastSeq 1 is not
  // a fresh wrap-forward), so its ROC=0 tag/ciphertext must not verify.
  assert.equal(srtp.decryptVerify(rx, stale), null);
});

function crypto_randomBuffer(len) {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = i & 0xff;
  return buf;
}
