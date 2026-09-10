// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {ICREPolicyGate} from "../cre/ICREPolicyGate.sol";
import {IPrivatePool} from "../interfaces/IPrivatePool.sol";
import {ISpendVerifier} from "../interfaces/ISpendVerifier.sol";

interface IERC20Cre { function transfer(address to, uint256 value) external returns (bool); function transferFrom(address from, address to, uint256 value) external returns (bool); }

/// @notice Fixed-bucket pool settled from CRE-published authorizations.
///
/// @dev WHAT THIS POOL DOES NOT DO, stated where nobody can miss it.
///
///      It checks no ring. There is no ring in this file — `settle` takes an
///      authorization id, and the only things enforced on chain are that the
///      gate approved that id, that the amounts match this pool's denomination
///      and fee, and that the nullifier has not been seen. Whether eight
///      candidate notes were ever considered is a fact about the CRE, not
///      about this contract, and no reader of the chain can check it.
///
///      That is why `capabilities()` reports ATTESTED_OFFCHAIN with a ring size
///      of one. PrivatePool + AttestedRingVerifier carries eight commitments in
///      its calldata and verifies every one is a real deposit, so an observer
///      can see the anonymity set. Here an observer sees a nullifier and a
///      recipient. Both designs trust an attester for soundness; only one of
///      them lets the chain corroborate the privacy claim.
///
///      An interface MUST read capabilities() rather than assume, and must
///      present this pool's privacy as trust in a named attester rather than
///      as a number. Rendering eight-member anonymity copy over this pool is
///      lying about what a user is getting.
contract CREAuthorizedPool {
    IERC20Cre public immutable token; ICREPolicyGate public immutable gate;
    uint256 public immutable denomination; uint16 public immutable feeBps; address public immutable feeCollector;
    mapping(bytes32 => bool) public commitments; mapping(bytes32 => bool) public nullifiers;
    error Invalid(); error Known(); error Spent(); error TransferFailed();
    event Deposited(bytes32 indexed commitment); event Settled(bytes32 indexed nullifier, address indexed recipient, uint256 gross, uint256 fee);

    constructor(IERC20Cre token_, ICREPolicyGate gate_, uint256 denomination_, uint16 feeBps_, address feeCollector_) {
        if (address(token_) == address(0) || address(gate_) == address(0) || denomination_ == 0 || feeBps_ > 10_000 || feeCollector_ == address(0)) revert Invalid();
        token = token_; gate = gate_; denomination = denomination_; feeBps = feeBps_; feeCollector = feeCollector_;
    }
    /// @notice Read, never assumed. See the note above on what is NOT checked.
    function capabilities() external view returns (IPrivatePool.Capabilities memory) {
        return IPrivatePool.Capabilities({
            proofMode: ISpendVerifier.ProofMode.ATTESTED_OFFCHAIN,
            // One. Not eight: the chain distinguishes exactly one consumed
            // nullifier and hides nothing about it.
            ringSize: 1,
            verifierId: verifierId(),
            denomination: denomination,
            // Nothing in the calldata is worth front-running — the
            // authorization binds its own recipient and is one-shot.
            requiresCommitReveal: false
        });
    }

    /// @dev Commits to the GATE, so two pools trusting different attesters can
    ///      never be confused for one another by anything reading capabilities.
    function verifierId() public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes("opaque/v1/spend-verifier")),
                Canonical.field(bytes("cre-attested-offchain")),
                abi.encodePacked(uint32(20), address(gate)),
                Canonical.field(Canonical.decimal(denomination))
            )
        );
    }

    function deposit(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert Invalid(); if (commitments[commitment]) revert Known();
        commitments[commitment] = true;
        if (!token.transferFrom(msg.sender, address(this), denomination)) revert TransferFailed();
        emit Deposited(commitment);
    }
    function settle(bytes32 authorizationId) external {
        ICREPolicyGate.Authorization memory a = gate.consume(authorizationId);
        uint256 expectedFee = (denomination * feeBps + 9_999) / 10_000;
        if (a.grossAmount != denomination || a.feeBps != feeBps || a.feeCollector != feeCollector || a.feeAmount != expectedFee) revert Invalid();
        if (nullifiers[a.nullifier]) revert Spent();
        nullifiers[a.nullifier] = true;
        emit Settled(a.nullifier, a.recipient, denomination, expectedFee);
        if (!token.transfer(a.recipient, denomination - expectedFee)) revert TransferFailed();
        if (!token.transfer(feeCollector, expectedFee)) revert TransferFailed();
    }
}
