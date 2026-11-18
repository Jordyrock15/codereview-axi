import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { importEdges, nameEdges } from '../../src/graph/resolve.js';
import { makeTree } from './tree.js';

const ts = createRequire(import.meta.url)('typescript');

/**
 * @param {string} path
 * @param {'modified'|'added'|'deleted'|'renamed'} [status]
 * @returns {import('../../src/graph/types.js').IChangedFile}
 */
const changed = (path, status = 'modified') => ({ path, status, added: 1, removed: 0 });

/**
 * @param {Record<string, string>} tree
 * @param {import('../../src/graph/types.js').IChangedFile[]} files
 * @returns {Promise<import('../../src/graph/types.js').IChangeEdge[]>}
 */
const edgesFor = async (tree, files) => {
  const made = await makeTree(tree);
  try {
    return importEdges(ts, made.dir, files);
  } finally {
    await made.cleanup();
  }
};

const jsFixture = {
  'src/x.js': "import { y } from './y.js';\nexport const x = y;\n",
  'src/y.js': 'export const y = 1;\n',
};
const jsFiles = [changed('src/x.js'), changed('src/y.js')];

test('alias through project references', async () => {
  const edges = await edgesFor({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }),
    'src/a.ts': "import { b } from '@/b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  }, [changed('src/a.ts'), changed('src/b.ts')]);
  assert.deepEqual(edges, [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }]);
});

test('test imports its source', async () => {
  const edges = await edgesFor({
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': "import { a } from './a';\n",
  }, [changed('src/a.ts'), changed('src/a.test.ts')]);
  assert.deepEqual(edges, [{ from: 'src/a.test.ts', to: 'src/a.ts', kind: 'test' }]);
});

test('duplicate import gives one edge', async () => {
  const edges = await edgesFor({
    'src/a.ts': "import { b } from './b';\nimport type { B } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\nexport type B = number;\n',
  }, [changed('src/a.ts'), changed('src/b.ts')]);
  assert.deepEqual(edges, [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }]);
});

test('unchanged target gives no edge', async () => {
  const edges = await edgesFor({
    'src/a.ts': "import { c } from './c';\n",
    'src/c.ts': 'export const c = 1;\n',
  }, [changed('src/a.ts')]);
  assert.deepEqual(edges, []);
});

test('deleted file has no edges', async () => {
  const edges = await edgesFor({
    'src/a.ts': "import { g } from './gone';\n",
  }, [changed('src/a.ts'), changed('src/gone.ts', 'deleted')]);
  assert.deepEqual(edges, []);
});

test('javascript repo with no tsconfig', async () => {
  const edges = await edgesFor(jsFixture, jsFiles);
  assert.deepEqual(edges, [{ from: 'src/x.js', to: 'src/y.js', kind: 'import' }]);
});

test('broken tsconfig falls back to defaults', async () => {
  const edges = await edgesFor({ ...jsFixture, 'tsconfig.json': '{ "compilerOptions": { , }' }, jsFiles);
  assert.deepEqual(edges, [{ from: 'src/x.js', to: 'src/y.js', kind: 'import' }]);
});

test('tsconfig with a missing extends falls back to defaults', async () => {
  const edges = await edgesFor({ ...jsFixture, 'tsconfig.json': '{ "extends": "./missing.json" }' }, jsFiles);
  assert.deepEqual(edges, [{ from: 'src/x.js', to: 'src/y.js', kind: 'import' }]);
});

test('tsconfig with comments and a trailing comma still resolves', async () => {
  const edges = await edgesFor({
    ...jsFixture,
    'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "allowJs": true, "module": "nodenext", },\n}\n',
  }, jsFiles);
  assert.deepEqual(edges, [{ from: 'src/x.js', to: 'src/y.js', kind: 'import' }]);
});

test('missing and binary files are skipped', async () => {
  const edges = await edgesFor({ 'img.png': '\u0000\u0001PNG' }, [changed('src/ghost.ts'), changed('img.png')]);
  assert.deepEqual(edges, []);
});

test('name edge', () => {
  const files = [changed('src/foo.js'), changed('src/foo.test.js')];
  assert.deepEqual(nameEdges(files, []), [{ from: 'src/foo.test.js', to: 'src/foo.js', kind: 'name' }]);
  assert.deepEqual(nameEdges(files, [{ from: 'src/foo.test.js', to: 'src/foo.js', kind: 'test' }]), []);
});

