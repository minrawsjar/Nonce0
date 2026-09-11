// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {AccountBoundPQKeyRegistry} from "../src/opaque/wallet/account/AccountBoundPQKeyRegistry.sol";
import {OpaquePqAccountFactory} from "../src/opaque/wallet/account/OpaquePqAccountFactory.sol";

/// Deploy only after joint review and provider simulation. Signing configuration
/// is supplied through Foundry's external signer mechanism, not a stored user key.
contract DeployPqAccount is Script {
    function run() external returns (AccountBoundPQKeyRegistry registry, OpaquePqAccountFactory factory) {
        require(block.chainid == 5042002 || block.chainid == 31337, "wrong chain");
        address ep = vm.envAddress("PQ_ENTRYPOINT");
        require(ep.code.length > 0 && ep.codehash == vm.envBytes32("PQ_ENTRYPOINT_CODEHASH"), "unverified EntryPoint");
        vm.startBroadcast();
        registry = new AccountBoundPQKeyRegistry();
        factory = new OpaquePqAccountFactory(IEntryPoint(ep), registry);
        vm.stopBroadcast();
    }
}
