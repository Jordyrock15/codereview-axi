import { spawn } from 'node:child_process';

/**
 * @param {string} url
 * @returns {Promise<void>}
 */
export const openUrl = async (url) => {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
};
