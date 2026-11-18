import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountApp, sessionFixture, fileFixture, graphFixture, commentFixture, settle,
} from '../helpers/dom.js';

/**
 * @typedef {import('../../src/graph/types.js').IChangeNode} IChangeNode
 * @typedef {import('../helpers/dom.js').Mounted} Mounted
 */

/**
 * @param {string} id
 * @param {Partial<IChangeNode>} [overrides]
 * @returns {IChangeNode}
 */
const node = (id, overrides = {}) => ({
  id, kind: 'source', isNew: false, added: 1, removed: 1, layer: 0, row: 0, ...overrides,
});

/**
 * @param {string[]} paths
 * @returns {import('../../src/types.js').Snapshot}
 */
const snapshot = (paths) => ({
  files: paths.map((path) => fileFixture({ path })),
  totals: { files: paths.length, added: paths.length, removed: paths.length },
});

/**
 * @param {Mounted} app
 * @param {Element|null|undefined} target
 * @param {string} [type]
 * @returns {Promise<void>}
 */
const fire = async (app, target, type = 'click') => {
  assert.ok(target, `no target for ${type}`);
  target.dispatchEvent(new app.window.MouseEvent(type, { bubbles: true }));
  await settle();
};

/**
 * @param {Mounted} app
 * @param {string} id
 * @returns {Element|undefined}
 */
const mapNode = (app, id) => [...app.document.querySelectorAll('#map-canvas g.node')]
  .find((element) => element.getAttribute('data-id') === id);

/**
 * @param {Element} root
 * @param {string} text
 * @returns {HTMLButtonElement|undefined}
 */
const buttonByText = (root, text) => /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('button')])
  .find((button) => button.textContent === text);

/**
 * @param {Mounted} app
 * @param {string} id
 * @returns {HTMLElement}
 */
const byId = (app, id) => /** @type {HTMLElement} */ (app.document.getElementById(id));

test('the Map button opens the map, a node shows its neighbours, and Open diff renders that file', async () => {
  const app = await mountApp({
    session: sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() }),
  });
  try {
    const toggle = byId(app, 'map-toggle');
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.textContent, 'Map');
    assert.equal(byId(app, 'map').hidden, true);

    await fire(app, toggle);
    assert.equal(byId(app, 'map').hidden, false);
    assert.equal(byId(app, 'diff').hidden, true);
    assert.equal(toggle.textContent, 'Diff');
    assert.equal(byId(app, 'map-note').textContent, '');

    await fire(app, mapNode(app, 'src/b.ts'));
    assert.ok(mapNode(app, 'src/b.ts')?.classList.contains('selected'));
    const panel = byId(app, 'map-panel');
    assert.equal(panel.querySelector('h3')?.textContent, 'src/b.ts');
    assert.match(panel.textContent ?? '', /Imported by/);
    assert.doesNotMatch(panel.textContent ?? '', /Tested by/);
    assert.ok(buttonByText(panel, 'src/a.ts'));

    await fire(app, buttonByText(panel, 'Open diff'));
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(byId(app, 'diff').hidden, false);
    assert.equal(toggle.textContent, 'Map');
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/b.ts');
    const current = app.document.querySelector('#files button[aria-current="true"]');
    assert.equal(current?.getAttribute('title'), 'src/b.ts');
  } finally {
    app.teardown();
  }
});

test('a double click on a node opens its diff', async () => {
  const app = await mountApp({
    session: sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    await fire(app, mapNode(app, 'src/b.ts'), 'dblclick');
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/b.ts');
  } finally {
    app.teardown();
  }
});

test('one file, a null graph, or no graph key at all: no Map button and no strip', async () => {
  const { graph: _drop, ...older } = sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']) });
  const sessions = [
    sessionFixture({ snapshot: snapshot(['src/a.ts']), graph: graphFixture({ nodes: [node('src/a.ts')], edges: [] }) }),
    sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: null }),
    /** @type {import('../../src/types.js').Session} */ (/** @type {unknown} */ (older)),
  ];
  for (const session of sessions) {
    const app = await mountApp({ session });
    try {
      assert.equal(byId(app, 'map-toggle').hidden, true);
      assert.equal(byId(app, 'map').hidden, true);
      assert.equal(app.document.querySelector('.strip'), null);
      assert.ok(app.document.querySelector('.filehead'));
    } finally {
      app.teardown();
    }
  }
});

