import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlight, renderLine, LINE_CAP } from '../../src/server/public/highlight.js';

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

test('renderLine highlights normally under the cap', () => {
  const { html, truncated } = renderLine('const n = 42;');
  assert.equal(truncated, false);
  assert.equal(html, highlight('const n = 42;'));
});

test('renderLine is at the boundary: exactly LINE_CAP characters still highlights', () => {
  const text = 'x'.repeat(LINE_CAP);
  const { truncated } = renderLine(text);
  assert.equal(truncated, false);
});

// The actual attack: one line of 8MB of `"` characters. Each pair becomes a
// span, so highlight() alone would produce millions of DOM nodes; renderLine
// must never call it once the cap is crossed.
test('renderLine skips highlighting entirely past the cap, however pathological the line', () => {
  const text = '"'.repeat(LINE_CAP + 1);
  const { html, truncated } = renderLine(text);

  assert.equal(truncated, true);
  assert.equal(html.includes('tok-string'), false, 'highlighting must not have run at all');
  assert.equal(html.length <= LINE_CAP + '&quot;'.length * LINE_CAP, true);
});

test('renderLine truncates the rendered text to LINE_CAP characters', () => {
  const text = `a${'b'.repeat(LINE_CAP + 500)}`;
  const { html } = renderLine(text);
  // Escaped output for plain 'a'+'b's has no entities to inflate the length,
  // so the html length itself is the truncation point to check.
  assert.equal(html.length, LINE_CAP);
});

test('renderLine still escapes HTML in a truncated line', () => {
  const text = `<script>${'x'.repeat(LINE_CAP)}`;
  const { html, truncated } = renderLine(text);
  assert.equal(truncated, true);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});
