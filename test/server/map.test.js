import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { neighbours, openCounts, renderMap } from '../../src/server/public/map.js';
import { commentFixture } from '../helpers/dom.js';

/**
 * @typedef {import('../../src/graph/types.js').IChangeGraph} IChangeGraph
 * @typedef {import('../../src/graph/types.js').IChangeNode} IChangeNode
 * @typedef {import('../../src/graph/types.js').IChangeEdge} IChangeEdge
 */

/**
 * @param {Partial<IChangeNode> & {id: string}} overrides
 * @returns {IChangeNode}
 */
const node = (overrides) => ({
  kind: 'source', isNew: false, added: 1, removed: 0, layer: 0, row: 0, ...overrides,
});

/**
 * @param {IChangeNode[]} nodes
 * @param {IChangeEdge[]} [edges]
 * @param {boolean} [typescript]
 * @returns {IChangeGraph}
 */
const graph = (nodes, edges = [], typescript = true) => ({
  nodes,
  edges,
  meta: {
    typescript,
    typescriptFrom: typescript ? 'bundled' : 'none',
    typescriptVersion: typescript ? '5.9.3' : null,
    repoTypescript: null,
    message: 'm',
    ms: 1,
    version: 1,
  },
});

const noop = () => {};

const dom = () => new JSDOM('<!doctype html><body></body>').window;

/**
 * @param {Element} element
 * @returns {{x: number, y: number}}
 */
const position = (element) => {
  const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(element.getAttribute('transform') ?? '');
  assert.ok(match, 'each node carries a translate');
  return { x: Number(match[1]), y: Number(match[2]) };
};

test('neighbours lists imports, importers and tests of a file, sorted', () => {
  const g = graph(['a', 'b', 'c', 't', 'n'].map((id) => node({ id })), [
    { from: 't', to: 'a', kind: 'test' },
    { from: 'a', to: 'b', kind: 'import' },
    { from: 'c', to: 'a', kind: 'import' },
    { from: 'n', to: 'a', kind: 'name' },
    { from: 'c', to: 'a', kind: 'import' },
  ]);
  assert.deepEqual(neighbours(g, 'a'), { imports: ['b'], importedBy: ['c'], testedBy: ['n', 't'] });
});

test('openCounts counts open, sent and answered comments per file', () => {
  const counts = openCounts([
    commentFixture({ id: 1, file: 'a.ts', status: 'open' }),
    commentFixture({ id: 2, file: 'a.ts', status: 'sent' }),
    commentFixture({ id: 3, file: 'a.ts', status: 'answered' }),
    commentFixture({ id: 4, file: 'a.ts', status: 'resolved' }),
    commentFixture({ id: 5, file: 'b.ts', status: 'stale' }),
    commentFixture({ id: 6, scope: 'session', file: null, status: 'open' }),
  ]);
  assert.equal(counts.get('a.ts'), 3);
  assert.equal(counts.has('b.ts'), false);
  assert.equal(counts.size, 1);
});

test('renderMap draws one node per graph node and one path per edge', () => {
  const { document } = dom();
  const g = graph([
    node({ id: 'src/a.ts', layer: 0 }),
    node({ id: 'src/b.ts', layer: 1, isNew: true }),
    node({ id: 'test/a.test.ts', kind: 'test', layer: 0, row: 1 }),
  ], [
    { from: 'src/a.ts', to: 'src/b.ts', kind: 'import' },
    { from: 'test/a.test.ts', to: 'src/a.ts', kind: 'test', cycle: true },
  ]);
  const svg = renderMap(document, g, { selected: 'src/b.ts', counts: new Map(), onSelect: noop, onOpen: noop });

  assert.equal(svg.querySelectorAll('g.node').length, 3);
  assert.equal(svg.querySelectorAll('path.edge').length, 2);
  assert.equal(svg.querySelectorAll('path.edge-import').length, 1);
  assert.equal(svg.querySelectorAll('path.edge-test.cycle').length, 1);
  assert.ok(svg.getAttribute('viewBox'));
  assert.equal(svg.querySelectorAll('[style]').length, 0);
  assert.equal(svg.hasAttribute('style'), false);

  const selected = svg.querySelectorAll('g.node.selected');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].getAttribute('data-id'), 'src/b.ts');
  assert.equal(selected[0].querySelector('text.tag')?.textContent, 'new');
  assert.equal(selected[0].querySelector('text.name')?.textContent, 'b.ts');
  assert.equal(selected[0].querySelector('text.stat')?.textContent, '+1 -0');
  assert.equal(selected[0].querySelector('title')?.textContent, 'src/b.ts');
  assert.ok(svg.querySelector('g.node.kind-test'));
  assert.ok(svg.querySelector('g.node rect.band'));

  const nodes = [...svg.childNodes].map((child) => /** @type {Element} */ (child).getAttribute?.('class') ?? '');
  assert.ok(nodes.indexOf('edges') < nodes.indexOf('nodes'), 'edges draw before nodes');
});

