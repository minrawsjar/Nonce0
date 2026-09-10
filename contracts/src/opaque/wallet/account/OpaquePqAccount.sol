// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {IAccountExecute} from "@account-abstraction/contracts/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {AccountBoundPQKeyRegistry} from "./AccountBoundPQKeyRegistry.sol";

/// Immutable ERC-4337 v0.7 account. No owner, upgrades, delegatecall or fallback authority.
contract OpaquePqAccount is IAccount, IAccountExecute {
    struct Call { address target; uint256 value; bytes data; }
    IEntryPoint public immutable entryPoint;
    AccountBoundPQKeyRegistry public immutable registry;
    address public immutable factory;
    // Value is resulting key epoch + 1; hash binds the full operation, not just calldata.
    mapping(bytes32 => uint256) private authorized;
    error Unauthorized();
    error BadOperation();
    error CallFailed(uint256 index, bytes reason);
    event Executed(bytes32 indexed userOpHash);

    constructor(IEntryPoint ep, AccountBoundPQKeyRegistry reg) {
        if (address(ep).code.length == 0 || address(reg).code.length == 0) revert BadOperation();
        entryPoint = ep; registry = reg; factory = msg.sender;
    }
    function initialize(bytes32 active, bytes32 next, uint64 deadline) external {
        if (msg.sender != factory) revert Unauthorized();
        registry.register(active, next, deadline);
    }
    receive() external payable {}

    /// callData begins with executeUserOp.selector followed by abi.encode(kind, actionData).
    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash, uint256 missingFunds)
        external returns (uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert Unauthorized();
        if (op.sender != address(this) || opHash != entryPoint.getUserOpHash(op) || op.nonce >> 64 != 0 ||
            op.callData.length < 4 || bytes4(op.callData[:4]) != IAccountExecute.executeUserOp.selector) revert BadOperation();
        (uint8 kind, bytes memory action) = abi.decode(op.callData[4:], (uint8, bytes));
        if (keccak256(op.callData[4:]) != keccak256(abi.encode(kind, action))) revert BadOperation();
        if (kind == 1) _checkCalls(action);
        // Fixed-width envelope avoids ABI copies of the large FORS signature.
        if (op.signature.length != 44 + 9251) revert BadOperation();
        uint256 epoch = uint256(bytes32(op.signature[0:32]));
        uint48 validAfter = uint48(bytes6(op.signature[32:38]));
        uint48 validUntil = uint48(bytes6(op.signature[38:44]));
        uint256 nextEpoch;
        (validationData, nextEpoch) = registry.authorize(
            AccountBoundPQKeyRegistry.Authorization(opHash, address(entryPoint), epoch, validAfter, validUntil),
            kind, action, op.signature[44:]
        );
        if (uint160(validationData) == 0) authorized[opHash] = nextEpoch + 1;
        if (missingFunds != 0) {
            (bool funded,) = payable(msg.sender).call{value: missingFunds}("");
            // EntryPoint checks the resulting deposit and rejects insufficient funding.
            funded;
        }
    }

    function executeUserOp(PackedUserOperation calldata op, bytes32 opHash) external {
        if (msg.sender != address(entryPoint)) revert Unauthorized();
        if (op.sender != address(this) || opHash != entryPoint.getUserOpHash(op) ||
            authorized[opHash] != registry.keyEpoch(address(this)) + 1) revert BadOperation();
        delete authorized[opHash];
        (uint8 kind, bytes memory action) = abi.decode(op.callData[4:], (uint8, bytes));
        if (kind == 1) {
            Call[] memory calls = _checkCalls(action);
            for (uint256 i; i < calls.length; ++i) {
                (bool ok, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
                if (!ok) revert CallFailed(i, result);
            }
        }
        if (kind == 3) registry.finishDisable();
        emit Executed(opHash);
    }
    function _checkCalls(bytes memory encoded) private view returns (Call[] memory calls) {
        calls = abi.decode(encoded, (Call[]));
        if (calls.length == 0 || calls.length > 8 || keccak256(encoded) != keccak256(abi.encode(calls))) revert BadOperation();
        for (uint256 i; i < calls.length; ++i) {
            address target = calls[i].target;
            if (target == address(0) || target == address(this) || target == address(registry) || target == address(entryPoint)) revert BadOperation();
        }
    }
}
