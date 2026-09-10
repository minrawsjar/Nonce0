// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {ForsVerifier} from "./ForsVerifier.sol";

/// @title PQKeyRegistry (§5.2) — per-account post-quantum key state.
/// @notice THE RULE THIS CONTRACT EXISTS TO ENFORCE: after registration, the
///         only thing that can change an account's PQ key is a valid signature
///         under that account's current PQ key.
///
///         There is deliberately no owner, no admin, no pause, no upgrade hatch
///         and no ECDSA guardian anywhere in this file. A quantum adversary
///         holding any such fallback would simply use it to rotate pkCommitment
///         to a key it controls, and every other line of this protocol would be
///         decoration. `msg.sender` authorises exactly one thing — the first
///         registration, which has to be paid for by somebody — and never a
///         change to an already-registered key.
contract PQKeyRegistry {
    struct PQKeyState {
        bytes32 pkCommitment;
        bytes32 nextCommitment;
        uint64 useCount;
        uint64 maxUses;
        uint64 rotationDeadline;
        uint64 disableAfter;
    }

    /// Registry actions are domain-separated from user payloads, so a signature
    /// authorising a transfer can never be replayed as a rotation. Without this
    /// a caller could hand `consume` a payload byte-identical to a rotation.
    string internal constant USER_ACTION_DOMAIN = "opaque/v1/pq-wallet/action";
    string internal constant ROTATE_DOMAIN = "opaque/v1/pq-wallet/rotate";
    string internal constant DISABLE_DOMAIN = "opaque/v1/pq-wallet/disable";
    string internal constant TAKEOVER_DOMAIN = "opaque/v1/pq-wallet/takeover";
    string internal constant PQ_DOMAIN = "opaque/v1/pq-wallet";

    uint64 public constant DISABLE_TIMELOCK = 30 days;

    mapping(address => PQKeyState) private _state;

    event Registered(address indexed account, bytes32 pkCommitment, bytes32 nextCommitment);
    event Consumed(address indexed account, uint64 useCount, bytes32 digest);
    event Rotated(address indexed account, bytes32 pkCommitment, bytes32 nextCommitment);
    event DisableInitiated(address indexed account, uint64 disableAfter);
    event TakenOver(address indexed account, bytes32 pkCommitment);

    error AlreadyRegistered();
    error NotRegistered();
    error KeyExhausted();
    error KeyDisabled();
    error TakeoverNotAllowed();
    error BadSignature();
    error InvalidParameters();

    function stateOf(address account) external view returns (PQKeyState memory) {
        return _state[account];
    }

    /// @notice Binds an account to a PQ key. Once. Every later change needs a
    ///         PQ signature, so this is the ONLY moment msg.sender matters.
    function register(
        bytes32 pkCommitment_,
        bytes32 nextCommitment_,
        uint64 maxUses_,
        uint64 rotationDeadline_
    ) external {
        if (_state[msg.sender].pkCommitment != bytes32(0)) revert AlreadyRegistered();
        if (pkCommitment_ == bytes32(0) || nextCommitment_ == bytes32(0)) revert InvalidParameters();
        // FORS is a FEW-time signature: forgery resistance decays as
        // (1 - (1 - 2^-a)^q)^k with q signatures. maxUses is a security
        // parameter, not a quota, so zero is a configuration error.
        if (maxUses_ == 0) revert InvalidParameters();

        _state[msg.sender] = PQKeyState({
            pkCommitment: pkCommitment_,
            nextCommitment: nextCommitment_,
            useCount: 0,
            maxUses: maxUses_,
            rotationDeadline: rotationDeadline_,
            disableAfter: 0
        });
        emit Registered(msg.sender, pkCommitment_, nextCommitment_);
    }

    /// @notice The §5.3 digest. Every field is load-bearing: dropping any one
    ///         reopens a replay class (cross-protocol, cross-chain,
    ///         cross-account, downgrade, or index reuse respectively).
    function digest(
        address account,
        string memory schemeId,
        uint64 useCount,
        bytes memory payload
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(PQ_DOMAIN)),
                Canonical.field(Canonical.decimal(block.chainid)),
                abi.encodePacked(uint32(20), account),
                Canonical.field(bytes(schemeId)),
                Canonical.field(Canonical.decimal(useCount)),
                Canonical.field(keccak256(payload))
            )
        );
    }

    /// @notice Verifies a signature under the account's CURRENT key and burns
    ///         the index. Reverts unless everything holds.
    /// @dev The digest binds the current useCount, so a used signature can
    ///      never verify again — the registry has already moved past it.
    function consume(address account, bytes calldata payload, bytes calldata signature) external {
        _consume(account, abi.encodePacked(USER_ACTION_DOMAIN, payload), signature);
    }

    function _consume(address account, bytes memory domainPayload, bytes calldata signature)
        private
        returns (bytes32 digestUsed)
    {
        PQKeyState storage s = _state[account];
        if (s.pkCommitment == bytes32(0)) revert NotRegistered();
        if (s.disableAfter != 0 && block.timestamp >= s.disableAfter) revert KeyDisabled();
        // Checked on EVERY verification, per §5.2, and refused rather than
        // continued past: exceeding maxUses does not merely stop being allowed,
        // it stops being safe.
        if (s.useCount >= s.maxUses) revert KeyExhausted();

        ForsVerifier.Params memory p = ForsVerifier.parseParams(signature);
        digestUsed = digest(account, ForsVerifier.schemeId(p), s.useCount, domainPayload);

        (bytes32 recovered,) = ForsVerifier.recoverCommitment(signature, digestUsed);
        if (recovered == bytes32(0) || recovered != s.pkCommitment) revert BadSignature();

        unchecked {
            s.useCount += 1;
        }
        emit Consumed(account, s.useCount, digestUsed);
    }

    /// @notice Rotation, authenticated by the CURRENT PQ key and nothing else.
    ///         Promotes the pre-committed next key and pre-commits another.
    ///         useCount resets because the key itself is new.
    function rotate(
        address account,
        bytes32 newNextCommitment,
        uint64 newMaxUses,
        uint64 newRotationDeadline,
        bytes calldata signature
    ) external {
        if (newNextCommitment == bytes32(0) || newMaxUses == 0) revert InvalidParameters();
        _consume(
            account,
            abi.encodePacked(
                ROTATE_DOMAIN,
                abi.encode(newNextCommitment, newMaxUses, newRotationDeadline)
            ),
            signature
        );

        PQKeyState storage s = _state[account];
        s.pkCommitment = s.nextCommitment;
        s.nextCommitment = newNextCommitment;
        s.useCount = 0;
        s.maxUses = newMaxUses;
        s.rotationDeadline = newRotationDeadline;
        emit Rotated(account, s.pkCommitment, newNextCommitment);
    }

    /// @notice The §5.2 escape hatch: a timelocked disable on suspected
    ///         compromise. Once elapsed the current key is permanently dead and
    ///         only the pre-committed next key can take the account over.
    function initiateDisable(address account, bytes calldata signature) external {
        _consume(account, abi.encodePacked(DISABLE_DOMAIN), signature);
        PQKeyState storage s = _state[account];
        s.disableAfter = uint64(block.timestamp) + DISABLE_TIMELOCK;
        emit DisableInitiated(account, s.disableAfter);
    }

    /// @notice The NEXT key proves itself and takes over, once the current key
    ///         can no longer act: its disable timelock has elapsed, or it has
    ///         used every signature it has. This is the one path that does not
    ///         verify under pkCommitment — it verifies under nextCommitment,
    ///         which was pre-committed by the key that is now being retired.
    ///
    ///         Exhaustion is here because without it a key that runs out
    ///         bricks everything bound to its account: rotate() and
    ///         initiateDisable() both spend a signature the key no longer has,
    ///         and an attester's address is immutable in its verifier, so every
    ///         note in that pool would be locked. It opens nothing: an exhausted
    ///         key can sign nothing here, and only the holder of the key
    ///         committed in advance can produce this signature.
    function takeover(
        address account,
        bytes32 newNextCommitment,
        uint64 newMaxUses,
        bytes calldata signature
    ) external {
        PQKeyState storage s = _state[account];
        if (s.pkCommitment == bytes32(0)) revert NotRegistered();
        bool disabled = s.disableAfter != 0 && block.timestamp >= s.disableAfter;
        if (!disabled && s.useCount < s.maxUses) revert TakeoverNotAllowed();
        if (newNextCommitment == bytes32(0) || newMaxUses == 0) revert InvalidParameters();

        ForsVerifier.Params memory p = ForsVerifier.parseParams(signature);
        bytes memory payload =
            abi.encodePacked(TAKEOVER_DOMAIN, abi.encode(newNextCommitment, newMaxUses));
        // Index 0 under the incoming key: it has never signed before.
        bytes32 d = digest(account, ForsVerifier.schemeId(p), 0, payload);

        (bytes32 recovered,) = ForsVerifier.recoverCommitment(signature, d);
        if (recovered == bytes32(0) || recovered != s.nextCommitment) revert BadSignature();

        s.pkCommitment = s.nextCommitment;
        s.nextCommitment = newNextCommitment;
        s.useCount = 1;
        s.maxUses = newMaxUses;
        s.disableAfter = 0;
        emit TakenOver(account, s.pkCommitment);
    }
}
