// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IPQKeyRegistry} from "../src/opaque/interfaces/IPQKeyRegistry.sol";
import {AttestedRingVerifier} from "../src/opaque/pool/AttestedRingVerifier.sol";
import {IERC20, PrivatePool} from "../src/opaque/pool/PrivatePool.sol";
import {PQKeyRegistry} from "../src/opaque/wallet/PQKeyRegistry.sol";
import {Canonical} from "../src/opaque/lib/Canonical.sol";
import {Deployments} from "./Deployments.sol";

/// Deploys the RING_8 settlement path — PrivatePool + AttestedRingVerifier — and
/// registers the attester whose post-quantum key signs spend attestations.
///
///   set -a; source ../backend/.env; source .env; set +a
///   ATTESTER=0x… ATTESTER_PK_COMMITMENT=0x… ATTESTER_NEXT_COMMITMENT=0x… \
///     forge script script/DeployRingPool.s.sol --rpc-url arc_testnet --broadcast
///
/// Keys come from the ENVIRONMENT only — PRIVATE_KEY (deployer) and
/// ATTESTER_EOA_KEY — never from a command argument, where they would sit in a
/// process list and shell history.
///
/// Another denomination, same attester (already registered, so no attester key):
///
///   REGISTER_ATTESTER=false DENOMINATION=10000000 \
///     forge script script/DeployRingPool.s.sol --rpc-url arc_testnet --broadcast
///
/// One attester serves any number of pools: each verifier binds its own pool id
/// and denomination into what the attester signs, and PQKeyRegistry.consume is
/// open to any verifier, so the attester's key budget and rotation are shared.
///
/// TWO SENDERS, deliberately. The deployer deploys and pays. The attester
/// registers from its OWN address, because PQKeyRegistry binds a key to
/// msg.sender at registration — and that is the ONLY thing msg.sender ever
/// authorises there. After this, the attester's ECDSA key has no power at all:
/// consuming and rotating need its FORS key. Its authority is post-quantum from
/// the first block it exists.
contract DeployRingPool is Deployments {
    /// Enough for the attester's single registration transaction, and no more.
    uint256 internal constant ATTESTER_GAS_FUND = 0.05 ether; // native USDC, 18dp

    function run() external {
        _assertChain();
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        bool registerAttester = vm.envOr("REGISTER_ATTESTER", true);
        uint256 attesterPk = registerAttester ? vm.envUint("ATTESTER_EOA_KEY") : 0;
        address attester = registerAttester ? vm.addr(attesterPk) : vm.parseJsonAddress(_config(), ".accounts.attester");
        if (registerAttester) require(attester == vm.envAddress("ATTESTER"), "ATTESTER does not match ATTESTER_EOA_KEY");
        require(attester != deployer, "the attester must not be the deployer");
        uint256 denomination = vm.envOr("DENOMINATION", uint256(1_000_000));

        IPQKeyRegistry registry = IPQKeyRegistry(_contract("pqKeyRegistry"));
        address usdc = _usdc();

        // ── deployer: verifier, pool, and the attester's gas ──────────────
        vm.startBroadcast(deployerPk);
        // The verifier binds the pool id and the pool derives it from its own
        // address, so predict first and refuse below if the prediction was wrong.
        uint64 nonce = vm.getNonce(deployer);
        address predictedPool = vm.computeCreateAddress(deployer, nonce + 1);
        bytes32 poolId = keccak256(
            abi.encodePacked(
                Canonical.field(bytes("opaque/v1/pool-id")),
                Canonical.field(Canonical.decimal(block.chainid)),
                abi.encodePacked(uint32(20), predictedPool)
            )
        );
        AttestedRingVerifier verifier = new AttestedRingVerifier(registry, attester, poolId, denomination);
        PrivatePool pool = new PrivatePool(IERC20(usdc), denomination, verifier);
        if (registerAttester) {
            (bool funded,) = payable(attester).call{value: ATTESTER_GAS_FUND}("");
            require(funded, "funding the attester failed");
        }
        vm.stopBroadcast();

        require(address(pool) == predictedPool, "pool address prediction failed");
        require(pool.poolId() == poolId, "pool id disagreement");

        // ── attester: one registration, then its ECDSA key is irrelevant ──
        if (registerAttester) {
            // FORS+C k=32,a=8: forgery odds ~1e-30 at 32 signatures, ~52% at 1000.
            // The registry refuses the 33rd, so the attester MUST rotate by then.
            uint64 maxUses = uint64(vm.envOr("ATTESTER_MAX_USES", uint256(32)));
            vm.startBroadcast(attesterPk);
            PQKeyRegistry(address(registry)).register(
                vm.envBytes32("ATTESTER_PK_COMMITMENT"), vm.envBytes32("ATTESTER_NEXT_COMMITMENT"), maxUses, uint64(block.timestamp + 30 days)
            );
            vm.stopBroadcast();
        }

        console2.log("chainId              ", block.chainid);
        console2.log("AttestedRingVerifier ", address(verifier));
        console2.log("PrivatePool (RING_8) ", address(pool));
        console2.log("attester             ", attester);
        console2.log("denomination         ", denomination);
        console2.logBytes32(poolId);
    }
}
