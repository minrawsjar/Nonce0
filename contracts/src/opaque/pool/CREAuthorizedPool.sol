// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ICREPolicyGate} from "../cre/ICREPolicyGate.sol";

interface IERC20Cre { function transfer(address to, uint256 value) external returns (bool); function transferFrom(address from, address to, uint256 value) external returns (bool); }

/// @notice Fixed-bucket pool. CRE must verify the ZKBoo ring proof before it publishes an authorization.
contract CREAuthorizedPool {
    IERC20Cre public immutable token; ICREPolicyGate public immutable gate;
    uint256 public immutable denomination; uint16 public immutable feeBps; address public immutable feeCollector;
    mapping(bytes32 => bool) public commitments; mapping(bytes32 => bool) public nullifiers;
    error Invalid(); error Known(); error Spent(); error TransferFailed();
    event Deposited(bytes32 indexed commitment); event Settled(bytes32 indexed nullifier, address indexed recipient, uint256 gross, uint256 fee);

    constructor(IERC20Cre token_, ICREPolicyGate gate_, uint256 denomination_, uint16 feeBps_, address feeCollector_) {
        if (address(token_) == address(0) || address(gate_) == address(0) || denomination_ == 0 || feeBps_ > 10_000 || feeCollector_ == address(0)) revert Invalid();
        token = token_; gate = gate_; denomination = denomination_; feeBps = feeBps_; feeCollector = feeCollector_;
    }
    function deposit(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert Invalid(); if (commitments[commitment]) revert Known();
        commitments[commitment] = true;
        if (!token.transferFrom(msg.sender, address(this), denomination)) revert TransferFailed();
        emit Deposited(commitment);
    }
    function settle(bytes32 authorizationId) external {
        ICREPolicyGate.Authorization memory a = gate.consume(authorizationId);
        uint256 expectedFee = (denomination * feeBps + 9_999) / 10_000;
        if (a.grossAmount != denomination || a.feeBps != feeBps || a.feeCollector != feeCollector || a.feeAmount != expectedFee) revert Invalid();
        if (nullifiers[a.nullifier]) revert Spent();
        nullifiers[a.nullifier] = true;
        emit Settled(a.nullifier, a.recipient, denomination, expectedFee);
        if (!token.transfer(a.recipient, denomination - expectedFee)) revert TransferFailed();
        if (!token.transfer(feeCollector, expectedFee)) revert TransferFailed();
    }
}
