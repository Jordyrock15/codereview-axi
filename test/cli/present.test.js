import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMMENT_FIELDS, AGENT_COMMENT_FIELDS, presentComment, selectFields,
} from '../../src/cli/present.js';

const comment = {
  id: 1,
  scope: 'line',
  file: 'rounding.js',
  side: 'new',
  startLine: 5,
  endLine: 6,
  quote: '  const remainder = total - each * ways;\n  return x;',
  body: 'Does this handle a negative total?',
  verdict: 'fix',
  status: 'open',
  agentReply: null,
  deliveredAt: null,
  createdAt: '2026-07-31T09:18:19.791Z',
  updatedAt: '2026-07-31T09:18:19.791Z',
};

test('the default field set is the six an agent acts on, quote included', () => {
  assert.deepEqual(DEFAULT_COMMENT_FIELDS, ['id', 'file', 'lines', 'verdict', 'body', 'quote']);
});

test('presentComment returns only the requested fields, in that order', () => {
  assert.deepEqual(presentComment(comment, DEFAULT_COMMENT_FIELDS), {
    id: 1,
    file: 'rounding.js',
    lines: 'new:5-6',
    verdict: 'fix',
    body: 'Does this handle a negative total?',
    quote: '  const remainder = total - each * ways;\n  return x;',
  });
});

test('lines collapses side and the line range into one cell', () => {
  assert.equal(presentComment({ ...comment, endLine: 5 }, ['lines']).lines, 'new:5');
  assert.equal(presentComment({ ...comment, side: 'old' }, ['lines']).lines, 'old:5-6');
  assert.equal(presentComment({ ...comment, scope: 'file', side: null, startLine: null, endLine: null }, ['lines']).lines, '');
});

test('quote is present by default, being the comment\'s anchor', () => {
  assert.equal(DEFAULT_COMMENT_FIELDS.includes('quote'), true);
  assert.equal(AGENT_COMMENT_FIELDS.includes('quote'), true);
  assert.match(String(presentComment(comment, ['quote']).quote), /const remainder/);
});

test('deliveredAt is unavailable at any --fields value, being internal bookkeeping', () => {
  assert.equal(AGENT_COMMENT_FIELDS.includes('deliveredAt'), false);
  assert.throws(() => selectFields('id,deliveredAt'), /deliveredAt/);
});

test('selectFields defaults, accepts a subset, and refuses an unknown name', () => {
  assert.deepEqual(selectFields(undefined), DEFAULT_COMMENT_FIELDS);
  assert.deepEqual(selectFields('id,quote'), ['id', 'quote']);
  assert.deepEqual(selectFields('all'), AGENT_COMMENT_FIELDS);
  assert.throws(() => selectFields('id,nope'), /nope/);
});

test('every comment presents the same key set, so the tabular form stays valid', () => {
  const a = presentComment(comment, DEFAULT_COMMENT_FIELDS);
  const b = presentComment({ ...comment, id: 2, scope: 'session', file: null, side: null, startLine: null, endLine: null }, DEFAULT_COMMENT_FIELDS);
  assert.deepEqual(Object.keys(a), Object.keys(b));
});
