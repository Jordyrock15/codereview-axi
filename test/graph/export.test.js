import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeGraph } from 'codereview-axi/graph';
import { makeTree } from './tree.js';

test('package export builds a graph', async () => {
  const tree = await makeTree({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const graph = buildChangeGraph(tree.dir, [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 0 }]);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, 'src/a.ts');
  } finally {
    await tree.cleanup();
  }
});
