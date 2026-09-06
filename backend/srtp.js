'use strict';

const crypto = require('crypto');

// ─── SDES-SRTP: AES_CM_128_HMAC_SHA1_80 (RFC 3711 mandatory-to-implement) ────
// Only this one crypto suite is supported — an answer offering anything
// else is treated as "no compatible SRTP" (see parseCryptoAttr).
const SUITE = 'AES_CM_128_HMAC_SHA1_80';

const LABEL_ENC  = 0x00;
const LABEL_AUTH = 0x01;
const LABEL_SALT = 0x02;

const AUTH_TAG_LEN = 10; // 80 bits

function generateMasterKeySalt() {
  return { key: crypto.randomBytes(16), salt: crypto.randomBytes(14) };
}

function buildCryptoAttr(tag, { key, salt }) {
  return `a=crypto:${tag} ${SUITE} inline:${Buffer.concat([key, salt]).toString('base64')}`;
}

function parseCryptoAttr(sdpText) {
  if (!sdpText) return null;
  const match = sdpText.match(/^a=crypto:(\d+)\s+(\S+)\s+inline:([A-Za-z0-9+/=]+)/m);
  if (!match) return null;
  const [, tag, suite, inline] = match;
  if (suite !== SUITE) return null;
  const raw = Buffer.from(inline, 'base64');
  if (raw.length !== 30) return null; // 16-byte key + 14-byte salt
  return { tag: parseInt(tag, 10), key: raw.slice(0, 16), salt: raw.slice(16) };
}

// RFC 3711 §4.3.1 key derivation, key derivation rate 0 (derive once, at
// session start — the default and simplest case, no periodic re-derivation).
// x = master_salt (zero-padded to a 16-byte AES block) with byte index 7
// XORed by `label` — confirmed against libsrtp's srtp_kdf_generate/
// srtp_aes_icm_*_set_iv (byte 7 is where key_id's label octet lands once
// the 112-bit salt is right-aligned against the 128-bit counter block).
// The keystream from AES-CM under master_key at that IV is the derived
// material (truncated to the length each key type needs).
function _kdfIv(masterSalt, label) {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv, 0);
  iv[7] ^= label;
  return iv;
}

function _prf(masterKey, iv, numBytes) {
  const blocks = Math.ceil(numBytes / 16);
  const cipher = crypto.createCipheriv('aes-128-ctr', masterKey, iv);
  const out = cipher.update(Buffer.alloc(blocks * 16));
  return out.slice(0, numBytes);
}

function deriveSessionKeys(masterKey, masterSalt) {
  return {
    encKey:  _prf(masterKey, _kdfIv(masterSalt, LABEL_ENC), 16),
    authKey: _prf(masterKey, _kdfIv(masterSalt, LABEL_AUTH), 20),
    saltKey: _prf(masterKey, _kdfIv(masterSalt, LABEL_SALT), 14),
  };
}

// RFC 3711 §4.1.1 packet IV: session_salt (shifted left 16 bits) XOR
// (SSRC shifted left 64 bits) XOR (packet index `2^16*ROC + SEQ` shifted
// left 16 bits), as a 128-bit big-endian block — confirmed byte-for-byte
// against libsrtp's srtp_protect/unprotect (`iv.v32[1]=ssrc;
// iv.v64[1]=be64_to_cpu(est<<16)`): SSRC occupies bytes 4-7, ROC bytes
// 8-11, SEQ bytes 12-13, bytes 0-3/14-15 come only from the salt.
function _packetIv(saltKey, ssrc, roc, seq) {
  const iv = Buffer.alloc(16);
  saltKey.copy(iv, 0);
  iv[4]  ^= (ssrc >>> 24) & 0xff;
  iv[5]  ^= (ssrc >>> 16) & 0xff;
  iv[6]  ^= (ssrc >>> 8)  & 0xff;
  iv[7]  ^=  ssrc         & 0xff;
  iv[8]  ^= (roc >>> 24) & 0xff;
  iv[9]  ^= (roc >>> 16) & 0xff;
  iv[10] ^= (roc >>> 8)  & 0xff;
  iv[11] ^=  roc         & 0xff;
  iv[12] ^= (seq >>> 8) & 0xff;
  iv[13] ^=  seq        & 0xff;
  return iv;
}

