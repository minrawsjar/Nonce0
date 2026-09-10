// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {IPrivatePool} from "../interfaces/IPrivatePool.sol";
import {ISpendVerifier} from "../interfaces/ISpendVerifier.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title PrivatePool (§6.6) — note-based pooled custody, one fixed denomination.
/// @notice There is deliberately no `mapping(address => uint256)` in this
///         contract. A deposit creates an opaque commitment, and a balance is
///         nothing but the set of notes someone holds secrets for. That is the
///         whole reason pooled custody exists: if each wallet moved its own
///         tokens, the transfer's `from` would name the spender and every
///         other privacy mechanism here would be decoration.
///
///         Fixed denomination, immutable. Variable amounts need homomorphic
///         value commitments and range proofs, which are elliptic-curve
///         constructions and would crack the "no EC anywhere" posture at the
///         amount-hiding layer (§6.6).
contract PrivatePool is IPrivatePool {
    string internal constant POOL_ID_DOMAIN = "opaque/v1/pool-id";
    string internal constant PAYMENT_DOMAIN = "opaque/v1/payment";
    string internal constant SPEND_COMMIT_DOMAIN = "opaque/v1/spend-commit";

    /// Long enough that a reveal cannot be sandwiched by a fresh commit in the
    /// same or the next block, short enough to stay usable.
    uint256 public constant COMMIT_DELAY_BLOCKS = 2;
    /// A commitment that is never revealed must not pin storage forever.
    uint256 public constant COMMIT_EXPIRY_BLOCKS = 7200;

    IERC20 public immutable token;
    uint256 public immutable denomination;
    ISpendVerifier public immutable verifier;
    bytes32 public immutable poolId;

    mapping(bytes32 => bool) private _commitments;
    mapping(bytes32 => bool) private _nullifiers;
    mapping(bytes32 => uint256) private _spendCommitBlock;

    uint256 public depositCount;

    event Deposited(bytes32 indexed commitment, uint256 index);
    event SpendCommitted(bytes32 indexed spendCommitment, uint256 atBlock);
    event Spent(bytes32 indexed nullifier, address indexed recipient, uint256 amount);
    /// §8.1: who funded a note, for the funding-cluster heuristic. A deposit is
    /// attributable by design (§4); this only says so where an indexer can read
    /// it — under ERC-4337 the transaction's sender is the bundler, not the
    /// account that deposited.
    event DepositFrom(bytes32 indexed commitment, address indexed depositor);
    /// §8.1: the members of a ring that was used, for AGGREGATE per-member use
    /// counts. Every member is already in the spend's calldata; this carries no
    /// nullifier and no recipient, and is never emitted for a one-note "ring",
    /// which would name the note it opened.
    event RingUsed(bytes32[] ring);

    error UnknownCommitment();
    error DuplicateCommitment();
    error NullifierAlreadySpent();
    error WrongRingSize();
    error TransferFailed();
    error NotCommitted();
    error CommitTooRecent();
    error CommitExpired();
    error AlreadyCommitted();
    error ZeroRecipient();

    constructor(IERC20 token_, uint256 denomination_, ISpendVerifier verifier_) {
        token = token_;
        denomination = denomination_;
        verifier = verifier_;
        poolId = keccak256(
            abi.encodePacked(
                Canonical.field(bytes(POOL_ID_DOMAIN)),
                Canonical.field(Canonical.decimal(block.chainid)),
                abi.encodePacked(uint32(20), address(this))
            )
        );
    }

    function capabilities() external view returns (Capabilities memory) {
        return Capabilities({
            proofMode: verifier.proofMode(),
            ringSize: verifier.ringSize(),
            verifierId: verifier.verifierId(),
            denomination: denomination,
            requiresCommitReveal: verifier.requiresCommitReveal()
        });
    }

    function isNullifierSpent(bytes32 nullifier) external view returns (bool) {
        return _nullifiers[nullifier];
    }

    function isCommitmentKnown(bytes32 commitment) external view returns (bool) {
        return _commitments[commitment];
    }

    /// @notice Attributable by design. §4 is explicit that the deposit is a
    ///         disclosed event and only the later spend is anonymous.
    function deposit(bytes32 commitment) external {
        if (_commitments[commitment]) revert DuplicateCommitment();
        _commitments[commitment] = true;
        uint256 index = depositCount++;
        // State before the external call: a reentrant token cannot observe a
        // half-written pool, and cannot deposit twice against one transfer.
        if (!token.transferFrom(msg.sender, address(this), denomination)) revert TransferFailed();
        emit Deposited(commitment, index);
        emit DepositFrom(commitment, msg.sender);
    }

    /// @notice Phase one of the two-phase spend. The commitment binds the
    ///         recipient and the proof before either is public, so watching the
    ///         reveal is useless: an attacker who learns the secret at reveal
    ///         time still has no earlier commit of their own, and creating one
    ///         costs COMMIT_DELAY_BLOCKS — by which time the nullifier is spent.
    function commitSpend(bytes32 commitment) external {
        if (_spendCommitBlock[commitment] != 0) revert AlreadyCommitted();
        _spendCommitBlock[commitment] = block.number;
        emit SpendCommitted(commitment, block.number);
    }

    function spendCommitment(bytes32[] calldata ring, bytes calldata proof, address recipient, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(SPEND_COMMIT_DOMAIN)),
                Canonical.field(keccak256(abi.encode(ring))),
                Canonical.field(keccak256(proof)),
                abi.encodePacked(uint32(20), recipient),
                Canonical.field(salt)
            )
        );
    }

    function paymentContext(address recipient) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(PAYMENT_DOMAIN)),
                Canonical.field(poolId),
                Canonical.field(Canonical.decimal(block.chainid)),
                abi.encodePacked(uint32(20), recipient),
                Canonical.field(Canonical.decimal(denomination))
            )
        );
    }

    /// @notice Phase two. Order is load-bearing: every ring member must be a
    ///         real deposit, the proof must verify, and the nullifier must be
    ///         marked spent BEFORE any token moves.
    function spend(bytes32[] calldata ring, bytes calldata proof, address recipient, bytes32 salt)
        external
    {
        if (recipient == address(0)) revert ZeroRecipient();
        if (ring.length != verifier.ringSize()) revert WrongRingSize();

        if (verifier.requiresCommitReveal()) {
            bytes32 sc = spendCommitment(ring, proof, recipient, salt);
            uint256 at = _spendCommitBlock[sc];
            if (at == 0) revert NotCommitted();
            if (block.number < at + COMMIT_DELAY_BLOCKS) revert CommitTooRecent();
            if (block.number > at + COMMIT_EXPIRY_BLOCKS) revert CommitExpired();
            delete _spendCommitBlock[sc];
        }

        for (uint256 i = 0; i < ring.length; i++) {
            if (!_commitments[ring[i]]) revert UnknownCommitment();
        }

        bytes32 nullifier = verifier.verifySpend(ring, proof, paymentContext(recipient));
        if (_nullifiers[nullifier]) revert NullifierAlreadySpent();
        _nullifiers[nullifier] = true;

        // The event names the nullifier and the recipient — both public at
        // settlement per §3 — and never a ring member. An event tying a
        // nullifier to the commitment it opened would undo the ring from the
        // indexing side, which is the §8 hard constraint.
        emit Spent(nullifier, recipient, denomination);
        if (ring.length > 1) emit RingUsed(ring);

        if (!token.transfer(recipient, denomination)) revert TransferFailed();
    }
}
