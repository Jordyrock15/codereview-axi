import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The result of installing (or finding already installed) the ambient-context hook.
 * @interface InstallHookResult
 * @typedef {Object} InstallHookResult
 * @property {'added'|'already-present'} action — Whether the hook was just added or was already there.
 * @property {string} path — The settings file that was read (and, for `added`, written).
 */

/**
 * Adds a SessionStart hook running `command`, merging into whatever is already
 * there. Refuses to touch a file it cannot parse: silently rewriting a human's
 * settings would be worse than doing nothing.
 * @param {string} settingsPath
 * @param {string} command
 * @returns {Promise<InstallHookResult>}
 */
export const installHook = async (settingsPath, command) => {
  /** @type {any} */
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (/** @type {any} */ err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`could not read ${settingsPath}, fix or move it first: ${err.message}`);
    }
  }

  // Valid JSON that is not a plain object (an array, null, a bare string or
  // number) parses without throwing, so the guard above lets it through:
  // `settings.hooks ??= {}` on an array silently attaches an own property
  // JSON.stringify then drops, and on null or a string it throws a raw
  // TypeError. Refuse it the same way malformed JSON is refused above.
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${settingsPath} does not contain a JSON object, fix or move it first`);
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];

  const present = settings.hooks.SessionStart.some(
    (/** @type {any} */ entry) => (entry?.hooks ?? []).some((/** @type {any} */ h) => h?.command === command),
  );
  if (present) return { action: 'already-present', path: settingsPath };

  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command }] });

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { action: 'added', path: settingsPath };
};
