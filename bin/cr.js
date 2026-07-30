#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from '../src/cli/commands.js';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const { code, out } = await run({ argv, cwd: process.cwd(), env: process.env });
process.stdout.write(`${out}\n`);
process.exit(code);
