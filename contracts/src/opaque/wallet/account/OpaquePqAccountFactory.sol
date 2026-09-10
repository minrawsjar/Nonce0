// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {OpaquePqAccount} from "./OpaquePqAccount.sol";
import {AccountBoundPQKeyRegistry} from "./AccountBoundPQKeyRegistry.sol";

/// Immutable-target minimal proxies: no implementation setter or upgrade authority.
/// Permissionless v0.7 creation can only initialize the exact committed keys.
contract OpaquePqAccountFactory {
    IEntryPoint public immutable entryPoint;
    AccountBoundPQKeyRegistry public immutable registry;
    address public immutable implementation;
    constructor(IEntryPoint ep, AccountBoundPQKeyRegistry reg) {
        entryPoint = ep; registry = reg;
        implementation = address(new OpaquePqAccount(ep, reg));
    }
    function deploymentSalt(bytes32 active, bytes32 next, uint64 deadline, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(active, next, deadline, salt));
    }
    function getAddress(bytes32 active, bytes32 next, uint64 deadline, bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, deploymentSalt(active, next, deadline, salt));
    }
    function createAccount(bytes32 active, bytes32 next, uint64 deadline, bytes32 salt) external returns (OpaquePqAccount account) {
        address predicted = getAddress(active, next, deadline, salt);
        if (predicted.code.length != 0) return OpaquePqAccount(payable(predicted));
        account = OpaquePqAccount(payable(Clones.cloneDeterministic(implementation, deploymentSalt(active, next, deadline, salt))));
        account.initialize(active, next, deadline);
    }
}
