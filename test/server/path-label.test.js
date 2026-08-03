import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPathLabel } from '../../src/server/public/path-label.js';

test('a deep path splits into a trailing-slash dir and the bare filename', () => {
  assert.deepEqual(
    splitPathLabel('lib/modules/charts/components/GridChart.tsx'),
    { dir: 'lib/modules/charts/components/', base: 'GridChart.tsx' },
  );
});

test('a root-level file has no dir and no stray separator', () => {
  assert.deepEqual(splitPathLabel('package.json'), { dir: '', base: 'package.json' });
});

test('a single directory level still splits correctly', () => {
  assert.deepEqual(splitPathLabel('src/index.js'), { dir: 'src/', base: 'index.js' });
});
