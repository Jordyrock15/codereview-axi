import { composeGraph } from './compose.js';

/** @type {import('./types.js').BuildChangeGraph} */
export const buildChangeGraph = (root, files) => composeGraph(root, files);
