// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../../lib/Canonical.sol";
import {ForsVerifier} from "../ForsVerifier.sol";

/// New, opt-in registry revision. Does not modify the deployed six-field registry.
/// Only an account can consume its own authorization; no public consume(account,...).
contract AccountBoundPQKeyRegistry {
    struct PQKeyState {
        bytes32 pkCommitment;
        bytes32 nextCommitment;
        uint64 useCount;
        uint64 maxUses;
        uint64 rotationDeadline;
        uint64 disableAfter;
    }
    struct Authorization {
        bytes32 userOpHash;
        address entryPoint;
        uint256 epoch;
        uint48 validAfter;
        uint48 validUntil;
    }
    uint64 public constant DISABLE_TIMELOCK = 30 days;
    // Explicit experimental profile, not a production security certification.
    uint64 public constant MAX_USES = 8;
    uint64 public constant LIFECYCLE_RESERVE = 2;
    mapping(address => PQKeyState) private states;
    mapping(address => uint256) public keyEpoch;
    mapping(address => mapping(bytes32 => bool)) private knownKeys;
    event Registered(address indexed account, bytes32 active, bytes32 next);
    event Authorized(address indexed account, bytes32 indexed userOpHash, uint8 kind, uint256 epoch, uint64 useCount);
    event Rotated(address indexed account, bytes32 active, bytes32 next, uint256 epoch);
    event DisableInitiated(address indexed account, uint64 disableAfter);
    error InvalidState();
    error InvalidSignature();
    error InvalidAction();

    function stateOf(address account) external view returns (PQKeyState memory) { return states[account]; }

    function register(bytes32 active, bytes32 next, uint64 deadline) external {
        if (states[msg.sender].pkCommitment != 0 || active == 0 || next == 0 || active == next) revert InvalidState();
        states[msg.sender] = PQKeyState(active, next, 0, MAX_USES, deadline, 0);
        emit Registered(msg.sender, active, next);
    }

    function operationPayload(Authorization memory a) public pure returns (bytes memory) {
        return abi.encode("opaque/v1/pq-wallet/erc4337-v07", a.entryPoint, a.userOpHash, a.epoch, a.validAfter, a.validUntil);
    }

    function digest(address account, Authorization memory a, uint64 useCount) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            Canonical.field(bytes("opaque/v1/pq-wallet")), Canonical.field(Canonical.decimal(block.chainid)),
            abi.encodePacked(uint32(20), account), Canonical.field(bytes("FORS+C/keccak256/k=32,a=8")),
            Canonical.field(Canonical.decimal(useCount)), Canonical.field(keccak256(operationPayload(a)))
        ));
    }

    /// Only the account can reach its state. Its execution path calls this
    /// after an authenticated disable operation, using actual inclusion time.
    function finishDisable() external {
        PQKeyState storage s = states[msg.sender];
        if (s.pkCommitment == 0 || s.disableAfter != 0) revert InvalidState();
        s.disableAfter = uint64(block.timestamp) + DISABLE_TIMELOCK;
        emit DisableInitiated(msg.sender, s.disableAfter);
    }

    /// Called during EntryPoint validation by the immutable account implementation.
    /// Time validity is returned to EntryPoint; no TIMESTAMP opcode in validation.
    /// Kinds: 0 activate, 1 calls, 2 rotate, 3 disable, 4 next-key takeover.
    function authorize(Authorization calldata a, uint8 kind, bytes calldata data, bytes calldata signature)
        external returns (uint256 validationData, uint256 resultingEpoch)
    {
        PQKeyState storage s = states[msg.sender];
        uint256 epoch = keyEpoch[msg.sender];
        if (s.pkCommitment == 0 || a.epoch != epoch || a.validUntil == 0 || a.validAfter > a.validUntil) revert InvalidState();
        if (kind > 4) revert InvalidAction();
        uint48 afterTime = a.validAfter;
        uint48 untilTime = a.validUntil;
        bool takeover = kind == 4;
        if (takeover) {
            if (s.disableAfter == 0 || s.disableAfter > type(uint48).max) revert InvalidState();
            if (afterTime < s.disableAfter) afterTime = uint48(s.disableAfter);
        } else {
            if (s.useCount >= s.maxUses) revert InvalidState();
            if (kind <= 1 && s.useCount >= s.maxUses - LIFECYCLE_RESERVE) revert InvalidState();
            if (s.disableAfter != 0 && untilTime >= s.disableAfter) untilTime = uint48(s.disableAfter - 1);
        }
        if (afterTime > untilTime) revert InvalidState();
        ForsVerifier.Params memory p = ForsVerifier.parseParams(signature);
        if (p.k != 32 || p.a != 8) revert InvalidSignature();
        (bytes32 recovered,) = ForsVerifier.recoverCommitment(signature, digest(msg.sender, a, takeover ? 0 : s.useCount));
        if (recovered != (takeover ? s.nextCommitment : s.pkCommitment)) return (1, epoch);
        if (kind == 0) {
            if (epoch != 0 || s.useCount != 0 || data.length != 0) revert InvalidAction();
        } else if (kind == 2 || takeover) {
            (bytes32 next, uint64 deadline) = abi.decode(data, (bytes32, uint64));
            if (data.length != 64 || next == 0 || next == s.pkCommitment || next == s.nextCommitment || knownKeys[msg.sender][next]) revert InvalidAction();
            // Deadline is observational, matching the original contract; no hidden expiry policy.
            knownKeys[msg.sender][s.pkCommitment] = true;
            s.pkCommitment = s.nextCommitment;
            s.nextCommitment = next;
            s.useCount = takeover ? 1 : 0;
            s.rotationDeadline = deadline;
            if (takeover) s.disableAfter = 0;
            keyEpoch[msg.sender] = ++epoch;
            emit Rotated(msg.sender, s.pkCommitment, next, epoch);
        } else if (kind == 3) {
            if (data.length != 0 || s.disableAfter != 0) revert InvalidAction();
            // The account schedules the timer in execution, using inclusion time.
        }
        if (kind != 2 && !takeover) ++s.useCount;
        emit Authorized(msg.sender, a.userOpHash, kind, epoch, s.useCount);
        return ((uint256(untilTime) << 160) | (uint256(afterTime) << 208), epoch);
    }
}
