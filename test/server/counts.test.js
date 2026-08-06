import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsView } from '../../src/server/public/counts.js';

/**
 * @typedef {import('../../src/types.js').Comment} Comment
 */

/**
 * @param {Partial<Comment>} overrides
 * @returns {Comment}
 */
const comment = (overrides = {}) => ({
  id: 1, scope: 'line', file: 'a.js', side: 'new', startLine: 1, endLine: 1,
  quote: '', body: '', verdict: 'fix', status: 'open', replies: [],
  deliveredAt: null, createdAt: '', updatedAt: '', ...overrides,
});

test('each status is counted on its own', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'open' }),
    comment({ id: 3, status: 'answered' }),
    comment({ id: 4, status: 'stale' }),
    comment({ id: 5, status: 'resolved' }),
  ]);
  assert.equal(shown.unsent, 2);
  assert.equal(shown.answered, 1);
  assert.equal(shown.stale, 1);
  assert.equal(shown.resolved, 1);
});

test('no stale comment leaves the stale label empty', () => {
  assert.equal(countsView([comment({ status: 'open' })]).staleLabel, '');
});

test('a stale comment is reported as text', () => {
  assert.equal(countsView([comment({ status: 'stale' })]).staleLabel, '1 stale');
});

test('an empty queue disables Send and drops the number', () => {
  const shown = countsView([comment({ status: 'answered' })]);
  assert.equal(shown.sendLabel, 'Send');
  assert.equal(shown.sendDisabled, true);
  assert.equal(shown.sendTitle, '');
});

test('a queued comment enables Send and counts it', () => {
  const shown = countsView([comment({ status: 'open' })]);
  assert.equal(shown.sendLabel, 'Send 1');
  assert.equal(shown.sendDisabled, false);
});

test('one reply owed blocks Send in the singular', () => {
  const shown = countsView([comment({ id: 1, status: 'open' }), comment({ id: 2, status: 'sent' })]);
  assert.equal(shown.sendDisabled, true);
  assert.equal(shown.sendLabel, 'Send 1');
  assert.equal(shown.sendTitle, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
});

test('two replies owed block Send in the plural', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'sent' }),
    comment({ id: 3, status: 'sent' }),
  ]);
  assert.equal(shown.sendTitle, 'The agent still owes 2 replies. Your drafts stay queued until it has answered.');
});

test('no comments at all is a disabled, unlabelled Send', () => {
  const shown = countsView([]);
  assert.deepEqual(shown, {
    unsent: 0, answered: 0, stale: 0, resolved: 0, pending: 0,
    staleLabel: '', sendLabel: 'Send', sendDisabled: true, sendTitle: '',
  });
});

test('pending counts the comments the agent holds', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'sent' }),
    comment({ id: 3, status: 'sent' }),
    comment({ id: 4, status: 'answered' }),
  ]);
  assert.equal(shown.pending, 2);
});

test('pending is zero when the agent holds nothing', () => {
  assert.equal(countsView([comment({ status: 'open' })]).pending, 0);
});

test('pending is the same number the blocked send names', () => {
  const shown = countsView([
    comment({ id: 1, status: 'open' }),
    comment({ id: 2, status: 'open' }),
    comment({ id: 3, status: 'sent' }),
  ]);
  assert.equal(shown.pending, 1);
  assert.equal(shown.sendTitle, 'The agent still owes a reply. Your drafts stay queued until it has answered.');
});
