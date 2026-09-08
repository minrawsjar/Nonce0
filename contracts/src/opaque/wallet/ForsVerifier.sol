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

    /// Scratch buffers and the constant words read back out of them. Held in
    /// memory rather than on the stack: the hot loop needs more live values
    /// than the stack can hold once assembly blocks pin them down.
    struct Scratch {
        uint256 ip;
        uint256 iTail;
        uint256 iLen;
        uint256 lp;
        uint256 lMid;
        uint256 lLen;
        uint256 np;
        uint256 nMid;
        uint256 nLen;
        uint256 rp;
        uint256 rHeader;
        uint256 rLen;
    }

    /// @dev Every buffer is laid out by abi.encodePacked ONCE, with the varying
    ///      fields zeroed, and the constant words are then read back out of it.
    ///      Nothing hardcodes an offset table that could drift from the
    ///      encoding the TypeScript agrees to.
    function _scratch(Params memory p, bytes32 digest) private pure returns (Scratch memory s) {
        bytes memory ib = abi.encodePacked(
            uint32(bytes(INDEX_DOMAIN).length), INDEX_DOMAIN,
            uint32(4), uint32(p.k), uint32(4), uint32(p.a),
            uint32(32), digest, uint32(4), uint32(0)
        );
        bytes memory lb = abi.encodePacked(
            uint32(bytes(LEAF_DOMAIN).length), LEAF_DOMAIN,
            uint32(4), uint32(0), uint32(4), uint32(0), uint32(32), bytes32(0)
        );
        bytes memory nb = abi.encodePacked(
            uint32(bytes(NODE_DOMAIN).length), NODE_DOMAIN,
            uint32(4), uint32(0), uint32(4), uint32(0),
            uint32(32), bytes32(0), uint32(32), bytes32(0)
        );
        bytes memory rb = abi.encodePacked(
            uint32(bytes(ROOTS_DOMAIN).length), ROOTS_DOMAIN,
            uint32(4), uint32(p.k), uint32(4), uint32(p.a),
            new bytes(uint256(p.k) * 36)
        );
        s.iLen = ib.length;
        s.lLen = lb.length;
        s.nLen = nb.length;
        s.rLen = rb.length;
        s.rHeader = s.rLen - uint256(p.k) * 36;
        assembly {
            let q := add(ib, 32)
            mstore(s, q)
            mstore(add(s, 32), mload(add(q, 52)))
            q := add(lb, 32)
            mstore(add(s, 96), q)
            mstore(add(s, 128), mload(add(q, 7)))
            q := add(nb, 32)
            mstore(add(s, 192), q)
            mstore(add(s, 224), mload(add(q, 7)))
            mstore(add(s, 288), add(rb, 32))
        }
    }

    /// @notice Verifies a FORS+C signature and returns the pkCommitment it
    ///         proves knowledge under. The caller compares that to the
    ///         registered commitment — this library never trusts a claimed key.
    ///
    /// @dev Preimages are poked into fixed scratch buffers rather than built
    ///      with abi.encodePacked. Measured on this circuit: 322 keccak calls
    ///      cost 41k gas of actual hashing and 457k when each preimage is a
    ///      fresh nested allocation. The hashing was never the expensive part.
    function recoverCommitment(bytes calldata signature, bytes32 digest)
        internal
        pure
        returns (bytes32 commitment, Params memory p)
    {
        p = parseParams(signature);
        Scratch memory s = _scratch(p, digest);
        uint256 mask = (uint256(1) << p.a) - 1;
        uint256 stride = 32 * (1 + uint256(p.a));

        for (uint256 i = 0; i < p.k; i++) {
            uint256 index;
            assembly {
                mstore(add(mload(s), 52), or(mload(add(s, 32)), i))
                index := and(shr(192, keccak256(mload(s), mload(add(s, 64)))), mask)
            }

            uint256 at = HEADER_BYTES + 32 + i * stride;
            bytes32 node = bytes32(signature[at:at + 32]);
            assembly {
                let lp := mload(add(s, 96))
                mstore(add(lp, 7), or(mload(add(s, 128)), or(shl(64, i), index)))
                mstore(add(lp, 43), node)
                node := keccak256(lp, mload(add(s, 160)))
            }

            for (uint256 l = 0; l < p.a; l++) {
                bytes32 sibling = bytes32(signature[at + 32 + l * 32:at + 64 + l * 32]);
                // Sibling order is the index bit at this level. Getting it
                // backwards still hashes, and is still wrong.
                (bytes32 left, bytes32 right) =
                    ((index >> l) & 1) == 0 ? (node, sibling) : (sibling, node);
                assembly {
                    let np := mload(add(s, 192))
                    mstore(add(np, 7), or(mload(add(s, 224)), or(shl(64, i), l)))
                    mstore(add(np, 43), left)
                    mstore(add(np, 79), right)
                    node := keccak256(np, mload(add(s, 256)))
                }
            }

            assembly {
                let slot := add(add(mload(add(s, 288)), mload(add(s, 320))), mul(i, 36))
                mstore(slot, shl(224, 32))
                mstore(add(slot, 4), node)
            }
        }

        bytes32 recomputed;
        assembly {
            recomputed := keccak256(mload(add(s, 288)), mload(add(s, 352)))
        }

        // The recomputed roots must reproduce the public key value the
        // signature carries; only then is that value worth committing to.
        if (recomputed != publicKeyValue(signature)) return (bytes32(0), p);
        commitment = pkCommitment(p, publicKeyValue(signature));
    }

    /// @notice The readable implementation of exactly the same function, built
    ///         out of the plain abi.encodePacked helpers above.
    /// @dev Not used in verification. It exists so the assembly can never
    ///      quietly drift from the encoding it claims to implement: the test
    ///      suite asserts the two agree on real signatures, and on tampered
    ///      ones. It is also the honest baseline for the gas comparison —
    ///      measured the same way, in the same place, on the same input.
    function recoverCommitmentReference(bytes calldata signature, bytes32 digest)
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

        if (keccak256(roots) != claimedValue) return (bytes32(0), p);
        commitment = pkCommitment(p, claimedValue);
    }
}
