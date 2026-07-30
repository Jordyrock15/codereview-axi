import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { homeDir, statePath, serverPath } from '../src/paths.js';

test('defaults to ~/.codereview-axi', () => {
  delete process.env.CODEREVIEW_AXI_HOME;
  assert.equal(homeDir(), path.join(os.homedir(), '.codereview-axi'));
});

test('honours CODEREVIEW_AXI_HOME', () => {
  process.env.CODEREVIEW_AXI_HOME = '/tmp/cr-test';
  assert.equal(homeDir(), '/tmp/cr-test');
  assert.equal(statePath(), '/tmp/cr-test/state.json');
  assert.equal(serverPath(), '/tmp/cr-test/server.json');
  delete process.env.CODEREVIEW_AXI_HOME;
});
