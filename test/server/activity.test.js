import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityState, activityLabel } from '../../src/server/public/activity.js';

/**
 * @typedef {import('../../src/types.js').Comment} Comment
 */

/**
 * @param {Partial<Comment>} overrides
 * @returns {Comment}
 */
const comment = (overrides = {}) => ({
  id: 1, scope: 'line', file: 'a.js', side: 'new', startLine: 1, endLine: 1,
  quote: '', body: '', verdict: 'fix', status: 'sent', replies: [],
  deliveredAt: null, createdAt: '', updatedAt: '', ...overrides,
});

const NOW = 1_000_000;

test('no sent comments and no lease is idle, not polling', () => {
  const state = activityState({ comments: [comment({ status: 'open' })], lease: null }, NOW);
  assert.deepEqual(state, { delivery: 'idle', polling: false });
});

test('a sent, undelivered comment is waiting', () => {
  const state = activityState({ comments: [comment({ status: 'sent', deliveredAt: null })], lease: null }, NOW);
  assert.equal(state.delivery, 'waiting');
});

test('a sent, delivered comment is working', () => {
  const state = activityState({ comments: [comment({ status: 'sent', deliveredAt: '2026-07-30T00:00:00.000Z' })], lease: null }, NOW);
  assert.equal(state.delivery, 'working');
});

test('one delivered and one undelivered sent comment reads as waiting, the more urgent case', () => {
  const state = activityState({
    comments: [
      comment({ id: 1, status: 'sent', deliveredAt: '2026-07-30T00:00:00.000Z' }),
      comment({ id: 2, status: 'sent', deliveredAt: null }),
    ],
    lease: null,
  }, NOW);
  assert.equal(state.delivery, 'waiting');
});

test('a resent comment (status sent, deliveredAt cleared back to null) reads as waiting again', () => {
  const resent = comment({ status: 'sent', deliveredAt: null, updatedAt: 'later' });
  const state = activityState({ comments: [resent], lease: null }, NOW);
  assert.equal(state.delivery, 'waiting');
});

test('an unexpired lease is polling', () => {
  const state = activityState({ comments: [], lease: { holder: 1, expiresAt: new Date(NOW + 5_000).toISOString() } }, NOW);
  assert.equal(state.polling, true);
});

test('an expired lease is not polling', () => {
  const state = activityState({ comments: [], lease: { holder: 1, expiresAt: new Date(NOW - 5_000).toISOString() } }, NOW);
  assert.equal(state.polling, false);
});

test('an expired lease alongside a delivered comment stays working, not polling', () => {
  const state = activityState({
    comments: [comment({ status: 'sent', deliveredAt: '2026-07-30T00:00:00.000Z' })],
    lease: { holder: 1, expiresAt: new Date(NOW - 1).toISOString() },
  }, NOW);
  assert.deepEqual(state, { delivery: 'working', polling: false });
});

test('an active lease combines with idle: nothing sent yet, but an agent is on the wire', () => {
  const state = activityState({ comments: [], lease: { holder: 1, expiresAt: new Date(NOW + 5_000).toISOString() } }, NOW);
  assert.deepEqual(state, { delivery: 'idle', polling: true });
});

test('an active lease combines with waiting: the agent is connected but has not delivered yet', () => {
  const state = activityState({
    comments: [comment({ status: 'sent', deliveredAt: null })],
    lease: { holder: 1, expiresAt: new Date(NOW + 5_000).toISOString() },
  }, NOW);
  assert.deepEqual(state, { delivery: 'waiting', polling: true });
});

test('an active lease combines with working: the agent has it and is still connected', () => {
  const state = activityState({
    comments: [comment({ status: 'sent', deliveredAt: '2026-07-30T00:00:00.000Z' })],
    lease: { holder: 1, expiresAt: new Date(NOW + 5_000).toISOString() },
  }, NOW);
  assert.deepEqual(state, { delivery: 'working', polling: true });
});

test('a lease expiring at exactly now is not polling', () => {
  const state = activityState({ comments: [], lease: { holder: 1, expiresAt: new Date(NOW).toISOString() } }, NOW);
  assert.equal(state.polling, false);
});

test('waiting with a lease is the agent listening', () => {
  assert.equal(activityLabel({ delivery: 'waiting', polling: true }), 'agent listening');
});

test('waiting with no lease is waiting for the agent', () => {
  assert.equal(activityLabel({ delivery: 'waiting', polling: false }), 'waiting for agent');
});

test('working with a lease is the agent working', () => {
  assert.equal(activityLabel({ delivery: 'working', polling: true }), 'agent working');
});

test('working with no lease is the agent having it', () => {
  assert.equal(activityLabel({ delivery: 'working', polling: false }), 'agent has it');
});

test('idle with a lease is the agent connected', () => {
  assert.equal(activityLabel({ delivery: 'idle', polling: true }), 'agent connected');
});

test('idle with no lease has nothing to say', () => {
  assert.equal(activityLabel({ delivery: 'idle', polling: false }), '');
});
