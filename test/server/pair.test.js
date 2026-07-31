import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairLines } from '../../src/server/public/pair.js';

/**
 * @typedef {import('../../src/types.js').DiffLine} DiffLine
 * @typedef {{old: DiffLine|null, new: DiffLine|null}} Pair
 */

/**
 * @param {string} text
 * @param {number} o
 * @param {number} n
 * @returns {DiffLine}
 */
const ctx = (text, o, n) => ({ kind: 'context', text, oldLine: o, newLine: n });
/**
 * @param {string} text
 * @param {number} o
 * @returns {DiffLine}
 */
const del = (text, o) => ({ kind: 'del', text, oldLine: o, newLine: null });
/**
 * @param {string} text
 * @param {number} n
 * @returns {DiffLine}
 */
const add = (text, n) => ({ kind: 'add', text, oldLine: null, newLine: n });

/** @param {Pair[]} pairs */
const shape = (pairs) => pairs.map((p) => [p.old?.text ?? null, p.new?.text ?? null]);

test('a context line appears on both sides', () => {
  assert.deepEqual(shape(pairLines([ctx('same', 1, 1)])), [['same', 'same']]);
});

test('a deletion followed by an addition sits on one row', () => {
  assert.deepEqual(shape(pairLines([del('old', 1), add('new', 1)])), [['old', 'new']]);
});

test('an unequal run pads the shorter side', () => {
  assert.deepEqual(
    shape(pairLines([del('a', 1), del('b', 2), add('c', 1)])),
    [['a', 'c'], ['b', null]],
  );
  assert.deepEqual(
    shape(pairLines([del('a', 1), add('b', 1), add('c', 2)])),
    [['a', 'b'], [null, 'c']],
  );
});

test('deletions with no additions pair against nothing', () => {
  assert.deepEqual(shape(pairLines([del('gone', 4)])), [['gone', null]]);
});

test('additions with no deletions pair against nothing', () => {
  assert.deepEqual(shape(pairLines([add('fresh', 4)])), [[null, 'fresh']]);
});

test('context between two change runs separates them', () => {
  assert.deepEqual(
    shape(pairLines([del('a', 1), add('b', 1), ctx('mid', 2, 2), del('c', 3), add('d', 3)])),
    [['a', 'b'], ['mid', 'mid'], ['c', 'd']],
  );
});

test('an addition before a deletion is not paired backwards', () => {
  assert.deepEqual(
    shape(pairLines([add('added', 1), del('removed', 1)])),
    [[null, 'added'], ['removed', null]],
  );
});

test('order within each side is preserved', () => {
  const pairs = pairLines([del('d1', 1), del('d2', 2), del('d3', 3), add('a1', 1), add('a2', 2)]);
  assert.deepEqual(pairs.map((p) => p.old?.text ?? null), ['d1', 'd2', 'd3']);
  assert.deepEqual(pairs.map((p) => p.new?.text ?? null), ['a1', 'a2', null]);
});

test('an empty hunk yields no pairs', () => {
  assert.deepEqual(pairLines([]), []);
});

test('a hunk that begins with additions and ends with deletions forms no pairs', () => {
  assert.deepEqual(
    shape(pairLines([add('a1', 1), add('a2', 2), del('d1', 1), del('d2', 2)])),
    [[null, 'a1'], [null, 'a2'], ['d1', null], ['d2', null]],
  );
});

test('a long run of deletions padded by a single addition keeps order and side', () => {
  const pairs = pairLines([
    del('d1', 1), del('d2', 2), del('d3', 3), del('d4', 4), add('a1', 1),
  ]);
  assert.deepEqual(shape(pairs), [
    ['d1', 'a1'], ['d2', null], ['d3', null], ['d4', null],
  ]);
});

test('a context line between a deletion run and an addition run prevents them pairing', () => {
  assert.deepEqual(
    shape(pairLines([del('a', 1), ctx('mid', 2, 2), add('b', 3)])),
    [['a', null], ['mid', 'mid'], [null, 'b']],
  );
});
