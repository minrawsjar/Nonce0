// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Public aggregate relay directory for Graph indexing. Never accepts a
/// payment, route, message id, client address, or per-request health record.
contract RelayDirectory {
    struct Node { address operator; string endpoint; bytes32 kemKeyCommitment; uint64 epoch; uint16 reliabilityBps; uint16 batchOccupancy; uint32 recentSelections; uint64 updatedAt; }
    mapping(bytes32 => Node) public nodes;
    error Invalid(); error NotOperator();
    event RelayAnnounced(bytes32 indexed nodeId, address indexed operator, string endpoint, bytes32 kemKeyCommitment, uint64 epoch);
    event RelayHealth(bytes32 indexed nodeId, uint16 reliabilityBps, uint16 batchOccupancy, uint32 recentSelections, uint64 observedAt);
    function announce(bytes32 nodeId, string calldata endpoint, bytes32 kemKeyCommitment, uint64 epoch) external {
        if (nodeId == bytes32(0) || bytes(endpoint).length == 0 || kemKeyCommitment == bytes32(0) || epoch == 0) revert Invalid();
        Node storage n = nodes[nodeId];
        if (n.operator != address(0) && n.operator != msg.sender) revert NotOperator();
        n.operator = msg.sender; n.endpoint = endpoint; n.kemKeyCommitment = kemKeyCommitment; n.epoch = epoch; n.updatedAt = uint64(block.timestamp);
        emit RelayAnnounced(nodeId, msg.sender, endpoint, kemKeyCommitment, epoch);
    }
    function report(bytes32 nodeId, uint16 reliabilityBps, uint16 batchOccupancy, uint32 recentSelections) external {
        Node storage n = nodes[nodeId]; if (n.operator != msg.sender || reliabilityBps > 10_000) revert Invalid();
        n.reliabilityBps = reliabilityBps; n.batchOccupancy = batchOccupancy; n.recentSelections = recentSelections; n.updatedAt = uint64(block.timestamp);
        emit RelayHealth(nodeId, reliabilityBps, batchOccupancy, recentSelections, n.updatedAt);
    }
}
