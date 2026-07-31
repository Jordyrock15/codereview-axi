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
