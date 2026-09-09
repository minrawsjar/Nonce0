// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ICREPolicyGate {
    struct Authorization {
        bytes32 id;
        bytes32 spendHash;
        bytes32 nullifier;
        address pool;
        address recipient;
        address feeCollector;
        uint256 grossAmount;
        uint256 feeAmount;
        uint16 feeBps;
        uint64 expiresAt;
    }

    function consume(bytes32 id) external returns (Authorization memory authorization);
}
