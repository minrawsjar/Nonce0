// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {ISpendVerifier} from "../interfaces/ISpendVerifier.sol";

/// @title SINGLE_NOTE_PQ — §6.3's stated fallback, built honestly.
/// @notice WHAT THIS PROVIDES: a spend authorised by pure keccak, with no
///         elliptic curve anywhere. Quantum-safe.
///
///         WHAT THIS DOES NOT PROVIDE: any sender anonymity whatsoever. The
///         note secret is revealed in calldata, so anyone can recompute the
///         commitment and link this withdrawal to its deposit. There is no ring
///         and there is nothing hidden.
///
///         This exists because the §6.3 spike MEASURED the eight-member ring
///         proof at 1.08 MiB, ~9x an Arc block to verify, and therefore
///         impossible on-chain (`node backend/zk/bench.ts` reproduces it). A
///         pool deployed with this verifier must report SINGLE_NOTE_PQ through
///         `capabilities()` so no interface can dress the padding up as
///         anonymity.
///
/// @dev Commitments here are keccak-based, not the AES-based ones the ring
///      circuit uses. That is not an inconsistency: a hash-preimage statement
///      proved by an MPC-in-the-head circuit wants a cheap-in-AND-gates
///      primitive, and one checked directly by the EVM wants the native
///      opcode. A pool is one mode or the other, and `capabilities()` says so.
contract SingleNotePqVerifier is ISpendVerifier {
    string internal constant NOTE_DOMAIN = "opaque/v1/note";
    string internal constant NULLIFIER_DOMAIN = "opaque/v1/nullifier";
    string internal constant VERIFIER_DOMAIN = "opaque/v1/spend-verifier";
    string internal constant SCHEME = "single-note-pq/keccak256";

    bytes32 public immutable poolId;
    uint256 public immutable denomination;

    error WrongRingSize();
    error MalformedProof();
    error CommitmentMismatch();

    constructor(bytes32 poolId_, uint256 denomination_) {
        poolId = poolId_;
        denomination = denomination_;
    }

    function verifierId() external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(VERIFIER_DOMAIN)),
                Canonical.field(bytes(SCHEME)),
                Canonical.field(poolId),
                Canonical.field(Canonical.decimal(denomination))
            )
        );
    }

    function proofMode() external pure returns (ProofMode) {
        return ProofMode.SINGLE_NOTE_PQ;
    }

    function ringSize() external pure returns (uint8) {
        return 1;
    }

    /// Revealing the secret is exactly what makes this front-runnable.
    function requiresCommitReveal() external pure returns (bool) {
        return true;
    }

    function noteCommitment(bytes32 secret) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(NOTE_DOMAIN)),
                Canonical.field(secret),
                Canonical.field(poolId),
                Canonical.field(Canonical.decimal(denomination))
            )
        );
    }

    /// @dev Binds the secret and the pool, and NOTHING else. A nullifier that
    ///      varied with the recipient would let one note be spent once per
    ///      recipient, without limit — an unlimited mint. The recipient is
    ///      bound separately, through paymentContext and the commit phase.
    function noteNullifier(bytes32 secret) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(NULLIFIER_DOMAIN)),
                Canonical.field(secret),
                Canonical.field(poolId)
            )
        );
    }

    function verifySpend(bytes32[] calldata ring, bytes calldata proof, bytes32)
        external
        view
        returns (bytes32)
    {
        if (ring.length != 1) revert WrongRingSize();
        if (proof.length != 32) revert MalformedProof();
        bytes32 secret = bytes32(proof[0:32]);
        if (noteCommitment(secret) != ring[0]) revert CommitmentMismatch();
        return noteNullifier(secret);
    }
}
