import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeLease, releaseLease, leaseHolder, LEASE_TTL_MS } from '../../src/server/lease.js';

const NOW = 1_800_000_000_000;
// A lease is only honoured while its holder process is alive, so a holder that
// must read as live has to be a real pid. 111 is used where the assertion is
// about expiry or ownership, which never consults liveness.
const LIVE = process.pid;
/** @type {() => any} */
const session = () => ({ lease: null, updatedAt: '' });

test('takeLease records the holder and an expiry', () => {
  const s = session();
  const lease = takeLease(s, 111, NOW, LEASE_TTL_MS);
  assert.equal(lease.holder, 111);
  assert.equal(lease.expiresAt, new Date(NOW + LEASE_TTL_MS).toISOString());
  assert.equal(s.lease, lease);
});

test('a second holder is refused with 409 while the lease is live', () => {
  const s = session();
  takeLease(s, LIVE, NOW, LEASE_TTL_MS);
  assert.throws(() => takeLease(s, LIVE + 1, NOW + 10, LEASE_TTL_MS), (/** @type {any} */err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /another agent is waiting/);
    return true;
  });
});

test('the same holder may retake its own lease, which is how re-polling works', () => {
  const s = session();
  takeLease(s, LIVE, NOW, LEASE_TTL_MS);
  const again = takeLease(s, LIVE, NOW + 500, LEASE_TTL_MS);
  assert.equal(again.expiresAt, new Date(NOW + 500 + LEASE_TTL_MS).toISOString());
});

test('an expired lease is free, so a crashed agent does not lock the session', () => {
  const s = session();
  takeLease(s, 111, NOW, LEASE_TTL_MS);
  const taken = takeLease(s, 222, NOW + LEASE_TTL_MS + 1, LEASE_TTL_MS);
  assert.equal(taken.holder, 222);
});

test('releaseLease clears only the holder own lease', () => {
  const s = session();
  takeLease(s, 111, NOW, LEASE_TTL_MS);
  releaseLease(s, 222);
  assert.notEqual(s.lease, null);
  releaseLease(s, 111);
  assert.equal(s.lease, null);
});

test('leaseHolder reports the live holder and null once expired', () => {
  const s = session();
  takeLease(s, LIVE, NOW, LEASE_TTL_MS);
  assert.equal(leaseHolder(s, NOW + 10), LIVE);
  assert.equal(leaseHolder(s, NOW + LEASE_TTL_MS + 1), null);
});

test('a lease whose holder is gone is free, even well inside its expiry', () => {
  const s = session();
  // A poll may legitimately run for the whole TTL, so waiting for the clock
  // locked the session out for 15 minutes every time a `cr wait` was killed.
  takeLease(s, 111, NOW, LEASE_TTL_MS);
  assert.equal(leaseHolder(s, NOW + 10), null, '111 is not a running process');
  assert.equal(takeLease(s, LIVE, NOW + 10, LEASE_TTL_MS).holder, LIVE);
});
