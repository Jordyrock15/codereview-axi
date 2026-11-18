import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeGraph } from '../../src/graph/build.js';
import { composeGraph } from '../../src/graph/compose.js';
import { makeTree } from './tree.js';

/** @typedef {import('../../src/graph/types.js').IChangedFile} IChangedFile */
/** @typedef {import('../../src/graph/types.js').IChangeEdge} IChangeEdge */

/**
 * @param {string} path
 * @param {IChangedFile['status']} [status]
 * @returns {IChangedFile}
 */
const changed = (path, status = 'modified') => ({ path, status, added: 1, removed: 0 });

/**
 * @param {IChangeEdge[]} edges
 * @returns {IChangeEdge[]}
 */
const sortEdges = (edges) => [...edges].sort((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`));

test('builds nodes, edges and meta', async () => {
  const tree = await makeTree({
    'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
    'src/a.test.ts': "import { a } from './a';\n",
  });
  try {
    const graph = buildChangeGraph(tree.dir, [changed('src/a.ts'), changed('src/b.ts'), changed('src/a.test.ts')]);
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(sortEdges(graph.edges), [
      { from: 'src/a.test.ts', to: 'src/a.ts', kind: 'test' },
      { from: 'src/a.ts', to: 'src/b.ts', kind: 'import' },
    ]);
    assert.equal(graph.meta.typescript, true);
    assert.equal(graph.meta.typescriptFrom, 'bundled');
    assert.equal(graph.meta.repoTypescript, null);
    assert.equal(graph.meta.version, 1);
    assert.equal(typeof graph.meta.ms, 'number');
    assert.match(graph.meta.message, /^Import links from the TypeScript \S+ in codereview-axi\. This repo has no TypeScript\.$/);
    for (const node of graph.nodes) {
      assert.equal(typeof node.layer, 'number');
      assert.equal(typeof node.row, 'number');
    }
  } finally {
    await tree.cleanup();
  }
});

test('added file is new', async () => {
  const tree = await makeTree({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
  try {
    const graph = buildChangeGraph(tree.dir, [changed('src/a.ts', 'added'), changed('src/b.ts')]);
    assert.equal(graph.nodes.find((n) => n.id === 'src/a.ts')?.isNew, true);
    assert.equal(graph.nodes.find((n) => n.id === 'src/b.ts')?.isNew, false);
  } finally {
    await tree.cleanup();
  }
});

test('no fallback', async () => {
  const tree = await makeTree({
    'src/foo.js': 'export const foo = 1;\n',
    'src/foo.test.js': "import { foo } from './foo.js';\n",
    'src/bar.js': 'export const bar = 1;\n',
  });
  try {
    const graph = composeGraph(tree.dir, [changed('src/foo.js'), changed('src/foo.test.js'), changed('src/bar.js')], {
      loadBundled: () => {
        throw new Error('gone');
      },
    });
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(graph.edges, [{ from: 'src/foo.test.js', to: 'src/foo.js', kind: 'name' }]);
    assert.equal(graph.meta.typescript, false);
    assert.equal(graph.meta.typescriptFrom, 'none');
    assert.equal(graph.meta.typescriptVersion, null);
    assert.equal(graph.meta.repoTypescript, null);
    assert.equal(graph.meta.message, 'No import links: the TypeScript in codereview-axi did not load.');
  } finally {
    await tree.cleanup();
  }
});

test('41 changed files give folder groups', async () => {
  /** @type {Record<string, string>} */
  const files = {};
  for (let i = 0; i < 21; i += 1) files[`src/a/f${i}.ts`] = i === 0 ? "import { b } from '../b/f0';\nexport const a = b;\n" : 'export const a = 1;\n';
  for (let i = 0; i < 20; i += 1) files[`src/b/f${i}.ts`] = 'export const b = 1;\n';
  const tree = await makeTree(files);
  try {
    const graph = buildChangeGraph(tree.dir, Object.keys(files).map((path) => changed(path)));
    assert.deepEqual(graph.nodes.map((n) => [n.id, n.members?.length]), [['src/a/', 21], ['src/b/', 20]]);
    assert.deepEqual(graph.edges, [{ from: 'src/a/', to: 'src/b/', kind: 'import' }]);
  } finally {
    await tree.cleanup();
  }
});

test('import edge failure keeps nodes and name edges', async () => {
  const tree = await makeTree({ 'src/foo.js': 'export const foo = 1;\n', 'src/foo.test.js': '\n' });
  try {
    const broken = { preProcessFile: () => { throw new Error('boom'); }, resolveModuleName: () => ({}), version: '5.0.0', sys: {} };
    const graph = composeGraph(tree.dir, [changed('src/foo.js'), changed('src/foo.test.js')], { loadBundled: () => broken });
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(graph.edges, [{ from: 'src/foo.test.js', to: 'src/foo.js', kind: 'name' }]);
    assert.equal(graph.meta.typescript, true);
  } finally {
    await tree.cleanup();
  }
});
