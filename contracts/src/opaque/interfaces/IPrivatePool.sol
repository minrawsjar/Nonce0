// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISpendVerifier} from "./ISpendVerifier.sol";

interface IPrivatePool {
    /// Mirrors ProtocolCapabilities in the frozen §2 contract, so an interface
    /// reads what a deployment IS rather than assuming what it wishes it were.
    struct Capabilities {
        ISpendVerifier.ProofMode proofMode;
        uint8 ringSize;
        bytes32 verifierId;
        uint256 denomination;
        bool requiresCommitReveal;
    }

    function capabilities() external view returns (Capabilities memory);
    function deposit(bytes32 commitment) external;
    function commitSpend(bytes32 spendCommitment) external;
    function spend(
        bytes32[] calldata ring,
        bytes calldata proof,
        address recipient,
        bytes32 salt
    ) external;
    function isNullifierSpent(bytes32 nullifier) external view returns (bool);
    function isCommitmentKnown(bytes32 commitment) external view returns (bool);
}
