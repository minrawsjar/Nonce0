// PrivatePoolContract, against the pool actually deployed on Arc.
//
// Two callers, deliberately one implementation: the browser adapter (deposit,
// capabilities, nullifier checks) and the managed egress (spend). A second
// implementation would be a second place for the two-phase spend to be got
// subtly wrong.
//
// ── The two-phase spend is not optional ──────────────────────────────────
//
// SINGLE_NOTE_PQ publishes, at reveal time, everything needed to re-spend the
// note. So the reveal is front-runnable: a watcher who copies the proof and
// submits it with their own recipient wins if they can be mined first.
//
// commitSpend binds (ring, proof, recipient, salt) into one hash BEFORE any of
// it is public. An attacker who learns the proof at reveal time still has no
// earlier commit, and creating one costs COMMIT_DELAY_BLOCKS — by which point
// the real nullifier is spent. This client therefore does commit → wait →
// reveal internally, because a caller who did only the second half would build
// something that works on a quiet chain and loses money on a busy one.
//
// THE SALT MUST SURVIVE THE WAIT. It is generated here and held until the
// reveal. If the process dies in between, the commit is stranded until
// COMMIT_EXPIRY_BLOCKS and the note is unspent but not lost — recorded here so
// nobody "fixes" it later by deriving the salt from the spend, which would put
// it back in reach of the watcher this whole dance exists to defeat.
//
// ── Decimals ─────────────────────────────────────────────────────────────
//
// The pool holds USDC through its 6-decimal ERC-20 interface. Arc's NATIVE
// USDC has 18 and pays gas. One asset, two interfaces, a factor of 10^12
// between them. `denomination` below is always the 6-decimal one.

import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  parseAbi,
  type Account,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from 'viem';

import {
  PROTOCOL_VERSION,
  ProtocolFailure,
  type Address,
  type Bytes32,
  type NoteCommitment,
  type Nullifier,
  type PoolScope,
  type PrivatePoolContract,
  type PrivateSpend,
  type ProtocolCapabilities,
  type TxHash,
} from '@opaque/protocol-types';

/** Arc Testnet. Chain id verified live against rpc.testnet.arc.io. */
export const ARC_TESTNET: Chain = {
  id: 5_042_002,
  name: 'Arc Testnet',
  // Arc's native currency IS USDC, at 18 decimals. Naming it USDC here and
  // meaning the 6-decimal ERC-20 elsewhere is the confusion this comment and
  // the Usdc6/Wei18 brands exist to prevent.
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
};

