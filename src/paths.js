import os from 'node:os';
import path from 'node:path';

/** @returns {string} */
export const homeDir = () => process.env.CODEREVIEW_AXI_HOME ?? path.join(os.homedir(), '.codereview-axi');

/** @returns {string} */
export const statePath = () => path.join(homeDir(), 'state.json');

/** @returns {string} */
export const serverPath = () => path.join(homeDir(), 'server.json');
