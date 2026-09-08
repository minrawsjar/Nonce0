// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";
import {IERC20, PrivatePool} from "../src/opaque/pool/PrivatePool.sol";
import {SingleNotePqVerifier} from "../src/opaque/pool/SingleNotePqVerifier.sol";
import {Canonical} from "../src/opaque/lib/Canonical.sol";

/// Deploys the registry, a verifier and one fixed-denomination pool.
///
///   forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast
///
/// Env: PRIVATE_KEY, and optionally USDC (defaults to Arc's ERC-20 USDC) and
/// DENOMINATION in 6-decimal units (defaults to 1 USDC).
///
/// NOTE ON THE VERIFIER. This ships SingleNotePqVerifier — SINGLE_NOTE_PQ,
/// §6.3's stated fallback. It is quantum-safe and NOT anonymous. The
/// eight-member ring was measured at 1.08 MiB and ~9x an Arc block to verify
/// (`node backend/zk/bench.ts`), so it cannot be verified on-chain at all. The
/// pool reads its mode through the ISpendVerifier seam, so swapping this out
/// later does not touch custody — but until it is swapped, `capabilities()`
/// reports SINGLE_NOTE_PQ and any interface must say so.
contract Deploy is Script {
    /// Arc's USDC through its 6-decimal ERC-20 interface. Arc's NATIVE USDC is
    /// 18 decimals and is used for gas; the two are one asset through two
    /// interfaces, and confusing them is a factor of 10^12.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address usdc = vm.envOr("USDC", ARC_USDC);
        uint256 denomination = vm.envOr("DENOMINATION", uint256(1_000_000));
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        PQKeyRegistry registry = new PQKeyRegistry();

        // The verifier binds the pool id and the pool derives that id from its
        // own address, so the verifier is constructed against the predicted
        // address and the assertion below refuses to proceed if it is wrong.
        uint64 nonce = vm.getNonce(deployer);
        address predictedPool = vm.computeCreateAddress(deployer, nonce + 1);
        bytes32 poolId = keccak256(
            abi.encodePacked(
                Canonical.field(bytes("opaque/v1/pool-id")),
                Canonical.field(Canonical.decimal(block.chainid)),
                abi.encodePacked(uint32(20), predictedPool)
            )
        );

        SingleNotePqVerifier verifier = new SingleNotePqVerifier(poolId, denomination);
        PrivatePool pool = new PrivatePool(IERC20(usdc), denomination, verifier);

        vm.stopBroadcast();

        require(address(pool) == predictedPool, "pool address prediction failed");
        require(pool.poolId() == poolId, "pool id disagreement");

        console2.log("chainId       ", block.chainid);
        console2.log("USDC          ", usdc);
        console2.log("denomination  ", denomination);
        console2.log("PQKeyRegistry ", address(registry));
        console2.log("SpendVerifier ", address(verifier));
        console2.log("PrivatePool   ", address(pool));
        console2.log("proofMode      SINGLE_NOTE_PQ (quantum-safe, NOT anonymous)");
    }
}
