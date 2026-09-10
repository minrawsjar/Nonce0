import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('ring_client_has_no_pq_wallet_internal_imports', () => {
  const root = fileURLToPath(new URL('../../ring-client/src/', import.meta.url));
  const wallet = fileURLToPath(new URL('../src/', import.meta.url));
  const allowed = new Set(['keyGen', 'sign', 'verify', 'pkCommitment', 'pqDigest', 'PQ_DOMAIN', 'DigestInput']);
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
    const file = resolve(root, name); const source = readFileSync(file, 'utf8');
    const imports = source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const target = match[1]!;
      assert.equal(target.startsWith('@opaque/pq-wallet/'), false, `${name} imports wallet internals`);
      if (target.startsWith('.')) assert.equal(resolve(dirname(file), target).startsWith(wallet), false, `${name} reaches into wallet source`);
    }
    for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s*['"]@opaque\/pq-wallet['"]/g)) {
      const clause = match[1]!.trim().replace(/^type\s+/, '');
      assert.ok(clause.startsWith('{') && clause.endsWith('}'), 'Use explicit scheme imports, not a namespace/default import');
      for (const item of clause.slice(1, -1).split(',').filter(s => s.trim())) {
        const symbol = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!;
        assert.ok(allowed.has(symbol), `${name} imports ${symbol} outside the signature-scheme boundary`);
      }
    }
  }
});
