# PQGuard

A post-quantum authorization layer that existing protocols install without redeploying or rewriting core logic.

**Design axiom: AND, never OR.** PQGuard never replaces ECDSA. Every protected call must satisfy the protocol's existing authorization *and* a hash-based signature. A break in either scheme alone is survivable. This is the only composition that lets a live protocol adopt an unproven module without adding a new single point of failure.

---

## 1. Threat model

### In scope

| Attack | Mechanism | PQGuard response |
|---|---|---|
| Admin key recovery | Shor on an exposed secp256k1 pubkey of a proxy admin, Safe owner, or timelock proposer | Second factor the quantum adversary cannot forge |
| Governance capture | Recovered signer keys reach quorum on a Safe | Same |
| Offchain auth forgery | Forged EIP-712 permits, oracle signer sets, bridge attestations | PQ co-signature bound into the message digest |
| Unpatchable soundness break | Pairing verifier is immutable, toxic waste becomes recoverable | Containment only: rate limits, turnstiles, delay windows |

### Explicitly out of scope

- **Retroactive decryption.** Every ECIES-encrypted note and ECDH stealth address already onchain is permanently exposed. No module fixes this.
- **Immutable verifier soundness.** If a deployed Groth16 verifier is your mint authority, PQGuard cannot make it sound. It can only cap the drain rate.
- **Hot-path signatures.** See gas analysis in §7. PQGuard is for privileged and high-value calls, not per-swap authorization.
- **Consensus, DA, and blob commitments.** Protocol-layer, not addressable from an application module.

### Adversary model

A quantum adversary that can derive any secp256k1 private key from any onchain-exposed public key, in the time it takes to run a transaction. It has no preimage or collision advantage on 256-bit hashes beyond Grover, which the 256-bit output size already absorbs down to a 128-bit security floor (NIST Level 1).

---

## 2. Architecture

```
                        ┌────────────────────────┐
                        │   PQKeyRegistry        │  singleton
                        │   key state, rotation  │
                        └───────────┬────────────┘
                                    │
                        ┌───────────▼────────────┐
                        │   PQGuardCore          │  singleton
                        │   digest, replay, auth │
                        └───────────┬────────────┘
                    ┌───────────────┼───────────────┐
                    │               │               │
          ┌─────────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────┐
          │ IPQVerifier    │ │ IPQPolicy    │ │ Containment    │
          │ FORS+C, WOTS+C │ │ what to      │ │ rate limits,   │
          │ SLH-DSA        │ │ protect      │ │ turnstiles     │
          └────────────────┘ └──────────────┘ └────────────────┘

  Adapters (one per host system, all stateless):
    PQSafeGuard        Safe ITransactionGuard
    PQValidator        ERC-7579 / ERC-4337 validator module
    PQOwnableAdapter   Ownable / AccessControl contracts
    PQTimelockGate     OZ TimelockController proposer gate
    PQPermitVerifier   offchain EIP-712 co-signature checker
```

Singletons are deployed once per chain at deterministic addresses. Integrators deploy nothing. They register a key and enable one adapter.

---

## 3. Key state

The verifier is the easy part. **Key state is where this protocol lives or dies.** Hash-based signatures are one-time or few-time, so a stateful, monotonic, replay-proof counter is a hard requirement, not a nicety.

```solidity
struct KeyState {
    bytes32 pkCommitment;      // H(public key) of the active key
    bytes32 nextCommitment;    // pre-committed successor, hash-chained
    uint32  schemeId;          // resolves to an IPQVerifier
    uint32  useCount;          // monotonic, bound into every digest
    uint32  maxUses;           // hard cap; scheme-dependent
    uint64  rotationDeadline;  // rotation required by this timestamp
    uint64  disableAfter;      // 0 = enabled; else escape-hatch unlock time
}

mapping(address account => KeyState) public keys;
```

### Rotation

Rotation is authenticated **by the current PQ key**, never by ECDSA. Otherwise the quantum adversary rotates your key for you and the whole module is theatre.

