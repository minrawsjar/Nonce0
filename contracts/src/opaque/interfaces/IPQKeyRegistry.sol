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

    function stateOf(address account) external view returns (PQKeyState memory);

    /// @dev schemeId is a STRING, not a uint32: it carries the FORS parameters
    ///      ("FORS+C/keccak256/k=32,a=8") so a signature can never be
    ///      reinterpreted under a weaker (k, a). An opaque numeric id would let
    ///      that downgrade through.
    function digest(address account, string memory schemeId, uint64 useCount, bytes memory payload)
        external
        view
        returns (bytes32);

    function consume(address account, bytes calldata payload, bytes calldata signature) external;
}
