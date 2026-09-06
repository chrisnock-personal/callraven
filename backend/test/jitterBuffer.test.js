'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JitterBuffer } = require('../jitterBuffer.js');

const SSRC = 0xaabbccdd;

function makeBuffer(targetDepth = 3) {
  const released = [];
  const jb = new JitterBuffer({ targetDepth, onRelease: (packet) => released.push(packet) });
  return { jb, released };
}

test('constructor requires an onRelease callback', () => {
  assert.throws(() => new JitterBuffer({}), /onRelease/);
});

test('does not release anything until targetDepth packets have been buffered', () => {
  const { jb, released } = makeBuffer(3);
  jb.push(1, SSRC, 'a');
  jb.tick();
  jb.push(2, SSRC, 'b');
  jb.tick();
  assert.deepEqual(released, []);
  jb.push(3, SSRC, 'c');
  jb.tick();
  assert.deepEqual(released, ['a']);
});

test('releases in sequence order even when pushed out of order', () => {
  const { jb, released } = makeBuffer(3);
  jb.push(5, SSRC, 'e');
  jb.push(3, SSRC, 'c');
  jb.push(4, SSRC, 'd');
  for (let i = 0; i < 3; i++) jb.tick();
  assert.deepEqual(released, ['c', 'd', 'e']);
});

test('one tick releases at most one packet', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(1, SSRC, 'a');
  jb.push(2, SSRC, 'b');
  jb.push(3, SSRC, 'c');
  jb.tick();
  assert.deepEqual(released, ['a']);
  jb.tick();
  assert.deepEqual(released, ['a', 'b']);
});

test('a missing sequence number is skipped, not waited on forever', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(1, SSRC, 'a');
  jb.push(2, SSRC, 'b');
  // seq 3 never arrives (lost)
  jb.push(4, SSRC, 'd');
  jb.tick(); // releases 1
  jb.tick(); // releases 2
  jb.tick(); // seq 3 missing — skipped, no release
  assert.deepEqual(released, ['a', 'b']);
  jb.tick(); // releases 4
  assert.deepEqual(released, ['a', 'b', 'd']);
});

test('a stale/duplicate packet arriving after its slot already released is dropped', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(1, SSRC, 'a');
  jb.push(2, SSRC, 'b');
  jb.tick(); // releases 1, nextSeq now 2
  jb.push(1, SSRC, 'a-late'); // stale — already released
  jb.tick(); // releases 2
  assert.deepEqual(released, ['a', 'b']);
});

test('sequence number wraparound (0xffff -> 0x0000) is handled in order', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(0xfffe, SSRC, 'a');
  jb.push(0xffff, SSRC, 'b');
  jb.push(0x0000, SSRC, 'c');
  jb.push(0x0001, SSRC, 'd');
  for (let i = 0; i < 4; i++) jb.tick();
  assert.deepEqual(released, ['a', 'b', 'c', 'd']);
});

test('re-primes on SSRC change instead of treating the new stream as stale', () => {
  const { jb, released } = makeBuffer(2);
  const SSRC2 = 0x11223344;
  jb.push(100, SSRC, 'a');
  jb.push(101, SSRC, 'b');
  jb.tick(); // releases 'a'
  // New source with much lower sequence numbers than the old stream's
  // in-flight state — should not be dropped as "stale".
  jb.push(5, SSRC2, 'x');
  jb.push(6, SSRC2, 'y');
  jb.tick();
  jb.tick();
  assert.deepEqual(released, ['a', 'x', 'y']);
});

test('a huge forward jump in sequence re-primes rather than stalling forever', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(1, SSRC, 'a');
  jb.push(2, SSRC, 'b');
  jb.tick(); // releases 'a', nextSeq now 2
  // A jump far beyond the reorder window (e.g. after a long silence gap)
  jb.push(5000, SSRC, 'far');
  jb.push(5001, SSRC, 'far2');
  jb.tick();
  jb.tick();
  assert.deepEqual(released, ['a', 'far', 'far2']);
});

test('drains, goes idle, and re-primes cleanly for a later burst', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(1, SSRC, 'a');
  jb.push(2, SSRC, 'b');
  jb.tick(); // releases 'a'
  jb.tick(); // releases 'b', queue now empty -> idle
  assert.deepEqual(released, ['a', 'b']);

  // A later, unrelated burst (same SSRC, but no continuity assumed since
  // the buffer went idle) should re-prime just like a fresh start.
  jb.push(9000, SSRC, 'c');
  jb.tick();
  assert.deepEqual(released, ['a', 'b']); // still buffering for depth 2
  jb.push(9001, SSRC, 'd');
  jb.tick();
  assert.deepEqual(released, ['a', 'b', 'c']);
});

test('stop() clears buffered state so a later push re-primes from scratch', () => {
  const { jb, released } = makeBuffer(2);
  jb.push(1, SSRC, 'a');
  jb.stop();
  jb.push(500, SSRC, 'b');
  jb.push(501, SSRC, 'c');
  jb.tick();
  assert.deepEqual(released, ['b']);
});
