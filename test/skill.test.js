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

test('the skill delegates the loop rather than restating it', () => {
  assert.ok(skill.includes('next_step'), 'the skill must point the agent at next_step');
  // A second copy of the loop is a second source of truth, and it is the copy
  // that goes stale: the output ships with the code, the skill file does not.
  assert.doesNotMatch(
    skill,
    /cr wait[\s\S]{0,80}cr reply[\s\S]{0,80}cr refresh/,
    'do not spell the wait/reply/refresh loop out here; next_step owns it',
  );
});

test('every cr flag the skill names is a real flag', () => {
  const flags = new Set(skill.match(/`cr [^`]*?(--[a-z-]+)[^`]*`/g) ?? []);
  const named = [...flags].flatMap((s) => s.match(/--[a-z-]+/g) ?? []);
  const usage = readFileSync('src/cli/spec.js', 'utf8');
  for (const flag of new Set(named)) {
    assert.ok(usage.includes(`'${flag.slice(2)}'`), `${flag} is not in the flag table`);
  }
});
