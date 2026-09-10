// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {CREPolicyGate} from "../src/opaque/cre/CREPolicyGate.sol";
import {CREAuthorizedPool, IERC20Cre} from "../src/opaque/pool/CREAuthorizedPool.sol";
import {CREBatchSettlement} from "../src/opaque/pool/CREBatchSettlement.sol";

/// @notice Arc deployment: one pool per public denomination, one CRE attester
///         and one fee policy.
/// @dev CRE_ATTESTER is an account REGISTERED IN PQKeyRegistry, not a hot
///      ECDSA signer. It is the post-quantum key that signs authorizations;
///      it never needs gas, because anyone may relay a signed batch. Register
///      it (and fund its rotation schedule) before pools go live, or every
///      publish reverts with NotRegistered.
contract DeployCrePools is Script {
    function run() external {
        address token = vm.envAddress("ARC_USDC"); address registry = vm.envAddress("PQ_KEY_REGISTRY"); address attester = vm.envAddress("CRE_ATTESTER"); address collector = vm.envAddress("FEE_COLLECTOR"); uint16 feeBps = uint16(vm.envUint("FEE_BPS"));
        vm.startBroadcast();
        CREPolicyGate gate = new CREPolicyGate(IPQKeyRegistry(registry), attester);
        new CREBatchSettlement();
        uint256[7] memory denoms = [uint256(1e6), 2e6, 5e6, 10e6, 20e6, 50e6, 100e6];
        for (uint256 i; i < denoms.length; ++i) new CREAuthorizedPool(IERC20Cre(token), gate, denoms[i], feeBps, collector);
        vm.stopBroadcast();
    }
}
