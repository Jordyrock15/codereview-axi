import {
  readFile, writeFile, mkdir, rename, realpath,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * The result of installing (or finding already installed) the ambient-context hook.
 * @interface InstallHookResult
 * @typedef {Object} InstallHookResult
 * @property {'added'|'already-present'} action — Whether the hook was just added or was already there.
 * @property {string} path — The settings file that was read (and, for `added`, written); resolved to its real path once it is known to exist, so a symlinked settings file makes the true destination visible.
 */

/**
 * Marks a hook entry as this tool's own, so a rerun can recognise it without
 * string-matching a command anyone might use (a settings file already
 * containing an unrelated `"command": "cr"` alias must not read as "ours").
 */
export const HOOK_MARKER = 'codereview-axi';

/**
 * Adds a SessionStart hook running `command`, merging into whatever is already
 * there. Refuses to touch a file it cannot parse: silently rewriting a human's
 * settings would be worse than doing nothing.
 * @param {string} settingsPath
 * @param {string} command
 * @returns {Promise<InstallHookResult>}
 */
export const installHook = async (settingsPath, command) => {
  /** @type {string|null} */
  let raw = null;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch (/** @type {any} */ err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`could not read ${settingsPath}, fix or move it first: ${err.message}`);
    }
  }

  // A UTF-8 BOM makes JSON.parse throw; strip it before parsing rather than
  // refusing a BOM'd settings file forever with no hint why.
  const text = raw === null ? '{}' : raw.replace(/^﻿/, '');

  /** @type {any} */
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (/** @type {any} */ err) {
    throw new Error(`could not read ${settingsPath}, fix or move it first: ${err.message}`);
  }

  // Valid JSON that is not a plain object (an array, null, a bare string or
  // number) parses without throwing, so a guard on JSON.parse succeeding
  // alone lets it through: `settings.hooks ??= {}` on an array silently
  // attaches an own property JSON.stringify then drops, and on null or a
  // string it throws a raw TypeError. Refuse it the same way malformed JSON is.
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${settingsPath} does not contain a JSON object, fix or move it first`);
  }

  settings.hooks ??= {};
  // Same shallowness one level down: `{"hooks":"nope"}` or `{"hooks":[1,2]}`
  // must be refused before `settings.hooks.SessionStart ??= []` either throws
  // a raw TypeError (on a string) or attaches a property JSON.stringify drops
  // (on an array).
  if (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks)) {
    throw new Error(`${settingsPath}'s "hooks" is not a JSON object, fix or move it first`);
  }

  settings.hooks.SessionStart ??= [];
  // And again for SessionStart itself: `{"hooks":{"SessionStart":{"a":1}}}`
  // otherwise surfaces `.some is not a function` instead of a clear refusal.
  if (!Array.isArray(settings.hooks.SessionStart)) {
    throw new Error(`${settingsPath}'s "hooks.SessionStart" is not an array, fix or move it first`);
  }

  const present = settings.hooks.SessionStart.some(
    (/** @type {any} */ entry) => (entry?.hooks ?? []).some((/** @type {any} */ h) => h?.[HOOK_MARKER] === true),
  );

  const dir = path.dirname(settingsPath);
  // Symlink resolution only matters once the file is known to exist: a fresh
  // install has nothing to resolve, and resolving the containing directory
  // for a brand-new path would report a path that was never actually chosen
  // (a symlinked tmp dir, for example) rather than the one the caller gave.
  const reportedPath = raw === null ? settingsPath : await realpath(settingsPath).catch(() => settingsPath);

  if (present) return { action: 'already-present', path: reportedPath };

  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command, [HOOK_MARKER]: true }] });

  await mkdir(dir, { recursive: true });

  // The previous contents are worth keeping: this is the user's agent
  // configuration, and a lost settings file is a bad day. Nothing to back up
  // on a first install.
  if (raw !== null) {
    await writeFile(`${settingsPath}.bak`, raw, { mode: 0o600 });
  }

  // Temp file plus rename, the same pattern src/state/store.js uses: a
  // truncate-then-write can leave a truncated file if interrupted, rename
  // cannot. This makes a lost update possible under concurrent writers, never
  // a corrupt file; that trade is the right one here, so no locking is added.
  const temp = path.join(dir, `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, settingsPath);

  return { action: 'added', path: reportedPath };
};
