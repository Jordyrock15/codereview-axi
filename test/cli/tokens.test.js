import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../src/cli/toon.js';
import { presentComment, DEFAULT_COMMENT_FIELDS } from '../../src/cli/present.js';

/** Realistic review prose: commas and colons are what force TOON to quote. */
const comments = [
  {
    id: 1, scope: 'line', file: 'src/payouts/rounding.js', side: 'new', startLine: 5, endLine: 6,
    quote: '  const remainder = total - each * ways;\n  return Array.from({ length: ways }, (_, i) => each + (i < remainder ? 1 : 0));',
    body: 'Does this handle a negative total? If it can, the remainder goes the wrong way.',
    verdict: 'fix', status: 'open', agentReply: null, deliveredAt: null,
    createdAt: '2026-07-31T09:18:19.791Z', updatedAt: '2026-07-31T09:18:19.791Z',
  },
  {
    id: 2, scope: 'line', file: 'src/payouts/rounding.js', side: 'new', startLine: 9, endLine: 9,
    quote: 'export const commission = (total, rate) => Math.round(total * rate * 100) / 100;',
    body: 'Why round here, and not at the payout boundary: does this compound across splits?',
    verdict: 'explain', status: 'open', agentReply: null, deliveredAt: null,
    createdAt: '2026-07-31T09:20:02.114Z', updatedAt: '2026-07-31T09:20:02.114Z',
  },
];

const pct = (/** @type {number} */ a, /** @type {number} */ b) => Math.round((1 - b / a) * 100);

test('the measured saving, reported rather than assumed', () => {
  const before = JSON.stringify({ comments }, null, 2);
  const presented = comments.map((c) => presentComment(c, DEFAULT_COMMENT_FIELDS));

  const fieldsOnlyJson = JSON.stringify({ comments: presented }, null, 2);
  const after = encode({ comments: presented });

  console.log(`  today, pretty JSON, all fields : ${before.length} chars`);
  console.log(`  default fields, still JSON     : ${fieldsOnlyJson.length} chars (${pct(before.length, fieldsOnlyJson.length)}% saved)`);
  console.log(`  default fields, TOON           : ${after.length} chars (${pct(before.length, after.length)}% saved overall)`);
  console.log(`  encoding alone contributed     : ${pct(fieldsOnlyJson.length, after.length)}%`);

  // Guard the direction, not a specific ratio: a brittle threshold would fail
  // on any wording change to a message, which is not a regression.
  assert.equal(after.length < before.length, true, 'the whole change must shrink the payload');
  assert.equal(after.length < fieldsOnlyJson.length, true, 'the encoding must contribute a saving of its own');
});

test('counterfactual: the cost of keeping quote in the default set', () => {
  const withoutQuote = DEFAULT_COMMENT_FIELDS.filter((f) => f !== 'quote');
  const presented = comments.map((c) => presentComment(c, withoutQuote));
  const after = encode({ comments: presented });

  const before = JSON.stringify({ comments }, null, 2);
  console.log(`  default fields minus quote, TOON: ${after.length} chars (${pct(before.length, after.length)}% saved overall)`);

  assert.equal(after.length < before.length, true);
});
