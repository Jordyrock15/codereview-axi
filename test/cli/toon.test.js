import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, quoteValue } from '../../src/cli/toon.js';

test('a flat object encodes one field per line', () => {
  assert.equal(encode({ key: 'abc123', note: 'tidy up' }), 'key: abc123\nnote: tidy up');
});

test('an array of uniform objects uses the tabular form, paying for field names once', () => {
  const out = encode({
    comments: [
      { id: 1, file: 'a.js', verdict: 'fix' },
      { id: 2, file: 'b.js', verdict: 'explain' },
    ],
  });
  assert.equal(out, [
    'comments[2]{id,file,verdict}:',
    '  1,a.js,fix',
    '  2,b.js,explain',
  ].join('\n'));
});

test('an empty array uses the key: [] form, never the legacy key[0]: header', () => {
  assert.equal(encode({ comments: [] }), 'comments: []');
});

test('an array of primitives is inline with its length declared', () => {
  assert.equal(encode({ tags: ['large', 'binary'] }), 'tags[2]: large,binary');
});

test('a nested object indents its fields by two spaces', () => {
  assert.equal(encode({ totals: { files: 1, added: 3 } }), 'totals:\n  files: 1\n  added: 3');
});

test('quoteValue quotes exactly what section 7.2 requires', () => {
  // Left alone.
  assert.equal(quoteValue('rounding.js'), 'rounding.js');
  assert.equal(quoteValue('Does this handle it?'), 'Does this handle it?');
  assert.equal(quoteValue('café'), 'café');
  // Quoted, one reason each.
  assert.equal(quoteValue(''), '""');
  assert.equal(quoteValue(' lead'), '" lead"');
  assert.equal(quoteValue('trail '), '"trail "');
  assert.equal(quoteValue('true'), '"true"');
  assert.equal(quoteValue('null'), '"null"');
  assert.equal(quoteValue('42'), '"42"');
  assert.equal(quoteValue('-3.14'), '"-3.14"');
  assert.equal(quoteValue('1e-6'), '"1e-6"');
  assert.equal(quoteValue('new:5-6'), '"new:5-6"');
  assert.equal(quoteValue('a,b'), '"a,b"');
  assert.equal(quoteValue('{}'), '"{}"');
  assert.equal(quoteValue('[x]'), '"[x]"');
  assert.equal(quoteValue('-x'), '"-x"');
  assert.equal(quoteValue('#x'), '"#x"');
});

test('quoteValue escapes per section 7.1', () => {
  assert.equal(quoteValue('a"b'), '"a\\"b"');
  assert.equal(quoteValue('a\\b'), '"a\\\\b"');
  assert.equal(quoteValue('a\nb'), '"a\\nb"');
  assert.equal(quoteValue('a\rb'), '"a\\rb"');
  assert.equal(quoteValue('a\tb'), '"a\\tb"');
  assert.equal(quoteValue('ab'), '"a\\u0001b"');
});

test('a key outside the unquoted pattern is quoted', () => {
  assert.equal(encode({ 'my-key': 1 }), '"my-key": 1');
});

test('booleans, null and numbers are canonical and unquoted', () => {
  assert.equal(encode({ a: true, b: false, c: null, d: 0, e: -1.5 }), 'a: true\nb: false\nc: null\nd: 0\ne: -1.5');
});

test('a multi-line string survives a tabular cell as an escaped one-liner', () => {
  const out = encode({ rows: [{ id: 1, quote: 'one\ntwo' }] });
  assert.equal(out, 'rows[1]{id,quote}:\n  1,"one\\ntwo"');
});

test('encode throws rather than emitting almost-TOON for a shape outside the subset', () => {
  assert.throws(() => encode({ mixed: [1, { a: 2 }] }), /uniform/);
  assert.throws(() => encode({ nested: [{ a: { b: 1 } }] }), /primitive/);
  assert.throws(() => encode({ deep: [[1, 2]] }), /uniform/);
});

test('the spec Appendix A users example round-trips to the documented bytes', () => {
  const out = encode({ users: [{ id: 1, name: 'Ada', role: 'admin' }, { id: 2, name: 'Bob', role: 'user' }] });
  assert.equal(out, 'users[2]{id,name,role}:\n  1,Ada,admin\n  2,Bob,user');
});
