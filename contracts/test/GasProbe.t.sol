// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/// Where does FORS verification actually spend its gas? If it is the hashing,
/// the parameters are the lever. If it is everything around the hashing, the
/// encoding is. Guessing wrong means optimising the wrong thing.
contract GasProbe is Test {
    /// 322 keccak calls over ~107-byte preimages, the shape ForsVerifier uses.
    function test_pureHashingFloor() public view {
        bytes memory preimage = new bytes(107);
        uint256 before = gasleft();
        bytes32 acc;
        for (uint256 i = 0; i < 322; i++) {
            assembly {
                mstore(add(preimage, 32), acc)
                acc := keccak256(add(preimage, 32), 107)
            }
        }
        console2.log("322 raw keccak calls:            ", before - gasleft());
    }

    /// The same count, but built the way the contract builds them today.
    function test_encodePackedOverhead() public view {
        uint256 before = gasleft();
        bytes32 acc;
        for (uint256 i = 0; i < 322; i++) {
            acc = keccak256(
                abi.encodePacked(
                    abi.encodePacked(uint32(19), "opaque/v1/fors/node"),
                    abi.encodePacked(uint32(4), uint32(i)),
                    abi.encodePacked(uint32(4), uint32(0)),
                    abi.encodePacked(uint32(32), acc),
                    abi.encodePacked(uint32(32), acc)
                )
            );
        }
        console2.log("322 via nested abi.encodePacked: ", before - gasleft());
    }

    /// And the O(n^2) accumulation the roots buffer does today.
    function test_growingBufferAccumulation() public view {
        uint256 before = gasleft();
        bytes memory roots = new bytes(0);
        for (uint256 i = 0; i < 32; i++) {
            roots = abi.encodePacked(roots, abi.encodePacked(uint32(32), bytes32(i)));
        }
        console2.log("32x growing abi.encodePacked:     ", before - gasleft());
    }
}
