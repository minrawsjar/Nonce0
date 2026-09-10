// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RelayDirectory (§8.2) — relay liveness and aggregate health, on chain
///        so the Graph can index it for hop selection.
/// @notice Never accepts a payment, route, message id, client address or
///         per-request record: each report is a node's aggregate over a window
///         — share of batch windows served, average batch occupancy, how often
///         it was picked (§8.2's RelayNode).
///
///         NOT a source of keys. The keys a wallet encrypts to come from the
///         signed, pinned directory (backend/mesh/directory.ts); the health
///         here can only weigh a choice among relays that directory names, and
///         the client clamps it (backend/mesh/graph-health.ts).
///
///         nodeId is the directory's relay id, UTF-8, right-padded to 32 bytes
///         ("R1" → 0x5231 00…), so the Graph and the directory name a relay
///         the same way.
contract RelayDirectory {
    struct Node {
        address operator;
        string endpoint;
        bytes32 kemKeyCommitment;
        uint64 epoch;
        uint16 reliabilityBps;
        uint16 batchOccupancy;
        uint32 recentSelections;
        uint64 updatedAt;
    }

    struct Report {
        bytes32 nodeId;
        uint16 reliabilityBps;
        uint16 batchOccupancy;
        uint32 recentSelections;
    }

    mapping(bytes32 => Node) public nodes;

    error Invalid();
    error NotOperator();
    error StaleEpoch();

    event RelayAnnounced(
        bytes32 indexed nodeId, address indexed operator, string endpoint, bytes32 kemKeyCommitment, uint64 epoch
    );
    event RelayHealth(
        bytes32 indexed nodeId, uint16 reliabilityBps, uint16 batchOccupancy, uint32 recentSelections, uint64 observedAt
    );

    /// @notice First announce claims the id; later ones must come from the same
    ///         operator and move the key epoch FORWARD. Re-announcing an old
    ///         epoch would put a retired key's commitment back in front of
    ///         every indexer.
    function announce(bytes32 nodeId, string calldata endpoint, bytes32 kemKeyCommitment, uint64 epoch) external {
        if (nodeId == bytes32(0) || bytes(endpoint).length == 0 || kemKeyCommitment == bytes32(0) || epoch == 0) {
            revert Invalid();
        }
        Node storage n = nodes[nodeId];
        if (n.operator != address(0)) {
            if (n.operator != msg.sender) revert NotOperator();
            if (epoch <= n.epoch) revert StaleEpoch();
        }
        n.operator = msg.sender;
        n.endpoint = endpoint;
        n.kemKeyCommitment = kemKeyCommitment;
        n.epoch = epoch;
        n.updatedAt = uint64(block.timestamp);
        emit RelayAnnounced(nodeId, msg.sender, endpoint, kemKeyCommitment, epoch);
    }

    /// @notice One transaction for a window's reports: one operator running
    ///         several relays pays once, not per relay.
    function report(Report[] calldata reports) external {
        uint64 at = uint64(block.timestamp);
        for (uint256 i = 0; i < reports.length; i++) {
            Report calldata r = reports[i];
            Node storage n = nodes[r.nodeId];
            if (n.operator != msg.sender) revert NotOperator();
            if (r.reliabilityBps > 10_000) revert Invalid();
            n.reliabilityBps = r.reliabilityBps;
            n.batchOccupancy = r.batchOccupancy;
            n.recentSelections = r.recentSelections;
            n.updatedAt = at;
            emit RelayHealth(r.nodeId, r.reliabilityBps, r.batchOccupancy, r.recentSelections, at);
        }
    }
}
