// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {CREPolicyGate} from "../src/opaque/cre/CREPolicyGate.sol";
import {ICREPolicyGate} from "../src/opaque/cre/ICREPolicyGate.sol";
import {CREAuthorizedPool, IERC20Cre} from "../src/opaque/pool/CREAuthorizedPool.sol";

contract CREAuthorizedPoolTest is Test {
    MockUSDC token; CREPolicyGate gate; CREAuthorizedPool pool;
    address constant PUBLISHER = address(0xC0DE); address constant ALICE = address(0xA11CE); address constant BOB = address(0xB0B); address constant FEES = address(0xFEE);
    uint256 constant DENOM = 20_000_000;
    function setUp() public { token = new MockUSDC(); gate = new CREPolicyGate(PUBLISHER); pool = new CREAuthorizedPool(IERC20Cre(address(token)), gate, DENOM, 50, FEES); token.mint(ALICE, DENOM); vm.prank(ALICE); token.approve(address(pool), DENOM); vm.prank(ALICE); pool.deposit(bytes32(uint256(1))); }
    function auth(bytes32 id) internal view returns (ICREPolicyGate.Authorization memory) { return ICREPolicyGate.Authorization(id, bytes32(uint256(2)), bytes32(uint256(3)), address(pool), BOB, FEES, DENOM, 100_000, 50, uint64(block.timestamp + 1 days)); }
    function testOnlyPublisherCanReleaseExactAuthorizationOnce() public {
        ICREPolicyGate.Authorization memory a = auth(bytes32(uint256(9)));
        vm.expectRevert(CREPolicyGate.NotPublisher.selector); gate.publish(a);
        vm.prank(PUBLISHER); gate.publish(a);
        pool.settle(a.id);
        assertEq(token.balanceOf(BOB), DENOM - a.feeAmount); assertEq(token.balanceOf(FEES), a.feeAmount); assertTrue(pool.nullifiers(a.nullifier));
        vm.expectRevert(CREPolicyGate.AlreadyConsumed.selector); pool.settle(a.id);
    }
    function testFeeOrPoolMutationCannotSettle() public {
        ICREPolicyGate.Authorization memory a = auth(bytes32(uint256(10))); a.feeAmount = 1;
        vm.prank(PUBLISHER); gate.publish(a);
        vm.expectRevert(CREAuthorizedPool.Invalid.selector); pool.settle(a.id);
    }
}
