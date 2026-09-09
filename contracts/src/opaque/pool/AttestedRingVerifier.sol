// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {IPQKeyRegistry} from "../interfaces/IPQKeyRegistry.sol";
import {ISpendVerifier} from "../interfaces/ISpendVerifier.sol";

/// @title RING_8 with the proof checked off-chain and the RESULT enforced here.
/// @notice §6.3's routing decision, made: the eight-member ring proof is
///         verified off-chain, and this contract enforces what comes back.
///
///         WHY NOT IN THE EVM: the proof measures 1.08 MiB and roughly nine
///         Arc blocks to verify (`node backend/zk/bench.ts` reproduces it). It
///         does not fit in a transaction, so "verify it on-chain" was never one
///         of the options — the real choice was between shrinking the privacy
///         claim to what the EVM can check (SINGLE_NOTE_PQ, no anonymity at
///         all) and moving verification off-chain while keeping enforcement on
///         it. This is the second.
///
///         WHAT THE CHAIN STILL ENFORCES, and it is most of the protocol:
///           - every ring member is a real deposit          (PrivatePool)
///           - the nullifier is consumed exactly once       (PrivatePool)
///           - one denomination out, to the bound recipient (PrivatePool)
///           - the attestation carries a valid signature under the attester's
///             CURRENT post-quantum key                     (PQKeyRegistry)
///           - that key has not exceeded its few-time bound (PQKeyRegistry)
///
///         WHAT MOVES OFF-CHAIN: one question only — does the ZK proof show
///         the spender knows a secret for one of these eight commitments.
///
/// @dev THE TRUST STATEMENT, stated once and plainly.
///
///      A dishonest attester can sign an attestation no valid proof supports,
///      and mint against the pool up to its balance. That is the cost of this
///      routing and it is not hidden anywhere in this file.
///
///      It cannot, however, learn who paid. The proof it checks is zero
///      knowledge, so verifying it reveals nothing about WHICH ring member was
///      opened. The attester is trusted for soundness and never for privacy —
///      an unusual split, and the reason this trade was acceptable at all.
///
///      Both halves are auditable after the fact: the proofs are ZK, so they
///      can be published without harming the payer, and anyone who keeps them
///      can re-verify every `Spent` event independently. A forging attester
///      gets caught; it just does not get stopped in the same block.
contract AttestedRingVerifier is ISpendVerifier {
    string internal constant VERIFIER_DOMAIN = "opaque/v1/spend-verifier";
    string internal constant ATTEST_DOMAIN = "opaque/v1/ring-attestation";
    /// Names the proof system whose verdict is being attested to, so an
    /// attestation minted for one construction cannot be replayed under
    /// another. Matches SCHEME in backend/zk/spend.ts.
    string internal constant SCHEME = "attested-ring8/zkboo-aes128-ring8";

    uint8 internal constant RING = 8;

    IPQKeyRegistry public immutable registry;
    /// The account whose PQ key signs attestations. Immutable: an attester that
    /// could be swapped after deployment is an admin key over the whole pool,
    /// and this protocol has none anywhere else either. Changing who attests
    /// means a new verifier and a new pool, which is exactly as loud as a
    /// change to the trust model deserves to be.
    address public immutable attester;
    bytes32 public immutable poolId;
    uint256 public immutable denomination;

    error WrongRingSize();
    error MalformedProof();

    constructor(IPQKeyRegistry registry_, address attester_, bytes32 poolId_, uint256 denomination_) {
        if (address(registry_) == address(0) || attester_ == address(0)) revert MalformedProof();
        registry = registry_;
        attester = attester_;
        poolId = poolId_;
        denomination = denomination_;
    }

    /// @dev Commits to the attester and the registry, not just the scheme. Two
    ///      deployments that differ only in who attests are different trust
    ///      models, so they must not share an id — `capabilities().verifierId`
    ///      is what an interface has to resolve to know whose word this is.
    function verifierId() public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(VERIFIER_DOMAIN)),
                Canonical.field(bytes(SCHEME)),
                Canonical.field(poolId),
                Canonical.field(Canonical.decimal(denomination)),
                abi.encodePacked(uint32(20), address(registry)),
                abi.encodePacked(uint32(20), attester)
            )
        );
    }

    function proofMode() external pure returns (ProofMode) {
        return ProofMode.RING_8;
    }

    function ringSize() external pure returns (uint8) {
        return RING;
    }

    /// @dev False, and this is a real improvement rather than a corner cut.
    ///      SINGLE_NOTE_PQ needs two phases because its calldata publishes the
    ///      note secret, so a watcher can re-spend it to a recipient of their
    ///      choosing. Here the calldata publishes an attestation that is signed
    ///      over `paymentContext`, and `paymentContext` binds the recipient.
    ///      Copy this transaction verbatim and the payment still lands where it
    ///      was always going; change one byte of it and the signature fails.
    ///      Nothing is left to front-run, so the commit phase — one extra
    ///      transaction and a two-block wait on every payment — comes off.
    function requiresCommitReveal() external pure returns (bool) {
        return false;
    }

    /// @notice The exact bytes the attester signs.
    /// @dev Every field closes a replay class. Without `verifierId` an
    ///      attestation moves between verifiers sharing an attester; without
    ///      the ring hash the same nullifier opens against a different
    ///      membership set; without `paymentContext` it redirects to another
    ///      recipient, pool or chain; without the nullifier it is not a
    ///      statement about a spend at all.
    ///
    ///      Length-prefixed, never concatenated with a separator — see
    ///      Canonical. PQKeyRegistry then wraps this in its own action domain
    ///      and binds chainId, the attester's address and its useCount, so a
    ///      spend attestation can never be re-presented as a key rotation.
    function attestation(bytes32[] calldata ring, bytes32 nullifier, bytes32 paymentContext)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            Canonical.field(bytes(ATTEST_DOMAIN)),
            Canonical.field(verifierId()),
            Canonical.field(keccak256(abi.encode(ring))),
            Canonical.field(nullifier),
            Canonical.field(paymentContext)
        );
    }

    /// @param proof 32-byte nullifier, then the attester's FORS signature.
    /// @dev The nullifier is asserted by the attester, not recomputed here —
    ///      recomputing it would need the note secret, and the whole point is
    ///      that nobody on this chain ever sees it. The pool still refuses a
    ///      nullifier it has seen, so a valid attestation buys exactly one
    ///      spend, and `consume` burns the signing index so it cannot buy even
    ///      that one twice.
    function verifySpend(bytes32[] calldata ring, bytes calldata proof, bytes32 paymentContext)
        external
        returns (bytes32)
    {
        if (ring.length != RING) revert WrongRingSize();
        if (proof.length <= 32) revert MalformedProof();

        bytes32 nullifier = bytes32(proof[0:32]);
        // A zero nullifier would be indistinguishable from an unset mapping
        // slot in any consumer that checks one, so it never becomes valid here.
        if (nullifier == bytes32(0)) revert MalformedProof();

        // Reverts unless the signature verifies under the attester's current
        // key, that key is live, and its few-time budget has room. There is no
        // branch after this: enforcement is the call.
        registry.consume(attester, attestation(ring, nullifier, paymentContext), proof[32:]);

        return nullifier;
    }
}
