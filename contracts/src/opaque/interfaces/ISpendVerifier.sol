// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The seam between the pool and whatever proves a spend.
/// @notice The pool holds funds and tracks nullifiers. It does NOT know how a
///         spend is proved. That separation is what lets the §6.3 decision be
///         made — and later revisited — without redeploying custody.
interface ISpendVerifier {
    /// @dev 0 = RING_8, 1 = SINGLE_NOTE_PQ. Mirrors ProofMode in the frozen
    ///      §2 contract, so a UI reads one value and cannot invent the other.
    ///
    ///      RING_8 says what the CHAIN can see: eight commitments, none
    ///      distinguished. It does not say who checked the proof. Read
    ///      `verifierId()` for that — it commits to the scheme and, where a
    ///      spend is attested rather than verified in the EVM, to the attester.
    ///      ATTESTED_OFFCHAIN is neither: the chain sees no ring and no note,
    ///      only an authorization id. Its anonymity set is whatever the
    ///      attester demanded off-chain, and no reader of the transaction can
    ///      check that number. RING_8 would be a lie there and SINGLE_NOTE_PQ
    ///      would understate it, so it gets its own value rather than being
    ///      squeezed into one that already means something else.
    enum ProofMode {
        RING_8,
        SINGLE_NOTE_PQ,
        ATTESTED_OFFCHAIN
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
    /// @dev NOT `view`. A verifier whose authority is a few-time signature has
    ///      to burn the index it just used, and a `view` seam would leave that
    ///      bound to off-chain bookkeeping — which is the one place it cannot
    ///      live, because an attester that miscounts is exactly the failure
    ///      being defended against. Implementations that need no state (see
    ///      SingleNotePqVerifier) may still declare themselves `view`;
    ///      Solidity allows an override to be more restrictive.
    /// @param ring        The commitments the spend is proved against.
    /// @param proof       Mode-specific witness.
    /// @param paymentContext Binds pool, chain, recipient and denomination.
    function verifySpend(bytes32[] calldata ring, bytes calldata proof, bytes32 paymentContext)
        external
        returns (bytes32 nullifier);
}
