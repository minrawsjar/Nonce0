// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPrivatePool {
    function deposit(bytes32 commitment, uint256 denomination) external;
    function spend(bytes32[8] calldata ring, bytes calldata proof, bytes32 nullifier, address recipient, uint256 denomination) external;
    function isNullifierSpent(bytes32 nullifier) external view returns (bool);
}