test('the neighbour strip lists imports and importers, and a click opens that diff', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      graph: graphFixture({
        nodes: [node('src/a.ts', { layer: 1 }), node('src/b.ts', { layer: 2 }), node('src/c.ts')],
        edges: [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }, { from: 'src/c.ts', to: 'src/a.ts', kind: 'import' }],
      }),
    }),
  });
  try {
    const strip = /** @type {HTMLElement} */ (app.document.querySelector('#diff .strip'));
    assert.ok(strip);
    assert.equal(strip.nextElementSibling?.className, 'filehead');
    assert.match(strip.textContent ?? '', /b\.ts/);
    assert.match(strip.textContent ?? '', /c\.ts/);
    assert.match(strip.textContent ?? '', /Imports/);
    assert.match(strip.textContent ?? '', /Imported by/);

    await fire(app, buttonByText(strip, 'src/b.ts'));
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/b.ts');
  } finally {
    app.teardown();
  }
});

test('a refresh keeps the selection while the file is in the graph and clears it once it leaves', async () => {
  const session = sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() });
  const app = await mountApp({ session });
  try {
    await fire(app, byId(app, 'map-toggle'));
    await fire(app, mapNode(app, 'src/b.ts'));

    await app.emit('refreshed');
    assert.equal(byId(app, 'map').hidden, false);
    assert.ok(mapNode(app, 'src/b.ts')?.classList.contains('selected'));

    app.setSession({
      ...session,
      snapshot: snapshot(['src/a.ts', 'src/c.ts']),
      graph: graphFixture({ nodes: [node('src/a.ts'), node('src/c.ts', { layer: 1 })], edges: [] }),
    });
    await app.emit('refreshed');
    assert.equal(byId(app, 'map').hidden, false);
    assert.equal(app.document.querySelectorAll('#map-canvas g.node').length, 2);
    assert.equal(app.document.querySelectorAll('#map-canvas g.node.selected').length, 0);
    assert.equal(byId(app, 'map-panel').querySelector('h3'), null);
  } finally {
    app.teardown();
  }
});

test('a refresh that leaves one file closes the map and hides the button', async () => {
  const session = sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() });
  const app = await mountApp({ session });
  try {
    await fire(app, byId(app, 'map-toggle'));
    app.setSession({ ...session, snapshot: snapshot(['src/a.ts']), graph: graphFixture({ nodes: [node('src/a.ts')], edges: [] }) });
    await app.emit('refreshed');
    assert.equal(byId(app, 'map-toggle').hidden, true);
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(byId(app, 'diff').hidden, false);
  } finally {
    app.teardown();
  }
});

test('a group node lists its files in the panel, and a member click opens its diff', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/a.ts', 'src/lib/x.ts', 'src/lib/y.ts']),
      graph: graphFixture({
        nodes: [node('src/a.ts'), node('src/lib/', { layer: 1, members: ['src/lib/x.ts', 'src/lib/y.ts'] })],
        edges: [{ from: 'src/a.ts', to: 'src/lib/', kind: 'import' }],
      }),
    }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    await fire(app, mapNode(app, 'src/lib/'));
    const panel = byId(app, 'map-panel');
    assert.equal(panel.querySelector('h3')?.textContent, 'src/lib/ (2 files)');
    assert.ok(buttonByText(panel, 'src/lib/x.ts'));

    await fire(app, buttonByText(panel, 'src/lib/y.ts'));
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/lib/y.ts');
  } finally {
    app.teardown();
  }
});

test('a nav click while the map is open closes the map and shows that diff', async () => {
  const app = await mountApp({
    session: sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    const navB = [...app.document.querySelectorAll('#files button')].find((button) => button.getAttribute('title') === 'src/b.ts');
    await fire(app, navB);
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(byId(app, 'diff').hidden, false);
    assert.equal(byId(app, 'map-toggle').textContent, 'Map');
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/b.ts');
  } finally {
    app.teardown();
  }
});

test('a comment jump while the map is open closes the map and shows the comment file', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/a.ts', 'src/b.ts']),
      graph: graphFixture(),
      comments: [commentFixture({ id: 1, file: 'src/b.ts', status: 'open' })],
    }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    await fire(app, byId(app, 'queue-open'));
    await fire(app, app.document.querySelector('#queue-list .queue-entry-open'));
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(byId(app, 'diff').hidden, false);
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/b.ts');
  } finally {
    app.teardown();
  }
});

