// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fixture: a forge-script-shaped file. Path matches PQG-011's pathHints
// (/deploy/i), so address extraction runs here and not on every .sol in the repo.
//
// The exposure oracle's real input at build step 4: the address below is a live
// mainnet EOA with a nonzero nonce, so `nonce0 scan test/fixtures` produces a
// genuine cross-chain exposure finding rather than a synthetic one.

import {Script} from "forge-std/Script.sol";

contract Deploy is Script {
    // PQG-011: hardcoded owner EOA. This key controls this address on EVERY
    // chain, and its public key is published the first time it signs anywhere.
    address constant PROTOCOL_OWNER = 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045;

    // A second address inside a comment, to prove extraction respects the
    // tier-2 comment stripper: 0x000000000000000000000000000000000000dEaD

    function run() external {
        vm.startBroadcast();
        // deployment omitted; the fixture exists for address extraction only
        vm.stopBroadcast();
    }
}