test('name edge prefers the source in the same folder', () => {
  const files = [changed('lib/foo.ts'), changed('src/foo.ts'), changed('src/foo.stories.tsx')];
  assert.deepEqual(nameEdges(files, []), [{ from: 'src/foo.stories.tsx', to: 'src/foo.ts', kind: 'name' }]);
});

test('name edge takes the first source by path order', () => {
  const files = [changed('test/foo.spec.ts'), changed('src/b/foo.ts'), changed('src/a/foo.ts')];
  assert.deepEqual(nameEdges(files, []), [{ from: 'test/foo.spec.ts', to: 'src/a/foo.ts', kind: 'name' }]);
});

test('name edge skips deleted files', () => {
  assert.deepEqual(nameEdges([changed('src/foo.js', 'deleted'), changed('src/foo.test.js')], []), []);
  assert.deepEqual(nameEdges([changed('src/foo.js'), changed('src/foo.test.js', 'deleted')], []), []);
});

test('projects resolve without a walk of unrelated folders', async () => {
  const made = await makeTree({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src', 'unrelated'] }),
    'src/a.ts': "import { b } from '@/b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
    'unrelated/deep/z.ts': 'export const z = 1;\n',
    'src/unrelated/y.ts': 'export const y = 1;\n',
  });
  /** @type {string[]} */
  const touched = [];
  const sys = new Proxy(ts.sys, {
    get: (target, name) => {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (/** @type {any[]} */ ...args) => {
        touched.push(`${String(name)} ${args.filter((arg) => typeof arg === 'string').join(' ')}`);
        return value.apply(target, args);
      };
    },
  });
  try {
    const edges = importEdges({ ...ts, sys }, made.dir, [changed('src/a.ts'), changed('src/b.ts')]);
    assert.deepEqual(edges, [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }]);
    assert.deepEqual(touched.filter((call) => /^(readDirectory|getDirectories) /.test(call)), []);
    assert.deepEqual(touched.filter((call) => call.includes('unrelated')), []);
  } finally {
    await made.cleanup();
  }
});

test('each file takes the options of the project that includes it', async () => {
  const edges = await edgesFor({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.lib.json' }, { path: './tsconfig.app.json' }] }),
    'tsconfig.lib.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['lib/*'] } }, include: ['lib'] }),
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }),
    'src/a.ts': "import { b } from '@/b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
    'lib/b.ts': 'export const b = 2;\n',
  }, [changed('src/a.ts'), changed('src/b.ts'), changed('lib/b.ts')]);
  assert.deepEqual(edges, [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }]);
});

test('a test that imports a non-source file gives an import edge', async () => {
  const edges = await edgesFor({
    'src/a.test.ts': "import { a } from './a';\nimport type { T } from './types/t';\n",
    'src/a.ts': 'export const a = 1;\n',
    'src/types/t.ts': 'export type T = number;\n',
  }, [changed('src/a.test.ts'), changed('src/a.ts'), changed('src/types/t.ts')]);
  assert.deepEqual(edges, [
    { from: 'src/a.test.ts', to: 'src/a.ts', kind: 'test' },
    { from: 'src/a.test.ts', to: 'src/types/t.ts', kind: 'import' },
  ]);
});

test('name edge ignores an edge to a non-source file', () => {
  const files = [changed('src/foo.js'), changed('src/foo.test.js'), changed('src/types/t.js')];
  assert.deepEqual(
    nameEdges(files, [{ from: 'src/foo.test.js', to: 'src/types/t.js', kind: 'import' }]),
    [{ from: 'src/foo.test.js', to: 'src/foo.js', kind: 'name' }],
  );
});

test('a folder whose name starts with two dots maps', async () => {
  const edges = await edgesFor({
    '..hidden/a.ts': "import { b } from './b';\n",
    '..hidden/b.ts': 'export const b = 1;\n',
  }, [changed('..hidden/a.ts'), changed('..hidden/b.ts')]);
  assert.deepEqual(edges, [{ from: '..hidden/a.ts', to: '..hidden/b.ts', kind: 'import' }]);
});
