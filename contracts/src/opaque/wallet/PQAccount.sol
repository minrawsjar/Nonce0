// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPQKeyRegistry} from "../interfaces/IPQKeyRegistry.sol";
import {PackedUserOperation} from "../interfaces/IERC4337.sol";
import {PQValidator} from "./PQValidator.sol";

/// @title PQAccount (§5) — an ERC-4337 v0.7 account whose only signer is a
///        FORS+C key in PQKeyRegistry.
/// @notice Deployed as EIP-1167 clones of one implementation by
///         PQAccountFactory. What it may do is what the EntryPoint executes
///         after PQValidator accepts a FORS+C signature over the whole
///         operation: deposits into a pool (approve + deposit), transfers,
///         anything — and nothing reaches execute() any other way.
///
///         No owner, no ECDSA key, no upgrade, no module management. The
///         validator is fixed at construction; the key rotates in the registry,
///         authenticated by the key itself (§5.2).
contract PQAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable entryPoint;
    PQValidator public immutable validator;
    IPQKeyRegistry public immutable registry;

    bool private _initialized;

    error NotEntryPoint();
    error AlreadyInitialized();
    error CallFailed(uint256 index, bytes reason);

    constructor(address entryPoint_, PQValidator validator_) {
        entryPoint = entryPoint_;
        validator = validator_;
        registry = validator_.registry();
        // The implementation itself can never be initialized, so it can never
        // hold a key or be driven through the EntryPoint as an account.
        _initialized = true;
    }

    /// @notice Called once, by the factory, in the transaction that creates the
    ///         clone. register() binds msg.sender — this clone — to the key.
    function initialize(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)
        external
    {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        registry.register(pkCommitment, nextCommitment, maxUses, rotationDeadline);
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    /// @notice ERC-4337 v0.7. Pays the prefund whatever the verdict: a failed
    ///         signature returns SIG_VALIDATION_FAILED and the EntryPoint then
    ///         rejects the operation, so nothing here executes on a bad one.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        validationData = validator.validateUserOp(userOp, userOpHash);
        if (missingAccountFunds != 0) {
            // Ignored on failure, as the reference account does: the
            // EntryPoint verifies the deposit itself and rejects a shortfall.
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (paid);
        }
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyEntryPoint {
        _call(0, target, value, data);
    }

    /// One operation, one signature, several calls — approve then deposit is
    /// the case this exists for.
    function executeBatch(Call[] calldata calls) external onlyEntryPoint {
        for (uint256 i = 0; i < calls.length; i++) {
            _call(i, calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(uint256 index, address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory reason) = target.call{value: value}(data);
        if (!ok) revert CallFailed(index, reason);
    }

    /// Native USDC is Arc's gas token: the account pays its own operations
    /// from what it holds.
    receive() external payable {}
}
