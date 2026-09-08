// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20, PrivatePool} from "../src/opaque/pool/PrivatePool.sol";
import {SingleNotePqVerifier} from "../src/opaque/pool/SingleNotePqVerifier.sol";

/// Drives the pool through arbitrary interleavings of deposit, commit and
/// reveal. foundry.toml says the state machine is the risk in this design and
/// not the cryptography; this is where that claim gets tested.
contract PoolHandler is Test {
    PrivatePool public pool;
    SingleNotePqVerifier public verifier;
    MockUSDC public usdc;

    uint256 public deposits;
    uint256 public payouts;
    bytes32[] public secrets;
    mapping(bytes32 => bool) public everSpent;

    constructor(PrivatePool pool_, SingleNotePqVerifier verifier_, MockUSDC usdc_) {
        pool = pool_;
        verifier = verifier_;
        usdc = usdc_;
    }

    function deposit(bytes32 secret) external {
        bytes32 commitment = verifier.noteCommitment(secret);
        if (pool.isCommitmentKnown(commitment)) return;
        usdc.mint(address(this), pool.denomination());
        usdc.approve(address(pool), pool.denomination());
        pool.deposit(commitment);
        secrets.push(secret);
        deposits++;
    }

    function commitAndSpend(uint256 seed, address recipient) external {
        if (secrets.length == 0) return;
        if (recipient == address(0) || recipient == address(pool)) return;
        bytes32 secret = secrets[seed % secrets.length];

        bytes32[] memory ring = new bytes32[](1);
        ring[0] = verifier.noteCommitment(secret);
        bytes memory proof = abi.encodePacked(secret);
        bytes32 salt = bytes32(seed);

        bytes32 sc = pool.spendCommitment(ring, proof, recipient, salt);
        try pool.commitSpend(sc) {} catch { return; }
        vm.roll(block.number + pool.COMMIT_DELAY_BLOCKS());

        try pool.spend(ring, proof, recipient, salt) {
            payouts++;
            everSpent[verifier.noteNullifier(secret)] = true;
        } catch {}
    }

    /// Once spent, always spent — checked from the handler's own record rather
    /// than from the pool's, so the two have to agree.
    function assertNullifiersStaySpent() external view {
        for (uint256 i = 0; i < secrets.length; i++) {
            bytes32 n = verifier.noteNullifier(secrets[i]);
            if (everSpent[n]) require(pool.isNullifierSpent(n), "a spent nullifier came back");
        }
    }
}

contract PrivatePoolInvariantTest is Test {
    MockUSDC internal usdc;
    PrivatePool internal pool;
    SingleNotePqVerifier internal verifier;
    PoolHandler internal handler;

    uint256 internal constant DENOM = 1_000_000;

    function setUp() public {
        usdc = new MockUSDC();
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
        handler = new PoolHandler(pool, verifier, usdc);
        targetContract(address(handler));
    }

    /// The pool is never short. If this breaks, someone was paid twice.
    function invariant_poolIsFullyBacked() public view {
        assertEq(
            usdc.balanceOf(address(pool)),
            (handler.deposits() - handler.payouts()) * DENOM,
            "pool balance must equal unspent notes"
        );
    }

    /// Payouts can never exceed deposits, whatever the interleaving.
    function invariant_neverPaysOutMoreThanWasDeposited() public view {
        assertLe(handler.payouts(), handler.deposits());
    }

    function invariant_spentNullifiersAreMonotonic() public view {
        handler.assertNullifiersStaySpent();
    }
}
