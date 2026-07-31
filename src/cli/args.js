/**
 * Parsed command line.
 * @interface ParsedArgs
 * @typedef {Object} ParsedArgs
 * @property {string} verb — The command to run, 'help' when argv is empty.
 * @property {Record<string, string|boolean>} flags — Long flags; a flag with no value is true.
 * @property {string[]} positional — Positionals after the verb.
 */

/**
 * @param {string[]} argv
 * @param {Set<string>} [booleanFlags] Flags known to take no value, so a
 *   following bare token is left as a positional rather than swallowed.
 * @returns {ParsedArgs}
 */
export const parseArgs = (argv, booleanFlags = new Set()) => {
  // A `{}` literal inherits Object.prototype, so `--__proto__ x` sets the
  // prototype instead of an own key and unknownFlags() never sees it.
  /** @type {Record<string, string|boolean>} */
  const flags = Object.create(null);
  /** @type {string[]} */
  const positional = [];
  let verb = 'help';
  let seenVerb = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (booleanFlags.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i += 1;
      }
      continue;
    }
    if (!seenVerb) {
      verb = arg;
      seenVerb = true;
    } else {
      positional.push(arg);
    }
  }

  return { verb, flags, positional };
};
