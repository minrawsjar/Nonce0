import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseAccountConfig } from '../src/account-config.ts';
import { httpRpc, RpcError } from '../src/bundler-client.ts';

/** Local development gateway. Fixed upstreams and methods; never accepts an arbitrary URL. */
export async function accountGateway(path: string | undefined) {
  if (!path) return async (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(503); response.end('Account deployment is not configured'); };
  const config = parseAccountConfig(JSON.parse(await readFile(path, 'utf8')));
  const publicConfig = { ...config, rpcUrl: '/rpc/chain', bundlerUrl: '/rpc/bundler',
    sponsorship: config.sponsorship.mode === 'sponsored' ? { ...config.sponsorship, url: '/rpc/sponsor' } : config.sponsorship };
  const routes = {
    '/rpc/chain': { rpc: httpRpc(config.rpcUrl), methods: new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_gasPrice', 'eth_getBalance', 'eth_getTransactionReceipt']) },
    '/rpc/bundler': { rpc: httpRpc(config.bundlerUrl), methods: new Set(['eth_chainId', 'eth_supportedEntryPoints', 'eth_estimateUserOperationGas', 'eth_sendUserOperation', 'eth_getUserOperationReceipt']) },
    '/rpc/sponsor': { rpc: config.sponsorship.mode === 'sponsored' ? httpRpc(config.sponsorship.url) : undefined, methods: new Set(['pm_sponsorUserOperation']) },
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/account-config.json' && request.method === 'GET') {
      response.end(JSON.stringify(publicConfig, (_, value) => typeof value === 'bigint' ? value.toString() : value)); return;
    }
    const route = routes[request.url as keyof typeof routes];
    if (!route?.rpc || request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) { response.writeHead(400); response.end('{}'); return; }
    // Browser POSTs must originate from this exact local server. No CORS bypass.
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { response.writeHead(403); response.end('{}'); return; }
    let id: unknown = null;
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 256_000) throw new Error('Request too large'); }
      const req = JSON.parse(body); id = req.id;
      if (!req || req.jsonrpc !== '2.0' || !route.methods.has(req.method) || (req.params !== undefined && !Array.isArray(req.params)) || !['number', 'string'].includes(typeof id)) throw new Error('Unsupported RPC request');
      const result = await route.rpc(req.method, req.params ?? []);
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: error instanceof RpcError
        ? { code: error.code, message: error.reason }
        : { code: -32000, message: 'Configured RPC service could not complete the request' } }));
    }
  };
}
