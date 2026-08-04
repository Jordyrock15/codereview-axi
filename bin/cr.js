#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from '../src/cli/commands.js';

const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const { code, out, after } = await run({ argv, cwd: process.cwd(), env: process.env });
process.stdout.write(`${out}\n`);

// Strictly after the write. `after` acknowledges delivery of the comments just
// printed, and doing it earlier would mean a process killed between the ack and
// the write consumed them for good, which is the failure this ordering exists to
// prevent. A failed ack is not worth an error: the comments simply stay
// deliverable and arrive again on the next poll.
try {
  await after?.();
} catch {
  // deliberately silent
}

process.exit(code);
