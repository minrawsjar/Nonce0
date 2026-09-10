// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IEntryPointStake} from "../interfaces/IERC4337.sol";
import {PQAccount} from "./PQAccount.sol";

/// @title PQAccountFactory — counterfactual PQ accounts, as EIP-1167 clones.
/// @notice The address is a function of the key and nothing else a caller
///         picks: salt = keccak256(pkCommitment, nextCommitment, maxUses,
///         rotationDeadline). A wallet knows its address before it exists, can
///         be funded there, and its first UserOperation deploys it (initCode).
///
///         Anyone may call createAccount — it creates exactly the account those
///         parameters name, registered to exactly that key, so the caller only
///         pays for gas. No owner: the stake below can be added and never
///         withdrawn, which is the price of having no one who could.
contract PQAccountFactory {
    /// EIP-1167 minimal proxy, creation code around the 20-byte implementation.
    bytes internal constant CLONE_PREFIX = hex"3d602d80600a3d3981f3363d3d373d3d3d363d73";
    bytes internal constant CLONE_SUFFIX = hex"5af43d82803e903d91602b57fd5bf3";

    PQAccount public immutable implementation;
    address public immutable entryPoint;

    event AccountCreated(address indexed account, bytes32 indexed pkCommitment);

    error CreateFailed();

    constructor(PQAccount implementation_) {
        implementation = implementation_;
        entryPoint = implementation_.entryPoint();
    }

    function createAccount(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)
        external
        returns (address account)
    {
        bytes32 salt = accountSalt(pkCommitment, nextCommitment, maxUses, rotationDeadline);
        account = _predict(salt);
        // Idempotent, as ERC-4337 expects of a factory: an initCode replayed
        // after deployment must return the account, not revert.
        if (account.code.length != 0) return account;

        bytes memory code = _cloneCode();
        address created;
        assembly ("memory-safe") {
            created := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (created == address(0) || created != account) revert CreateFailed();
        PQAccount(payable(created)).initialize(pkCommitment, nextCommitment, maxUses, rotationDeadline);
        emit AccountCreated(created, pkCommitment);
    }

    function getAddress(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)
        external
        view
        returns (address)
    {
        return _predict(accountSalt(pkCommitment, nextCommitment, maxUses, rotationDeadline));
    }

    function accountSalt(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(pkCommitment, nextCommitment, maxUses, rotationDeadline));
    }

    /// @notice Stakes this factory in the EntryPoint. ERC-7562 lets a staked
    ///         factory's account touch its registry slots during the operation
    ///         that deploys it — register() in the factory step, consume() in
    ///         validation — so a first UserOperation can create the account and
    ///         act in one go. Permanent by design: there is no owner to unlock
    ///         or withdraw it.
    function addStake(uint32 unstakeDelaySec) external payable {
        IEntryPointStake(entryPoint).addStake{value: msg.value}(unstakeDelaySec);
    }

    function _cloneCode() private view returns (bytes memory) {
        return abi.encodePacked(CLONE_PREFIX, address(implementation), CLONE_SUFFIX);
    }

    function _predict(bytes32 salt) private view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(_cloneCode())))))
        );
    }
}
