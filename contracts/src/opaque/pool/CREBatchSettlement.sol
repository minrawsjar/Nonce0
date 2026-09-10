// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ICRESettlingPool { function settle(bytes32 authorizationId) external; }

/// @notice Executes independent fixed-bucket CRE settlements atomically.
contract CREBatchSettlement {
    error EmptyBatch(); error LengthMismatch();
    function settleAll(address[] calldata pools, bytes32[] calldata authorizationIds) external {
        if (pools.length == 0) revert EmptyBatch();
        if (pools.length != authorizationIds.length) revert LengthMismatch();
        for (uint256 i; i < pools.length; ++i) ICRESettlingPool(pools[i]).settle(authorizationIds[i]);
    }
}