// AES-CM is symmetric — the same keystream XOR runs encryption and
// decryption, so this one function serves both directions.
function _cryptPayload(encKey, iv, data) {
  const cipher = crypto.createCipheriv('aes-128-ctr', encKey, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function _authTag(authKey, headerAndCipher, roc) {
  const rocBuf = Buffer.alloc(4);
  rocBuf.writeUInt32BE(roc >>> 0, 0);
  const hmac = crypto.createHmac('sha1', authKey);
  hmac.update(headerAndCipher);
  hmac.update(rocBuf);
  return hmac.digest().slice(0, AUTH_TAG_LEN);
}

// Rollover counter (ROC) tracking: a 16-bit RTP sequence number wraps every
// 65536 packets — detect a wrap as a large backward jump (current seq far
// below the last seen seq) and bump ROC accordingly. Computed rather than
// mutated in place so callers can discard the result on auth failure
// (decryptVerify) instead of corrupting state from a spoofed packet.
function _computeRoc(ctx, seq) {
  let roc = ctx.roc;
  if (ctx.lastSeq !== null && (ctx.lastSeq - seq) > 0x8000) roc = (roc + 1) >>> 0;
  return roc;
}

// `txCtx`/`rxCtx` shape: { sessionKeys: {encKey,authKey,saltKey}, roc, lastSeq }
// (lastSeq starts null; roc starts 0).

function encrypt(txCtx, headerBuf, payloadBuf) {
  const ssrc = headerBuf.readUInt32BE(8);
  const seq  = headerBuf.readUInt16BE(2);
  const roc  = _computeRoc(txCtx, seq);
  txCtx.roc     = roc;
  txCtx.lastSeq = seq;

  const iv = _packetIv(txCtx.sessionKeys.saltKey, ssrc, roc, seq);
  const ciphertext = _cryptPayload(txCtx.sessionKeys.encKey, iv, payloadBuf);
  const headerAndCipher = Buffer.concat([headerBuf, ciphertext]);
  const tag = _authTag(txCtx.sessionKeys.authKey, headerAndCipher, roc);
  return Buffer.concat([headerAndCipher, tag]);
}

// Returns { header, payload } on success, or null if the packet is too
// short or fails authentication (caller should drop the packet — rxCtx is
// only updated on success, so a spoofed/corrupt packet can't skew ROC state).
function decryptVerify(rxCtx, packet) {
  if (packet.length < 12 + AUTH_TAG_LEN) return null;

  const header          = packet.slice(0, 12);
  const headerAndCipher  = packet.slice(0, packet.length - AUTH_TAG_LEN);
  const ciphertext       = packet.slice(12, packet.length - AUTH_TAG_LEN);
  const tagReceived      = packet.slice(packet.length - AUTH_TAG_LEN);

  const seq  = header.readUInt16BE(2);
  const ssrc = header.readUInt32BE(8);
  const roc  = _computeRoc(rxCtx, seq);

  const expectedTag = _authTag(rxCtx.sessionKeys.authKey, headerAndCipher, roc);
  if (expectedTag.length !== tagReceived.length || !crypto.timingSafeEqual(expectedTag, tagReceived)) {
    return null;
  }

  rxCtx.roc     = roc;
  rxCtx.lastSeq = seq;

  const iv      = _packetIv(rxCtx.sessionKeys.saltKey, ssrc, roc, seq);
  const payload = _cryptPayload(rxCtx.sessionKeys.encKey, iv, ciphertext);
  return { header, payload };
}

module.exports = {
  SUITE,
  generateMasterKeySalt,
  buildCryptoAttr,
  parseCryptoAttr,
  deriveSessionKeys,
  encrypt,
  decryptVerify,
};