export const POOL_ABI = parseAbi([
  'function capabilities() view returns ((uint8 proofMode, uint8 ringSize, bytes32 verifierId, uint256 denomination, bool requiresCommitReveal))',
  'function deposit(bytes32 commitment)',
  'function commitSpend(bytes32 commitment)',
  'function spend(bytes32[] ring, bytes proof, address recipient, bytes32 salt)',
  'function spendCommitment(bytes32[] ring, bytes proof, address recipient, bytes32 salt) pure returns (bytes32)',
  'function isNullifierSpent(bytes32 nullifier) view returns (bool)',
  'function isCommitmentKnown(bytes32 commitment) view returns (bool)',
  'function denomination() view returns (uint256)',
  'function token() view returns (address)',
  'function poolId() view returns (bytes32)',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/** Matches COMMIT_DELAY_BLOCKS in PrivatePool.sol. */
const COMMIT_DELAY_BLOCKS = 2n;

export interface PoolClientOptions {
  readonly rpcUrl?: string;
  readonly chain?: Chain;
  /** Browser: an EIP-1193 wallet. Server: an account. Reads need neither. */
  readonly provider?: EIP1193Provider;
  readonly account?: Account;
  /**
   * The fields capabilities() cannot answer, because they are not on chain.
   * Passed explicitly rather than defaulted: confidentialExecution in
   * particular must read SIMULATED until attestations are actually verified,
   * and a default would let it quietly say otherwise.
   */
  readonly offChain: Pick<
    ProtocolCapabilities,
    'pqWallet' | 'graph' | 'confidentialExecution' | 'policyScope'
  >;
  /** Injected so a test does not wait on real blocks. */
  readonly waitForBlocks?: (n: bigint) => Promise<void>;
}

const PROOF_MODES = ['RING_8', 'SINGLE_NOTE_PQ', 'ATTESTED_OFFCHAIN'] as const;

/**
 * The ring as the contract wants it: eight commitments, or one for
 * SINGLE_NOTE_PQ. Typed as plain hex rather than Bytes32 because NoteCommitment
 * and Bytes32 are distinct brands and the ABI boundary is where brands stop —
 * widening here is honest, whereas casting each element would hide that a
 * commitment and a hash are different things everywhere else.
 */
const ringOf = (spend: PrivateSpend): readonly `0x${string}`[] =>
  spend.mode === 'RING_8'
    ? (spend.ring as readonly string[] as readonly `0x${string}`[])
    : ([spend.commitment] as readonly string[] as readonly `0x${string}`[]);

export interface OpaquePoolClient extends PrivatePoolContract {
  /** ERC-20 approval for one deposit. Separate because it is a separate tx. */
  approveDeposit(pool: Address): Promise<TxHash>;
  readonly publicClient: PublicClient;
}

export function createPoolClient(options: PoolClientOptions): OpaquePoolClient {
  const chain = options.chain ?? ARC_TESTNET;
  const publicClient = createPublicClient({
    chain,
    transport: http(options.rpcUrl ?? chain.rpcUrls.default.http[0]),
  }) as PublicClient;

  const wallet = (): WalletClient => {
    if (options.provider !== undefined) {
      return createWalletClient({ chain, transport: custom(options.provider) });
    }
    if (options.account !== undefined) {
      return createWalletClient({
        chain,
        account: options.account,
        transport: http(options.rpcUrl ?? chain.rpcUrls.default.http[0]),
      });
    }
    // Refused rather than silently read-only: a caller that thinks it
    // deposited and did not is worse than one that cannot deposit.
    throw new ProtocolFailure('INVALID_INPUT', 'this pool client has no signer');
  };

  /**
   * The signer, in the form viem needs to pick the right send path.
   *
   * A local Account object is returned WHOLE, not narrowed to its address.
   * viem decides how to send from what it is given: an Account signs locally
   * and calls eth_sendRawTransaction, while a bare address means "the node
   * holds this key" and calls eth_sendTransaction. Public RPCs do not hold
   * keys, so narrowing to an address here produced
   * `eth_sendTransaction does not exist` on every write — and reads, which is
   * all the unit tests covered, never touched it.
   */
  const signerFor = async (client: WalletClient): Promise<Account | Address> => {
    if (client.account !== undefined) return client.account;
    const [first] = await client.getAddresses();
    if (first === undefined) throw new ProtocolFailure('INVALID_INPUT', 'no account available');
    return first as Address;
  };

  const waitForBlocks =
    options.waitForBlocks ??
    (async (n: bigint) => {
      const start = await publicClient.getBlockNumber();
      // Polled, not slept: block times vary and a fixed sleep either wastes
      // the user's time or reveals too early and reverts with CommitTooRecent.
      for (;;) {
        if ((await publicClient.getBlockNumber()) >= start + n) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    });

  async function send(
    client: WalletClient,
    address: Address,
    functionName: string,
    args: readonly unknown[],
    abi: typeof POOL_ABI | typeof ERC20_ABI = POOL_ABI,
  ): Promise<TxHash> {
    const { request } = await publicClient.simulateContract({
      address: getAddress(address),
      abi,
      functionName,
      args,
      account: await signerFor(client),
    } as never);
    // Simulated first, so a revert surfaces as a decoded custom error here
    // rather than as a spent transaction that failed on chain.
    const hash = (await client.writeContract(request as never)) as TxHash;
    await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    return hash;
  }

  return {
    publicClient,

    async capabilities(pool: Address): Promise<ProtocolCapabilities> {
      const onChain = (await publicClient.readContract({
        address: getAddress(pool),
        abi: POOL_ABI,
        functionName: 'capabilities',
      })) as {
        proofMode: number;
        ringSize: number;
        verifierId: Bytes32;
        denomination: bigint;
        requiresCommitReveal: boolean;
      };

      const proofMode = PROOF_MODES[onChain.proofMode];
      if (proofMode === undefined) {
        // A mode this build does not know is not a mode to guess at: rendering
        // a spend under the wrong anonymity story is the failure to avoid.
        throw new ProtocolFailure(
          'UNSUPPORTED_PROOF_MODE',
          `pool reports proof mode ${onChain.proofMode}, which this build does not know`,
        );
      }
      if (onChain.ringSize !== 8 && onChain.ringSize !== 1) {
        throw new ProtocolFailure('UNSUPPORTED_PROOF_MODE', `unexpected ring size ${onChain.ringSize}`);
      }

      // READ, never assumed. A SINGLE_NOTE_PQ deployment must never be
      // rendered with eight-member anonymity copy.
      return {
        protocolVersion: PROTOCOL_VERSION,
        proofMode,
        ringSize: onChain.ringSize,
        verifierId: onChain.verifierId,
        ...options.offChain,
      };
    },

    async deposit(input: { scope: PoolScope; commitment: NoteCommitment }): Promise<TxHash> {
      // Attributable by design: §4 is explicit that the deposit is a disclosed
      // event and only the later spend is anonymous. Nothing here hides it.
      return send(wallet(), input.scope.pool, 'deposit', [input.commitment]);
    },

    async approveDeposit(pool: Address): Promise<TxHash> {
      const client = wallet();
      const denomination = (await publicClient.readContract({
        address: getAddress(pool),
        abi: POOL_ABI,
        functionName: 'denomination',
      })) as bigint;
      const token = (await publicClient.readContract({
        address: getAddress(pool),
        abi: POOL_ABI,
        functionName: 'token',
      })) as Address;
      // Exactly one denomination, not MaxUint256. An unlimited approval to a
      // pool is an unlimited approval for as long as the wallet exists.
      return send(client, token, 'approve', [getAddress(pool), denomination], ERC20_ABI);
    },

    async spend(spend: PrivateSpend): Promise<TxHash> {
      const client = wallet();
      const pool = spend.scope.pool;
      const ring = ringOf(spend);

      // Fresh per spend, and never derived from the spend. A salt an observer
      // could recompute puts the commit back within reach of the front-runner
      // the two-phase flow exists to defeat.
      const salt = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Bytes32;

      const commitment = (await publicClient.readContract({
        address: getAddress(pool),
        abi: POOL_ABI,
        functionName: 'spendCommitment',
        args: [ring, spend.proof, getAddress(spend.recipient), salt],
      })) as Bytes32;

      await send(client, pool, 'commitSpend', [commitment]);
      // The salt lives only in this closure across the wait. See the header.
      await waitForBlocks(COMMIT_DELAY_BLOCKS);
      return send(client, pool, 'spend', [ring, spend.proof, getAddress(spend.recipient), salt]);
    },

    async isNullifierSpent(scope: PoolScope, value: Nullifier): Promise<boolean> {
      return (await publicClient.readContract({
        address: getAddress(scope.pool),
        abi: POOL_ABI,
        functionName: 'isNullifierSpent',
        args: [value],
      })) as boolean;
    },
  };
}

/**
 * The egress's submitter, backed by the same client. `deliverApprovedRelease`
 * verifies the MAC before this is ever called, so by here the spend is one the
 * confidential workflow already approved.
 */
export const poolSubmitter = (client: PrivatePoolContract) => ({
  submit: (spend: PrivateSpend): Promise<TxHash> => client.spend(spend),
});
