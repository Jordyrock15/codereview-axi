import { spawn } from 'node:child_process';

/**
 * @param {string} url
 * @returns {Promise<void>}
 */
export const openUrl = async (url) => {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  // A missing xdg-open emits 'error'; unhandled, that is fatal for the whole process.
  child.once('error', () => {});
  child.unref();
};
