// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Denominations} from "../src/opaque/pool/Denominations.sol";

contract DenominationsTest is Test {
    function test_theOfficialPoolSetMatchesTheWalletPolicy() external pure {
        assertTrue(Denominations.isSupported(1_000_000));
        assertTrue(Denominations.isSupported(2_000_000));
        assertTrue(Denominations.isSupported(5_000_000));
        assertTrue(Denominations.isSupported(10_000_000));
        assertTrue(Denominations.isSupported(20_000_000));
        assertTrue(Denominations.isSupported(50_000_000));
        assertTrue(Denominations.isSupported(100_000_000));
    }

    function test_anUnsupportedBucketCannotBeOfficiallyDeployed() external pure {
        assertFalse(Denominations.isSupported(3_000_000));
    }
}
