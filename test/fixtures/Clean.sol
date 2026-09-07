// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fixture: MUST produce ZERO findings.
//
// This is the most important fixture in the repo. A scanner that flags
// everything is the failure mode you cannot see from the inside, and the only
// thing that catches it is a file that is genuinely clean but looks dirty to a
// naive regex.
//
// Every trigger word below sits in a comment, a string literal, or a view
// function, so tier 1 hits it and tier 2 must clear it:
//   - the words ecrecover and onlyOwner appear in THIS comment
//   - ecrecover appears in a string literal
//   - a view function is named in a way that a naive matcher trips on
//
// NOTE: this fixture only passes once the tier-2 lexer (src/repo/solidity.js,
// build step 3) exists. Until then tier 1 alone will flag it, which is correct
// and expected. test/scan.test.js enables the zero-findings assertion at step 3.

contract CleanRegistry {
    mapping(address => bytes32) private _commitments;

    string public constant NOTE = "this contract does not call ecrecover or use onlyOwner";

    function commitmentOf(address account) external view returns (bytes32) {
        return _commitments[account];
    }

    // A view function. Nothing here authorises anything.
    function isCommitted(address account) external view returns (bool) {
        return _commitments[account] != bytes32(0);
    }

    function commit(bytes32 commitment) external {
        require(_commitments[msg.sender] == bytes32(0), "already committed");
        _commitments[msg.sender] = commitment;
    }
}
