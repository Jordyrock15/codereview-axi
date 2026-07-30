import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homeDir, statePath } from '../paths.js';

/**
 * @typedef {import('../types.js').Session} Session
 * @typedef {{sessions: Record<string, Session>}} State
 */

/** @returns {Promise<State>} */
export const loadState = async () => {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'));
    const ok = parsed && typeof parsed === 'object' && typeof parsed.sessions === 'object'
      && parsed.sessions !== null && !Array.isArray(parsed.sessions);
    return ok ? parsed : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
};

/**
 * @param {State} state
 * @returns {Promise<void>}
 */
export const saveState = async (state) => {
  const dir = homeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to a directory it creates, so an existing one needs this.
  await chmod(dir, 0o700);

  const target = statePath();
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
  await chmod(target, 0o600);
};

/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/**
 * Runs a mutation against the loaded state and persists it. Serialised so two
 * handlers in the same process cannot clobber each other's write.
 * @template T
 * @param {(state: State) => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export const mutateState = (fn) => {
  const run = async () => {
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
};
