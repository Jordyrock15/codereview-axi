import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identLabel, viewToggleLabel, noteTitle } from '../../src/server/public/labels.js';

test('a PR session names the PR and its base', () => {
  assert.equal(identLabel({ pr: 41, base: 'main', branch: 'feat/x' }), 'PR #41 → main');
});

test('a branch session names the branch and its base', () => {
  assert.equal(identLabel({ pr: null, base: 'main', branch: 'feat/x' }), 'feat/x → main');
});

test('a branch with no base names the branch alone', () => {
  assert.equal(identLabel({ pr: null, base: null, branch: 'feat/x' }), 'feat/x');
});

test('a base with no branch names the base alone', () => {
  assert.equal(identLabel({ pr: null, base: 'main', branch: null }), '→ main');
});

test('no PR, branch or base is the working tree', () => {
  assert.equal(identLabel({ pr: null, base: null, branch: null }), 'working tree');
});

test('an undefined branch, written by an older version, still reads', () => {
  assert.equal(identLabel({ pr: null, base: 'main', branch: undefined }), '→ main');
});

test('the view toggle names the view a click switches to', () => {
  assert.equal(viewToggleLabel({ view: 'split' }), 'unified');
  assert.equal(viewToggleLabel({ view: 'unified' }), 'split');
});

test('a note goes in the tooltip after the ident', () => {
  assert.equal(noteTitle('feat/x → main', 'fixed the ack'), 'feat/x → main: fixed the ack');
});

test('no note leaves the tooltip as the ident alone', () => {
  assert.equal(noteTitle('feat/x → main', ''), 'feat/x → main');
});
