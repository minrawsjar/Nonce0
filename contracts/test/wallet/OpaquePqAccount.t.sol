// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IAccountExecute} from "@account-abstraction/contracts/interfaces/IAccountExecute.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {OpaquePqAccount} from "../../src/opaque/wallet/account/OpaquePqAccount.sol";
import {OpaquePqAccountFactory} from "../../src/opaque/wallet/account/OpaquePqAccountFactory.sol";
import {AccountBoundPQKeyRegistry} from "../../src/opaque/wallet/account/AccountBoundPQKeyRegistry.sol";

contract TestRecipient {
    uint256 public received;
    function accept() external payable { received += msg.value; }
    function fail() external pure { revert("target failure"); }
}
/// Test-only sponsor; not a deployable production sponsorship policy.
contract TestSponsor is IPaymaster {
    address immutable ep;
    constructor(address entry) { ep = entry; }
    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256) external view returns (bytes memory, uint256) {
        require(msg.sender == ep); return ("", 0);
    }
    function postOp(PostOpMode, bytes calldata, uint256, uint256) external view { require(msg.sender == ep); }
}
contract OpaquePqAccountTest is Test {
    EntryPoint ep;
    AccountBoundPQKeyRegistry reg;
    OpaquePqAccountFactory factory;
    OpaquePqAccount account;
    TestRecipient recipient;
    bytes32 a; bytes32 b; bytes32 c;
    function ffi(string memory arg, uint256 seed) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node"; cmd[1] = "../packages/pq-wallet/scripts/sign-account-fixture.ts";
        cmd[2] = arg; cmd[3] = vm.toString(seed); cmd[4] = "public-test-fixture";
        return vm.ffi(cmd);
    }
    function setUp() public {
        if (!vm.envOr("PQ_ACCOUNT_TESTS", false)) vm.skip(true);
        vm.chainId(31337); vm.warp(1000);
        ep = new EntryPoint(); reg = new AccountBoundPQKeyRegistry(); factory = new OpaquePqAccountFactory(ep, reg);
        a = abi.decode(ffi("commitment", 1), (bytes32));
        b = abi.decode(ffi("commitment", 2), (bytes32));
        c = abi.decode(ffi("commitment", 3), (bytes32));
        account = factory.createAccount(a, b, 5000, bytes32(0));
        recipient = new TestRecipient();
        vm.deal(address(account), 10 ether);
    }
    function unsigned(uint8 kind, bytes memory data) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account); op.nonce = ep.getNonce(address(account), 0);
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(kind, data));
        op.accountGasLimits = bytes32((uint256(480000) << 128) | 500000);
        op.preVerificationGas = 180000; op.gasFees = bytes32((uint256(1) << 128) | 1);
    }
    function signed(PackedUserOperation memory op, uint256 seed, uint48 afterTime, uint48 untilTime) internal returns (PackedUserOperation memory) {
        uint256 epoch = reg.keyEpoch(address(account));
        uint64 useCount = seed == 2 && reg.stateOf(address(account)).pkCommitment == a ? 0 : reg.stateOf(address(account)).useCount;
        bytes32 d = reg.digest(address(account), AccountBoundPQKeyRegistry.Authorization(ep.getUserOpHash(op), address(ep), epoch, afterTime, untilTime), useCount);
        op.signature = abi.encodePacked(epoch, afterTime, untilTime, ffi(vm.toString(d), seed));
        return op;
    }
    function submit(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1); ops[0] = op;
        ep.handleOps(ops, payable(address(0xFEE)));
    }
    function transferData(bool failing) internal view returns (bytes memory) {
        OpaquePqAccount.Call[] memory calls = new OpaquePqAccount.Call[](1);
        calls[0] = OpaquePqAccount.Call(address(recipient), 1 ether, failing ? abi.encodeCall(recipient.fail, ()) : abi.encodeCall(recipient.accept, ()));
        return abi.encode(calls);
    }
    function test_realEntryPointTransfersWithPqSignature() public {
        submit(signed(unsigned(1, transferData(false)), 1, 0, 2000));
        assertEq(recipient.received(), 1 ether); assertEq(reg.stateOf(address(account)).useCount, 1);
    }
    function test_dummyActivationSignatureCannotExecuteDuringEstimation() public {
        PackedUserOperation memory op = unsigned(0, "");
        bytes memory dummy = new bytes(9251);
        for (uint256 i; i < dummy.length; ++i) dummy[i] = 0x01;
        dummy[0] = 0x00; dummy[1] = 0x20; dummy[2] = 0x08;
        op.signature = abi.encodePacked(uint256(0), uint48(0), uint48(2000), dummy);
        bytes32 hash = ep.getUserOpHash(op);
        vm.prank(address(ep));
        uint256 validationData = account.validateUserOp(op, hash, 0);
        assertEq(uint160(validationData), 1, "dummy signature must fail validation");
        vm.expectRevert(OpaquePqAccount.BadOperation.selector);
        vm.prank(address(ep));
        account.executeUserOp(op, hash);
        assertEq(reg.stateOf(address(account)).useCount, 0);
    }
    function test_estimatorChangingFeesInvalidatesRealActivationSignature() public {
        PackedUserOperation memory op = signed(unsigned(0, ""), 1, 0, 2000);
        // Hosted estimators can normalize fees and gas before simulation.
        // Even a genuine signature no longer authorizes that changed operation.
        op.gasFees = bytes32((uint256(2) << 128) | 2);
        bytes32 changedHash = ep.getUserOpHash(op);
        vm.prank(address(ep));
        uint256 validationData = account.validateUserOp(op, changedHash, 0);
        assertEq(uint160(validationData), 1);
        vm.expectRevert(OpaquePqAccount.BadOperation.selector);
        vm.prank(address(ep));
        account.executeUserOp(op, changedHash);
        assertEq(reg.stateOf(address(account)).useCount, 0);
    }
    function test_sponsoredCounterfactualActivationWithoutEoaWallet() public {
        bytes32 salt = bytes32(uint256(9));
        address predicted = factory.getAddress(a, b, 5000, salt);
        account = OpaquePqAccount(payable(predicted));
        TestSponsor sponsor = new TestSponsor(address(ep));
        vm.deal(address(this), 1 ether); ep.depositTo{value: 1 ether}(address(sponsor));
        PackedUserOperation memory op = unsigned(0, "");
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (a, b, 5000, salt)));
        op.accountGasLimits = bytes32((uint256(500000) << 128) | 500000);
        op.paymasterAndData = abi.encodePacked(address(sponsor), uint128(100000), uint128(100000));
        submit(signed(op, 1, 0, 2000));
        assertGt(predicted.code.length, 0); assertEq(reg.stateOf(predicted).pkCommitment, a);
        assertEq(reg.stateOf(predicted).useCount, 1); assertEq(predicted.balance, 0);
    }
    function test_replayRejects() public {
        PackedUserOperation memory op = signed(unsigned(1, transferData(false)), 1, 0, 2000);
        submit(op); vm.expectRevert(); submit(op); assertEq(recipient.received(), 1 ether);
    }
    function test_changedCallAndWrongKeyReject() public {
        PackedUserOperation memory op = signed(unsigned(1, transferData(false)), 1, 0, 2000);
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(uint8(0), bytes("")));
        vm.expectRevert(); submit(op);
        op = signed(unsigned(1, transferData(false)), 3, 0, 2000); vm.expectRevert(); submit(op);
        assertEq(reg.stateOf(address(account)).useCount, 0);
    }
    function test_directValidationAndExecutionReject() public {
        PackedUserOperation memory op = unsigned(1, transferData(false));
        vm.expectRevert(OpaquePqAccount.Unauthorized.selector); account.validateUserOp(op, bytes32(0), 0);
        vm.expectRevert(OpaquePqAccount.Unauthorized.selector); account.executeUserOp(op, bytes32(0));
    }
    function test_expiryRejectsWithoutBurningOnchainCount() public {
        PackedUserOperation memory op = signed(unsigned(1, transferData(false)), 1, 0, 999);
        vm.expectRevert(); submit(op); assertEq(reg.stateOf(address(account)).useCount, 0);
    }
    function test_failedExecutionBurnsAcceptedUseAndEntryPointNonce() public {
        submit(signed(unsigned(1, transferData(true)), 1, 0, 2000));
        assertEq(reg.stateOf(address(account)).useCount, 1); assertEq(ep.getNonce(address(account), 0), 1);
        assertEq(recipient.received(), 0);
    }
    function test_rotationRetiresOldKeyAndMaintainsAddress() public {
        submit(signed(unsigned(2, abi.encode(c, uint64(6000))), 1, 0, 2000));
        assertEq(reg.stateOf(address(account)).pkCommitment, b); assertEq(reg.keyEpoch(address(account)), 1);
        PackedUserOperation memory bad = signed(unsigned(1, transferData(false)), 1, 0, 2000);
        vm.expectRevert(); submit(bad);
        submit(signed(unsigned(1, transferData(false)), 2, 0, 2000)); assertEq(recipient.received(), 1 ether);
    }
    function test_disableAndNextKeyTakeover() public {
        submit(signed(unsigned(3, ""), 1, 0, 2000));
        uint64 deadline = uint64(block.timestamp) + 30 days;
        assertEq(reg.stateOf(address(account)).disableAfter, deadline);
        PackedUserOperation memory op = signed(unsigned(4, abi.encode(c, uint64(6000000))), 2, 0, uint48(deadline + 100));
        vm.expectRevert(); submit(op);
        vm.warp(deadline); submit(op);
        assertEq(reg.stateOf(address(account)).pkCommitment, b); assertEq(reg.stateOf(address(account)).useCount, 1);
        assertEq(reg.stateOf(address(account)).disableAfter, 0);
    }
    function test_copyingFactoryDataCannotChangeAuthority() public {
        assertEq(address(factory.createAccount(a, b, 5000, bytes32(0))), address(account));
        assertTrue(factory.getAddress(c, b, 5000, bytes32(0)) != address(account));
    }
    function test_signatureCannotBeConsumedByAnotherAccount() public {
        PackedUserOperation memory op = signed(unsigned(1, transferData(false)), 1, 0, 2000);
        bytes memory sig = ffi(vm.toString(reg.digest(address(account), AccountBoundPQKeyRegistry.Authorization(ep.getUserOpHash(op), address(ep), 0, 0, 2000), 0)), 1);
        AccountBoundPQKeyRegistry.Authorization memory auth = AccountBoundPQKeyRegistry.Authorization(ep.getUserOpHash(op), address(ep), 0, 0, 2000);
        bytes memory data = transferData(false);
        vm.expectRevert(); reg.authorize(auth, 1, data, sig);
        assertEq(reg.stateOf(address(account)).useCount, 0); submit(op);
    }
    function test_cannotReinitializeOrCallRegistryThroughBatch() public {
        vm.expectRevert(); account.initialize(c, b, 5000);
        OpaquePqAccount.Call[] memory calls = new OpaquePqAccount.Call[](1);
        calls[0] = OpaquePqAccount.Call(address(reg), 0, abi.encodeCall(reg.finishDisable, ()));
        PackedUserOperation memory op = signed(unsigned(1, abi.encode(calls)), 1, 0, 2000);
        vm.expectRevert(); submit(op);
        assertEq(reg.stateOf(address(account)).disableAfter, 0);
    }
    function test_ordinaryBudgetPreservesRotationAndRetiredKeysCannotReturn() public {
        for (uint256 i; i < 6; ++i) submit(signed(unsigned(1, transferData(false)), 1, 0, 2000));
        PackedUserOperation memory exhausted = signed(unsigned(1, transferData(false)), 1, 0, 2000);
        vm.expectRevert(); submit(exhausted);
        submit(signed(unsigned(2, abi.encode(c, uint64(6000))), 1, 0, 2000));
        PackedUserOperation memory recycled = signed(unsigned(2, abi.encode(a, uint64(7000))), 2, 0, 2000);
        vm.expectRevert(); submit(recycled);
        assertEq(reg.stateOf(address(account)).pkCommitment, b);
    }
    function test_feeMutationAndUnauthorizedEntryPointExecutionReject() public {
        PackedUserOperation memory op = signed(unsigned(1, transferData(false)), 1, 0, 2000);
        op.gasFees = bytes32((uint256(1) << 128) | 2);
        vm.expectRevert(); submit(op);
        bytes32 hash = ep.getUserOpHash(op);
        vm.prank(address(ep)); vm.expectRevert(); account.executeUserOp(op, hash);
    }
    function test_disableBoundaryRejectsCurrentKey() public {
        submit(signed(unsigned(3, ""), 1, 0, 2000));
        uint64 disabledAt = reg.stateOf(address(account)).disableAfter;
        PackedUserOperation memory op = signed(unsigned(1, transferData(false)), 1, 0, uint48(disabledAt + 100));
        vm.warp(disabledAt); vm.expectRevert(); submit(op);
    }
    function testFuzz_factoryAddressBindsCommitments(bytes32 other) public view {
        vm.assume(other != a);
        assertTrue(factory.getAddress(other, b, 5000, bytes32(0)) != address(account));
    }

}
