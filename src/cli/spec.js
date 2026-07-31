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
      { name: 'fields', arg: 'LIST', help: 'comma-separated fields, or all, default id,file,lines,verdict,body,quote' },
      { name: 'full', arg: null, help: 'do not truncate body or quote' },
    ],
  },
  list: {
    summary: 'print comments without blocking',
    flags: [
      { name: 'status', arg: 'STATUS', help: 'only comments with this status' },
      { name: 'fields', arg: 'LIST', help: 'comma-separated fields, or all, default id,file,lines,verdict,body,quote' },
      { name: 'full', arg: null, help: 'do not truncate body or quote' },
    ],
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
  setup: {
    summary: 'install a Claude Code hook so every session starts knowing about a review',
    flags: [{ name: 'global', arg: null, help: 'install into ~/.claude/settings.json instead of this repository' }],
  },
};

/**
 * Accepted everywhere, so no verb has to declare them. All four are boolean:
 * none takes a value.
 */
export const UNIVERSAL = ['help', 'json', 'version', 'no-help'];

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
 * The boolean flag names in play for a verb: the universal ones plus any the
 * verb declares with `arg: null`. `undefined` (verb not yet known) gives just
 * the universal set, enough to find the verb itself without misreading it as
 * a flag's value.
 * @param {string} [verb]
 * @returns {Set<string>}
 */
export const booleanFlagNames = (verb) => {
  const spec = verb === undefined ? undefined : VERBS[verb];
  return new Set([...UNIVERSAL, ...(spec ? spec.flags.filter((f) => f.arg === null).map((f) => f.name) : [])]);
};

/**
 * A boolean flag declared with `arg: null` takes no value; catches
 * `--json=true`, `--no-browser=false`, and anything else that hands one over.
 * @param {string} verb
 * @param {Record<string, string|boolean>} flags
 * @returns {string|null} A message naming the offending flag, or null.
 */
export const checkArity = (verb, flags) => {
  for (const name of booleanFlagNames(verb)) {
    if (Object.hasOwn(flags, name) && flags[name] !== true) {
      return `--${name} does not take a value`;
    }
  }
  return null;
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
  'every verb accepts --json to print JSON instead of TOON',
  '',
  'every verb appends help[] lines suggesting the next command; --no-help suppresses them',
  '',
  '--version prints the installed version and exits 0',
  '',
  'exit codes: 0 ok, 1 error, 2 unknown flag; the error code says which error',
].join('\n');
