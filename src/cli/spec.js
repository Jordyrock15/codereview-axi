/**
 * One verb's command line surface.
 * @interface VerbSpec
 * @typedef {Object} VerbSpec
 * @property {string} summary — One line describing what the verb does.
 * @property {{name: string, arg: string|null, help: string}[]} flags — Declared flags, `arg` null for a boolean.
 */

/** @type {Record<string, VerbSpec>} */
export const VERBS = {
  open: {
    summary: 'start or resume a review, against a base ref or a pull request',
    flags: [
      { name: 'note', arg: 'TEXT', help: 'a note for the human, shown in the tab header' },
      { name: 'base', arg: 'REF', help: 'review this branch against its merge base with REF' },
      { name: 'pr', arg: 'N', help: 'review pull request N, needs gh on PATH and authenticated' },
      { name: 'no-browser', arg: null, help: 'do not open a browser tab' },
    ],
  },
  wait: {
    summary: 'block until the human sends comments',
    flags: [
      { name: 'timeout', arg: 'SECONDS', help: 'how long to hold the poll, default 300' },
      { name: 'say', arg: 'TEXT', help: 'tell the human something, replaces the note' },
    ],
  },
  list: {
    summary: 'print comments without blocking',
    flags: [{ name: 'status', arg: 'STATUS', help: 'only comments with this status' }],
  },
  reply: {
    summary: 'answer one comment',
    flags: [
      { name: 'id', arg: 'N', help: 'the comment to answer' },
      { name: 'status', arg: 'S', help: 'fixed, explained or skipped' },
      { name: 'body', arg: 'TEXT', help: 'what to tell the human' },
    ],
  },
  refresh: { summary: 'recompute the diff and push it to the tab', flags: [] },
  close: { summary: 'end the session', flags: [] },
};

/** Accepted everywhere, so no verb has to declare them. */
const UNIVERSAL = ['help'];

/**
 * @param {string} verb
 * @param {Record<string, string|boolean>} flags
 * @returns {string[]} The flag names this verb does not declare, in the order given.
 */
export const unknownFlags = (verb, flags) => {
  const spec = VERBS[verb];
  if (!spec) return [];
  const declared = new Set([...UNIVERSAL, ...spec.flags.map((f) => f.name)]);
  return Object.keys(flags).filter((name) => !declared.has(name));
};

/**
 * @param {string} verb
 * @returns {string}
 */
export const verbHelp = (verb) => {
  const spec = VERBS[verb];
  if (!spec) return USAGE;
  const flags = spec.flags.map((f) => {
    const label = f.arg === null ? `--${f.name}` : `--${f.name} ${f.arg}`;
    return `  ${label.padEnd(22)} ${f.help}`;
  });
  return [`usage: cr ${verb} [flags]`, '', `  ${spec.summary}`, ...(flags.length ? ['', ...flags] : [])].join('\n');
};

const widest = Math.max(...Object.keys(VERBS).map((v) => v.length));

export const USAGE = [
  'usage: cr <verb> [flags]',
  '',
  ...Object.entries(VERBS).map(([verb, spec]) => `  ${verb.padEnd(widest + 2)} ${spec.summary}`),
  '',
  'run `cr <verb> --help` for a verb\'s flags',
  '',
  'exit codes: 0 ok, 1 error, 2 unknown flag; the error code says which error',
].join('\n');