test('a jump to a session comment while the map is open closes the map', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/a.ts', 'src/b.ts']),
      graph: graphFixture(),
      comments: [commentFixture({
        id: 1, scope: 'session', file: null, side: null, startLine: null, endLine: null, status: 'open',
      })],
    }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    await fire(app, byId(app, 'queue-open'));
    await fire(app, app.document.querySelector('#queue-list .queue-entry-open'));
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(byId(app, 'diff').hidden, false);
  } finally {
    app.teardown();
  }
});

test('Enter on a focused node selects it, and the panel button opens its diff', async () => {
  const app = await mountApp({
    session: sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    const target = /** @type {Element} */ (mapNode(app, 'src/b.ts'));
    target.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert.equal(byId(app, 'map').hidden, false);
    assert.ok(mapNode(app, 'src/b.ts')?.classList.contains('selected'));
    const panel = byId(app, 'map-panel');
    assert.equal(panel.querySelector('h3')?.textContent, 'src/b.ts');

    await fire(app, buttonByText(panel, 'Open diff'));
    assert.equal(byId(app, 'map').hidden, true);
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/b.ts');
  } finally {
    app.teardown();
  }
});

test('the strip of a file inside a folder group shows the neighbours of its group', async () => {
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/lib/x.ts', 'src/lib/y.ts', 'src/a.ts']),
      graph: graphFixture({
        nodes: [node('src/a.ts'), node('src/lib/', { layer: 1, members: ['src/lib/x.ts', 'src/lib/y.ts'] })],
        edges: [{ from: 'src/a.ts', to: 'src/lib/', kind: 'import' }],
      }),
    }),
  });
  try {
    const strip = /** @type {HTMLElement} */ (app.document.querySelector('#diff .strip'));
    assert.ok(strip);
    assert.match(strip.textContent ?? '', /Imported by/);
    await fire(app, buttonByText(strip, 'src/a.ts'));
    assert.equal(app.document.querySelector('.filehead span')?.textContent, 'src/a.ts');
  } finally {
    app.teardown();
  }
});

test('the diff keeps its scroll position across Map and Diff', async () => {
  const app = await mountApp({
    session: sessionFixture({ snapshot: snapshot(['src/a.ts', 'src/b.ts']), graph: graphFixture() }),
  });
  try {
    const diff = byId(app, 'diff');
    let top = 0;
    Object.defineProperty(diff, 'scrollTop', {
      configurable: true,
      get: () => (diff.hidden ? 0 : top),
      set: (value) => { top = diff.hidden ? 0 : value; },
    });
    diff.scrollTop = 240;

    await fire(app, byId(app, 'map-toggle'));
    top = 0;
    await fire(app, byId(app, 'map-toggle'));
    assert.equal(diff.scrollTop, 240);
  } finally {
    app.teardown();
  }
});

test('a path with <, &, " and spaces shows as text in the panel and the strip', async () => {
  const odd = 'src/<a&"b> c.ts';
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/a.ts', odd]),
      graph: graphFixture({
        nodes: [node('src/a.ts'), node(odd, { layer: 1 })],
        edges: [{ from: 'src/a.ts', to: odd, kind: 'import' }],
      }),
    }),
  });
  try {
    const strip = /** @type {HTMLElement} */ (app.document.querySelector('#diff .strip'));
    assert.ok(buttonByText(strip, odd));
    assert.equal(strip.querySelectorAll('a').length, 0);

    await fire(app, byId(app, 'map-toggle'));
    await fire(app, mapNode(app, odd));
    const panel = byId(app, 'map-panel');
    assert.equal(panel.querySelector('h3')?.textContent, odd);
    assert.equal(panel.querySelectorAll('a').length, 0);

    await fire(app, buttonByText(panel, 'Open diff'));
    assert.equal(app.document.querySelector('.filehead span')?.textContent, odd);
  } finally {
    app.teardown();
  }
});

test('without TypeScript the map shows the meta message over the grid', async () => {
  const graph = graphFixture();
  const message = 'No import links: the TypeScript in codereview-axi did not load.';
  const app = await mountApp({
    session: sessionFixture({
      snapshot: snapshot(['src/a.ts', 'src/b.ts']),
      graph: { ...graph, edges: [], meta: { ...graph.meta, typescript: false, typescriptFrom: 'none', message } },
    }),
  });
  try {
    await fire(app, byId(app, 'map-toggle'));
    assert.equal(byId(app, 'map-note').textContent, message);
    assert.equal(app.document.querySelectorAll('#map-canvas g.node').length, 2);
  } finally {
    app.teardown();
  }
});
