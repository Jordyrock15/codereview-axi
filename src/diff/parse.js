/**
 * @typedef {import('../types.js').DiffFile} DiffFile
 * @typedef {import('../types.js').Hunk} Hunk
 * @typedef {import('../types.js').DiffLine} DiffLine
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

const C_ESCAPES = {
  '\\': 0x5c, '"': 0x22, n: 0x0a, t: 0x09, r: 0x0d, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b,
};

/**
 * core.quotePath only stops git quoting non-ASCII bytes; a literal quote,
 * backslash or control character in a filename is always C-escaped and
 * wrapped in double quotes, regardless of that setting.
 * @param {string} quoted A string starting and ending with an unescaped `"`.
 * @returns {string|null} The decoded path, or null when the escaping is malformed.
 */
const dequote = (quoted) => {
  const inner = quoted.slice(1, -1);
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      // core.quotePath=false lets non-ASCII bytes through raw even on a name
      // git still had to quote for some other character; charCodeAt(0) is
      // only correct for single-byte ASCII, so re-encode anything above it
      // back to the UTF-8 bytes git actually emitted.
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    i += 1;
    const esc = inner[i];
    if (esc === undefined) return null;
    if (esc >= '0' && esc <= '7') {
      const octal = inner.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    if (!(esc in C_ESCAPES)) return null;
    bytes.push(C_ESCAPES[/** @type {keyof typeof C_ESCAPES} */ (esc)]);
  }
  return Buffer.from(bytes).toString('utf8');
};

/**
 * `rename from`/`rename to` are quoted independently of the `diff --git`
 * line and by the same rule, so they need the same treatment.
 * @param {string} raw
 * @returns {string}
 */
const maybeDequote = (raw) => {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return dequote(raw) ?? raw;
};

/**
 * Reads one path token (quoted or not) off the front of a header remainder.
 * @param {string} s
 * @returns {{value: string, rest: string}|null}
 */
const readPathToken = (s) => {
  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    if (i >= s.length) return null;
    const value = dequote(s.slice(0, i + 1));
    return value === null ? null : { value, rest: s.slice(i + 1) };
  }
  const sp = s.indexOf(' ');
  return sp === -1 ? { value: s, rest: '' } : { value: s.slice(0, sp), rest: s.slice(sp) };
};

/**
 * Every way `a/<A> b/<B>` could split at an occurrence of the literal ` b/`.
 * The `diff --git` line is not the path source any more (see `resolvePath`
 * below), but it is still all that is left for a binary or mode-only entry,
 * which carries no `---`/`+++` line to disambiguate it. A path itself
 * containing ` b/` (the decoy shape) produces more than one candidate here;
 * without a rename's `a`/`b` genuinely differing, the true split is the one
 * where both halves match, so that is what the caller prefers.
 * @param {string} raw Everything after `diff --git `.
 * @returns {{a: string, b: string}[]}
 */
const gitHeaderCandidates = (raw) => {
  if (raw.startsWith('"')) {
    const first = readPathToken(raw);
    if (first === null || !first.value.startsWith('a/')) return [];
    const second = readPathToken(first.rest.replace(/^ /, ''));
    if (second === null || !second.value.startsWith('b/')) return [];
    const a = first.value.slice(2);
    const b = second.value.slice(2);
    return a === '' || b === '' ? [] : [{ a, b }];
  }

  if (!raw.startsWith('a/')) return [];
  /** @type {{a: string, b: string}[]} */
  const candidates = [];
  let idx = raw.indexOf(' b/');
  while (idx !== -1) {
    const a = raw.slice(2, idx);
    const b = raw.slice(idx + 3);
    if (a !== '' && b !== '') candidates.push({ a, b });
    idx = raw.indexOf(' b/', idx + 1);
  }
  return candidates;
};

/**
 * Picks a path for the one case left with no `---`/`+++` line and no rename
 * markers: binary content or a mode-only change. There is no `a`/`b`
 * asymmetry in either case, so the candidate where both sides agree is the
 * real split; anything else, including no candidate at all, is unresolvable.
 * @param {string} raw Everything after `diff --git `.
 * @returns {string|null}
 */
const resolveHeaderOnlyPath = (raw) => {
  const match = gitHeaderCandidates(raw).find((c) => c.a === c.b);
  return match ? match.b : null;
};

/**
 * A single, unquoted or quoted path token, prefixed with `a/` or `b/`, taken
 * whole (no second token follows on this line, so unlike the `diff --git`
 * header there is nothing to split on and so nothing ambiguous).
 * @param {string} raw Everything after `--- ` or `+++ `.
 * @param {'a/'|'b/'} marker
 * @returns {{devNull: true}|{devNull: false, value: string}|null}
 */
