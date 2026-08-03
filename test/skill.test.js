import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SKILL_PATH = 'skills/code-review/SKILL.md';
const skill = readFileSync(SKILL_PATH, 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const frontmatter = () => {
  const m = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md must open with a YAML frontmatter block');
  return m[1];
};

test('the skill ships in the npm tarball', () => {
  assert.ok(
    pkg.files.includes('skills/code-review'),
    'package.json files must include skills/code-review, or installers get no skill',
  );
});

test('frontmatter carries the keys skill installers read', () => {
  const fm = frontmatter();
  for (const key of ['name', 'description', 'argument-hint', 'author']) {
    assert.match(fm, new RegExp(`^${key}: \\S`, 'm'), `frontmatter needs ${key}`);
  }
  assert.match(fm, /^name: code-review$/m);
});

test('the skill takes an explicit request', () => {
  assert.ok(skill.includes('$ARGUMENTS'), 'slash-command invocations pass the request as $ARGUMENTS');
});

test('the skill spells the loop out as well as pointing at next_step', () => {
  assert.ok(skill.includes('next_step'), 'the skill must point the agent at next_step');
  // Delegating the loop entirely to next_step was tried and did not hold: an
  // agent treats payload text as data and drops the poll. State it in both
  // places, as lavish-axi does.
  for (const verb of ['cr open', 'cr wait', 'cr reply', 'cr refresh']) {
    assert.ok(skill.includes(verb), `the workflow must name ${verb}`);
  }
});

test('the skill forbids backgrounding the poll', () => {
  // A wait behind `&` returns comments to a process nobody is listening to,
  // which reads to the human as an agent that silently stopped caring.
  for (const trap of ['nohup', 'disown', 'foreground']) {
    assert.ok(skill.includes(trap), `the poll rules must address ${trap}`);
  }
  assert.match(skill, /never kill it/i, 'the skill must say not to kill the wait');
});

test('every cr flag the skill names is a real flag', () => {
  const flags = new Set(skill.match(/`cr [^`]*?(--[a-z-]+)[^`]*`/g) ?? []);
  const named = [...flags].flatMap((s) => s.match(/--[a-z-]+/g) ?? []);
  const usage = readFileSync('src/cli/spec.js', 'utf8');
  for (const flag of new Set(named)) {
    assert.ok(usage.includes(`'${flag.slice(2)}'`), `${flag} is not in the flag table`);
  }
});
