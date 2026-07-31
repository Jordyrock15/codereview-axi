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

test('drops a file whose quoted header cannot be decoded, rather than giving it an empty path', () => {
  const diff = [
    'diff --git "a/bad\\zzz.js" "b/bad\\zzz.js"',
    'index 0000000..1111111 100644',
    '--- "a/bad\\zzz.js"',
    '+++ "b/bad\\zzz.js"',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');

  assert.deepEqual(parseUnifiedDiff(diff), []);
});
