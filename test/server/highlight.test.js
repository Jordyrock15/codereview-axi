import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlight } from '../../src/server/public/highlight.js';

test('escapes HTML in plain text', () => {
  assert.equal(highlight('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('escapes HTML inside a matched token', () => {
  assert.match(highlight('const x = "<script>"'), /&lt;script&gt;/);
  assert.equal(highlight('const x = "<script>"').includes('<script>'), false);
});

test('wraps keywords, strings, numbers and comments', () => {
  const out = highlight('const n = 42; // note');
  assert.match(out, /tok-keyword">const/);
  assert.match(out, /tok-number">42/);
  assert.match(out, /tok-comment">\/\/ note/);
});

test('leaves unrecognised text alone', () => {
  assert.equal(highlight('plain words here'), 'plain words here');
});
