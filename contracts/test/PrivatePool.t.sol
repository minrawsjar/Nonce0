// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20, PrivatePool} from "../src/opaque/pool/PrivatePool.sol";
import {SingleNotePqVerifier} from "../src/opaque/pool/SingleNotePqVerifier.sol";
import {ISpendVerifier} from "../src/opaque/interfaces/ISpendVerifier.sol";
import {IPrivatePool} from "../src/opaque/interfaces/IPrivatePool.sol";

contract PrivatePoolTest is Test {
    MockUSDC internal usdc;
    PrivatePool internal pool;
    SingleNotePqVerifier internal verifier;

    uint256 internal constant DENOM = 1_000_000; // 1 USDC
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant MALLORY = address(0x4A1104);

    function setUp() public {
        usdc = new MockUSDC();
        // The verifier binds the pool id, and the pool derives its id from its
        // own address, so the deployment order is: predict, construct, deploy.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        bytes32 poolId = keccak256(
            abi.encodePacked(
                uint32(bytes("opaque/v1/pool-id").length),
                "opaque/v1/pool-id",
                uint32(bytes("31337").length),
                "31337",
                uint32(20),
                predicted
            )
        );
        verifier = new SingleNotePqVerifier(poolId, DENOM);
        pool = new PrivatePool(IERC20(address(usdc)), DENOM, verifier);
        assertEq(address(pool), predicted, "pool address prediction");
        assertEq(pool.poolId(), poolId, "pool id agreement");

        usdc.mint(ALICE, 10 * DENOM);
        vm.prank(ALICE);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _deposit(bytes32 secret) internal returns (bytes32 commitment) {
        commitment = verifier.noteCommitment(secret);
        vm.prank(ALICE);
        pool.deposit(commitment);
    }

    function _spend(bytes32 secret, address recipient, bytes32 salt) internal {
        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);

        pool.commitSpend(pool.spendCommitment(ring, proof, recipient, salt));
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());
        pool.spend(ring, proof, recipient, salt);
    }

    function test_capabilitiesReportTheTruth() public view {
        IPrivatePool.Capabilities memory c = pool.capabilities();
        assertEq(uint8(c.proofMode), uint8(ISpendVerifier.ProofMode.SINGLE_NOTE_PQ));
        assertEq(c.ringSize, 1, "no eight-member claim from a single-note pool");
        assertTrue(c.requiresCommitReveal);
        assertEq(c.denomination, DENOM);
    }

    function test_depositThenSpend() public {
        bytes32 secret = keccak256("note-1");
        _deposit(secret);
        assertEq(usdc.balanceOf(address(pool)), DENOM);

        _spend(secret, BOB, bytes32(uint256(7)));
        assertEq(usdc.balanceOf(BOB), DENOM, "recipient paid");
        assertEq(usdc.balanceOf(address(pool)), 0, "pool drained of that note");
        assertTrue(pool.isNullifierSpent(verifier.noteNullifier(secret)));
    }

    /// A one-note "ring" is the note itself: emitting it would name the
    /// deposit the spend opened. The depositor, though, is public by design.
    function test_aSingleNoteSpendNamesNoRingAndTheDepositNamesItsFunder() public {
        bytes32 secret = keccak256("note-events");
        vm.recordLogs();
        _deposit(secret);
        _spend(secret, BOB, bytes32(uint256(3)));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool funded;
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != keccak256("RingUsed(bytes32[])"), "a one-note ring was emitted");
            if (logs[i].topics[0] == keccak256("DepositFrom(bytes32,address)")) funded = true;
        }
        assertTrue(funded, "DepositFrom emitted");
    }

    function test_theSameNoteCannotBeSpentTwice() public {
        bytes32 secret = keccak256("note-2");
        _deposit(secret);
        _spend(secret, BOB, bytes32(uint256(1)));

        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);
        pool.commitSpend(pool.spendCommitment(ring, proof, BOB, bytes32(uint256(2))));
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());
        vm.expectRevert(PrivatePool.NullifierAlreadySpent.selector);
        pool.spend(ring, proof, BOB, bytes32(uint256(2)));
    }

    /// The nullifier binds the secret and the pool and NOT the recipient. If it
    /// bound the recipient, this second spend would succeed and one deposit
    /// would pay out once per recipient, without limit.
    function test_changingTheRecipientDoesNotMintANewNullifier() public {
        bytes32 secret = keccak256("note-3");
        _deposit(secret);
        _spend(secret, BOB, bytes32(uint256(1)));

        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);
        pool.commitSpend(pool.spendCommitment(ring, proof, MALLORY, bytes32(uint256(9))));
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());
        vm.expectRevert(PrivatePool.NullifierAlreadySpent.selector);
        pool.spend(ring, proof, MALLORY, bytes32(uint256(9)));
    }

    /// The whole reason the two-phase flow exists: this mode publishes the note
    /// secret in calldata, so a one-shot spend would be trivially front-run.
    function test_frontRunningTheRevealFails() public {
        bytes32 secret = keccak256("note-4");
        _deposit(secret);

        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);
        bytes32 salt = bytes32(uint256(42));

        pool.commitSpend(pool.spendCommitment(ring, proof, BOB, salt));
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());

        // Mallory has learned the secret from the mempool and redirects it.
        // She has no commitment of her own, so there is nothing to reveal.
        vm.prank(MALLORY);
        vm.expectRevert(PrivatePool.NotCommitted.selector);
        pool.spend(ring, proof, MALLORY, salt);

        // Committing now does not help: the honest reveal lands first, and by
        // the time her delay elapses the nullifier is already spent.
        vm.prank(MALLORY);
        pool.commitSpend(pool.spendCommitment(ring, proof, MALLORY, salt));
        pool.spend(ring, proof, BOB, salt);

        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());
        vm.prank(MALLORY);
        vm.expectRevert(PrivatePool.NullifierAlreadySpent.selector);
        pool.spend(ring, proof, MALLORY, salt);

        assertEq(usdc.balanceOf(BOB), DENOM);
        assertEq(usdc.balanceOf(MALLORY), 0);
    }

    function test_revealBeforeTheDelayIsRejected() public {
        bytes32 secret = keccak256("note-5");
        _deposit(secret);
        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);
        pool.commitSpend(pool.spendCommitment(ring, proof, BOB, bytes32(0)));
        vm.expectRevert(PrivatePool.CommitTooRecent.selector);
        pool.spend(ring, proof, BOB, bytes32(0));
    }

    function test_aSecretForNoDepositCannotSpend() public {
        bytes32 secret = keccak256("never-deposited");
        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);
        pool.commitSpend(pool.spendCommitment(ring, proof, BOB, bytes32(0)));
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());
        vm.expectRevert(PrivatePool.UnknownCommitment.selector);
        pool.spend(ring, proof, BOB, bytes32(0));
    }

    function test_aWrongSecretDoesNotOpenADeposit() public {
        _deposit(keccak256("note-6"));
        bytes32 wrong = keccak256("not-it");
        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(keccak256("note-6"));
        bytes memory proof = abi.encodePacked(wrong);
        pool.commitSpend(pool.spendCommitment(ring, proof, BOB, bytes32(0)));
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());
        vm.expectRevert(SingleNotePqVerifier.CommitmentMismatch.selector);
        pool.spend(ring, proof, BOB, bytes32(0));
    }

    function test_ringSizeIsEnforced() public {
        bytes32[] memory ring = new bytes32[](8);
        vm.expectRevert(PrivatePool.WrongRingSize.selector);
        pool.spend(ring, abi.encodePacked(bytes32(0)), BOB, bytes32(0));
    }

    function test_duplicateDepositIsRejected() public {
        bytes32 c = _deposit(keccak256("note-7"));
        vm.prank(ALICE);
        vm.expectRevert(PrivatePool.DuplicateCommitment.selector);
        pool.deposit(c);
    }

    function test_zeroRecipientRejected() public {
        bytes32[] memory ring = new bytes32[](1);
        vm.expectRevert(PrivatePool.ZeroRecipient.selector);
        pool.spend(ring, abi.encodePacked(bytes32(0)), address(0), bytes32(0));
    }

    function testFuzz_anyDepositedNoteSpendsExactlyOnce(bytes32 secret, address recipient) public {
        vm.assume(recipient != address(0) && recipient != address(pool));
        _deposit(secret);
        uint256 before = usdc.balanceOf(recipient);
        _spend(secret, recipient, bytes32(uint256(1)));
        assertEq(usdc.balanceOf(recipient) - before, DENOM);
        assertTrue(pool.isNullifierSpent(verifier.noteNullifier(secret)));
    }

    function testFuzz_distinctSecretsGiveDistinctNullifiers(bytes32 a, bytes32 b) public view {
        vm.assume(a != b);
        assertTrue(verifier.noteNullifier(a) != verifier.noteNullifier(b));
        assertTrue(verifier.noteCommitment(a) != verifier.noteCommitment(b));
    }
}
