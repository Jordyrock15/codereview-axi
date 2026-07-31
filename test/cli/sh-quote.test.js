import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shQuote } from '../../src/cli/commands.js';

const exec = promisify(execFile);

// git check-ref-format --branch accepts every one of these in a branch name;
// only a space is rejected. A PR head branch comes from whoever opened the
// PR, so any of these can arrive in the CLI's copy-pasteable suggestion.
const DANGEROUS = [
  'feat;echo INJECTED',
  'feat|echo INJECTED',
  'feat&echo INJECTED',
  'feat`echo INJECTED`',
  'feat$(echo INJECTED)',
  "feat'echo INJECTED",
  "it's-a-branch",
  "''",
  "'",
];

for (const name of DANGEROUS) {
  test(`shQuote round-trips ${JSON.stringify(name)} through a real shell without executing any of it`, async () => {
    // If quoting were wrong, a shell metacharacter here would end the quoted
    // string early and let the rest run as a separate command; printf would
    // then either see extra output (from the injected command) or a mangled
    // argument, not the original string back.
    const { stdout } = await exec('sh', ['-c', `printf '%s' ${shQuote(name)}`]);
    assert.equal(stdout, name, 'the shell must see exactly the original string, nothing executed and nothing lost');
  });
}
