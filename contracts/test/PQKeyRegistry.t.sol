// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";

/// Signatures here are produced by packages/pq-wallet in TypeScript and never
/// by Solidity, so these tests exercise the real cross-language path a wallet
/// actually takes rather than a self-consistent loop.
contract PQKeyRegistryTest is Test {
    PQKeyRegistry internal reg;

    address internal constant ACCOUNT = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    bytes32 internal pkA;
    bytes32 internal pkB;
    bytes32 internal pkC;
    bytes internal userPayload;
    bytes internal sigConsume0;
    bytes internal sigConsume1;
    bytes internal sigRotate0;
    bytes internal sigDisable0;
    bytes internal sigTakeoverB;
    bytes internal sigWrongKeyB;
    uint64 internal nextMaxUses;
    uint64 internal nextDeadline;

    function setUp() public {
        vm.chainId(31337);
        reg = new PQKeyRegistry();
        string memory j = vm.readFile("test/fixtures/registry-vectors.json");
        pkA = vm.parseJsonBytes32(j, ".pkA");
        pkB = vm.parseJsonBytes32(j, ".pkB");
        pkC = vm.parseJsonBytes32(j, ".pkC");
        userPayload = vm.parseJsonBytes(j, ".userPayload");
        sigConsume0 = vm.parseJsonBytes(j, ".sigConsume0");
        sigConsume1 = vm.parseJsonBytes(j, ".sigConsume1");
        sigRotate0 = vm.parseJsonBytes(j, ".sigRotate0");
        sigDisable0 = vm.parseJsonBytes(j, ".sigDisable0");
        sigTakeoverB = vm.parseJsonBytes(j, ".sigTakeoverB");
        sigWrongKeyB = vm.parseJsonBytes(j, ".sigWrongKeyB");
        nextMaxUses = uint64(vm.parseJsonUint(j, ".nextMaxUses"));
        nextDeadline = uint64(vm.parseJsonUint(j, ".nextDeadline"));

        vm.prank(ACCOUNT);
        reg.register(pkA, pkB, 4, 1_000_000);
    }

    function test_registrationHappensOnce() public {
        vm.prank(ACCOUNT);
        vm.expectRevert(PQKeyRegistry.AlreadyRegistered.selector);
        reg.register(pkC, pkC, 4, 1);
    }

    /// The one that matters most. If any address other than the PQ key holder
    /// can move pkCommitment, a quantum adversary holding that fallback owns
    /// the wallet and every other line of this protocol is decoration.
    function test_noAddressCanChangeAKeyWithoutAPqSignature() public {
        address attacker = address(0xBEEF);
        vm.startPrank(attacker);
        // Registering under the attacker's own address cannot touch ACCOUNT.
        reg.register(pkC, pkC, 4, 1);
        assertEq(reg.stateOf(ACCOUNT).pkCommitment, pkA, "victim key untouched");

        // And there is no other entry point: every mutator demands a signature
        // that recovers to the account's own commitment.
        vm.expectRevert();
        reg.rotate(ACCOUNT, pkC, 4, 1, sigWrongKeyB);
        vm.stopPrank();
        assertEq(reg.stateOf(ACCOUNT).pkCommitment, pkA, "still untouched");
    }

    function test_consumesARealSignatureAndBurnsTheIndex() public {
        reg.consume(ACCOUNT, userPayload, sigConsume0);
        assertEq(reg.stateOf(ACCOUNT).useCount, 1);
        reg.consume(ACCOUNT, userPayload, sigConsume1);
        assertEq(reg.stateOf(ACCOUNT).useCount, 2);
    }

    /// The digest binds useCount, so a used signature can never verify again.
    function test_aUsedSignatureNeverVerifiesAgain() public {
        reg.consume(ACCOUNT, userPayload, sigConsume0);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        reg.consume(ACCOUNT, userPayload, sigConsume0);
    }

    function test_rejectsASignatureFromAnotherKey() public {
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        reg.consume(ACCOUNT, userPayload, sigWrongKeyB);
    }

    /// FORS is FEW-time: forgery resistance decays per signature, so the cap is
    /// a security parameter and the registry must refuse rather than continue.
    function test_refusesPastMaxUses() public {
        // A fresh registry so ACCOUNT can be registered with a budget of one.
        // Signatures bind the account, not the registry, so they carry over.
        PQKeyRegistry tight = new PQKeyRegistry();
        vm.prank(ACCOUNT);
        tight.register(pkA, pkB, 1, 1_000_000);

        tight.consume(ACCOUNT, userPayload, sigConsume0);
        assertEq(tight.stateOf(ACCOUNT).useCount, 1);

        vm.expectRevert(PQKeyRegistry.KeyExhausted.selector);
        tight.consume(ACCOUNT, userPayload, sigConsume1);
    }

    function test_rotationPromotesThePreCommittedKeyAndResetsTheIndex() public {
        reg.rotate(ACCOUNT, pkC, nextMaxUses, nextDeadline, sigRotate0);
        PQKeyRegistry.PQKeyState memory s = reg.stateOf(ACCOUNT);
        assertEq(s.pkCommitment, pkB, "next key promoted");
        assertEq(s.nextCommitment, pkC, "new next pre-committed");
        assertEq(s.useCount, 0, "index resets for a new key");
        assertEq(s.maxUses, nextMaxUses);
    }

    /// A rotation signature is domain-separated from a user action, so an
    /// authorisation to transfer can never be replayed as a key rotation.
    function test_aUserActionSignatureCannotRotate() public {
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        reg.rotate(ACCOUNT, pkC, nextMaxUses, nextDeadline, sigConsume0);
    }

    function test_disableIsTimelockedAndThenPermanent() public {
        reg.initiateDisable(ACCOUNT, sigDisable0);
        uint64 at = reg.stateOf(ACCOUNT).disableAfter;
        assertEq(at, uint64(block.timestamp) + reg.DISABLE_TIMELOCK());

        // Before the timelock elapses the key still works.
        reg.consume(ACCOUNT, userPayload, sigConsume1);

        vm.warp(at + 1);
        vm.expectRevert(PQKeyRegistry.KeyDisabled.selector);
        reg.consume(ACCOUNT, userPayload, sigConsume1);
    }

    function test_takeoverNeedsTheNextKeyAndAnElapsedTimelock() public {
        reg.initiateDisable(ACCOUNT, sigDisable0);
        uint64 at = reg.stateOf(ACCOUNT).disableAfter;

        vm.expectRevert(PQKeyRegistry.DisableNotElapsed.selector);
        reg.takeoverAfterDisable(ACCOUNT, pkC, nextMaxUses, sigTakeoverB);

        vm.warp(at + 1);
        reg.takeoverAfterDisable(ACCOUNT, pkC, nextMaxUses, sigTakeoverB);
        PQKeyRegistry.PQKeyState memory s = reg.stateOf(ACCOUNT);
        assertEq(s.pkCommitment, pkB, "next key took over");
        assertEq(s.disableAfter, 0, "account is live again");
    }

    function test_takeoverRejectsAnyKeyButThePreCommittedNext() public {
        reg.initiateDisable(ACCOUNT, sigDisable0);
        vm.warp(reg.stateOf(ACCOUNT).disableAfter + 1);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        reg.takeoverAfterDisable(ACCOUNT, pkC, nextMaxUses, sigRotate0);
    }

    function test_unregisteredAccountsHaveNoState() public {
        vm.expectRevert(PQKeyRegistry.NotRegistered.selector);
        reg.consume(address(0x1234), userPayload, sigConsume0);
    }

    function test_registrationRejectsAZeroBudget() public {
        vm.prank(address(0xFEED));
        vm.expectRevert(PQKeyRegistry.InvalidParameters.selector);
        reg.register(pkA, pkB, 0, 1);
    }
}
