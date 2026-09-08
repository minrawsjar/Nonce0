// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The seam between the pool and whatever proves a spend.
/// @notice The pool holds funds and tracks nullifiers. It does NOT know how a
///         spend is proved. That separation is what lets the §6.3 decision be
///         made — and later revisited — without redeploying custody.
interface ISpendVerifier {
    /// @dev 0 = RING_8, 1 = SINGLE_NOTE_PQ. Mirrors ProofMode in the frozen
    ///      §2 contract, so a UI reads one value and cannot invent the other.
    enum ProofMode {
        RING_8,
        SINGLE_NOTE_PQ
    }

    function verifierId() external view returns (bytes32);
    function proofMode() external view returns (ProofMode);
    function ringSize() external view returns (uint8);

    /// @notice True when revealing the proof also reveals everything needed to
    ///         re-spend the note, which makes the reveal front-runnable and
    ///         forces the pool's two-phase flow. A ring proof binds its
    ///         recipient into its own challenge and does not need this; a
    ///         single-note spend that publishes the secret absolutely does.
    function requiresCommitReveal() external view returns (bool);

    /// @notice Reverts, or returns the nullifier this spend consumes.
    /// @param ring        The commitments the spend is proved against.
    /// @param proof       Mode-specific witness.
    /// @param paymentContext Binds pool, chain, recipient and denomination.
    function verifySpend(bytes32[] calldata ring, bytes calldata proof, bytes32 paymentContext)
        external
        view
        returns (bytes32 nullifier);
}
