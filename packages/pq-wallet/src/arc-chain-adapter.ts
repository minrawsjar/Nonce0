import { createPublicClient, http, parseAbi, keccak256, encodeFunctionData, concat, type Hex as VHex } from 'viem';
import { asAddress, asBytes32, asChainId } from '@opaque/protocol-types/codecs.js';
import type { Address, Bytes32 } from '@opaque/protocol-types';
import { BundlerClient, httpRpc, sponsorOperation, type Rpc } from './bundler-client.ts';
import { packedGas, operationHash, signatureEnvelope, type PackedOperation, type OperationContext } from './user-operation.ts';
import type { PQKeyState } from './registry.ts';
export const REGISTRY_ABI = parseAbi([
  'function stateOf(address) view returns ((bytes32 pkCommitment,bytes32 nextCommitment,uint64 useCount,uint64 maxUses,uint64 rotationDeadline,uint64 disableAfter))',
  'function keyEpoch(address) view returns (uint256)',
]);
export const FACTORY_ABI = parseAbi([
  'function getAddress(bytes32,bytes32,uint64,bytes32) view returns (address)',
  'function createAccount(bytes32,bytes32,uint64,bytes32) returns (address)',
  'function implementation() view returns (address)', 'function registry() view returns (address)', 'function entryPoint() view returns (address)',
]);
const EP_ABI = parseAbi(['function getNonce(address,uint192) view returns (uint256)',
  'function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)) view returns (bytes32)']);
