import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote } from '../../src/server/public/quote.js';

/**
 * @param {number} line
 * @param {string} text
 * @param {string} [hunk]
 * @returns {{line: number, hunk: string, text: string}}
 */
const row = (line, text, hunk = '0') => ({ line, hunk, text });

test('one line in range is the whole quote', () => {
  const result = buildQuote([row(1, 'a'), row(2, 'b'), row(3, 'c')], 2, 2);
  assert.deepEqual(result, { quote: 'b', contiguous: true, rowCount: 1 });
});

test('several lines join with newlines, in row order', () => {
  const result = buildQuote([row(1, 'a'), row(2, 'b'), row(3, 'c')], 1, 3);
  assert.equal(result.quote, 'a\nb\nc');
  assert.equal(result.rowCount, 3);
});

test('a row with no number on this side is skipped without breaking contiguity', () => {
  const result = buildQuote([row(1, 'a'), row(0, 'deleted'), row(2, 'b')], 1, 2);
  assert.equal(result.quote, 'a\nb');
  assert.equal(result.contiguous, true);
});

test('a range reaching into another hunk is not contiguous', () => {
  const result = buildQuote([row(1, 'a', '0'), row(9, 'b', '1')], 1, 9);
  assert.equal(result.contiguous, false);
  assert.equal(result.rowCount, 2);
});

test('no matching row gives a row count of zero and no contiguity', () => {
  const result = buildQuote([row(1, 'a')], 5, 6);
  assert.deepEqual(result, { quote: '', contiguous: false, rowCount: 0 });
});

test('a blank line is a legitimate one-line quote', () => {
  const result = buildQuote([row(1, 'a'), row(2, ''), row(3, 'c')], 2, 2);
  assert.deepEqual(result, { quote: '', contiguous: true, rowCount: 1 });
});
