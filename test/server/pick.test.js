import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPick, pickRange, inPickRange, draftKey } from '../../src/server/public/pick.js';

/**
 * @typedef {import('../../src/server/public/pick.js').Pick} Pick
 */

/** @type {Pick} */
const NOTHING = { file: null, side: 'new', start: null, end: null, hunk: null };

/**
 * @param {Partial<Pick>} overrides
 * @returns {Pick}
 */
const picked = (overrides = {}) => ({ file: 'a.js', side: 'new', start: 4, end: 4, hunk: '0', ...overrides });

/**
 * @param {Partial<import('../../src/server/public/pick.js').PickClick>} overrides
 * @returns {import('../../src/server/public/pick.js').PickClick}
 */
const click = (overrides = {}) => ({ file: 'a.js', side: 'new', line: 6, hunk: '0', shiftKey: false, ...overrides });

test('a plain click starts a one-line range', () => {
  const result = nextPick(NOTHING, click());
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 6, end: 6, hunk: '0' });
  assert.equal(result.shiftExtend, false);
  assert.equal(result.rejected, false);
});

test('a plain click on an existing selection restarts it', () => {
  const result = nextPick(picked(), click({ line: 9 }));
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 9, end: 9, hunk: '0' });
  assert.equal(result.rejected, false);
});

test('shift extends the end inside one hunk and side', () => {
  const result = nextPick(picked(), click({ line: 6, shiftKey: true }));
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 4, end: 6, hunk: '0' });
  assert.equal(result.shiftExtend, true);
  assert.equal(result.rejected, false);
});

test('shift into another hunk restarts and reports a rejection', () => {
  const result = nextPick(picked(), click({ line: 20, hunk: '1', shiftKey: true }));
  assert.deepEqual(result.pick, { file: 'a.js', side: 'new', start: 20, end: 20, hunk: '1' });
  assert.equal(result.shiftExtend, false);
  assert.equal(result.rejected, true);
});

test('shift on the other side restarts and reports a rejection', () => {
  const result = nextPick(picked(), click({ side: 'old', shiftKey: true }));
  assert.equal(result.pick.side, 'old');
  assert.equal(result.rejected, true);
});

test('shift in another file restarts and stays silent', () => {
  const result = nextPick(picked(), click({ file: 'b.js', shiftKey: true }));
  assert.equal(result.pick.file, 'b.js');
  assert.equal(result.rejected, false);
});

test('a first shift-click with nothing picked stays silent', () => {
  const result = nextPick(NOTHING, click({ shiftKey: true }));
  assert.equal(result.shiftExtend, false);
  assert.equal(result.rejected, false);
});

test('nextPick does not mutate the pick it receives', () => {
  const extendInput = picked();
  const extendCopy = { ...extendInput };
  nextPick(extendInput, click({ line: 6, shiftKey: true }));
  assert.deepEqual(extendInput, extendCopy);

  const restartInput = picked();
  const restartCopy = { ...restartInput };
  nextPick(restartInput, click({ line: 9 }));
  assert.deepEqual(restartInput, restartCopy);
});

test('the outcome carries a fresh object, so app.js must copy the fields across', () => {
  const extendInput = picked();
  assert.notEqual(nextPick(extendInput, click({ line: 6, shiftKey: true })).pick, extendInput);

  const restartInput = picked();
  assert.notEqual(nextPick(restartInput, click({ line: 9 })).pick, restartInput);
});

test('a range whose end precedes its start reads low to high', () => {
  assert.deepEqual(pickRange(picked({ start: 9, end: 4 })), { from: 4, to: 9 });
});

test('a range with no end is the start line alone', () => {
  assert.deepEqual(pickRange(picked({ start: 7, end: null })), { from: 7, to: 7 });
});

test('a line inside the range on the picked side is in range', () => {
  assert.equal(inPickRange(5, 'new', picked({ start: 4, end: 6 })), true);
});

test('a line outside the range is not in range', () => {
  assert.equal(inPickRange(9, 'new', picked({ start: 4, end: 6 })), false);
});

test('the same line on the other side is not in range', () => {
  assert.equal(inPickRange(5, 'old', picked({ start: 4, end: 6 })), false);
});

test('nothing is in range when nothing is picked', () => {
  assert.equal(inPickRange(5, 'new', NOTHING), false);
});

test('the draft key ignores the end line, so a shift-extend keeps one draft', () => {
  assert.equal(draftKey(picked({ start: 4, end: 4 })), draftKey(picked({ start: 4, end: 9 })));
});

test('a different file, side or start line gets its own draft key', () => {
  const base = draftKey(picked());
  assert.notEqual(base, draftKey(picked({ file: 'b.js' })));
  assert.notEqual(base, draftKey(picked({ side: 'old' })));
  assert.notEqual(base, draftKey(picked({ start: 5 })));
});
