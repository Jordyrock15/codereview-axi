import { performance } from 'node:perf_hooks';
import { classifyFile } from './classify.js';
import { groupFolders, layoutGraph } from './layout.js';
import { importEdges, nameEdges } from './resolve.js';
import { loadTypeScript } from './typescript.js';

/** @typedef {import('./types.js').IChangedFile} IChangedFile */
/** @typedef {import('./types.js').IChangeEdge} IChangeEdge */
/** @typedef {import('./types.js').IChangeGraph} IChangeGraph */
/** @typedef {import('./types.js').IChangeNode} IChangeNode */

/**
 * @param {any} ts
 * @param {string} root
 * @param {IChangedFile[]} files
 * @returns {IChangeEdge[]}
 */
const safeImportEdges = (ts, root, files) => {
  if (!ts) return [];
  try {
    return importEdges(ts, root, files);
  } catch {
    return [];
  }
};

/**
 * @param {string} root
 * @param {IChangedFile[]} files
 * @param {import('./typescript.js').ILoadTypeScriptOptions} [options]
 * @returns {IChangeGraph}
 */
export const composeGraph = (root, files, options = {}) => {
  const started = performance.now();
  /** @type {IChangeNode[]} */
  const nodes = files.map((file) => ({
    id: file.path,
    kind: classifyFile(file.path),
    isNew: file.status === 'added',
    added: file.added,
    removed: file.removed,
    layer: 0,
    row: 0,
  }));
  const pick = loadTypeScript(root, options);
  const imports = safeImportEdges(pick.ts, root, files);
  const edges = [...imports, ...nameEdges(files, imports)];
  const grouped = groupFolders(nodes, edges);
  const laid = layoutGraph(grouped.nodes, grouped.edges);
  return {
    nodes: laid.nodes,
    edges: laid.edges,
    meta: {
      typescript: pick.ts !== null,
      typescriptFrom: pick.from,
      typescriptVersion: pick.version,
      repoTypescript: pick.repoVersion,
      message: pick.message,
      ms: performance.now() - started,
      version: 1,
    },
  };
};
