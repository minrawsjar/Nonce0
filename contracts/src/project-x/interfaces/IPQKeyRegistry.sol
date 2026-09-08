// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPQKeyRegistry {
    struct PQKeyState {
        bytes32 pkCommitment;
        bytes32 nextCommitment;
        uint64 useCount;
        uint64 maxUses;
        uint64 rotationDeadline;
        uint64 disableAfter;
    }

    function getState(address account) external view returns (PQKeyState memory);
    function digestFor(address account, bytes calldata payload, uint32 schemeId, uint64 useCount) external view returns (bytes32);
}
