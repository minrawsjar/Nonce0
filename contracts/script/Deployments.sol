// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice Reads deployments/arc-testnet.json — the one place addresses live.
/// @dev Scripts that need an EXISTING contract read it here rather than from an
///      env var. An env var is a second copy of the address, and the second
///      copy is the one that goes stale after a redeploy.
abstract contract Deployments is Script {
    string internal constant CONFIG = "../deployments/arc-testnet.json";

    function _config() internal view returns (string memory) {
        return vm.readFile(CONFIG);
    }

    /// Refuses a contract the config marks `null` (not deployed), with a message
    /// that names the file to edit — vm.parseJsonAddress on null would only say
    /// that parsing failed.
    function _contract(string memory name) internal view returns (address) {
        string memory json = _config();
        string memory key = string.concat(".contracts.", name, ".address");
        require(vm.keyExistsJson(json, key), string.concat(name, " is not deployed: set it in ", CONFIG));
        return vm.parseJsonAddress(json, key);
    }

    function _usdc() internal view returns (address) {
        return vm.parseJsonAddress(_config(), ".tokens.usdc.address");
    }

    function _chainId() internal view returns (uint256) {
        return vm.parseJsonUint(_config(), ".network.chainId");
    }

    /// Stops a script broadcasting to a chain other than the one the config
    /// describes, which is the other way an address list goes wrong.
    function _assertChain() internal view {
        require(block.chainid == _chainId(), "connected chain does not match deployments/arc-testnet.json");
    }
}
