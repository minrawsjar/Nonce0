// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {RelayDirectory} from "../src/opaque/mesh/RelayDirectory.sol";
import {PQAccount} from "../src/opaque/wallet/PQAccount.sol";
import {PQAccountFactory} from "../src/opaque/wallet/PQAccountFactory.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";
import {PQValidator} from "../src/opaque/wallet/PQValidator.sol";
import {Deployments} from "./Deployments.sol";

/// Deploys the PQ wallet layer (§5) and the relay directory (§8.2):
/// PQKeyRegistry, PQValidator, the PQAccount implementation, PQAccountFactory
/// (staked in the EntryPoint), and RelayDirectory.
///
///   set -a; source .env; set +a
///   forge script script/DeployPQStack.s.sol --rpc-url arc_testnet --broadcast
///
/// Then record the addresses in deployments/arc-testnet.json and run
/// DeployRingPool.s.sol, which binds its verifier to THIS registry.
contract DeployPQStack is Deployments {
    /// ERC-4337 v0.7's EntryPoint — the same address on every chain, and the
    /// one deployments/arc-testnet.json lists (checked live there).
    address internal constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    /// Native USDC (18dp), Arc's gas token. Permanent: the factory has no owner
    /// who could ever unlock it.
    uint256 internal constant FACTORY_STAKE = 1 ether;
    uint32 internal constant UNSTAKE_DELAY = 1 days;

    function run() external {
        _assertChain();
        require(ENTRY_POINT_V07.code.length != 0, "no EntryPoint v0.7 on this chain");
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        PQKeyRegistry registry = new PQKeyRegistry();
        PQValidator validator = new PQValidator(IPQKeyRegistry(address(registry)));
        PQAccount implementation = new PQAccount(ENTRY_POINT_V07, validator);
        PQAccountFactory factory = new PQAccountFactory(implementation);
        factory.addStake{value: FACTORY_STAKE}(UNSTAKE_DELAY);
        RelayDirectory directory = new RelayDirectory();
        vm.stopBroadcast();

        require(address(implementation.registry()) == address(registry), "account bound to the wrong registry");
        require(factory.entryPoint() == ENTRY_POINT_V07, "factory bound to the wrong EntryPoint");

        console2.log("chainId            ", block.chainid);
        console2.log("block              ", block.number);
        console2.log("PQKeyRegistry      ", address(registry));
        console2.log("PQValidator        ", address(validator));
        console2.log("PQAccount (impl)   ", address(implementation));
        console2.log("PQAccountFactory   ", address(factory));
        console2.log("RelayDirectory     ", address(directory));
    }
}