1. At registration the owner commits to `pkCommitment` and `nextCommitment = H(pk_{n+1})`.
2. To rotate, the owner reveals `pk_{n+1}`, signs the rotation message with key *n*, and supplies `nextCommitment_{n+1}`.
3. `useCount` resets, `rotationDeadline` extends.

This is a hash chain of commitments. Compromise of the ECDSA path cannot advance it.

### Exhaustion

`useCount` is bound into the signed digest, so a signature is valid at exactly one index. When `useCount >= maxUses` the registry rejects further use and emits `KeyExhausted`. Recommended `maxUses` for FORS+C is conservative and parameter-dependent; treat the few-time bound as a budget, not a target. WOTS+C is strictly `maxUses = 1`.

### Escape hatch

A lost PQ key must not brick a protocol permanently. `requestDisable()` is callable by the existing ECDSA authority and starts a **long, loud timelock** (recommended 30 days, integrator-configurable with an enforced floor). Every block of that window is a public alarm. A quantum adversary holding your ECDSA keys can start it too, which is precisely why the delay is measured in weeks and emits an event on every block explorer.

Fail-closed otherwise: if the verifier is unset, paused, or the key is exhausted, protected calls revert.

---

## 4. Digest construction

```solidity
bytes32 digest = keccak256(abi.encode(
    PQ_DOMAIN,          // constant, distinguishes from EIP-712 and everything else
    block.chainid,
    address(this),      // PQGuardCore, pinned
    account,            // the protected account
    schemeId,           // prevents cross-scheme replay
    useCount,           // monotonic, one signature per index
    keccak256(payload)  // adapter-specific, see below
));
```

Every field is load-bearing. Dropping `schemeId` allows a downgrade replay across verifiers; dropping `useCount` breaks the one-time property; dropping `chainid` allows cross-chain replay of governance actions on multi-chain deployments.

`payload` is canonicalized per adapter and must cover the **full** call:

| Adapter | payload |
|---|---|
| Safe | `abi.encode(to, value, keccak256(data), operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver)` |
| ERC-7579 | the UserOp hash |
| Ownable | `abi.encode(target, selector, keccak256(callData), value, deadline)` |
| Timelock | the operation id |
| EIP-712 permit | `abi.encode(originalTypedDataHash, deadline)` |

Note the Safe payload deliberately omits `nonce`. At `checkTransaction` time the Safe nonce has already been incremented, making it ambiguous to reconstruct. The registry's own `useCount` provides strictly stronger replay protection, so binding the parameter tuple is sufficient.

---

## 5. Verifier interface

```solidity
interface IPQVerifier {
    /// @notice Stateless verification. All state lives in PQKeyRegistry.
    /// @return ok            signature valid under pkCommitment
    /// @return revealedNext  successor commitment revealed by this signature, or 0
    function verify(
        bytes32 digest,
        bytes calldata signature,
        bytes32 pkCommitment
    ) external view returns (bool ok, bytes32 revealedNext);

    function schemeId() external pure returns (uint32);
    function maxUsesRecommended() external pure returns (uint32);
    function isFewTime() external pure returns (bool);
}
```

Verifiers are pure functions of their inputs, which makes them independently auditable and hot-swappable. Registration of a new `schemeId` goes through a governance delay so a malicious verifier cannot be slotted in instantly.

### Scheme selection

**Default: FORS+C.** Roughly 2448-byte signatures and roughly 35k verification gas at NIST Level 1 on published onchain implementations, with graceful degradation on accidental reuse. That last property is why it beats WOTS+C as the default: the realistic failure mode of this system is a key-state bug, not a cryptanalytic break, and the scheme should not be catastrophic when the state machine slips.

**WOTS+C** is offered for integrators who want smaller signatures (roughly 468 bytes, roughly 73k verify gas) and can guarantee strict single use, for example a one-shot break-glass key.

**SLH-DSA (SPHINCS+, FIPS 205)** is included as a stateless option for integrators who cannot tolerate any key-state requirement, at substantially higher cost. It is the correct choice for an emergency recovery key used approximately never.