export interface ArcConfig {
  chainId: number; entryPointVersion: '0.7'; rpcUrl: string; bundlerUrl: string;
  entryPoint: Address; registry: Address; factory: Address; implementation: Address;
  codeHashes: { entryPoint: Bytes32; registry: Bytes32; factory: Bytes32; implementation: Bytes32 };
  sponsorship: { mode: 'self-funded' } | { mode: 'sponsored'; url: string; paymaster: Address; codeHash: Bytes32 };
  maxFeePerGas: bigint; maxVerificationGas: bigint; maxCallGas: bigint; maxPreVerificationGas: bigint;
}
export interface AccountObservation { state: PQKeyState | undefined; epoch: bigint; nonce: bigint; block: bigint; now: bigint; deployed: boolean }
export class ArcChainAdapter {
  readonly client;
  readonly bundler: BundlerClient;
  readonly config: ArcConfig;
  private readonly sponsorRpc: Rpc | undefined;
  constructor(config: ArcConfig) {
    if (config.entryPointVersion !== '0.7' || ![5042002, 31337].includes(config.chainId)) throw new Error('Unsupported network/version');
    asChainId(BigInt(config.chainId));
    for (const name of ['entryPoint', 'registry', 'factory', 'implementation'] as const) { asAddress(config[name]); asBytes32(config.codeHashes[name]); }
    for (const n of [config.maxFeePerGas, config.maxVerificationGas, config.maxCallGas, config.maxPreVerificationGas]) if (n <= 0n || n >= 1n << 128n) throw new Error('Explicit positive gas/fee ceilings required');
    if (config.sponsorship.mode === 'sponsored') { asAddress(config.sponsorship.paymaster); asBytes32(config.sponsorship.codeHash); }
    // Validate endpoint policy even for viem's transport.
    httpRpc(config.rpcUrl);
    this.config = Object.freeze({ ...structuredClone(config), codeHashes: Object.freeze({ ...config.codeHashes }), sponsorship: Object.freeze({ ...config.sponsorship }) });
    this.client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 30_000 }) });
    this.bundler = new BundlerClient(httpRpc(config.bundlerUrl), config.entryPoint, BigInt(config.chainId));
    this.sponsorRpc = config.sponsorship.mode === 'sponsored' ? httpRpc(config.sponsorship.url) : undefined;
  }
  async check(): Promise<void> {
    if (await this.client.getChainId() !== this.config.chainId) throw new Error('Wrong RPC network');
    const blockNumber = await this.client.getBlockNumber();
    for (const name of ['entryPoint', 'registry', 'factory', 'implementation'] as const) {
      const code = await this.client.getCode({ address: this.config[name], blockNumber });
      if (!code || keccak256(code) !== this.config.codeHashes[name]) throw new Error(`Unverified ${name} deployment`);
    }
    for (const name of ['entryPoint', 'registry', 'implementation'] as const) {
      const actual = await this.client.readContract({ address: this.config.factory, abi: FACTORY_ABI, functionName: name, blockNumber });
      if (actual.toLowerCase() !== this.config[name].toLowerCase()) throw new Error('Factory configuration mismatch');
    }
    if (this.config.sponsorship.mode === 'sponsored') {
      const code = await this.client.getCode({ address: this.config.sponsorship.paymaster, blockNumber });
      if (!code || keccak256(code) !== this.config.sponsorship.codeHash) throw new Error('Unverified paymaster');
    }
    await this.bundler.check();
  }
  async address(active: Bytes32, next: Bytes32, deadline: bigint, salt: Bytes32): Promise<Address> {
    return asAddress((await this.client.readContract({ address: this.config.factory, abi: FACTORY_ABI, functionName: 'getAddress', args: [active, next, deadline, salt] })).toLowerCase());
  }
  initCode(active: Bytes32, next: Bytes32, deadline: bigint, salt: Bytes32): VHex {
    return concat([this.config.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createAccount', args: [active, next, deadline, salt] })]);
  }
  async observe(account: Address): Promise<AccountObservation> {
    const block = await this.client.getBlock(); const blockNumber = block.number;
    const [state, epoch, nonce, code] = await Promise.all([
      this.client.readContract({ address: this.config.registry, abi: REGISTRY_ABI, functionName: 'stateOf', args: [account], blockNumber }),
      this.client.readContract({ address: this.config.registry, abi: REGISTRY_ABI, functionName: 'keyEpoch', args: [account], blockNumber }),
      this.client.readContract({ address: this.config.entryPoint, abi: EP_ABI, functionName: 'getNonce', args: [account, 0n], blockNumber }),
      this.client.getCode({ address: account, blockNumber }),
    ]);
    const deployed = !!code && code !== '0x';
    if (deployed) {
      const expected = concat(['0x363d3d373d3d3d363d73', this.config.implementation, '0x5af43d82803e903d91602b57fd5bf3']);
      if (code.toLowerCase() !== expected.toLowerCase()) throw new Error('Unexpected account bytecode');
    }
    const registered = BigInt(state.pkCommitment) !== 0n;
    if (registered !== deployed) throw new Error('Inconsistent account deployment/registry state');
    return { state: registered ? { ...state, pkCommitment: asBytes32(state.pkCommitment), nextCommitment: asBytes32(state.nextCommitment) } : undefined,
      epoch, nonce, block: blockNumber, now: block.timestamp, deployed };
  }
  async finalize(sender: Address, nonce: bigint, callData: VHex, initCode: VHex, context: OperationContext): Promise<PackedOperation> {
    const price = await this.client.getGasPrice();
    const fee = price * 2n; if (fee > this.config.maxFeePerGas) throw new Error('Network fee exceeds configured ceiling');
    // Synthetic invalid signature of the full profile; no real signing key is touched.
    const dummy = new Uint8Array(9251).fill(1); dummy[0] = 0; dummy[1] = 32; dummy[2] = 8;
    const op: PackedOperation = { sender, nonce, initCode, callData, accountGasLimits: packedGas(this.config.maxVerificationGas, this.config.maxCallGas),
      gasFees: packedGas(price, fee), preVerificationGas: this.config.maxPreVerificationGas, paymasterAndData: '0x',
      signature: signatureEnvelope(context, `0x${Array.from(dummy, b => b.toString(16).padStart(2, '0')).join('')}` as import('@opaque/protocol-types').Hex) };
    if (this.config.sponsorship.mode === 'sponsored') {
      const quote = await sponsorOperation(this.sponsorRpc!, op, this.config.entryPoint, this.config.sponsorship.paymaster);
      op.paymasterAndData = quote.paymasterAndData;
      op.accountGasLimits = packedGas(quote.verificationGasLimit, quote.callGasLimit); op.preVerificationGas = quote.preVerificationGas;
    } else {
      // Execution requires successful PQ authorization, so a dummy signature cannot
      // estimate this account. Commit explicit gas budgets, then simulate the saved
      // real signature before submission. Never edit gas fields after signing.
      const required = (this.config.maxVerificationGas + this.config.maxCallGas + op.preVerificationGas) * fee;
      const balance = await this.client.getBalance({ address: sender });
      if (balance < required) throw new Error('Fund this account with enough native USDC for the configured gas budget before signing');
    }
    const verification = BigInt(`0x${op.accountGasLimits.slice(2, 34)}`), call = BigInt(`0x${op.accountGasLimits.slice(34)}`);
    if (verification > this.config.maxVerificationGas || call > this.config.maxCallGas || op.preVerificationGas > this.config.maxPreVerificationGas) throw new Error('Gas estimate exceeds limits');
    // Check that the actual bundler accepts the finalized sponsor/estimation path.
    if (this.config.sponsorship.mode === 'sponsored') {
      const check = await this.bundler.estimate(op);
      if (check.verification > verification || check.call > call || check.pre > op.preVerificationGas) throw new Error('Final operation needs a new estimate/sponsorship quote');
    }
    op.signature = '0x';
    const actual = await this.client.readContract({ address: this.config.entryPoint, abi: EP_ABI, functionName: 'getUserOpHash', args: [op] });
    if (actual !== operationHash(op, this.config.entryPoint, BigInt(this.config.chainId))) throw new Error('EntryPoint operation hash mismatch');
    return op;
  }
  async checkSignedGas(op: PackedOperation): Promise<void> {
    if (op.signature === '0x') throw new Error('A saved PQ signature is required for simulation');
    const gas = await this.bundler.estimate(op);
    const verification = BigInt(`0x${op.accountGasLimits.slice(2, 34)}`);
    const call = BigInt(`0x${op.accountGasLimits.slice(34)}`);
    if (gas.verification > verification || gas.call > call || gas.pre > op.preVerificationGas) {
      throw new Error('Simulation exceeds the signed gas budget. No submission was sent by this wallet. Keep this request until expiry; changing gas requires a new signature and consumes another slot.');
    }
  }
}
