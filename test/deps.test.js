// The zero-runtime-dependency claim is load-bearing product copy, not a preference.
// It is also the easiest claim in the repo to break by accident, because
// `import kleur from 'kleur'` resolves fine on the machine that wrote it and
// explodes on a stranger's `npx nonce0`.
//
// Two checks. The manifest assertion alone is provably insufficient: it stays
// green while src/report.js imports a package that happens to be installed
// somewhere up the tree. The static import scan is what catches that, on the day
// the file is written, including code paths no smoke test ever executes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_DIRS = ['bin', 'src']; // must match package.json "files"

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return []; // dir not built yet
    throw err;
  }
  const out = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Matches `from '<spec>'` and bare `import '<spec>'`, static and dynamic.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

test('package.json declares no dependencies of any kind', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'dependencies must stay empty');
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), [], 'devDependencies must stay empty');
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), [], 'peerDependencies must stay empty');
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), [], 'optionalDependencies must stay empty');
});

test('every import in shipped code is relative or a node: builtin', async () => {
  const files = (await Promise.all(SHIPPED_DIRS.map((d) => walk(join(ROOT, d))))).flat();
  const offences = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, spec] of source.matchAll(SPECIFIER)) {
      const ok =
        spec.startsWith('.') ||
        spec.startsWith('/') ||
        spec.startsWith('node:') ||
        builtinModules.includes(spec);
      // A bare builtin without the node: prefix is legal but banned here: the
      // prefix is what makes an undeclared dependency obvious on sight.
      if (ok && !spec.startsWith('node:') && builtinModules.includes(spec)) {
        offences.push(`${file.slice(ROOT.length + 1)}: '${spec}' -> use 'node:${spec}'`);
      } else if (!ok) {
        offences.push(`${file.slice(ROOT.length + 1)}: '${spec}' is a third-party import`);
      }
    }
  }

  assert.deepEqual(offences, [], `zero-dependency claim violated:\n  ${offences.join('\n  ')}`);
});

test('package.json files[] covers every shipped directory', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  for (const dir of SHIPPED_DIRS) {
    assert.ok(pkg.files.includes(dir), `"${dir}" missing from package.json files[]`);
  }
  assert.equal(pkg.bin.nonce0, './bin/nonce0.js');
});
