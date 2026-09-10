// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Canonical} from "../lib/Canonical.sol";
import {IPQKeyRegistry} from "../interfaces/IPQKeyRegistry.sol";
import {IERC7579Validator, PackedUserOperation} from "../interfaces/IERC4337.sol";

/// @title PQValidator (§5.4) — the ERC-7579/4337 validator for a PQ account.
/// @notice The UserOperation's signature field carries a FORS+C signature, and
///         nothing else can authorise the account: this contract hands it to
///         PQKeyRegistry.consume, which checks useCount < maxUses and the
///         disable timelock, verifies against pkCommitment under the §5.3
///         digest, and burns the index. There is no ECDSA path, owner or
///         fallback here to fall back to.
///
///         Stateless and shared: the account is always msg.sender, so one
///         validator serves every account and holds no storage a bundler's
///         ERC-7562 rules would have to reason about.
contract PQValidator is IERC7579Validator {
    /// §5.3's "keccak256(payload)" for a UserOperation: the WHOLE operation.
    /// The v0.7 userOpHash commits to the sender, nonce, initCode, callData,
    /// gas limits and fees, paymaster, EntryPoint and chain, so a signature over
    /// it authorises that operation and no reduced target/value/calldata view
    /// of it. Tagged so it can never collide with another action's payload.
    string public constant USER_OPERATION_DOMAIN = "opaque/v1/pq-account/user-operation";

    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    uint256 internal constant MODULE_TYPE_VALIDATOR = 1;
    /// ERC-1271's "invalid" value.
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;

    IPQKeyRegistry public immutable registry;

    error NotRegistered();
    error CannotUninstall();

    constructor(IPQKeyRegistry registry_) {
        registry = registry_;
    }

    /// The account registers its own key (register is bound to msg.sender);
    /// installing only confirms that it did.
    function onInstall(bytes calldata) external view {
        if (!isInitialized(msg.sender)) revert NotRegistered();
    }

    /// Refused. A PQ account without its PQ validator has no signer at all,
    /// and swapping in another is exactly the fallback §5.2 rules out.
    function onUninstall(bytes calldata) external pure {
        revert CannotUninstall();
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address smartAccount) public view returns (bool) {
        return registry.stateOf(smartAccount).pkCommitment != bytes32(0);
    }

    /// @notice Called by the account (msg.sender) from its validateUserOp.
    ///         A bad signature, an exhausted or disabled key all return
    ///         SIG_VALIDATION_FAILED instead of reverting, which is what lets a
    ///         bundler simulate an operation with a placeholder signature.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256) {
        try registry.consume(msg.sender, userOperationPayload(userOpHash), userOp.signature) {
            return VALIDATION_SUCCESS;
        } catch {
            return SIG_VALIDATION_FAILED;
        }
    }

    /// Never valid. ERC-1271 lets anyone re-check one signature any number of
    /// times, and a few-time key cannot offer a reusable signature without
    /// spending an index it can never get back.
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_INVALID;
    }

    /// The payload a wallet signs for a UserOperation. Public so the client and
    /// the tests build it from the contract, not from a second copy.
    function userOperationPayload(bytes32 userOpHash) public pure returns (bytes memory) {
        return abi.encodePacked(Canonical.field(bytes(USER_OPERATION_DOMAIN)), Canonical.field(userOpHash));
    }
}
