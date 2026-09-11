import { keccak256, toBytes, encodeFunctionData, parseAbi } from 'viem';
import { ProtocolFailure, type Address, type Bytes32, type Hex, type PqWallet, type PqWalletState, type TxHash } from '@opaque/protocol-types';
import { asAddress, asBytes32, asUnixSeconds } from '@opaque/protocol-types/codecs.js';
import { initializeSigner, signerSummary, unsafeState, type SignerStore, type SignedOutput } from './signer-state.ts';
import { signDigest } from './sign.ts';
import { accountDigest, actionCallData, batchAction, decodeAction, decodeOperation, encodeOperation, lifecycleAction, operationHash, signatureEnvelope, type OperationContext } from './user-operation.ts';
import { ArcChainAdapter, type AccountObservation } from './arc-chain-adapter.ts';
import { validateAccountRecord, type AccountRecord, type AccountStore } from './operation-outbox.ts';

type Lock = <T>(run: () => Promise<T>) => Promise<T>;
/** Application controller exposes the unchanged PqWallet facade, with delivery outside that interface. */
export class AccountWalletController {
  readonly wallet: PqWallet;
  private readonly configId: Bytes32;
  readonly network: ArcChainAdapter; readonly signerStore: SignerStore; readonly store: AccountStore; private readonly lock: Lock;
  constructor(network: ArcChainAdapter, signerStore: SignerStore, store: AccountStore, lock: Lock) {
    this.network = network; this.signerStore = signerStore; this.store = store; this.lock = lock;
    const c = network.config;
    this.configId = asBytes32(keccak256(toBytes(JSON.stringify({ chain: c.chainId, version: c.entryPointVersion,
      entryPoint: c.entryPoint.toLowerCase(), registry: c.registry.toLowerCase(), factory: c.factory.toLowerCase(),
      implementation: c.implementation.toLowerCase(), hashes: c.codeHashes, sponsorship: c.sponsorship.mode === 'sponsored' ? c.sponsorship.paymaster.toLowerCase() : 'self-funded' }))));
    this.wallet = Object.freeze({ create: () => this.lock(() => this.create()), getState: () => this.lock(() => this.state()),
      register: () => this.lock(() => this.perform(0)), rotate: () => this.lock(() => this.perform(2)),
      disable: () => this.lock(() => this.perform(3)), signUserOperation: (encoded: Hex) => this.lock(() => this.sign(encoded)) });
  }
  private async read(): Promise<AccountRecord> {
    const r = await this.store.read(); if (!r) throw unsafeState(); validateAccountRecord(r);
    if (r.configId !== this.configId) throw unsafeState(); return r;
  }
  private async save(r: AccountRecord): Promise<AccountRecord> {
    const updated = { ...r, revision: r.revision + 1n }; await this.store.write(r.revision, updated); return updated;
  }
  private async newKey(epoch: bigint): Promise<Bytes32> {
    return initializeSigner(this.signerStore, { keyEpoch: epoch, maxUses: 8n, lifecycleReserve: 2n, params: { k: 32, a: 8 } });
  }
  private async create(): Promise<PqWalletState> {
    if (await this.store.read()) return this.state();
    await this.network.check();
    const active = await this.newKey(0n), next = await this.newKey(1n);
    const salt = asBytes32(`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')}`);
    const block = await this.network.client.getBlock(); const initialDeadline = block.timestamp + 30n * 86400n;
    const account = await this.network.address(active, next, initialDeadline, salt);
    await this.store.write(undefined, { version: 1, revision: 0n, configId: this.configId, account, active, next, salt,
      initialActive: active, initialNext: next, initialDeadline, epoch: 0n, lastBlock: block.number, chainCount: 0n, registered: false, history: [] });
    return this.state();
  }
  private async reconcile(): Promise<{ record: AccountRecord; observation: AccountObservation }> {
    let r = await this.read(); const observation = await this.network.observe(r.account);
    if (observation.block < r.lastBlock) throw unsafeState();
    const s = observation.state;
    if (!s && r.registered) throw unsafeState();
    if (s && (s.pkCommitment !== r.active || observation.epoch !== r.epoch)) {
      const replacement = r.pending?.replacement;
      if (!replacement || s.pkCommitment !== r.next || s.nextCommitment !== replacement.next || observation.epoch !== r.epoch + 1n) throw unsafeState();
      r = { ...r, active: r.next, next: replacement.next, epoch: observation.epoch, chainCount: 0n };
    }
    const local = await signerSummary(this.signerStore, r.active);
    if (local.keyEpoch !== r.epoch || (s && (s.nextCommitment !== r.next || s.useCount < r.chainCount || s.useCount > local.localSigningReservations || s.maxUses !== local.maxUses))) throw unsafeState();
    r = { ...r, registered: !!s, lastBlock: observation.block, chainCount: s?.useCount ?? 0n };
    const pending = r.pending;
    if (pending && pending.phase !== 'prepared' && !pending.receipt) {
      const receipt = await this.network.bundler.receipt(pending.hash, r.account, pending.operation.nonce);
      if (receipt) {
        // Independently verify the bundle exists at the reported block. Its success
        // alone is insufficient; the UserOperationEvent is checked below.
        const chainReceipt = await this.network.client.getTransactionReceipt({ hash: receipt.transactionHash });
        if (chainReceipt.status !== 'success' || chainReceipt.blockNumber !== receipt.blockNumber || receipt.blockNumber > observation.block) throw new Error('Receipt not reconciled with the observed chain');
        const { parseEventLogs } = await import('viem');
        const events = parseEventLogs({ abi: parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']), logs: chainReceipt.logs });
        const event = events.find(e => e.address.toLowerCase() === this.network.config.entryPoint.toLowerCase() && e.args.userOpHash === pending.hash);
        if (!event || event.args.sender.toLowerCase() !== r.account.toLowerCase() || event.args.nonce !== pending.operation.nonce || event.args.success !== receipt.success) throw unsafeState();
        r.pending = { ...pending, phase: receipt.success ? 'confirmed' : 'failed', receipt };
        r.history = [...r.history, receipt];
      }
    }
    r = await this.save(r); return { record: r, observation };
  }
  private async state(): Promise<PqWalletState> {
    const { record: r, observation: o } = await this.reconcile(); const local = await signerSummary(this.signerStore, r.active);
    return { accountAddress: r.account, pkCommitment: r.active, keyEpoch: r.epoch, chainUseCount: r.chainCount,
      localSigningReservations: local.localSigningReservations, maxUses: local.maxUses,
      rotationDeadline: asUnixSeconds(o.state?.rotationDeadline ?? r.initialDeadline),
      active: !!o.state && o.state.useCount < o.state.maxUses && local.localSigningReservations < local.maxUses && (!o.state.disableAfter || o.now < o.state.disableAfter) };
  }
  private async prepare(kind: 0 | 1 | 2 | 3 | 4, callData?: Hex): Promise<Hex> {
    const { record: r, observation: o } = await this.reconcile();
    if (r.pending && !r.pending.receipt) throw new Error('An operation is already pending; retry or inspect it first');
    if (kind !== 0 && !o.state) throw new Error('Activate the account first');
    if (kind === 0 && o.state) throw new Error('Account is already registered');
    const takeover = kind === 4;
    if (takeover && (!o.state?.disableAfter || o.now < o.state.disableAfter)) throw new Error('Takeover waiting period has not elapsed');
    if (!takeover && o.state?.disableAfter && o.now >= o.state.disableAfter) throw new Error('Current key is disabled');
    let replacement: { next: Bytes32; deadline: bigint } | undefined;
    if (kind === 2 || takeover) {
      replacement = { next: await this.newKey(r.epoch + 2n), deadline: o.now + 30n * 86400n };
      callData = lifecycleAction(kind, replacement.next, replacement.deadline);
    }
    if (!callData) callData = actionCallData(kind);
    if (decodeAction(callData).kind !== kind) throw new Error('Action mismatch');
    const context: OperationContext = { chainId: BigInt(this.network.config.chainId), entryPoint: this.network.config.entryPoint,
      epoch: r.epoch, useCount: takeover ? 0n : o.state?.useCount ?? 0n, validAfter: o.now, validUntil: o.now + 300n };
    const initCode = o.deployed ? '0x' : this.network.initCode(r.initialActive, r.initialNext, r.initialDeadline, r.salt);
    const operation = await this.network.finalize(r.account, o.nonce, callData, initCode, context);
    r.pending = { phase: 'prepared', operation, context, digest: accountDigest(operation, context),
      hash: operationHash(operation, context.entryPoint, context.chainId), signer: takeover ? r.next : r.active, ...(replacement ? { replacement } : {}) };
    await this.save(r); return encodeOperation(operation);
  }
  private async sign(encoded: Hex): Promise<SignedOutput> {
    const { record: r, observation: o } = await this.reconcile(); const p = r.pending;
    const op = decodeOperation(encoded);
    if (!p || encodeOperation({ ...p.operation, signature: '0x' }) !== encodeOperation({ ...op, signature: '0x' })) throw new Error('Operation was not prepared by this wallet');
    if (o.now > p.context.validUntil) throw new Error('This request expired. Refresh, then use Discard unsigned or expired request before preparing another action. The used signing slot stays used.');
    if (o.nonce !== p.operation.nonce || o.epoch !== p.context.epoch) throw new Error('Prepared operation is stale');
    const kind = decodeAction(p.operation.callData).kind;
    if (p.context.useCount !== (kind === 4 ? 0n : o.state?.useCount ?? 0n)) throw unsafeState();
    const output = await signDigest(this.signerStore, p.signer, p.digest, kind <= 1 ? 'ordinary' : 'lifecycle');
    const signature = signatureEnvelope(p.context, output.signature);
    if (p.signature && p.signature !== signature) throw unsafeState();
    if (p.phase === 'prepared') { r.pending = { ...p, phase: 'signed', signature, operation: { ...p.operation, signature } }; await this.save(r); }
    return output;
  }
  private async submit(): Promise<Bytes32> {
    let { record: r, observation: o } = await this.reconcile(); const p = r.pending;
    if (!p || p.phase === 'prepared' || !p.signature) throw new Error('Sign the prepared operation first');
    if (p.receipt) return p.hash;
    if (o.now > p.context.validUntil) throw new Error('This request expired. Refresh, then use Discard unsigned or expired request before preparing another action. The used signing slot stays used.');
    // Validate the saved signature through the original durable signer cache before broadcasting.
    const kind = decodeAction(p.operation.callData).kind;
    const cached = await signDigest(this.signerStore, p.signer, p.digest, kind <= 1 ? 'ordinary' : 'lifecycle');
    if (signatureEnvelope(p.context, cached.signature) !== p.operation.signature) throw unsafeState();
    r.pending = { ...p, phase: 'unknown' }; r = await this.save(r);
    // The simulation RPC receives a valid authorization. Persist it before disclosure
    // and retain the exact bytes on failure; it must never trigger automatic re-signing.
    if (this.network.config.sponsorship.mode === 'self-funded') await this.network.checkSignedGas(p.operation);
    const hash = asBytes32(await this.network.bundler.submit(p.operation));
    r.pending = { ...p, phase: 'submitted' }; await this.save(r); return hash;
  }
  private async perform(kind: 0 | 2 | 3 | 4): Promise<TxHash> {
    const prior = await this.read();
    if (prior.pending && !prior.pending.receipt && decodeAction(prior.pending.operation.callData).kind !== kind) throw new Error('A different operation is pending');
    const encoded = prior.pending && !prior.pending.receipt ? encodeOperation(prior.pending.operation) : await this.prepare(kind);
    await this.sign(encoded); await this.submit();
    for (let i = 0; i < 15; i++) {
      const { record } = await this.reconcile();
      if (record.pending?.receipt) {
        if (!record.pending.receipt.success) throw new Error('Operation was included but execution failed');
        return record.pending.receipt.transactionHash as TxHash;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new ProtocolFailure('SETTLEMENT_REVERTED', 'Operation pending; refresh to check confirmation. Do not create a replacement.', true);
  }
  prepareTransfer(recipient: Address, amount: bigint, token?: Address): Promise<Hex> {
    if (amount <= 0n) throw new Error('Amount must be positive'); asAddress(recipient);
    const calls = token ? [{ target: token, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [recipient, amount] }) }]
      : [{ target: recipient, value: amount, data: '0x' as Hex }];
    return this.lock(() => this.prepare(1, batchAction(calls)));
  }
  abandonExpired(): Promise<void> {
    return this.lock(async () => {
      const { record: r, observation: o } = await this.reconcile(); const p = r.pending;
      if (!p || p.receipt) return;
      if (p.phase !== 'prepared' && (o.now <= p.context.validUntil || o.nonce !== p.operation.nonce || o.epoch !== p.context.epoch || (decodeAction(p.operation.callData).kind === 4 ? 0n : o.state?.useCount ?? 0n) !== p.context.useCount)) {
        throw new Error('Signed operation cannot be abandoned until expiry and unchanged chain state are confirmed');
      }
      r.abandoned = [...r.abandoned ?? [], p]; delete r.pending; await this.save(r);
    });
  }
  submitPending(): Promise<Bytes32> { return this.lock(() => this.submit()); }
  takeover(): Promise<TxHash> { return this.lock(() => this.perform(4)); }
  inspect(): Promise<AccountRecord> { return this.lock(async () => (await this.reconcile()).record); }
}
