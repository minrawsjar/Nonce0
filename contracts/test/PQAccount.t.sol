// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";
import {PQValidator} from "../src/opaque/wallet/PQValidator.sol";
import {PQAccount} from "../src/opaque/wallet/PQAccount.sol";
import {PQAccountFactory} from "../src/opaque/wallet/PQAccountFactory.sol";
import {PackedUserOperation} from "../src/opaque/interfaces/IERC4337.sol";

contract Target {
    uint256 public calls;
    function hit() external payable { calls++; }
    function fail() external pure { revert("target said no"); }
}

/// Signatures come from backend/zk/account-vectors.ts — the client's own
/// payload, address and digest code — never from Solidity.
contract PQAccountTest is Test {
    PQKeyRegistry internal registry;
    PQValidator internal validator;
    PQAccount internal implementation;
    PQAccountFactory internal factory;

    address internal ENTRY_POINT;
    address internal ACCOUNT;
    bytes32 internal pkA;
    bytes32 internal pkB;
    uint64 internal maxUses;
    uint64 internal deadline;
    bytes32 internal opHash0;
    bytes32 internal opHash1;
    bytes internal sigOp0;
    bytes internal sigOp1;
    bytes internal sigWrongKey0;
    bytes internal payload0;

    function setUp() public {
        string memory j = vm.readFile("test/fixtures/account-vectors.json");
        vm.chainId(vm.parseJsonUint(j, ".chainId"));
        ENTRY_POINT = vm.parseJsonAddress(j, ".entryPoint");
        ACCOUNT = vm.parseJsonAddress(j, ".account");
        pkA = vm.parseJsonBytes32(j, ".pkA");
        pkB = vm.parseJsonBytes32(j, ".pkB");
        maxUses = uint64(vm.parseJsonUint(j, ".maxUses"));
        deadline = uint64(vm.parseJsonUint(j, ".deadline"));
        opHash0 = vm.parseJsonBytes32(j, ".userOpHash0");
        opHash1 = vm.parseJsonBytes32(j, ".userOpHash1");
        sigOp0 = vm.parseJsonBytes(j, ".sigOp0");
        sigOp1 = vm.parseJsonBytes(j, ".sigOp1");
        sigWrongKey0 = vm.parseJsonBytes(j, ".sigWrongKey0");
        payload0 = vm.parseJsonBytes(j, ".userOperationPayload0");

        address r = vm.parseJsonAddress(j, ".registry");
        address v = vm.parseJsonAddress(j, ".validator");
        address i = vm.parseJsonAddress(j, ".implementation");
        address f = vm.parseJsonAddress(j, ".factory");
        deployCodeTo("PQKeyRegistry.sol:PQKeyRegistry", r);
        deployCodeTo("PQValidator.sol:PQValidator", abi.encode(r), v);
        deployCodeTo("PQAccount.sol:PQAccount", abi.encode(ENTRY_POINT, v), i);
        deployCodeTo("PQAccountFactory.sol:PQAccountFactory", abi.encode(i), f);
        registry = PQKeyRegistry(r);
        validator = PQValidator(v);
        implementation = PQAccount(payable(i));
        factory = PQAccountFactory(f);
    }

    function _op(bytes memory signature) internal view returns (PackedUserOperation memory op) {
        op.sender = ACCOUNT;
        op.signature = signature;
    }

    function _created() internal returns (PQAccount) {
        return PQAccount(payable(factory.createAccount(pkA, pkB, maxUses, deadline)));
    }

    function test_theAddressIsTheKeysAndTheClientAgrees() public {
        assertEq(factory.getAddress(pkA, pkB, maxUses, deadline), ACCOUNT, "client-side prediction");
        PQAccount account = _created();
        assertEq(address(account), ACCOUNT);
        assertGt(ACCOUNT.code.length, 0);
        PQKeyRegistry.PQKeyState memory s = registry.stateOf(ACCOUNT);
        assertEq(s.pkCommitment, pkA, "registered to exactly that key");
        assertEq(s.nextCommitment, pkB);
        assertEq(s.maxUses, maxUses);
        // ERC-4337 replays initCode; a second call must return, not revert.
        assertEq(factory.createAccount(pkA, pkB, maxUses, deadline), ACCOUNT);
    }

    function test_thePayloadIsTheClients() public view {
        assertEq(validator.userOperationPayload(opHash0), payload0);
    }

    function test_aRealSignatureValidatesAndBurnsTheIndex() public {
        PQAccount account = _created();
        vm.prank(ENTRY_POINT);
        assertEq(account.validateUserOp(_op(sigOp0), opHash0, 0), 0);
        assertEq(registry.stateOf(ACCOUNT).useCount, 1);
        vm.prank(ENTRY_POINT);
        assertEq(account.validateUserOp(_op(sigOp1), opHash1, 0), 0);
        assertEq(registry.stateOf(ACCOUNT).useCount, 2);
    }

    /// Returned, not reverted: a bundler simulates with a placeholder signature.
    function test_aWrongKeyOrAReplayFailsValidationAndBurnsNothing() public {
        PQAccount account = _created();
        vm.prank(ENTRY_POINT);
        assertEq(account.validateUserOp(_op(sigWrongKey0), opHash0, 0), 1, "wrong key");
        vm.prank(ENTRY_POINT);
        assertEq(account.validateUserOp(_op(sigOp0), opHash1, 0), 1, "signature for another operation");
        assertEq(registry.stateOf(ACCOUNT).useCount, 0, "no index burned on failure");

        vm.prank(ENTRY_POINT);
        assertEq(account.validateUserOp(_op(sigOp0), opHash0, 0), 0);
        vm.prank(ENTRY_POINT);
        assertEq(account.validateUserOp(_op(sigOp0), opHash0, 0), 1, "a used signature never verifies again");
    }

    function test_onlyTheEntryPointCanDriveTheAccount() public {
        PQAccount account = _created();
        vm.expectRevert(PQAccount.NotEntryPoint.selector);
        account.validateUserOp(_op(sigOp0), opHash0, 0);
        vm.expectRevert(PQAccount.NotEntryPoint.selector);
        account.execute(address(1), 0, "");
        vm.expectRevert(PQAccount.NotEntryPoint.selector);
        account.executeBatch(new PQAccount.Call[](0));
    }

    function test_executesWhatTheEntryPointHandsIt() public {
        PQAccount account = _created();
        Target target = new Target();
        vm.deal(ACCOUNT, 1 ether);

        PQAccount.Call[] memory calls = new PQAccount.Call[](2);
        calls[0] = PQAccount.Call(address(target), 0, abi.encodeCall(Target.hit, ()));
        calls[1] = PQAccount.Call(address(target), 0.5 ether, abi.encodeCall(Target.hit, ()));
        vm.prank(ENTRY_POINT);
        account.executeBatch(calls);
        assertEq(target.calls(), 2);
        assertEq(address(target).balance, 0.5 ether);

        calls[1] = PQAccount.Call(address(target), 0, abi.encodeCall(Target.fail, ()));
        vm.prank(ENTRY_POINT);
        vm.expectPartialRevert(PQAccount.CallFailed.selector);
        account.executeBatch(calls);
    }

    function test_paysThePrefund() public {
        PQAccount account = _created();
        vm.deal(ACCOUNT, 1 ether);
        vm.prank(ENTRY_POINT);
        account.validateUserOp(_op(sigOp0), opHash0, 0.01 ether);
        assertEq(ENTRY_POINT.balance, 0.01 ether);
    }

    function test_neitherTheImplementationNorACloneCanBeReinitialized() public {
        vm.expectRevert(PQAccount.AlreadyInitialized.selector);
        implementation.initialize(pkB, pkA, 4, 1);
        PQAccount account = _created();
        vm.expectRevert(PQAccount.AlreadyInitialized.selector);
        account.initialize(pkB, pkA, 4, 1);
        assertEq(registry.stateOf(ACCOUNT).pkCommitment, pkA, "key untouched");
    }

    function test_theValidatorIsAFixedPQOnlyModule() public {
        _created();
        assertTrue(validator.isModuleType(1));
        assertFalse(validator.isModuleType(2));
        assertTrue(validator.isInitialized(ACCOUNT));
        vm.expectRevert(PQValidator.CannotUninstall.selector);
        validator.onUninstall("");
        // A few-time key has no reusable signature to offer.
        assertEq(validator.isValidSignatureWithSender(address(0), opHash0, sigOp0), bytes4(0xffffffff));
    }
}
