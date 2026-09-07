#!/usr/bin/env node
// Arg parsing, output selection, exit codes. THE ONLY FILE ALLOWED TO EXIT.
//
// Exit codes are load-bearing for CI: 0 clean, 1 findings at or above --fail-on,
// 2 tool error. Distinguishing 1 from 2 is what makes the GitHub Action
// trustworthy, because a network failure must never read as a clean scan.

import { scan, isAddress } from '../src/scan.js';
import { renderText } from '../src/report.js';
import { worstAtOrAbove } from '../src/score.js';

const USAGE = `nonce0 — find out which of your keys a quantum computer would break

  npx nonce0 scan .              your source code, before you deploy
  npx nonce0 scan 0xProtocol     a live protocol, after you deployed

Options
  --json              raw findings, for tooling and the MCP server
  --fail-on <sev>     exit 1 at or above this severity (default: critical)
  --include-deps      also scan vendored dependencies
  -h, --help

Exit codes: 0 clean, 1 findings at or above --fail-on, 2 tool error.
`;

function parse(argv) {
  const opts = { json: false, failOn: 'critical', includeDeps: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--include-deps') opts.includeDeps = true;
    else if (arg === '--fail-on') opts.failOn = argv[++i];
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  return { opts, positional };
}

async function main() {
  const { opts, positional } = parse(process.argv.slice(2));
  if (opts.help || !positional.length) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, target] = positional.length === 1 ? ['scan', positional[0]] : positional;
  if (command !== 'scan') throw new Error(`unknown command: ${command}`);
  if (!target) throw new Error('scan needs a target: a path, or a 0x address');

  const { findings, meta } = await scan(target, { includeDeps: opts.includeDeps });

  if (opts.json) process.stdout.write(JSON.stringify({ findings, meta }, null, 2) + '\n');
  else process.stdout.write(renderText(findings, { target, mode: meta.mode }));

  return worstAtOrAbove(findings, opts.failOn) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Exit 2, never 1: a tool error is not a clean scan and is not a finding.
    process.stderr.write(`nonce0: ${err.message}\n`);
    if (process.env.NONCE0_DEBUG) process.stderr.write(String(err.stack) + '\n');
    process.exit(2);
  });
