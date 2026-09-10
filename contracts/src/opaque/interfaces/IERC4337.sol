// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The slice of ERC-4337 v0.7 and ERC-7579 this repo uses, declared
///         here rather than pulled from a library: four types, and the exact
///         selectors the canonical EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032
///         calls. Nothing else of those standards is assumed.

/// ERC-4337 v0.7's PackedUserOperation, field for field.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointStake {
    function addStake(uint32 unstakeDelaySec) external payable;
}

/// ERC-7579 validator module (module type 1).
interface IERC7579Validator {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256);
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4);
}
