// File discovery. Walks a tree, skips what is not yours to fix, routes by extension.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';

// Findings in vendored dependencies are not yours to fix, and burying real
// findings under them is how linters get ignored. --include-deps overrides.
const SKIP = new Set([
  'node_modules', 'lib', 'out', 'cache', 'artifacts', 'broadcast',
  '.git', 'target', 'dist', 'build', '.nonce0-cache', 'coverage',
]);

const CODE = new Set(['.sol', '.ts', '.js', '.tsx', '.jsx', '.circom', '.nr', '.json', '.toml']);

// ponytail: prefix/suffix/exact gitignore matching only, no globstar or negation.
// Upgrade to full gitignore semantics if a real repo trips on it.
async function gitignorePatterns(root) {
  try {
    return (await readFile(join(root, '.gitignore'), 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => l.replace(/\/$/, ''));
  } catch {
    return [];
  }
}

function ignored(rel, patterns) {
  return patterns.some((p) =>
    p.startsWith('*') ? rel.endsWith(p.slice(1)) : rel === p || rel.startsWith(p + sep) || rel.split(sep).includes(p)
  );
}

/** Yields { path, rel, ext, source } for every scannable file under root. */
export async function* discover(root, { includeDeps = false } = {}) {
  const patterns = includeDeps ? [] : await gitignorePatterns(root);
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a scan failure
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (!includeDeps && (SKIP.has(entry.name) || ignored(rel, patterns))) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name);
      if (!CODE.has(ext) && !/\.(ptau|zkey)$/.test(entry.name) && entry.name !== 'verification_key.json') continue;
      // Artifacts are matched on filename alone; never read a multi-GB .ptau.
      if (/\.(ptau|zkey)$/.test(entry.name)) {
        yield { path: full, rel, ext, source: null, bytes: (await stat(full)).size };
        continue;
      }
      try {
        yield { path: full, rel, ext, source: await readFile(full, 'utf8') };
      } catch {
        continue; // binary or unreadable: not scannable, not an error
      }
    }
  }
}

/** A single file, for `nonce0 scan path/to/One.sol`. */
export async function discoverOne(path) {
  const ext = extname(path);
  return [{ path, rel: path, ext, source: await readFile(path, 'utf8') }];
}
