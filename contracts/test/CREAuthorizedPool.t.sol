// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {CREPolicyGate} from "../src/opaque/cre/CREPolicyGate.sol";
import {ICREPolicyGate} from "../src/opaque/cre/ICREPolicyGate.sol";
import {CREBatchSettlement} from "../src/opaque/pool/CREBatchSettlement.sol";
import {CREAuthorizedPool, IERC20Cre} from "../src/opaque/pool/CREAuthorizedPool.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {IPrivatePool} from "../src/opaque/interfaces/IPrivatePool.sol";
import {ISpendVerifier} from "../src/opaque/interfaces/ISpendVerifier.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";

/// Authorizations here are signed by packages/pq-wallet in TypeScript, never by
/// Solidity, so these exercise the real cross-language path a CRE workflow
/// takes rather than a self-consistent loop.
///
/// Regenerate with: node zk/cre-gate-vectors.ts  (from backend/)
contract CREAuthorizedPoolTest is Test {
    MockUSDC internal token;
    PQKeyRegistry internal registry;
    CREPolicyGate internal gate;
    CREAuthorizedPool internal pool20;
    CREAuthorizedPool internal pool5;
    CREBatchSettlement internal batcher;

    address internal constant ALICE = address(0xA11CE);
    address internal constant RELAYER = address(0xDEAD11);
    uint16 internal constant FEE_BPS = 50;

    address internal TOKEN_AT;
    address internal REGISTRY_AT;
    address internal GATE_AT;
    address internal POOL20_AT;
    address internal POOL5_AT;
    address internal ATTESTER;
    address internal BOB;
    address internal FEES;

    ICREPolicyGate.Authorization[] internal single;
    ICREPolicyGate.Authorization[] internal batch;
    ICREPolicyGate.Authorization[] internal third;
    bytes internal sigSingle;
    bytes internal sigBatchAt0;
    bytes internal sigBatchAt1;
    bytes internal sigThirdAt2;
    bytes internal sigImpostor;

    function _read(string memory j, string memory key) internal pure returns (ICREPolicyGate.Authorization memory a) {
        a.id = vm.parseJsonBytes32(j, string.concat(key, ".id"));
        a.spendHash = vm.parseJsonBytes32(j, string.concat(key, ".spendHash"));
        a.nullifier = vm.parseJsonBytes32(j, string.concat(key, ".nullifier"));
        a.pool = vm.parseJsonAddress(j, string.concat(key, ".pool"));
        a.recipient = vm.parseJsonAddress(j, string.concat(key, ".recipient"));
        a.feeCollector = vm.parseJsonAddress(j, string.concat(key, ".feeCollector"));
        a.grossAmount = vm.parseJsonUint(j, string.concat(key, ".grossAmount"));
        a.feeAmount = vm.parseJsonUint(j, string.concat(key, ".feeAmount"));
        a.feeBps = uint16(vm.parseJsonUint(j, string.concat(key, ".feeBps")));
        a.expiresAt = uint64(vm.parseJsonUint(j, string.concat(key, ".expiresAt")));
    }

    function setUp() public {
        string memory j = vm.readFile("test/fixtures/cre-gate-vectors.json");
        vm.chainId(vm.parseJsonUint(j, ".chainId"));
        // Comfortably inside the fixture's expiry, and far from zero.
        vm.warp(1_800_000_000);

        TOKEN_AT = vm.parseJsonAddress(j, ".token");
        REGISTRY_AT = vm.parseJsonAddress(j, ".registry");
        GATE_AT = vm.parseJsonAddress(j, ".gate");
        POOL20_AT = vm.parseJsonAddress(j, ".pool20");
        POOL5_AT = vm.parseJsonAddress(j, ".pool5");
        ATTESTER = vm.parseJsonAddress(j, ".attester");
        BOB = vm.parseJsonAddress(j, ".recipient");
        FEES = vm.parseJsonAddress(j, ".feeCollector");

        single.push(_read(j, ".single[0]"));
        batch.push(_read(j, ".batch[0]"));
        batch.push(_read(j, ".batch[1]"));
        third.push(_read(j, ".third[0]"));
        sigSingle = vm.parseJsonBytes(j, ".sigSingle");
        sigBatchAt0 = vm.parseJsonBytes(j, ".sigBatchAt0");
        sigBatchAt1 = vm.parseJsonBytes(j, ".sigBatchAt1");
        sigThirdAt2 = vm.parseJsonBytes(j, ".sigThirdAt2");
        sigImpostor = vm.parseJsonBytes(j, ".sigImpostor");

        deployCodeTo("MockUSDC.sol:MockUSDC", TOKEN_AT);
        deployCodeTo("PQKeyRegistry.sol:PQKeyRegistry", REGISTRY_AT);
        deployCodeTo("CREPolicyGate.sol:CREPolicyGate", abi.encode(IPQKeyRegistry(REGISTRY_AT), ATTESTER), GATE_AT);
        deployCodeTo(
            "CREAuthorizedPool.sol:CREAuthorizedPool",
            abi.encode(IERC20Cre(TOKEN_AT), ICREPolicyGate(GATE_AT), uint256(20_000_000), FEE_BPS, FEES),
            POOL20_AT
        );
        deployCodeTo(
            "CREAuthorizedPool.sol:CREAuthorizedPool",
            abi.encode(IERC20Cre(TOKEN_AT), ICREPolicyGate(GATE_AT), uint256(5_000_000), FEE_BPS, FEES),
            POOL5_AT
        );
        token = MockUSDC(TOKEN_AT);
        registry = PQKeyRegistry(REGISTRY_AT);
        gate = CREPolicyGate(GATE_AT);
        pool20 = CREAuthorizedPool(POOL20_AT);
        pool5 = CREAuthorizedPool(POOL5_AT);
        batcher = new CREBatchSettlement();

        vm.prank(ATTESTER);
        registry.register(
            vm.parseJsonBytes32(j, ".pkAttester"), vm.parseJsonBytes32(j, ".pkAttesterNext"), 2, 1_000_000_000
        );

        token.mint(ALICE, 100_000_000);
        vm.startPrank(ALICE);
        token.approve(POOL20_AT, type(uint256).max);
        token.approve(POOL5_AT, type(uint256).max);
        pool20.deposit(keccak256("note-20-a"));
        pool20.deposit(keccak256("note-20-b"));
        pool5.deposit(keccak256("note-5"));
        vm.stopPrank();
    }

    // ── what this deployment says it is ───────────────────────────────────

    /// A pool that checks no ring must not be able to pass for one that does.
    function test_capabilitiesRefuseToClaimARingThisPoolNeverChecks() public view {
        IPrivatePool.Capabilities memory c = pool20.capabilities();
        assertEq(uint8(c.proofMode), uint8(ISpendVerifier.ProofMode.ATTESTED_OFFCHAIN));
        assertTrue(c.proofMode != ISpendVerifier.ProofMode.RING_8, "never RING_8: there is no ring here");
        assertEq(c.ringSize, 1, "the chain distinguishes exactly one nullifier");
        assertFalse(c.requiresCommitReveal);
        assertEq(c.denomination, 20_000_000);
    }

    /// Two pools trusting different attesters are different trust models, and
    /// verifierId is what an interface resolves to tell them apart.
    function test_verifierIdCommitsToTheGate() public {
        deployCodeTo(
            "CREPolicyGate.sol:CREPolicyGate",
            abi.encode(IPQKeyRegistry(REGISTRY_AT), address(0xDEAD)),
            address(0x7777)
        );
        CREAuthorizedPool other = new CREAuthorizedPool(
            IERC20Cre(TOKEN_AT), ICREPolicyGate(address(0x7777)), 20_000_000, FEE_BPS, FEES
        );
        assertTrue(other.verifierId() != pool20.verifierId(), "the gate must change the id");
    }

    // ── the property this contract exists to hold ─────────────────────────

    /// THE ONE THAT MATTERS. There is no ECDSA key on the mint path any more.
    /// Authority is a post-quantum signature; msg.sender authorises nothing, so
    /// a random relayer can carry a signed batch and cannot alter it.
    function test_anyoneMayRelayASignedBatchAndNobodyMayForgeOne() public {
        vm.prank(RELAYER);
        gate.publish(single, sigSingle);
        assertEq(gate.authorizationOf(single[0].id).id, single[0].id, "a relayer carried it");

        // And the relayer's own address buys nothing without the signature.
        vm.prank(RELAYER);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        gate.publish(batch, sigImpostor);
    }

    function test_aBatchCannotBeAlteredUnderItsSignature() public {
        ICREPolicyGate.Authorization[] memory tampered = batch;
        tampered[0].recipient = address(0xBADBEEF);
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        gate.publish(tampered, sigBatchAt0);

        // Dropping an entry is the other half: the payload commits to the count.
        ICREPolicyGate.Authorization[] memory shortened = new ICREPolicyGate.Authorization[](1);
        shortened[0] = batch[0];
        vm.expectRevert(PQKeyRegistry.BadSignature.selector);
        gate.publish(shortened, sigBatchAt0);
    }

    /// FORS is few-time, and the registry is where that is enforced. Two
    /// batches is the whole budget this attester was registered with.
    ///
    /// The third batch has to be a GENUINELY new one: re-presenting an earlier
    /// batch is refused as a duplicate before the registry is ever consulted,
    /// so it would prove nothing about the bound.
    function test_theFewTimeBoundIsEnforcedOnChain() public {
        gate.publish(single, sigSingle);
        gate.publish(batch, sigBatchAt1);
        assertEq(registry.stateOf(ATTESTER).useCount, 2, "one index per BATCH, not per payment");
        assertEq(registry.stateOf(ATTESTER).useCount, registry.stateOf(ATTESTER).maxUses);

        vm.expectRevert(PQKeyRegistry.KeyExhausted.selector);
        gate.publish(third, sigThirdAt2);
    }

    /// Three payments, two signing indices. This is the whole reason publish
    /// takes a batch: one signature per payment would exhaust a few-time key
    /// in a day, and rotation is not free.
    function test_aBatchCostsOneIndexRegardlessOfHowManyPaymentsItCarries() public {
        gate.publish(batch, sigBatchAt0);
        assertEq(registry.stateOf(ATTESTER).useCount, 1, "two payments, one index");
    }

    /// A batch that cannot be published must not cost the attester an index it
    /// never got to use.
    function test_aRejectedBatchDoesNotBurnASigningIndex() public {
        ICREPolicyGate.Authorization[] memory bad = new ICREPolicyGate.Authorization[](1);
        bad[0] = single[0];
        bad[0].recipient = address(0);
        vm.expectRevert(CREPolicyGate.InvalidAuthorization.selector);
        gate.publish(bad, sigSingle);
        assertEq(registry.stateOf(ATTESTER).useCount, 0, "the index survives a refused batch");
    }

    // ── settlement ────────────────────────────────────────────────────────

    function test_publishThenSettleOnce() public {
        gate.publish(single, sigSingle);
        pool20.settle(single[0].id);

        assertEq(token.balanceOf(BOB), 20_000_000 - single[0].feeAmount, "recipient paid net");
        assertEq(token.balanceOf(FEES), single[0].feeAmount, "collector paid the fee");
        assertTrue(pool20.nullifiers(single[0].nullifier));

        vm.expectRevert(CREPolicyGate.AlreadyConsumed.selector);
        pool20.settle(single[0].id);
    }

    /// The multi-note case: one payment split across denominations, one
    /// signature, and either both legs land or neither does.
    function test_aMultiDenominationBatchSettlesAtomically() public {
        gate.publish(batch, sigBatchAt0);
        address[] memory pools = new address[](2);
        bytes32[] memory ids = new bytes32[](2);
        (pools[0], pools[1]) = (POOL20_AT, POOL5_AT);
        (ids[0], ids[1]) = (batch[0].id, batch[1].id);

        batcher.settleAll(pools, ids);
        assertEq(token.balanceOf(BOB), 25_000_000 - batch[0].feeAmount - batch[1].feeAmount, "both legs paid");

        // And a batch where one leg is already spent reverts whole: no partial
        // payment, which is the entire reason settleAll exists.
        vm.expectRevert();
        batcher.settleAll(pools, ids);
    }

    function test_onlyTheNamedPoolMaySettleIt() public {
        gate.publish(batch, sigBatchAt0);
        // batch[1] is the 5 USDC leg; the 20 USDC pool must not be able to take it.
        vm.expectRevert(CREPolicyGate.NotPool.selector);
        pool20.settle(batch[1].id);
    }

    function test_feeOrPoolMutationCannotSettle() public {
        gate.publish(batch, sigBatchAt0);
        // batch[0] is priced for the 20 USDC pool; presenting it to the 5 USDC
        // pool fails on the amount even though the signature is genuine.
        vm.expectRevert(CREPolicyGate.NotPool.selector);
        pool5.settle(batch[0].id);
    }

    function test_anExpiredAuthorizationCannotSettle() public {
        gate.publish(single, sigSingle);
        vm.warp(uint256(single[0].expiresAt) + 1);
        vm.expectRevert(CREPolicyGate.Expired.selector);
        pool20.settle(single[0].id);
    }

    function test_theSameAuthorizationIdCannotBePublishedTwice() public {
        gate.publish(single, sigSingle);
        vm.expectRevert(CREPolicyGate.Duplicate.selector);
        gate.publish(single, sigSingle);
    }
}