const resolvePathLine = (raw, marker) => {
  // Git appends a bare trailing tab to this line, quoted or not, whenever the
  // path contains a space: the traditional format's way of marking "no
  // timestamp follows" so a space in the name is never mistaken for one.
  const trimmed = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (trimmed === '/dev/null') return { devNull: true };
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const decoded = dequote(trimmed);
    if (decoded === null || !decoded.startsWith(marker)) return null;
    return { devNull: false, value: decoded.slice(marker.length) };
  }
  if (!trimmed.startsWith(marker)) return null;
  return { devNull: false, value: trimmed.slice(marker.length) };
};

/**
 * Parses git's unified diff output.
 *
 * The path is read from `--- a/<path>` / `+++ b/<path>`, not from the
 * `diff --git` line: those two carry exactly one path each, so they are
 * unambiguous, where `diff --git a/<A> b/<B>` is not once `<A>` or `<B>` can
 * itself contain the literal text ` b/` (a directory named `decoy b`, for
 * instance) — the greedy split then lands on the wrong boundary and a
 * crafted path can steal another file's identity. The `diff --git` line is
 * used only when there is no `---`/`+++` at all, the binary and mode-only
 * case, where the two sides never differ over content and so the candidate
 * split with matching halves is trustworthy.
 * @param {string} text
 * @returns {DiffFile[]}
 */
export const parseUnifiedDiff = (text) => {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile|null} */
  let file = null;
  /** @type {Hunk|null} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  /** Raw text after `diff --git ` for the current file, the last-resort path source. */
  let rawHeader = '';
  /** @type {{devNull: true}|{devNull: false, value: string}|null} */
  let minus = null;
  /** @type {{devNull: true}|{devNull: false, value: string}|null} */
  let plus = null;

  /** Replaces the current file with the standard tagged stand-in, discarding whatever it parsed. */
  const markUnparsable = () => {
    if (file === null) return;
    console.error(`cr: could not determine a file path for "diff --git ${rawHeader}", skipping it`);
    files[files.length - 1] = {
      path: `(unparsable path, raw header: diff --git ${rawHeader})`,
      oldPath: null,
      status: 'modified',
      binary: false,
      added: 0,
      removed: 0,
      hunks: [],
      tags: ['unparsable'],
    };
  };

  /** Settles the current file's path once its header block is fully read. */
  const finalizeFile = () => {
    if (file === null) return;

    if (plus !== null || minus !== null) {
      if (plus !== null && !plus.devNull) { file.path = plus.value; return; }
      if (minus !== null && !minus.devNull) { file.path = minus.value; return; }
      // Both sides present but neither usable: malformed quoting on both, or
      // (nonsensically) both /dev/null. Guessing from diff --git here would
      // reintroduce the very ambiguity this fix removes.
      markUnparsable();
      return;
    }

    // A pure rename with no content change has neither line; `rename to`
    // already set the real path, unambiguously, so there is nothing to do.
    if (file.status === 'renamed') return;

    const resolved = resolveHeaderOnlyPath(rawHeader);
    if (resolved === null) { markUnparsable(); return; }
    file.path = resolved;
  };

  const rawLines = text.split('\n');
  // A diff ending in a newline splits with a trailing '', which is not a
  // line at all; left in, it is read as a phantom blank context line at the
  // tail of the last hunk, one past what the diff actually contains.
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finalizeFile();
      rawHeader = line.slice('diff --git '.length);
      minus = null;
      plus = null;
      file = {
        path: '',
        oldPath: null,
        status: 'modified',
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
        tags: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('rename from ')) {
      file.oldPath = maybeDequote(line.slice('rename from '.length));
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = maybeDequote(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('Binary files ')) {
      file.binary = true;
      continue;
    }
    // These only ever precede the first hunk; once `hunk` exists, a line
    // starting the same way is real diff content (a deleted line that
    // itself begins with `-- `), not a header.
    if (!hunk && line.startsWith('--- ')) {
      minus = resolvePathLine(line.slice('--- '.length), 'a/');
      continue;
    }
    if (!hunk && line.startsWith('+++ ')) {
      plus = resolvePathLine(line.slice('+++ '.length), 'b/');
      continue;
    }

    const match = HUNK.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: newLine,
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        header: match[5] ?? '',
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('\\')) continue;

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      file.added += 1;
      continue;
    }
    if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      file.removed += 1;
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      // A bare empty line inside a hunk is an unchanged blank line, not a terminator.
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  finalizeFile();

  return files;
};
