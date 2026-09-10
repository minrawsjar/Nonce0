// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {AttestedRingVerifier} from "../src/opaque/pool/AttestedRingVerifier.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {IPrivatePool} from "../src/opaque/interfaces/IPrivatePool.sol";
import {ISpendVerifier} from "../src/opaque/interfaces/ISpendVerifier.sol";
import {IERC20, PrivatePool} from "../src/opaque/pool/PrivatePool.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";

/// Attestations here are signed by packages/pq-wallet in TypeScript over
/// commitments derived by backend/zk — never by Solidity. If the two languages
/// disagree by a single byte about how a ring, a nullifier and a payment
/// context are bound together, every test in this file fails, which is the
/// entire point of pinning them to a fixture rather than to each other.
///
/// Regenerate with: node zk/attested-vectors.ts  (from backend/)
contract AttestedRingVerifierTest is Test {
    MockUSDC internal usdc;
    PQKeyRegistry internal registry;
    AttestedRingVerifier internal verifier;
    PrivatePool internal pool;

    uint256 internal constant DENOM = 1_000_000;
    address internal constant ALICE = address(0xA11CE);

    address internal USDC_AT;
    address internal REGISTRY_AT;
    address internal VERIFIER_AT;
    address internal POOL_AT;
    address internal ATTESTER;
    address internal BOB;

    bytes32[] internal ring;
    bytes32 internal nullifierA;
    bytes32 internal nullifierB;
    bytes internal sigA;
    bytes internal sigB;
    bytes internal sigImpostor;
    bytes32 internal pkAttester;
    bytes32 internal pkAttesterNext;

    function setUp() public {
        string memory j = vm.readFile("test/fixtures/attested-ring-vectors.json");
        vm.chainId(vm.parseJsonUint(j, ".chainId"));

        USDC_AT = vm.parseJsonAddress(j, ".usdc");
        REGISTRY_AT = vm.parseJsonAddress(j, ".registry");
        VERIFIER_AT = vm.parseJsonAddress(j, ".verifier");
        POOL_AT = vm.parseJsonAddress(j, ".pool");
        ATTESTER = vm.parseJsonAddress(j, ".attester");
        BOB = vm.parseJsonAddress(j, ".recipient");

        ring = vm.parseJsonBytes32Array(j, ".ring");
        nullifierA = vm.parseJsonBytes32(j, ".nullifierA");
        nullifierB = vm.parseJsonBytes32(j, ".nullifierB");
        sigA = vm.parseJsonBytes(j, ".sigA");
        sigB = vm.parseJsonBytes(j, ".sigB");
        sigImpostor = vm.parseJsonBytes(j, ".sigImpostor");
        pkAttester = vm.parseJsonBytes32(j, ".pkAttester");
        pkAttesterNext = vm.parseJsonBytes32(j, ".pkAttesterNext");

        // Fixed addresses, not a predicted deploy order: the verifier id binds
        // the registry and the attester, and the pool id binds the pool, so a
        // fixture tied to nonces would break on any new line in this function.
        deployCodeTo("MockUSDC.sol:MockUSDC", USDC_AT);
        deployCodeTo("PQKeyRegistry.sol:PQKeyRegistry", REGISTRY_AT);
        usdc = MockUSDC(USDC_AT);
        registry = PQKeyRegistry(REGISTRY_AT);

        deployCodeTo(
            "AttestedRingVerifier.sol:AttestedRingVerifier",
            abi.encode(IPQKeyRegistry(REGISTRY_AT), ATTESTER, vm.parseJsonBytes32(j, ".poolId"), DENOM),
            VERIFIER_AT
        );
        verifier = AttestedRingVerifier(VERIFIER_AT);

        deployCodeTo(
            "PrivatePool.sol:PrivatePool",
            abi.encode(IERC20(USDC_AT), DENOM, ISpendVerifier(VERIFIER_AT)),
            POOL_AT
        );
        pool = PrivatePool(POOL_AT);

        // The cross-language pin. Everything else in this file is meaningless
        // if these two disagree.
        assertEq(pool.poolId(), vm.parseJsonBytes32(j, ".poolId"), "pool id: Solidity vs TypeScript");
        assertEq(verifier.verifierId(), vm.parseJsonBytes32(j, ".verifierId"), "verifier id");

        // maxUses 2 is the point, not a shortcut: FORS is few-time, and the
        // registry is where that bound is enforced rather than hoped for.
        vm.prank(ATTESTER);
        registry.register(pkAttester, pkAttesterNext, 2, 1_000_000);

        usdc.mint(ALICE, 100 * DENOM);
        vm.startPrank(ALICE);
        usdc.approve(POOL_AT, type(uint256).max);
        for (uint256 i = 0; i < ring.length; i++) {
            pool.deposit(ring[i]);
        }
        vm.stopPrank();
    }

    function _proof(bytes32 nullifier, bytes memory signature) internal pure returns (bytes memory) {
        return abi.encodePacked(nullifier, signature);
    }

    // ── what a deployment says it is ──────────────────────────────────────

    function test_capabilitiesReportTheTruth() public view {
        IPrivatePool.Capabilities memory c = pool.capabilities();
        assertEq(uint8(c.proofMode), uint8(ISpendVerifier.ProofMode.RING_8));
        assertEq(c.ringSize, 8, "an eight-member ring is what the chain can see");
        assertFalse(c.requiresCommitReveal, "nothing in the calldata is worth front-running");
        assertEq(c.denomination, DENOM);
    }

    /// Two pools that differ only in WHO attests are different trust models.
    /// If they shared a verifier id, an interface could not tell them apart.
    function test_verifierIdCommitsToTheAttester() public {
        AttestedRingVerifier other =
            new AttestedRingVerifier(IPQKeyRegistry(REGISTRY_AT), address(0xDEAD), pool.poolId(), DENOM);
        assertTrue(other.verifierId() != verifier.verifierId(), "attester must change the id");
    }

    // ── the happy path ────────────────────────────────────────────────────

    /// No commitSpend, no two-block wait. One transaction settles the payment.
    function test_anAttestedSpendSettlesInOneTransaction() public {
        pool.spend(ring, _proof(nullifierA, sigA), BOB, bytes32(0));

        assertEq(usdc.balanceOf(BOB), DENOM, "recipient paid");
        assertTrue(pool.isNullifierSpent(nullifierA), "nullifier consumed");
        assertEq(registry.stateOf(ATTESTER).useCount, 1, "the signing index was burned");
    }

    /// The ring is eight real deposits and the calldata does not say which one
    /// moved. That is the whole claim this routing buys.
    function test_theSpentRingMemberIsNotNamedOnChain() public {
        vm.recordLogs();
        pool.spend(ring, _proof(nullifierA, sigA), BOB, bytes32(0));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            for (uint256 t = 0; t < logs[i].topics.length; t++) {
                for (uint256 r = 0; r < ring.length; r++) {
                    assertTrue(logs[i].topics[t] != ring[r], "an event named a ring member");
                }
            }
        }
    }

    function test_oneKeyAttestsMoreThanOneSpend() public {
        pool.spend(ring, _proof(nullifierA, sigA), BOB, bytes32(0));
        pool.spend(ring, _proof(nullifierB, sigB), BOB, bytes32(0));
        assertEq(usdc.balanceOf(BOB), 2 * DENOM, "both payments landed");
        assertEq(registry.stateOf(ATTESTER).useCount, 2);
    }

    // ── enforcement, which is what the chain is still for ─────────────────

    function test_aReplayedAttestationBuysNothing() public {
        pool.spend(ring, _proof(nullifierA, sigA), BOB, bytes32(0));
        // Two independent refusals: the index has moved, and even if it had
        // not, the nullifier is spent.
        vm.expectRevert();
        pool.spend(ring, _proof(nullifierA, sigA), BOB, bytes32(0));
    }

    function test_anUnregisteredSignerCannotAttest() public {
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        pool.spend(ring, _proof(nullifierA, sigImpostor), BOB, bytes32(0));
        assertEq(usdc.balanceOf(BOB), 0);
    }

    /// The one that matters most for this routing: a valid attestation is a
    /// statement about ONE spend, and every field of it is load-bearing.
    function test_aValidAttestationCannotBeRedirected() public {
        // Different recipient — paymentContext changes, so the signature does
        // not cover this call. Without this, an observer redirects the payment.
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        pool.spend(ring, _proof(nullifierA, sigA), address(0xBADBEEF), bytes32(0));

        // Different nullifier: the attestation names the one it approved.
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        pool.spend(ring, _proof(nullifierB, sigA), BOB, bytes32(0));

        assertEq(usdc.balanceOf(BOB), 0, "nothing moved");
    }

    function test_aValidAttestationCannotBeMovedToAnotherRing() public {
        bytes32[] memory swapped = ring;
        (swapped[0], swapped[1]) = (ring[1], ring[0]);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        pool.spend(swapped, _proof(nullifierA, sigA), BOB, bytes32(0));
    }

    /// Ring membership stays the pool's job, not the attester's. An attester
    /// that signed off on a commitment nobody deposited still cannot move funds.
    function test_theChainStillChecksEveryRingMemberIsARealDeposit() public {
        bytes32[] memory fake = ring;
        fake[3] = keccak256("never deposited");
        vm.expectRevert(PrivatePool.UnknownCommitment.selector);
        pool.spend(fake, _proof(nullifierA, sigA), BOB, bytes32(0));
    }

    /// FORS security decays with every signature under one key. maxUses is a
    /// security parameter, and the chain refuses rather than degrading quietly.
    function test_theFewTimeBoundIsEnforcedOnChainNotByTheAttester() public {
        pool.spend(ring, _proof(nullifierA, sigA), BOB, bytes32(0));
        pool.spend(ring, _proof(nullifierB, sigB), BOB, bytes32(0));

        assertEq(registry.stateOf(ATTESTER).useCount, registry.stateOf(ATTESTER).maxUses);
        // A third attestation cannot be honoured at any price until the
        // attester rotates, no matter how well-formed it is.
        vm.expectRevert(PQKeyRegistry.KeyExhausted.selector);
        pool.spend(ring, _proof(keccak256("third"), sigA), BOB, bytes32(0));
    }

    function test_ringSizeIsExactlyEight() public {
        bytes32[] memory short_ = new bytes32[](7);
        for (uint256 i = 0; i < 7; i++) short_[i] = ring[i];
        // The pool checks the size against the verifier before anything else.
        vm.expectRevert(PrivatePool.WrongRingSize.selector);
        pool.spend(short_, _proof(nullifierA, sigA), BOB, bytes32(0));
    }

    function test_aZeroNullifierIsNeverValid() public {
        vm.expectRevert(AttestedRingVerifier.MalformedProof.selector);
        pool.spend(ring, _proof(bytes32(0), sigA), BOB, bytes32(0));
    }

    function test_aProofWithNoSignatureIsRefused() public {
        vm.expectRevert(AttestedRingVerifier.MalformedProof.selector);
        pool.spend(ring, abi.encodePacked(nullifierA), BOB, bytes32(0));
    }

    /// There is no admin, no pause and no ECDSA fallback anywhere in this path.
    /// The only thing that can change who attests is the attester's own PQ key.
    function test_noAddressCanReplaceTheAttester() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        registry.rotate(ATTESTER, keccak256("mine"), 4, 1, sigImpostor);
        assertEq(registry.stateOf(ATTESTER).pkCommitment, pkAttester, "untouched");
    }
}

// Imported last so the Vm.Log type above resolves without shadowing Test.
import {Vm} from "forge-std/Vm.sol";
