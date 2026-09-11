// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The seven public note values the wallet, Graph index, and official deployer
/// agree on. Values use USDC's six-decimal integer units.
library Denominations {
    function isSupported(uint256 value) internal pure returns (bool) {
        return value == 1_000_000
            || value == 2_000_000
            || value == 5_000_000
            || value == 10_000_000
            || value == 20_000_000
            || value == 50_000_000
            || value == 100_000_000;
    }
}
