const UNQUOTED_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NUMERIC_LIKE = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
const NEEDS_QUOTE = /[:"\\[\]{},]|[\u0000-\u001f]/;

/**
 * True if `s` contains a UTF-16 surrogate code unit with no matching partner.
 * A correctly paired astral character (two surrogates in sequence) is valid
 * and must not trip this check.
 * @param {string} s
 * @returns {boolean}
 */
const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
};

/**
 * @param {string} s
 * @returns {void}
 */
const assertNoLoneSurrogate = (s) => {
  if (hasLoneSurrogate(s)) throw new Error('a lone surrogate cannot be represented in TOON (spec section 3)');
};

/**
 * @param {unknown} v
 * @returns {string}
 */
const describeValue = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const ctorName = /** @type {{ constructor?: { name?: string } }} */ (v).constructor?.name;
  return ctorName || typeof v;
};

/**
 * @param {string} s
 * @returns {string}
 */
const escapeInner = (s) => s.replace(/[\\"\n\r\t\u0000-\u001f]/g, (/** @type {string} */ ch) => {
  if (ch === '\\') return '\\\\';
  if (ch === '"') return '\\"';
  if (ch === '\n') return '\\n';
  if (ch === '\r') return '\\r';
  if (ch === '\t') return '\\t';
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
});

/**
 * Quotes a string value only where section 7.2 requires it. An unquoted value
 * that should have been quoted decodes as the wrong type, so err towards quoting.
 * @param {string} s
 * @returns {string}
 */
export const quoteValue = (s) => {
  const must = s === ''
    || /^[ \t]/.test(s) || /[ \t]$/.test(s)
    || s === 'true' || s === 'false' || s === 'null'
    || NUMERIC_LIKE.test(s)
    || NEEDS_QUOTE.test(s)
    || s.startsWith('-') || s.startsWith('#');
  return must ? `"${escapeInner(s)}"` : s;
};

/**
 * @param {string} k
 * @returns {string}
 */
const key = (k) => {
  assertNoLoneSurrogate(k);
  return UNQUOTED_KEY.test(k) ? k : `"${escapeInner(k)}"`;
};

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isPrimitive = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * @param {unknown} v
 * @returns {string}
 */
const primitive = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'null';
    return String(v);
  }
  if (typeof v === 'string') {
    assertNoLoneSurrogate(v);
    return quoteValue(v);
  }
  throw new Error(`cannot encode a ${describeValue(v)} as a primitive value`);
};

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isPlainObject = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * @param {unknown[]} rows
 * @returns {string[]}
 */
const tabularFields = (rows) => {
  if (rows.some((r) => Array.isArray(r))) {
    throw new Error('an array of arrays is out of scope for this encoder (TOON spec section 9.2, list form)');
  }
  if (!rows.every(isPlainObject)) throw new Error('an array of objects must be uniform to encode');
  const fields = Object.keys(/** @type {Record<string, unknown>} */ (rows[0]));
  if (fields.length === 0) throw new Error('an array of objects must be uniform to encode');
  for (const row of rows) {
    const typedRow = /** @type {Record<string, unknown>} */ (row);
    const ks = Object.keys(typedRow);
    if (ks.length !== fields.length || !fields.every((f) => Object.hasOwn(typedRow, f))) {
      throw new Error('an array of objects must be uniform to encode');
    }
    for (const f of fields) {
      if (!isPrimitive(typedRow[f])) throw new Error(`every tabular cell must be primitive, ${f} is not`);
    }
  }
  return fields;
};

/**
 * @param {string} k
 * @param {unknown[]} arr
 * @param {number} depth
 * @returns {string[]}
 */
const arrayLines = (k, arr, depth) => {
  const pad = '  '.repeat(depth);
  if (arr.length === 0) return [`${pad}${key(k)}: []`];
  if (arr.every(isPrimitive)) {
    return [`${pad}${key(k)}[${arr.length}]: ${arr.map(primitive).join(',')}`];
  }
  const fields = tabularFields(arr);
  const inner = '  '.repeat(depth + 1);
  return [
    `${pad}${key(k)}[${arr.length}]{${fields.map(key).join(',')}}:`,
    ...arr.map((row) => `${inner}${fields.map((f) => primitive(/** @type {any} */ (row)[f])).join(',')}`),
  ];
};

/**
 * @param {Record<string, unknown>} obj
 * @param {number} depth
 * @returns {string[]}
 */
const objectLines = (obj, depth) => {
  const pad = '  '.repeat(depth);
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out.push(...arrayLines(k, v, depth));
    else if (isPlainObject(v)) out.push(`${pad}${key(k)}:`, ...objectLines(/** @type {any} */ (v), depth + 1));
    else out.push(`${pad}${key(k)}: ${primitive(v)}`);
  }
  return out;
};

/**
 * Encodes the shapes `cr` emits as TOON. Throws on anything outside that
 * subset: almost-TOON is worse than JSON, because it parses until it does not.
 *
 * Deliberately unimplemented: TOON spec section 9.3's nested-uniform columns
 * (a tabular column of uniform objects, emitted as a nested field group) and
 * section 9.5's keyed tabular form (an object of uniform objects). `cr`'s
 * payloads do not produce either shape, so array-of-object columns and
 * object values fall back to nested form or throw rather than being encoded
 * in either of those forms.
 * @param {unknown} value
 * @returns {string}
 */
export const encode = (value) => {
  if (!isPlainObject(value)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      throw new Error(`the root value must be a plain object, got ${describeValue(value)}`);
    }
    throw new Error('the root value must be an object');
  }
  return objectLines(/** @type {any} */ (value), 0).join('\n');
};
