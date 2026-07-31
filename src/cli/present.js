/**
 * The six fields an agent acts on. `quote` is included by ruling: it is what the
 * comment is anchored to, so it should never need asking for.
 */
export const DEFAULT_COMMENT_FIELDS = ['id', 'file', 'lines', 'verdict', 'body', 'quote'];

/**
 * Everything an agent may ask for. `deliveredAt` is deliberately absent: it is
 * at-most-once delivery bookkeeping, and there is nothing correct to do with it.
 */
export const AGENT_COMMENT_FIELDS = [
  'id', 'scope', 'file', 'lines', 'quote', 'body', 'verdict', 'status',
  'agentReply', 'createdAt', 'updatedAt',
];

const lines = (/** @type {any} */ c) => {
  if (c.startLine === null || c.startLine === undefined) return '';
  const range = c.endLine !== null && c.endLine !== c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  return c.side === null || c.side === undefined ? range : `${c.side}:${range}`;
};

const reply = (/** @type {any} */ c) => (
  c.agentReply === null || c.agentReply === undefined ? '' : `${c.agentReply.status}: ${c.agentReply.body}`
);

/**
 * @param {Record<string, unknown>} comment
 * @param {string[]} fields
 * @returns {Record<string, string|number|boolean|null>}
 */
export const presentComment = (comment, fields) => {
  /** @type {Record<string, string|number|boolean|null>} */
  const out = {};
  for (const f of fields) {
    if (f === 'lines') out.lines = lines(comment);
    else if (f === 'agentReply') out.agentReply = reply(comment);
    else {
      const v = comment[f];
      // Absent becomes empty rather than missing: the tabular form needs a
      // uniform key set across every row.
      out[f] = v === undefined || v === null ? '' : /** @type {any} */ (v);
    }
  }
  return out;
};

/**
 * @param {string|undefined} requested
 * @returns {string[]}
 */
export const selectFields = (requested) => {
  if (requested === undefined) return DEFAULT_COMMENT_FIELDS;
  if (requested === 'all') return AGENT_COMMENT_FIELDS;
  const asked = requested.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const bad = asked.filter((f) => !AGENT_COMMENT_FIELDS.includes(f));
  if (bad.length > 0) {
    throw new Error(`unknown ${bad.length === 1 ? 'field' : 'fields'} ${bad.join(', ')}, available: ${AGENT_COMMENT_FIELDS.join(', ')}`);
  }
  return asked;
};
