// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RelayDirectory} from "../src/opaque/mesh/RelayDirectory.sol";

contract RelayDirectoryTest is Test {
    RelayDirectory directory;
    address constant OPERATOR = address(0xA11CE);
    bytes32 constant R1 = bytes32("R1");
    bytes32 constant R2 = bytes32("R2");

    function setUp() public {
        directory = new RelayDirectory();
        vm.startPrank(OPERATOR);
        directory.announce(R1, "https://relay.example/r1/v1/relay", bytes32(uint256(1)), 100);
        directory.announce(R2, "https://relay.example/r2/v1/relay", bytes32(uint256(2)), 100);
        vm.stopPrank();
    }

    function _reports(uint16 reliability) internal pure returns (RelayDirectory.Report[] memory r) {
        r = new RelayDirectory.Report[](2);
        r[0] = RelayDirectory.Report(R1, reliability, 12, 3);
        r[1] = RelayDirectory.Report(R2, reliability, 7, 5);
    }

    function test_indexesOnlyAggregateRelayHealth() public {
        vm.prank(OPERATOR);
        directory.report(_reports(9_500));
        (address operator,,, uint64 epoch, uint16 reliability, uint16 occupancy, uint32 selections,) = directory.nodes(R1);
        assertEq(operator, OPERATOR);
        assertEq(epoch, 100);
        assertEq(reliability, 9_500);
        assertEq(occupancy, 12);
        assertEq(selections, 3);
        (,,,,,, uint32 r2Selections,) = directory.nodes(R2);
        assertEq(r2Selections, 5, "one transaction reported both");
    }

    function test_theIdIsTheDirectoryRelayId() public pure {
        assertEq(R1, bytes32(hex"5231"), "UTF-8, right-padded");
    }

    function test_onlyTheOperatorReportsOrReannounces() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(RelayDirectory.NotOperator.selector);
        directory.report(_reports(10_000));

        vm.prank(address(0xBAD));
        vm.expectRevert(RelayDirectory.NotOperator.selector);
        directory.announce(R1, "https://evil.example/v1/relay", bytes32(uint256(9)), 101);
    }

    function test_theKeyEpochOnlyMovesForward() public {
        vm.startPrank(OPERATOR);
        vm.expectRevert(RelayDirectory.StaleEpoch.selector);
        directory.announce(R1, "https://relay.example/r1/v1/relay", bytes32(uint256(7)), 100);
        vm.expectRevert(RelayDirectory.StaleEpoch.selector);
        directory.announce(R1, "https://relay.example/r1/v1/relay", bytes32(uint256(7)), 99);
        directory.announce(R1, "https://relay.example/r1/v1/relay", bytes32(uint256(7)), 101);
        vm.stopPrank();
        (,, bytes32 kem, uint64 epoch,,,,) = directory.nodes(R1);
        assertEq(kem, bytes32(uint256(7)));
        assertEq(epoch, 101);
    }

    function test_rejectsImpossibleHealth() public {
        vm.prank(OPERATOR);
        vm.expectRevert(RelayDirectory.Invalid.selector);
        directory.report(_reports(10_001));
    }
}