**ML-DSA** is stubbed. Lattice verification is not economical in the EVM today, but the roadmap includes PQ signature verification precompiles at a later milestone. When that lands, it becomes a verifier registration, not a redesign.

Do not use any of these keys for encryption. Signing only.

---

## 6. Adapters

### 6.1 Safe

```solidity
contract PQSafeGuard is ITransactionGuard {
    function checkTransaction(
        address to, uint256 value, bytes calldata data, Enum.Operation op,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice,
        address gasToken, address payable refundReceiver,
        bytes memory signatures, address msgSender
    ) external override {
        if (!policy.requiresPQ(msg.sender, to, value, data, op)) return;
        PQEnvelope memory env = _extractEnvelope(signatures);
        core.authorize(msg.sender, _payload(to, value, data, op, /*...*/), env);
    }
    function checkAfterExecution(bytes32, bool) external override {}
}
```

Safe's guard hook receives the raw `signatures` blob. Safe validates the first `threshold` slots and, for contract signatures, dynamic segments referenced by offset. Trailing bytes beyond that are not validated by Safe itself, so the PQ envelope is appended with a magic suffix and a length prefix, and located by scanning backward from the end.

**This is the sharpest edge in the whole design.** It depends on the layout tolerance of a specific Safe version. The adapter must:
- pin supported Safe versions explicitly and revert on anything else,
- reject any envelope that overlaps a region Safe interprets as a contract-signature dynamic segment,
- ship a fuzz suite over `(threshold, ownerCount, contractSigCount, envelopeLength)`.

**Fallback path** for hosts where the auth blob cannot be extended: two-phase `arm()`. The signer submits `PQGuardCore.arm(account, digest, signature)` in a prior transaction, which stores a short-lived (single-block or short-deadline) authorization that the guard then consumes. Costs an extra transaction, removes all encoding fragility. Every adapter must support this path.

### 6.2 ERC-7579 / ERC-4337

```solidity
contract PQValidator is IValidator {
    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash)
        external returns (uint256 validationData)
    {
        (bytes memory ecdsaSig, PQEnvelope memory env) = _split(op.signature);
        bool a = _checkExistingOwner(opHash, ecdsaSig);
        bool b = core.authorize(msg.sender, abi.encode(opHash), env);
        return (a && b) ? SIG_VALIDATION_SUCCESS : SIG_VALIDATION_FAILED;
    }
}
```

Cleanest integration by far, since the signature field is arbitrary bytes by construction. This is also the path the ecosystem is converging on: signature agility through account abstraction rather than a network-wide migration.

### 6.3 Ownable / AccessControl protocols

For protocols that own their own contracts, the adapter becomes the owner and forwards:

```solidity
contract PQOwnableAdapter {
    address public immutable protectedTarget;
    function execute(address target, uint256 value, bytes calldata data,
                     uint64 deadline, PQEnvelope calldata env)
        external returns (bytes memory)
    {
        require(existingAuth.isAuthorized(msg.sender, target, data), "auth");
        require(block.timestamp <= deadline, "expired");
        core.authorize(address(this), _payload(target, data, value, deadline), env);
        return target.functionCallWithValue(data, value);
    }
}
```

Migration is a single `transferOwnership` to the adapter, with the adapter's own escape hatch as the recovery path.

### 6.4 Offchain signatures

`PQPermitVerifier` is a library for protocols consuming EIP-712 signatures. The PQ signature is bound to the original typed-data hash and carried alongside it. This covers oracle signer sets, bridge attestation quorums, and order flow, where the ECDSA signature never touches the chain until settlement and the attacker's window is the mempool.

---

## 7. Cost

FORS+C at NIST Level 1:

| Component | Gas |
|---|---|
| Calldata, roughly 2448 bytes, mostly non-zero | approximately 39,000 |
| Verification | approximately 35,000 |
| Registry read, digest, counter write | approximately 15,000 |
| **Total overhead per protected call** | **approximately 89,000** |

