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
    if (ch !== '\\') { bytes.push(ch.charCodeAt(0)); continue; }
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
 * @param {string} raw Everything after `diff --git `.
 * @returns {{a: string, b: string}|null}
 */
const parseGitPaths = (raw) => {
  // The common, unquoted case first: greedy matching is what lets an
  // unquoted path containing a literal space parse correctly.
  const simple = raw.match(/^a\/(.+) b\/(.+)$/);
  if (simple) return { a: simple[1], b: simple[2] };

  const first = readPathToken(raw);
  if (first === null || !first.value.startsWith('a/')) return null;
  const second = readPathToken(first.rest.replace(/^ /, ''));
  if (second === null || !second.value.startsWith('b/')) return null;

  return { a: first.value.slice(2), b: second.value.slice(2) };
};

/**
 * Parses git's unified diff output.
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

  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = parseGitPaths(line.slice('diff --git '.length));
      if (paths === null) {
        // A path git felt it had to quote for reasons other than non-ASCII
        // bytes (a literal quote, backslash or newline) but that this parser
        // cannot decode: better to drop the entry than hand back an empty
        // path, which would render as a blank row and collide with any other.
        console.error(`cr: could not parse a file path from "${line}", skipping it`);
        file = null;
        hunk = null;
        continue;
      }
      file = {
        path: paths.b,
        oldPath: null,
        status: 'modified',
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
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

  return files;
};
