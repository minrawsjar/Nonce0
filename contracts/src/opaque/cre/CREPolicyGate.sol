// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ICREPolicyGate} from "./ICREPolicyGate.sol";

/// @notice One-shot public settlement results published by the trusted CRE egress.
contract CREPolicyGate is ICREPolicyGate {
    address public immutable crePublisher;
    mapping(bytes32 => Authorization) private _authorizations;
    mapping(bytes32 => bool) public consumed;

    error NotPublisher(); error Duplicate(); error InvalidAuthorization(); error NotPool(); error Expired(); error AlreadyConsumed();
    event Published(bytes32 indexed id, bytes32 indexed spendHash, bytes32 indexed nullifier, address pool);
    event Consumed(bytes32 indexed id, address indexed pool);

    constructor(address publisher) { if (publisher == address(0)) revert InvalidAuthorization(); crePublisher = publisher; }

    function publish(Authorization calldata a) external {
        if (msg.sender != crePublisher) revert NotPublisher();
        if (_authorizations[a.id].id != bytes32(0)) revert Duplicate();
        if (a.id == bytes32(0) || a.pool == address(0) || a.recipient == address(0) || a.feeCollector == address(0)
            || a.grossAmount == 0 || a.feeAmount >= a.grossAmount || a.feeBps > 10_000 || a.expiresAt <= block.timestamp) revert InvalidAuthorization();
        _authorizations[a.id] = a;
        emit Published(a.id, a.spendHash, a.nullifier, a.pool);
    }

    function consume(bytes32 id) external returns (Authorization memory a) {
        a = _authorizations[id];
        if (a.id == bytes32(0) || a.pool != msg.sender) revert NotPool();
        if (consumed[id]) revert AlreadyConsumed();
        if (block.timestamp >= a.expiresAt) revert Expired();
        consumed[id] = true;
        emit Consumed(id, msg.sender);
    }
}
