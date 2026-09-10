// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RelayDirectory} from "../src/opaque/mesh/RelayDirectory.sol";

contract RelayDirectoryTest is Test {
    RelayDirectory directory;
    address constant OPERATOR = address(0xA11CE);

    function setUp() public { directory = new RelayDirectory(); }

    function test_indexesOnlyAggregateRelayHealth() public {
        bytes32 node = keccak256("relay-1");
        vm.prank(OPERATOR);
        directory.announce(node, "https://relay.example", bytes32(uint256(1)), 1);
        vm.prank(OPERATOR);
        directory.report(node, 9_500, 12, 3);
        (address operator,,,uint64 epoch,uint16 reliability,uint16 occupancy,uint32 selections,) = directory.nodes(node);
        assertEq(operator, OPERATOR); assertEq(epoch, 1); assertEq(reliability, 9_500);
        assertEq(occupancy, 12); assertEq(selections, 3);
    }
}
