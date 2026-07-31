import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUnifiedDiff } from '../../src/diff/parse.js';

/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.diff`, import.meta.url), 'utf8');

test('parses a modified file with correct line numbers', () => {
  const [file] = parseUnifiedDiff(fixture('modified'));
  assert.equal(file.path, 'src/payouts/splitter.js');
  assert.equal(file.status, 'modified');
  assert.equal(file.binary, false);
  assert.equal(file.added, 2);
  assert.equal(file.removed, 1);

  const [hunk] = file.hunks;
  assert.equal(hunk.oldStart, 40);
  assert.equal(hunk.newStart, 40);
  assert.equal(hunk.header, 'const helper = () => {');

  assert.deepEqual(
    hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 40, 40],
      ['del', 41, null],
      ['add', null, 41],
      ['add', null, 42],
      ['context', 42, 43],
      ['context', 43, 44],
    ],
  );
});

test('strips the leading marker from line text', () => {
  const [file] = parseUnifiedDiff(fixture('modified'));
  assert.equal(file.hunks[0].lines[1].text, 'return shares.map(Math.round);');
  assert.equal(file.hunks[0].lines[0].text, 'const shares = split(total, parts);');
});

test('detects renames and keeps the old path', () => {
  const [file] = parseUnifiedDiff(fixture('renamed'));
  assert.equal(file.status, 'renamed');
  assert.equal(file.path, 'src/new-name.js');
  assert.equal(file.oldPath, 'src/old-name.js');
  assert.equal(file.hunks.length, 1);
});

test('marks binary files and emits no hunks', () => {
  const [file] = parseUnifiedDiff(fixture('binary'));
  assert.equal(file.binary, true);
  assert.deepEqual(file.hunks, []);
  assert.equal(file.added, 0);
  assert.equal(file.removed, 0);
});

test('keeps a mode-only change as a file with no hunks', () => {
  const [file] = parseUnifiedDiff(fixture('mode-only'));
  assert.equal(file.path, 'scripts/run.sh');
  assert.equal(file.status, 'modified');
  assert.deepEqual(file.hunks, []);
});

test('detects deletions', () => {
  const [file] = parseUnifiedDiff(fixture('deleted'));
  assert.equal(file.status, 'deleted');
  assert.equal(file.path, 'src/gone.js');
  assert.equal(file.removed, 2);
  assert.equal(file.added, 0);
});

// The fixture's trailing newline, once split on '\n', leaves an empty final
// element that is not a line at all. Left in, it reads as a phantom context
// row one past the end of the file, numbered 0 on the old side because the
// last hunk here is del-only and never touches oldLine's running count.
test('drops the trailing artefact of a final newline rather than a phantom context row', () => {
  const [file] = parseUnifiedDiff(fixture('deleted'));
  assert.equal(file.hunks[0].lines.length, 2, 'exactly the two deleted lines, no trailing phantom row');
  assert.equal(file.hunks[0].lines.every((l) => l.oldLine !== 0), true, 'no row numbered 0');
});

test('ignores the no-newline marker without counting it as a line', () => {
  const [file] = parseUnifiedDiff(fixture('no-newline'));
  assert.equal(file.added, 1);
  assert.equal(file.removed, 1);
  assert.deepEqual(file.hunks[0].lines.map((l) => l.kind), ['del', 'add']);
});

test('parses multiple hunks and multiple files', () => {
  const files = parseUnifiedDiff(fixture('multi-hunk'));
  assert.equal(files.length, 2);
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[0].hunks[1].oldStart, 20);
  assert.equal(files[0].added, 3);
  assert.equal(files[0].removed, 2);
  assert.equal(files[1].path, 'b.js');
});

test('strips a trailing CR so CRLF diffs parse', () => {
  const crlf = fixture('modified').replace(/\n/g, '\r\n');
  const [file] = parseUnifiedDiff(crlf);
  assert.equal(file.path, 'src/payouts/splitter.js');
  assert.equal(file.hunks[0].lines[0].text, 'const shares = split(total, parts);');
});

test('returns an empty array for an empty diff', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('\n'), []);
});

// git's core.quotePath defaults on: a non-ASCII filename arrives C-escaped
// and quoted, e.g. `"a/caf\303\251.js"` for café.js (0xC3 0xA9 is the UTF-8
// encoding of é). The plain a/(.+) b/(.+) regex never matches that line.
test('decodes a quoted diff --git header for an accented filename', () => {
  const diff = [
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"',
    'index 0000000..1111111 100644',
    '--- "a/caf\\303\\251.js"',
    '+++ "b/caf\\303\\251.js"',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, 'café.js');
  assert.equal(file.hunks[0].lines[0].text, 'hello');
});

test('decodes a quoted rename with an accented new name', () => {
  const diff = [
    'diff --git "a/old.js" "b/caf\\303\\251.js"',
    'similarity index 100%',
    'rename from old.js',
    'rename to "caf\\303\\251.js"',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.status, 'renamed');
  assert.equal(file.oldPath, 'old.js');
  assert.equal(file.path, 'café.js');
});

// core.quotePath=false (see src/diff/git.js) only stops git quoting a name
// for non-ASCII bytes alone; a name that needs quoting for some other reason
// (a literal quote, backslash, control character) still gets quoted and
// C-escaped, but with non-ASCII bytes now passed through *raw* rather than
// themselves being octal-escaped. dequote() must reconstruct the exact bytes
// git emitted in every one of these shapes, independently encoded here so
// the test does not share a bug with the code it is checking.
/**
 * @param {string} name The real, decoded filename.
 * @returns {string} The escaped body git would print for it under
 * core.quotePath=false, without the surrounding quotes.
 */
const gitEscape = (name) => {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') { out += '\\"'; continue; }
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    if (code < 0x20 || code === 0x7f) { out += `\\${code.toString(8).padStart(3, '0')}`; continue; }
    out += ch; // raw, including non-ASCII: this is what quotePath=false changed.
  }
  return out;
};

/** @param {string} name @returns {string} */
const quotedDiffHeader = (name) => `diff --git "a/${gitEscape(name)}" "b/${gitEscape(name)}"`;

for (const [label, name] of /** @type {[string, string][]} */ ([
  ['a literal quote', 'caf"e.js'],
  ['a backslash', 'caf\\e.js'],
  ['a newline', 'caf\ne.js'],
  ['a tab', 'caf\te.js'],
  ['an octal escape (a control byte with no named C escape)', 'caf\x01e.js'],
  ['non-ASCII together with a quote-forcing character', 'café"q.js'],
])) {
  test(`dequote decodes a name with ${label}`, () => {
    const header = quotedDiffHeader(name);
    const diff = [header, 'index 0000000..1111111 100644', '@@ -0,0 +1 @@', '+hello', ''].join('\n');
    const [file] = parseUnifiedDiff(diff);
    assert.equal(file.path, name);
  });
}

// Real git output never quotes a name for non-ASCII bytes alone once
// quotePath=false is set; this is the ordinary, unquoted path, not dequote.
test('a plain non-ASCII name (no forcing character) decodes via the unquoted path', () => {
  const diff = [
    'diff --git a/café.js b/café.js',
    'index 0000000..1111111 100644',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, 'café.js');
});

test('a header of exactly "a/" "b/" never produces an empty path', () => {
  const diff = [
    'diff --git "a/" "b/"',
    'index 0000000..1111111 100644',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(diff);
  assert.notEqual(file.path, '');
  assert.deepEqual(file.tags, ['unparsable']);
});

test('a file whose quoted header cannot be decoded surfaces as a tagged entry, not an empty path', () => {
  const diff = [
    'diff --git "a/bad\\zzz.js" "b/bad\\zzz.js"',
    'index 0000000..1111111 100644',
    '--- "a/bad\\zzz.js"',
    '+++ "b/bad\\zzz.js"',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path === '', false, 'must never hand back an empty path');
  assert.deepEqual(file.tags, ['unparsable']);
  assert.deepEqual(file.hunks, []);
});

// Real output of `git -c core.quotePath=false diff HEAD` from a repo containing
// a decoy directory `decoy b/` alongside a genuinely modified `index.js`. Before
// the fix, the greedy `a\/(.+) b\/(.+)$` match on the `diff --git` line splits
// at the LAST ` b/`, so the decoy's header parses as path "index.js" too, and
// `.find()`-based lookups downstream then never reach the real index.js entry.
test('a decoy directory named to end in " b/" cannot steal another file\'s path', () => {
  const diff = [
    'diff --git a/decoy b/index.js b/decoy b/index.js',
    'index af4c3e6..9c0c907 100644',
    '--- a/decoy b/index.js\t',
    '+++ b/decoy b/index.js\t',
    '@@ -1 +1 @@',
    '-harmless',
    '+decoy changed',
    'diff --git a/index.js b/index.js',
    'index b7767f6..0a3fae5 100644',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-safe',
    '+SECRET_PAYLOAD',
    '',
  ].join('\n');

  const [decoy, real] = parseUnifiedDiff(diff);
  assert.equal(decoy.path, 'decoy b/index.js');
  assert.equal(real.path, 'index.js', 'the real file must keep its own path, not the decoy\'s');
  assert.notEqual(decoy.path, real.path);
  assert.equal(real.hunks[0].lines.some((l) => l.kind === 'add' && l.text === 'SECRET_PAYLOAD'), true);
});

test('a deletion takes its path from --- a/, since +++ is /dev/null', () => {
  const diff = [
    'diff --git a/decoy b/gone.js b/decoy b/gone.js',
    'deleted file mode 100644',
    'index 5555555..0000000',
    '--- a/decoy b/gone.js',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-const gone = true;',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.status, 'deleted');
  assert.equal(file.path, 'decoy b/gone.js');
});

test('a rename with content changes takes its path from +++ b/, not the diff --git line', () => {
  const diff = [
    'diff --git a/old.js b/decoy b/new.js',
    'similarity index 92%',
    'rename from old.js',
    'rename to decoy b/new.js',
    'index 1111111..2222222 100644',
    '--- a/old.js',
    '+++ b/decoy b/new.js',
    '@@ -1 +1 @@',
    '-const a = 1;',
    '+const a = 2;',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.status, 'renamed');
  assert.equal(file.oldPath, 'old.js');
  assert.equal(file.path, 'decoy b/new.js');
});

// Binary and mode-only changes carry no ---/+++ line, so the diff --git line
// is the only source left. A binary decoy has no rename info to disambiguate
// with, so the fallback must pick the split where both sides agree, not the
// greedy (last) or naive (first) one.
test('a binary decoy resolves via the diff --git line\'s matching-halves candidate', () => {
  const diff = [
    'diff --git a/decoy b/index.js b/decoy b/index.js',
    'index 96db3e1..698ec4e 100644',
    'Binary files a/decoy b/index.js and b/decoy b/index.js differ',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, 'decoy b/index.js');
  assert.equal(file.binary, true);
});

test('a quoted non-ASCII path arriving on the +++ line decodes correctly', () => {
  const diff = [
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"',
    'index 0000000..1111111 100644',
    '--- "a/caf\\303\\251.js"',
    '+++ "b/caf\\303\\251.js"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, 'café.js');
});

test('a --- / +++ path containing a space carries git\'s trailing tab, which must not become part of the path', () => {
  const diff = [
    'diff --git a/my file.js b/my file.js',
    'index 5626abf..f719efd 100644',
    '--- a/my file.js\t',
    '+++ b/my file.js\t',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    '',
  ].join('\n');

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, 'my file.js');
});
