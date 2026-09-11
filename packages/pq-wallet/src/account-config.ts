import { asAddress, asBytes32 } from '@opaque/protocol-types/codecs.js';
import type { ArcConfig } from './arc-chain-adapter.ts';
export function parseAccountConfig(raw: unknown): ArcConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Account configuration is missing');
  const r = raw as Record<string, unknown>;
  const address = (x: unknown) => asAddress(typeof x === 'string' ? x.toLowerCase() : x);
  const string = (x: unknown): string => { if (typeof x !== 'string' || !x) throw new Error('Incomplete configuration'); return x; };
  const integer = (x: unknown): bigint => { const s = string(x); if (!/^[1-9][0-9]*$/.test(s)) throw new Error('Expected positive decimal gas/fee ceiling'); return BigInt(s); };
  if (r.entryPointVersion !== '0.7' || (r.chainId !== 5042002 && r.chainId !== 31337)) throw new Error('Unsupported chain or EntryPoint version');
  const h = r.codeHashes as Record<string, unknown>;
  const s = r.sponsorship as Record<string, unknown>;
  if (!h || !s || !['sponsored', 'self-funded'].includes(string(s.mode))) throw new Error('Deployment hashes and fee mode required');
  return { chainId: r.chainId, entryPointVersion: r.entryPointVersion, rpcUrl: string(r.rpcUrl), bundlerUrl: string(r.bundlerUrl),
    entryPoint: address(r.entryPoint), registry: address(r.registry), factory: address(r.factory), implementation: address(r.implementation),
    codeHashes: { entryPoint: asBytes32(h.entryPoint), registry: asBytes32(h.registry), factory: asBytes32(h.factory), implementation: asBytes32(h.implementation) },
    sponsorship: s.mode === 'sponsored' ? { mode: 'sponsored', url: string(s.url), paymaster: address(s.paymaster), codeHash: asBytes32(s.codeHash) } : { mode: 'self-funded' },
    maxFeePerGas: integer(r.maxFeePerGas), maxVerificationGas: integer(r.maxVerificationGas), maxCallGas: integer(r.maxCallGas), maxPreVerificationGas: integer(r.maxPreVerificationGas) };
}
