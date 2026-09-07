// The one orchestrator. bin/nonce0.js, backend/server.js and src/mcp.js all
// call this and nothing else.
//
// It RETURNS DATA AND THROWS. It never calls process.exit and never writes to
// stdout — that is bin/'s job alone. This is what makes it safe for the API to
// import in-process: a scan failure must not kill the server mid-demo.

import { stat } from 'node:fs/promises';
import { discover, discoverOne } from './repo/discover.js';
import { matchFile } from './rules/engine.js';
import { rank } from './score.js';

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);

export async function scan(target, options = {}) {
  if (isAddress(target)) {
    // Chain mode lands at build step 9. Fail loudly rather than returning an
    // empty findings array, which would read as a clean bill of health.
    const err = new Error(`chain mode is not implemented yet (build step 9): ${target}`);
    err.code = 'ENOTIMPLEMENTED';
    throw err;
  }
  return scanRepo(target, options);
}

async function scanRepo(root, options) {
  const info = await stat(root); // throws ENOENT for a bad path, which is correct
  const files = info.isDirectory() ? discover(root, options) : await discoverOne(root);

  const findings = [];
  let scanned = 0;
  for await (const file of files) {
    scanned += 1;
    findings.push(...matchFile(file));
  }

  // Returns an object, not an array with properties bolted on: JSON.stringify
  // silently drops non-index properties of an array, which would lose meta in
  // --json output and in every API response.
  return { findings: rank(findings), meta: { target: root, mode: 'repo', scanned, generatedBy: 'nonce0' } };
}