Trivial for a governance action or a proxy upgrade executed a few times a year. Prohibitive on a per-swap path. This is why the policy layer exists, and it is a scoping argument, not a limitation to apologize for: the assets a quantum adversary takes are taken through the authority path, not the trading path.

Signing cost matters on hardware wallets, where time is dominated by hash throughput. FORS+C needs roughly 2.4k hash calls to build a keypair, against roughly 35k for full SPHINCS+.

---

## 8. Policy layer

```solidity
interface IPQPolicy {
    function requiresPQ(address account, address to, uint256 value,
                        bytes calldata data, uint8 operation)
        external view returns (bool);
}
```

Default policy, `StrictAuthorityPolicy`, requires PQ for:
- any `DELEGATECALL`,
- any call to an address flagged as a proxy admin, implementation slot writer, or upgrade entrypoint,
- any call whose selector is on the protected list (`upgradeTo`, `transferOwnership`, `grantRole`, `setImplementation`, pause and parameter setters),
- any value transfer above a configured threshold,
- any call to the guard, registry, or policy itself.

The last clause is not optional. A policy that does not protect its own mutation is bypassable in one transaction.

---

## 9. Containment

For findings PQGuard cannot fix, invariant breakers bound the damage:

- **Rate limiter.** Rolling-window cap on outflow per asset. Excess queues into a delay window instead of reverting, so honest users are inconvenienced rather than blocked.
- **Supply turnstile.** For shielded pools, track total deposits per pool and reject withdrawals exceeding it. This is the last line of defense against a soundness break enabling undetected supply inflation, and it works even though the underlying verifier is immutable.
- **Delay window.** Large exits announce and settle after a fixed delay, converting an instant drain into a detectable event with response time.

These generalize past quantum to any zero-day in a proving system. That is a feature to state plainly, since it means adopting the containment module has value on day one regardless of quantum timelines.

---

## 10. Integration

```bash
npx nonce0 scan 0xProtocol --rpc $RPC      # CBOM + ranked kill chains
npx nonce0 keygen --scheme fors-c          # keypair, commitments, backup
npx nonce0 install 0xProtocol --safe       # emits the install transaction bundle
npx nonce0 verify 0xProtocol               # confirms guard is live and armed
```

Install is three transactions: register the key, deploy or point at the adapter, enable it on the host. No redeployment of protocol contracts, no state migration.

---

## 11. Failure modes, stated openly

| Failure | Consequence | Mitigation |
|---|---|---|
| PQ key lost | Protected calls blocked until escape hatch elapses | 30-day timelocked disable, loud events, offline backup of the commitment chain |
| Key state desync between signer and chain | Signature rejected at wrong index | Registry is the single source of truth; CLI reads `useCount` before every signature |
| Accidental key reuse | Partial key material exposure | FORS+C degrades gracefully; WOTS+C does not, hence the default choice |
| Malicious verifier registration | Full bypass | Governance delay on scheme registration, verifiers are `view`-only and independently auditable |
| Safe envelope encoding breaks on a new Safe version | Guard reverts, Safe is frozen for protected calls | Version pinning with explicit revert, plus the `arm()` fallback path |
| Guard itself is buggy | Protocol frozen | Escape hatch, and AND-composition means the guard can only ever deny, never grant |

That last row is the strongest structural property of the design. Because PQGuard only ever adds a requirement, a bug in it cannot authorize anything. The worst case is a liveness failure with a documented, timelocked recovery, not a loss of funds.

---

## 12. Build order

1. `PQKeyRegistry` plus `PQGuardCore`, with a mock verifier. The state machine is the risk; test it first.
2. `FORSCVerifier`, integrated from an audited reference implementation rather than written fresh.
3. `PQOwnableAdapter`, the simplest host, proving the end-to-end path.
4. `PQSafeGuard` with the `arm()` fallback working before the appended-envelope path.
5. Fork harness: a `CRQC` oracle that returns the private key for any exposed public key. Run the identical exploit before and after install.
6. `PQValidator` for 7579.
7. Containment.
8. Scanner CLI and CBOM output.

The demo is step 5. Everything before it is setup, everything after it is scope.