test('a group node shows the sum of open comments on its members, and no count when it is 0', () => {
  const { document } = dom();
  const g = graph([node({ id: 'src/lib/', members: ['src/lib/x.ts', 'src/lib/y.ts'] }), node({ id: 'src/a.ts', layer: 1 })]);

  const counted = renderMap(document, g, {
    selected: null, counts: new Map([['src/lib/x.ts', 2], ['src/lib/y.ts', 1]]), onSelect: noop, onOpen: noop,
  });
  const group = counted.querySelector('g.node[data-id="src/lib/"]');
  assert.equal(group?.querySelector('text.name')?.textContent, 'src/lib/');
  assert.equal(group?.querySelector('text.count')?.textContent, '3');
  assert.equal(counted.querySelector('g.node[data-id="src/a.ts"] text.count'), null);

  const empty = renderMap(document, g, { selected: null, counts: new Map(), onSelect: noop, onOpen: noop });
  assert.equal(empty.querySelectorAll('text.count').length, 0);
});

test('label is text', () => {
  const { document } = dom();
  const id = 'src/<a&"b>.ts';
  const svg = renderMap(document, graph([node({ id })]), { selected: null, counts: new Map(), onSelect: noop, onOpen: noop });

  assert.equal(svg.querySelector('text.name')?.textContent, '<a&"b>.ts');
  assert.equal(svg.querySelector('title')?.textContent, id);
  assert.equal(svg.querySelectorAll('a').length, 0);
  assert.equal(svg.querySelector('g.node')?.getAttribute('data-id'), id);
});

test('a long name is cut short so it clears the new tag', () => {
  const { document } = dom();
  const svg = renderMap(document, graph([
    node({ id: 'test/server/graph-routes.test.js', isNew: true }),
    node({ id: 'test/server/abcdefghijklmnopqrstuvwxyz.js' }),
  ]), { selected: null, counts: new Map(), onSelect: noop, onOpen: noop });
  const names = [...svg.querySelectorAll('text.name')].map((text) => text.textContent);

  assert.deepEqual(names, ['graph-routes.test…', 'abcdefghijklmnopqrst…']);
});

test('click, Enter and Space select, double click opens', () => {
  const window = dom();
  /** @type {string[]} */
  const selected = [];
  /** @type {string[]} */
  const opened = [];
  const svg = renderMap(window.document, graph([node({ id: 'src/a.ts' })]), {
    selected: null, counts: new Map(), onSelect: (id) => selected.push(id), onOpen: (id) => opened.push(id),
  });
  window.document.body.append(svg);
  const target = /** @type {Element} */ (svg.querySelector('g.node'));

  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  target.dispatchEvent(space);
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));

  assert.deepEqual(selected, ['src/a.ts', 'src/a.ts', 'src/a.ts']);
  assert.deepEqual(opened, ['src/a.ts']);
  assert.equal(space.defaultPrevented, true);
});

test('no typescript gives a grid', () => {
  const { document } = dom();
  const g = graph(['a', 'b', 'c', 'd', 'e'].map((id) => node({ id, layer: 0, row: 0 })), [], false);
  const svg = renderMap(document, g, { selected: null, counts: new Map(), onSelect: noop, onOpen: noop });
  const nodes = [...svg.querySelectorAll('g.node')];

  const first = position(nodes[0]);
  const fourth = position(nodes[3]);
  const fifth = position(nodes[4]);
  assert.equal(fourth.y, first.y);
  assert.ok(fourth.x > first.x);
  assert.equal(fifth.x, first.x);
  assert.equal(fifth.y, first.y + 52 + 16);
});
