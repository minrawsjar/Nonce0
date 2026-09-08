// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";

/// @title FORS+C verification on-chain (§5.1).
/// @notice A few-time hash-based signature. Verification is pure keccak — no
///         elliptic curve, no precompile, nothing a quantum adversary breaks.
///
///         Unlike the ring proof (§6.3, measured at ~9x an Arc block and
///         therefore NOT verifiable on-chain), this one fits comfortably. That
///         asymmetry is the point: wallet authorisation is on-chain and
///         quantum-safe today; sender anonymity is the part that is not.
///
/// @dev FEW-time, not many-time. Forgery resistance is (1 - (1 - 2^-a)^q)^k
///      after q signatures: at k=32, a=8 that is 2^-256 at one signature,
///      2^-160 at eight, 2^-121 at thirty-two. Security DEGRADES with every
///      signature, which is why PQKeyRegistry enforces maxUses rather than
///      treating it as a quota.
library ForsVerifier {
    using Canonical for bytes;
    using Canonical for bytes32;

    string internal constant LEAF_DOMAIN = "opaque/v1/fors/leaf";
    string internal constant NODE_DOMAIN = "opaque/v1/fors/node";
    string internal constant ROOTS_DOMAIN = "opaque/v1/fors/roots";
    string internal constant INDEX_DOMAIN = "opaque/v1/fors/index";
    string internal constant PK_COMMITMENT_DOMAIN = "opaque/v1/fors/pk-commitment";

    error MalformedSignature();
    error UnsupportedParameters();

    /// Wire format, fixed width and exact length:
    ///   k (uint16 BE) | a (uint8) | pk value (32) | k * (leaf 32 | path a*32)
    uint256 internal constant HEADER_BYTES = 3;

    struct Params {
        uint16 k;
        uint8 a;
    }

    function parseParams(bytes calldata signature) internal pure returns (Params memory p) {
        if (signature.length < HEADER_BYTES) revert MalformedSignature();
        p.k = uint16(bytes2(signature[0:2]));
        p.a = uint8(signature[2]);
        if (p.k < 1 || p.k > 64 || p.a < 1 || p.a > 20) revert UnsupportedParameters();
        if (signature.length != encodedLength(p)) revert MalformedSignature();
    }

    function encodedLength(Params memory p) internal pure returns (uint256) {
        return HEADER_BYTES + 32 + uint256(p.k) * 32 * (1 + uint256(p.a));
    }

    function publicKeyValue(bytes calldata signature) internal pure returns (bytes32) {
        return bytes32(signature[HEADER_BYTES:HEADER_BYTES + 32]);
    }

    /// @notice The bytes32 the registry stores. Binds the PARAMETERS as well as
    ///         the key, so a public key can never be re-presented under a
    ///         weaker (k, a) — that is the downgrade this commitment prevents.
    function pkCommitment(Params memory p, bytes32 value) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(PK_COMMITMENT_DOMAIN)),
                Canonical.u32Field(uint32(p.k)),
                Canonical.u32Field(uint32(p.a)),
                Canonical.field(value)
            )
        );
    }

    /// @notice The canonical scheme identifier that goes into the §5.3 digest,
    ///         so a signature can never be reinterpreted under other parameters.
    function schemeId(Params memory p) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                "FORS+C/keccak256/k=",
                Canonical.decimal(p.k),
                ",a=",
                Canonical.decimal(p.a)
            )
        );
    }

    /// @dev One leaf index per tree, each `a` bits wide, derived by a separate
    ///      domain-separated hash of the digest. FIPS 205 splits the digest
    ///      itself, which caps k*a at 256; this keeps (k, a) free so §5.1 can
    ///      move the parameter set after benchmarking.
    function deriveIndex(Params memory p, bytes32 digest, uint32 i) internal pure returns (uint32) {
        bytes32 stream = keccak256(
            abi.encodePacked(
                Canonical.field(bytes(INDEX_DOMAIN)),
                Canonical.u32Field(uint32(p.k)),
                Canonical.u32Field(uint32(p.a)),
                Canonical.field(digest),
                Canonical.u32Field(i)
            )
        );
        uint64 acc = uint64(bytes8(stream));
        return uint32(acc & ((uint64(1) << p.a) - 1));
    }

    function leafNode(uint32 tree, uint32 index, bytes32 secret) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(LEAF_DOMAIN)),
                Canonical.u32Field(tree),
                Canonical.u32Field(index),
                Canonical.field(secret)
            )
        );
    }

    /// @dev `level` is the level of the two CHILDREN, so a node's height is
    ///      bound into its hash. Without that a sibling could be replayed at a
    ///      different depth.
    function internalNode(uint32 tree, uint32 level, bytes32 left, bytes32 right)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                Canonical.field(bytes(NODE_DOMAIN)),
                Canonical.u32Field(tree),
                Canonical.u32Field(level),
                Canonical.field(left),
                Canonical.field(right)
            )
        );
    }

    /// @notice Verifies a FORS+C signature and returns the pkCommitment it
    ///         proves knowledge under. The caller compares that to the
    ///         registered commitment — this library never trusts a claimed key.
    function recoverCommitment(bytes calldata signature, bytes32 digest)
        internal
        pure
        returns (bytes32 commitment, Params memory p)
    {
        p = parseParams(signature);
        bytes32 claimedValue = publicKeyValue(signature);

        bytes memory roots = abi.encodePacked(
            Canonical.field(bytes(ROOTS_DOMAIN)),
            Canonical.u32Field(uint32(p.k)),
            Canonical.u32Field(uint32(p.a))
        );

        uint256 stride = 32 * (1 + uint256(p.a));
        uint256 base = HEADER_BYTES + 32;

        for (uint32 i = 0; i < p.k; i++) {
            uint256 at = base + uint256(i) * stride;
            uint32 index = deriveIndex(p, digest, i);
            bytes32 node = leafNode(i, index, bytes32(signature[at:at + 32]));

            for (uint32 l = 0; l < p.a; l++) {
                bytes32 sibling = bytes32(signature[at + 32 + uint256(l) * 32:at + 64 + uint256(l) * 32]);
                node = ((index >> l) & 1) == 0
                    ? internalNode(i, l, node, sibling)
                    : internalNode(i, l, sibling, node);
            }
            roots = abi.encodePacked(roots, Canonical.field(node));
        }

        // The recomputed roots must reproduce the public key value the
        // signature carries; only then is that value worth committing to.
        if (keccak256(roots) != claimedValue) return (bytes32(0), p);
        commitment = pkCommitment(p, claimedValue);
    }
}
