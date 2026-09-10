// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployments} from "../script/Deployments.sol";

/// The deploy scripts read existing addresses from deployments/arc-testnet.json.
/// This pins what they get, so a script can never broadcast against an address
/// it silently failed to parse.
contract DeploymentsHarness is Deployments {
    function usdc() external view returns (address) { return _usdc(); }
    function contractAddress(string memory n) external view returns (address) { return _contract(n); }
    function chainId() external view returns (uint256) { return _chainId(); }
}

contract DeploymentsTest is Test {
    DeploymentsHarness internal d;

    function setUp() public {
        d = new DeploymentsHarness();
    }

    function test_readsTheDeployedAddresses() public view {
        assertEq(d.usdc(), 0x3600000000000000000000000000000000000000, "usdc");
        assertEq(d.contractAddress("pqKeyRegistry"), 0x7FC11e0f5d224439b2d710BB1c141913F454eF17, "registry");
        assertEq(d.chainId(), 5042002, "chain");
    }

    /// null means NOT DEPLOYED, and a script that needs it must stop — with a
    /// message that says which file to edit, not a bare JSON parse failure.
    ///
    /// The ERC-4337 account factory is the example because it does not exist
    /// yet — it has not even been written. (This used attestedRingVerifier until
    /// that was deployed, which is the point: null is a state, not a constant.)
    function test_anUndeployedContractIsRefusedByName() public {
        vm.expectRevert(bytes("pqAccountFactory is not deployed: set it in ../deployments/arc-testnet.json"));
        d.contractAddress("pqAccountFactory");
    }
}
