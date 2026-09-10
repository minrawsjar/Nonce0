// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {CREPolicyGate} from "../src/opaque/cre/CREPolicyGate.sol";
import {CREAuthorizedPool, IERC20Cre} from "../src/opaque/pool/CREAuthorizedPool.sol";
import {CREBatchSettlement} from "../src/opaque/pool/CREBatchSettlement.sol";

/// @notice Arc deployment: one pool per public denomination, one CRE publisher and one fee policy.
contract DeployCrePools is Script {
    function run() external {
        address token = vm.envAddress("ARC_USDC"); address publisher = vm.envAddress("CRE_PUBLISHER"); address collector = vm.envAddress("FEE_COLLECTOR"); uint16 feeBps = uint16(vm.envUint("FEE_BPS"));
        vm.startBroadcast();
        CREPolicyGate gate = new CREPolicyGate(publisher);
        new CREBatchSettlement();
        uint256[7] memory denoms = [uint256(1e6), 2e6, 5e6, 10e6, 20e6, 50e6, 100e6];
        for (uint256 i; i < denoms.length; ++i) new CREAuthorizedPool(IERC20Cre(token), gate, denoms[i], feeBps, collector);
        vm.stopBroadcast();
    }
}
