#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from '../src/cli/args.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { verb, flags } = parseArgs(process.argv.slice(2));

if (verb === 'version' || flags.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

process.stdout.write('usage: cr <open|wait|list|reply|refresh|close> [flags]\n');
process.exit(verb === 'help' ? 0 : 1);
