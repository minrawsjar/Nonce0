// nonce0 scan API — the one hosted process.
//
// Why this exists at all: Hedera requires a LIVE x402-gated endpoint a judge
// watches settle. A published CLI cannot be one and a stdio MCP server cannot be
// one, so exactly one hosted process must exist — and exactly one does.
//
// Why payment is here and not bolted on: a full kill-chain report on a live
// protocol with unpatched exposure IS an attack plan. Serving that free and
// anonymous makes this an attack service. The tiering is a safety decision that
// happens to be a payment integration, not the other way round.
//
// Two rules this file must never break:
//   1. It NEVER calls process.exit(). An in-process scan failure must not kill
//      the API mid-demo. bin/nonce0.js is the only file allowed to exit.
//   2. It serves ../frontend same-origin, so there is no CORS to debug at 4am
//      and no second deploy target.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FRONTEND = resolve(HERE, '..', 'frontend');
const PORT = Number(process.env.PORT ?? 8402);

// Traversal depth per tier. `simulate` is deliberately absent: it would mean
// shelling out to `forge test --fork-url` on a host with no forge binary, and a
// priced tier with no runner is worse than three honest ones.
const TIERS = {
  free:   { depth: 0, price: 0,     returns: 'severity counts only' },
  depth1: { depth: 1, price: 0.01,  returns: 'direct authority edges, no traversal' },
  depth3: { depth: 3, price: 0.10,  returns: 'full kill chain, nested Safes, value at risk' },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = resolve(FRONTEND, rel);
  // Trust boundary: never serve outside frontend/, whatever the URL claims.
  if (file !== FRONTEND && !file.startsWith(FRONTEND + sep)) return send(res, 403, { error: 'forbidden' });
  try {
    if ((await stat(file)).isDirectory()) return send(res, 404, { error: 'not found' });
    send(res, 200, await readFile(file, 'utf8'), MIME[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// The scanner is loaded lazily and by relative path. Until build step 2 lands
// src/scan.js this returns a clear 503 rather than crashing the process, which
// is what lets the frontend be built against a running server today.
async function loadScanner() {
  try {
    return (await import('../src/scan.js')).scan;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

async function handleScan(req, res, url) {
  const target = url.searchParams.get('target');
  const tierName = url.searchParams.get('tier') ?? 'free';
  const tier = TIERS[tierName];

  if (!target) return send(res, 400, { error: 'missing ?target= (a path or a 0x address)' });
  if (!tier) return send(res, 400, { error: `unknown tier '${tierName}'`, tiers: Object.keys(TIERS) });

  // x402 gate (build step 10). Paid tiers answer 402 with a price until the
  // settlement check is wired; the free tier is the only one open by design.
  if (tier.price > 0 && !req.headers['x-payment']) {
    return send(res, 402, {
      error: 'payment required',
      tier: tierName,
      price: tier.price,
      returns: tier.returns,
      note: 'settlement not wired yet — build step 10',
    });
  }

  const scan = await loadScanner();
  if (!scan) {
    return send(res, 503, {
      error: 'scanner not built yet',
      detail: 'src/scan.js lands at build step 2. The API is up; the engine is not.',
      target,
      tier: tierName,
    });
  }

  try {
    const findings = await scan(target, { depth: tier.depth });
    if (tierName === 'free') {
      const counts = {};
      for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      return send(res, 200, { target, tier: tierName, counts, total: findings.length });
    }
    send(res, 200, { target, tier: tierName, findings });
  } catch (err) {
    // Never let a bad target take the process down mid-demo.
    send(res, 500, { error: 'scan failed', detail: err.message, target, tier: tierName });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, scanner: Boolean(await loadScanner()), tiers: TIERS });
    if (url.pathname === '/api/tiers') return send(res, 200, TIERS);
    if (url.pathname === '/api/scan') return await handleScan(req, res, url);
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'no such endpoint' });
    await serveStatic(res, url.pathname);
  } catch (err) {
    send(res, 500, { error: 'internal', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`nonce0 api  http://localhost:${PORT}`);
  console.log(`  frontend  ${FRONTEND}`);
  console.log(`  tiers     ${Object.keys(TIERS).join(', ')}`);
});
