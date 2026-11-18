import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile } from '../../src/graph/classify.js';
import { groupFolders, layoutGraph } from '../../src/graph/layout.js';

/** @typedef {import('../../src/graph/types.js').IChangeNode} IChangeNode */
/** @typedef {import('../../src/graph/types.js').IChangeEdge} IChangeEdge */

/**
 * @param {string} id
 * @returns {IChangeNode}
 */
const node = (id) => ({ id, kind: classifyFile(id), isNew: false, added: 1, removed: 0, layer: 0, row: 0 });

/**
 * @param {string} from
 * @param {string} to
 * @param {IChangeEdge['kind']} [kind]
 * @returns {IChangeEdge}
 */
const edge = (from, to, kind = 'import') => ({ from, to, kind });

/**
 * @param {IChangeNode[]} nodes
 * @param {string} id
 * @returns {IChangeNode}
 */
const find = (nodes, id) => {
  const found = nodes.find((n) => n.id === id);
  assert.ok(found, `no node ${id}`);
  return found;
};

test('cycle ends and one edge is marked', () => {
  const nodes = ['a.ts', 'b.ts', 'c.ts'].map(node);
  const edges = [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('c.ts', 'a.ts')];
  const out = layoutGraph(nodes, edges);
  assert.equal(out.edges.filter((e) => e.cycle === true).length, 1);
  for (const n of out.nodes) assert.ok(n.layer >= 1, `${n.id} layer ${n.layer}`);
  assert.equal(edges.some((e) => 'cycle' in e), false);
  assert.ok(nodes.every((n) => n.layer === 0 && n.row === 0));
});

test('columns', () => {
  const nodes = ['t.test.ts', 'a.ts', 'b.ts', 'types/x.ts', 'vite.config.ts'].map(node);
  const edges = [edge('t.test.ts', 'a.ts', 'test'), edge('a.ts', 'b.ts')];
  const out = layoutGraph(nodes, edges);
  assert.equal(find(out.nodes, 't.test.ts').layer, 0);
  assert.equal(find(out.nodes, 'a.ts').layer, 1);
  assert.equal(find(out.nodes, 'b.ts').layer, 2);
  assert.equal(find(out.nodes, 'types/x.ts').layer, 3);
  const config = find(out.nodes, 'vite.config.ts');
  for (const n of out.nodes) {
    if (n !== config) assert.ok(config.row > n.row, `${n.id} row ${n.row}`);
  }
});

test('barycentre', () => {
  const nodes = ['a.test.ts', 'b.test.ts', 'y.ts', 'z.ts'].map(node);
  const edges = [edge('a.test.ts', 'z.ts', 'test'), edge('b.test.ts', 'y.ts', 'test')];
  const out = layoutGraph(nodes, edges);
  assert.deepEqual([find(out.nodes, 'a.test.ts').row, find(out.nodes, 'b.test.ts').row], [0, 1]);
  assert.deepEqual([find(out.nodes, 'z.ts').layer, find(out.nodes, 'z.ts').row], [1, 0]);
  assert.deepEqual([find(out.nodes, 'y.ts').layer, find(out.nodes, 'y.ts').row], [1, 1]);
});

test('same input gives the same layout', () => {
  const ids = ['src/c.ts', 'src/a.test.ts', 'src/b.ts', 'src/a.ts'];
  const edges = [edge('src/a.test.ts', 'src/a.ts', 'test'), edge('src/a.ts', 'src/b.ts'), edge('src/c.ts', 'src/b.ts')];
  const first = layoutGraph(ids.map(node), edges);
  const second = layoutGraph([...ids].reverse().map(node), [...edges].reverse());
  /**
   * @param {{ nodes: IChangeNode[] }} graph
   * @returns {string[]}
   */
  const places = (graph) => graph.nodes.map((n) => `${n.id}:${n.layer}:${n.row}`).sort();
  assert.deepEqual(places(first), places(second));
});

test('41 nodes make folder groups', () => {
  const nodes = [
    ...Array.from({ length: 21 }, (_, i) => node(`src/a/f${i}.ts`)),
    ...Array.from({ length: 20 }, (_, i) => node(`src/b/f${i}.ts`)),
  ];
  const edges = [edge('src/a/f0.ts', 'src/b/f0.ts')];
  const out = groupFolders(nodes, edges);
  assert.deepEqual(out.nodes.map((n) => n.id), ['src/a/', 'src/b/']);
  assert.deepEqual(out.nodes.map((n) => n.members?.length), [21, 20]);
  assert.deepEqual(out.edges, [{ from: 'src/a/', to: 'src/b/', kind: 'import' }]);
  const a = find(out.nodes, 'src/a/');
  assert.equal(a.kind, 'source');
  assert.equal(a.added, 21);
  assert.equal(a.isNew, false);
  assert.equal(nodes.length, 41);
});

test('40 nodes stay files', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => node(`src/a/f${i}.ts`));
  const out = groupFolders(nodes, [edge('src/a/f0.ts', 'src/a/f1.ts')]);
  assert.equal(out.nodes.length, 40);
  assert.ok(out.nodes.every((n) => n.members === undefined));
  assert.equal(out.edges.length, 1);
});

test('regroup one level up', () => {
  const nodes = Array.from({ length: 45 }, (_, i) => [node(`src/f${i}/a.ts`), node(`src/f${i}/b.ts`)]).flat();
  const out = groupFolders(nodes, []);
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].id, 'src/');
  assert.equal(out.nodes[0].members?.length, 90);
});

test('group kind ties go to source and edges drop self links', () => {
  const nodes = [
    node('src/x/a.ts'), node('src/x/a.test.ts'),
    ...Array.from({ length: 40 }, (_, i) => node(`src/y/f${i}.test.ts`)),
  ];
  const edges = [edge('src/x/a.test.ts', 'src/x/a.ts', 'test'), edge('src/y/f0.test.ts', 'src/x/a.ts', 'test'), edge('src/y/f1.test.ts', 'src/x/a.ts', 'test')];
  const out = groupFolders(nodes, edges);
  assert.equal(find(out.nodes, 'src/x/').kind, 'source');
  assert.equal(find(out.nodes, 'src/y/').kind, 'test');
  assert.deepEqual(out.edges, [{ from: 'src/y/', to: 'src/x/', kind: 'test' }]);
});
