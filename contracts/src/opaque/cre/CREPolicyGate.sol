// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {IPQKeyRegistry} from "../interfaces/IPQKeyRegistry.sol";
import {ICREPolicyGate} from "./ICREPolicyGate.sol";

/// @title One-shot settlement authorizations, published under a post-quantum key.
/// @notice The CRE verifies the ring proof off-chain and publishes the RESULT
///         here; a pool then consumes it exactly once to move funds.
///
/// @dev WHAT CHANGED, AND WHY IT HAD TO.
///
///      This gate previously authorised `publish` with `msg.sender ==
///      crePublisher` — a plain secp256k1 address. That put an elliptic-curve
///      key on the mint path of every CRE pool: whoever held it could publish
///      an authorization for any nullifier, to any recipient, and drain the
///      pool. In a protocol whose entire claim is that no elliptic curve sits
///      anywhere in its application crypto, that was the one place the claim
///      was not true, and it was the place that mattered most.
///
///      There is a real distinction being drawn here, not a purity argument.
///      Every transaction on an EVM chain is ECDSA-signed by whoever pays the
///      gas, and that is unavoidable. What is avoidable is making the AUTHORITY
///      TO MOVE FUNDS an ECDSA key. PrivatePool never did: `msg.sender` there
///      pays for a deposit and authorises nothing. This contract now matches.
///
///      Authority is a FORS+C signature verified through PQKeyRegistry, which
///      also enforces the few-time bound that makes such a signature safe.
///      `msg.sender` authorises nothing at all any more, so anyone may relay a
///      signed batch — the CRE needs neither gas nor a hot key of its own, and
///      a compromised relayer can only pay for a batch it cannot alter.
///
///      Batching is what makes a few-time key practical here. FORS security
///      decays with every signature under one key, so one signature per payment
///      would exhaust a key in a day. One signature covers a whole batch, which
///      is also exactly the unit CREBatchSettlement settles.
contract CREPolicyGate is ICREPolicyGate {
    string internal constant PUBLISH_DOMAIN = "opaque/v1/cre/publish";

    IPQKeyRegistry public immutable registry;
    /// The account whose PQ key signs authorizations. Immutable: an attester
    /// that could be swapped after deployment is an admin key over every pool
    /// pointing at this gate. Changing who attests means a new gate.
    address public immutable attester;

    mapping(bytes32 => Authorization) private _authorizations;
    mapping(bytes32 => bool) public consumed;

    error Duplicate();
    error InvalidAuthorization();
    error NotPool();
    error Expired();
    error AlreadyConsumed();
    error EmptyBatch();

    event Published(bytes32 indexed id, bytes32 indexed spendHash, bytes32 indexed nullifier, address pool);
    event Consumed(bytes32 indexed id, address indexed pool);

    constructor(IPQKeyRegistry registry_, address attester_) {
        if (address(registry_) == address(0) || attester_ == address(0)) revert InvalidAuthorization();
        registry = registry_;
        attester = attester_;
    }

    /// @notice The exact bytes the attester signs for a batch.
    /// @dev Length-prefixed through Canonical, and the COUNT first. Joining
    ///      these with separators is a forgery: without a count, one
    ///      authorization whose fields contained the separator could be
    ///      re-split into two, and a signature issued for one settlement would
    ///      authorise a second nobody approved.
    function publishPayload(Authorization[] calldata list) public pure returns (bytes memory payload) {
        payload = abi.encodePacked(
            Canonical.field(bytes(PUBLISH_DOMAIN)),
            Canonical.field(Canonical.decimal(list.length))
        );
        for (uint256 i = 0; i < list.length; i++) {
            Authorization calldata a = list[i];
            payload = abi.encodePacked(
                payload,
                Canonical.field(a.id),
                Canonical.field(a.spendHash),
                Canonical.field(a.nullifier),
                abi.encodePacked(uint32(20), a.pool),
                abi.encodePacked(uint32(20), a.recipient),
                abi.encodePacked(uint32(20), a.feeCollector),
                Canonical.field(Canonical.decimal(a.grossAmount)),
                Canonical.field(Canonical.decimal(a.feeAmount)),
                Canonical.field(Canonical.decimal(a.feeBps)),
                Canonical.field(Canonical.decimal(a.expiresAt))
            );
        }
    }

    /// @notice Records a signed batch. Reverts unless every entry is well
    ///         formed and the signature verifies under the attester's current
    ///         post-quantum key.
    function publish(Authorization[] calldata list, bytes calldata signature) external {
        if (list.length == 0) revert EmptyBatch();

        // Validate BEFORE spending the signing index. A batch with one bad
        // entry must not burn a few-time index it was never going to use.
        for (uint256 i = 0; i < list.length; i++) {
            Authorization calldata a = list[i];
            if (
                a.id == bytes32(0) || a.pool == address(0) || a.recipient == address(0)
                    || a.feeCollector == address(0) || a.grossAmount == 0 || a.feeAmount >= a.grossAmount
                    || a.feeBps > 10_000 || a.expiresAt <= block.timestamp
            ) revert InvalidAuthorization();
            if (_authorizations[a.id].id != bytes32(0)) revert Duplicate();
        }

        // Reverts unless the signature verifies under the attester's live key
        // and that key has budget left. There is no branch after this.
        registry.consume(attester, publishPayload(list), signature);

        for (uint256 i = 0; i < list.length; i++) {
            Authorization calldata a = list[i];
            _authorizations[a.id] = a;
            emit Published(a.id, a.spendHash, a.nullifier, a.pool);
        }
    }

    function authorizationOf(bytes32 id) external view returns (Authorization memory) {
        return _authorizations[id];
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
