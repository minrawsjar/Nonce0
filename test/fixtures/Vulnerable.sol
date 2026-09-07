// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fixture: MUST produce findings. Every rule this file trips is asserted in
// test/scan.test.js. If a change to the rule engine stops flagging one of these,
// that is a regression, not an improvement.

interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); }

contract VulnerableVault {
    address public owner;                 // PQG-007
    address public implementation;        // PQG-006
    mapping(address => uint256) public balances;
    mapping(bytes32 => bool) public usedDigests;

    modifier onlyOwner() {                // PQG-007 onlyOwner
        require(msg.sender == owner, "not owner");
        _;
    }

    // PQG-001: ecrecover in a state-changing function. The whole authority
    // decision rests on a secp256k1 signature.
    function withdrawWithSig(
        address to,
        uint256 amount,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 digest = keccak256(abi.encodePacked(to, amount, block.chainid));
        require(!usedDigests[digest], "replay");
        address signer = ecrecover(digest, v, r, s);
        require(signer == owner, "bad signature");
        usedDigests[digest] = true;
        balances[to] -= amount;
        payable(to).transfer(amount);
    }

    // PQG-002: EIP-712 permit path.
    bytes32 public DOMAIN_SEPARATOR;
    function permit(address holder, address spender, uint256 value, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, holder, spender, value));
        require(ecrecover(digest, v, r, s) == holder, "bad permit");
        balances[spender] += value;
    }

    // PQG-006: upgrade authority. This is the guard target.
    function upgradeTo(address newImplementation) external onlyOwner {
        implementation = newImplementation;
    }

    function _authorizeUpgrade(address) internal onlyOwner {}

    // PQG-007: ownership transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // PQG-008: uncapped exit path. No ceiling, no cooldown, no delay.
    function emergencyWithdraw() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    // PQG-003: pairing-based verification, immutable once deployed.
    function verifyProof(uint256[8] calldata proof, uint256[2] calldata input) public view returns (bool) {
        (bool ok, ) = address(0x08).staticcall(abi.encode(proof, input));
        return ok;
    }
}
