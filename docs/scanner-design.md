# PQGuard Scanner — design

Two commands, one engine.

```
npx nonce0 scan .            # repo mode: source, pre-deploy
npx nonce0 scan 0xProtocol   # chain mode: bytecode + authority graph, post-deploy
```

The argument decides the mode. Anything matching `/^0x[0-9a-fA-F]{40}$/` is an address, anything else is a path. No `--mode` flag, because the one thing a security tool must never do is scan the wrong thing quietly.

---

## 1. Constraints that shape everything

**Zero runtime dependencies.** A security tool that pulls 400 transitive packages is asking you to trust a supply chain in order to check your supply chain. Node 18+ has `fetch`, `fs/promises` and `crypto` built in, which is everything this needs. It also means `npx nonce0` is a single fast download, which matters for adoption.

**No compiler requirement.** Requiring `solc` or a working Foundry install kills half your install base and makes CI setup a chore. The Solidity analysis is therefore lexical, not AST-based, which is a real accuracy tradeoff handled explicitly in §3.2.

**Every finding must be actionable.** A finding with no file, no line, and no suggested fix is noise. The schema enforces location and remediation as required fields.

---

## 2. Architecture

```
bin/pqguard.js          arg parse, mode dispatch, exit codes
src/
  rules/
    catalog.js          rule definitions, data only
    engine.js           two-tier matcher (prefilter -> structural confirm)
  repo/
    discover.js         file walk, gitignore respect, language routing
    solidity.js         comment/string stripper, brace tracker, function context
    typescript.js       lighter pass for TS/JS
    circuits.js         circom / noir
    artifacts.js        .ptau, .zkey, verification_key.json, deploy configs
  chain/
    rpc.js              minimal JSON-RPC batching client
    disasm.js           opcode walker (PUSH-aware)
    slots.js            EIP-1967 / EIP-1822 storage probes
    authority.js        ownership graph traversal
  exposure/
    oracle.js           cross-chain public key exposure
  score.js              severity + fixability -> ranked findings
  report/
    text.js  sarif.js  cbom.js  json.js
```

The rule catalog is pure data with no logic in it. That is what lets the same rule IDs appear in repo findings and chain findings, so a team sees `PQG-003` before deploy and recognises it after.

---

## 3. Repo mode

### 3.1 Discovery

Walk from the root, honour `.gitignore` plus a built-in skip list (`node_modules`, `lib`, `out`, `cache`, `artifacts`, `broadcast`, `.git`). Route by extension: `.sol`, `.ts/.js`, `.circom/.nr`, and an artifact bucket for `.ptau`, `.zkey`, `verification_key.json`, `foundry.toml`, `hardhat.config.*`, `.env.example`, `deployments/*.json`.

Skipping `lib/` is deliberate: findings in OpenZeppelin are not yours to fix, and burying real findings under vendored ones is how linters get ignored. Offer `--include-deps` for people who want the full picture.

### 3.2 The accuracy problem, and the tier that solves it

Pure regex over Solidity produces garbage. `ecrecover` appears in comments, in strings, in test files, and in dead code. Full AST parsing means shipping a compiler. The middle path is two tiers:

**Tier 1, prefilter.** Cheap substring and regex scan over raw bytes. Fast enough to run over a large monorepo. Its only job is deciding which files deserve tier 2. False positives here cost nothing.

**Tier 2, structural confirmation.** For files that hit, run a small Solidity lexer that:
- strips comments and string literals so matches inside them are discarded outright,
- tracks brace depth to know contract and function boundaries,
- captures each function's name, visibility, modifiers and mutability header,
- records whether the match sits inside a `view`/`pure` function, which downgrades most auth findings.

That lexer is maybe 150 lines and it is the difference between a tool people keep and a tool people uninstall on day two. It does not need to be a parser. It needs to know "am I inside a comment, and which function am I in."

Each finding carries a `confidence` of `high` when tier 2 confirmed structure, `medium` when it matched outside a recognised function body.

### 3.3 Rule catalog

| ID | Signal | Severity | Fixability |
|---|---|---|---|
| PQG-001 | `ecrecover`, `ECDSA.recover`, `SignatureChecker` in a state-changing function | critical | fixable, add PQ co-signature |
| PQG-002 | `permit`, `_hashTypedDataV4`, `DOMAIN_SEPARATOR`, `isValidSignature` | high | fixable |
| PQG-003 | pairing ops, `verifyProof`, bn254 precompiles | high | **unfixable if immutable**, contain only |
| PQG-004 | KZG point evaluation (`0x0a`) | medium | protocol-layer |
| PQG-005 | ECIES / ECDH / stealth address derivation in TS or Solidity | high | **retroactive**, unfixable once shipped |
| PQG-006 | `UUPSUpgradeable`, `_authorizeUpgrade`, `upgradeTo`, proxy admin | critical | fixable, this is the guard target |
| PQG-007 | `Ownable`, `onlyOwner`, `AccessControl`, `transferOwnership` | high | fixable |
| PQG-008 | withdraw/redeem/claim path with no cap, cooldown or delay nearby | medium | fixable, multiplies everything above |
| PQG-009 | `.ptau`, `.zkey`, `verification_key.json` present | high | trusted setup toxic waste becomes recoverable |
| PQG-010 | Pedersen or ElGamal commitments in circuits | high | binding vs hiding break, differs by scheme |
| PQG-011 | hardcoded EOA address in deploy script or config | critical | **feeds the exposure oracle** |
| PQG-012 | `new Wallet(`, `privateKeyToAccount`, secp256k1 signing in TS | medium | fixable |

PQG-011 is the one that matters most and is the cheapest to implement. Extract every `0x[0-9a-fA-F]{40}` from deploy scripts, config files and `deployments/*.json`, and hand the set to §5.

### 3.4 What repo mode cannot know

Say this in the README rather than letting users discover it: source scanning has no value at risk, no knowledge of which contracts are actually deployed, and no way to tell a live admin path from a test fixture. `--deployed-only` and a `.nonce0ignore` exist because of this.

---

## 4. Chain mode

### 4.1 Bytecode analysis

`eth_getCode`, then walk opcodes rather than grepping bytes. This matters more than it sounds: a naive byte search for `0x60 0x08` finds PUSH data, immediates, and packed constants, and the false positive rate makes results worthless.

The walker is a simple loop: read opcode, if it is in `PUSH1..PUSH32` skip `n` data bytes, advance. Correct disassembly-lite in about 20 lines.

Detection then becomes: record every `PUSHn` whose immediate is in `{1, 6, 7, 8, 10}`, and flag it when a `STATICCALL` (`0xFA`) or `CALL` (`0xF1`) appears within a small window afterward. Precompile calls are compiled with the address pushed shortly before the call, so a window of roughly 20 instructions catches real usage without catching noise.

That yields the crypto inventory: `0x01` ecrecover, `0x06/0x07/0x08` bn254 (a pairing verifier), `0x0a` KZG.

### 4.2 Authority graph

Probe in order, each a single `eth_call` or `eth_getStorageAt`:

| Probe | Method |
|---|---|
| EIP-1967 implementation | slot `0x360894...bbc` |
| EIP-1967 admin | slot `0xb53127...103` |
| EIP-1967 beacon | slot `0xa3f0ad7...d50` |
| `owner()` | `0x8da5cb5b` |
| Safe `getOwners()` | `0xa0e67e2b` |
| Safe `getThreshold()` | `0xe75235b8` |
| AccessControl admin | `getRoleMember(DEFAULT_ADMIN_ROLE, 0)` |

Then recurse: for each authority found, `eth_getCode` it. Non-empty code means another contract, so traverse again up to `--depth` (default 3). Empty code means a terminal EOA, which is where the graph ends and §5 begins.

The Safe path is the one that produces the headline finding, because it goes protocol proxy to Safe to three EOAs to "quorum reached, everything upgradeable."

**Batch the calls.** A depth-3 traversal on a nested Safe setup is dozens of RPC round trips. Use JSON-RPC batch arrays and a per-address memo cache, or the scan takes 30 seconds and feels broken.

### 4.3 The failure mode to design around

Ownership traversal is where this breaks in a demo. Safes own Safes own timelocks, and one unrecognised pattern returns an empty graph and a clean bill of health, which is worse than an error. Two defences: emit an explicit `PQG-000 unresolved authority` finding whenever a probe returns something the traverser does not understand, and cache all RPC responses to disk under `.nonce0-cache/` so a demo never depends on venue networking.

---

## 5. The exposure oracle — the bridge between modes

This is what makes the tool more than a linter, and it is small.

**Free, exact, works on any RPC with no indexer:**

```
eth_getTransactionCount(address, "latest") > 0   =>  public key is exposed on this chain
```

An account's public key is revealed by the ECDSA signature on any transaction it sends. A nonce above zero means it has sent one. There is no ambiguity and no heuristic.

Run that across every configured chain in `chains.json`, in parallel. The result is the finding nobody else computes: an address showing zero nonce on mainnet and nonce 47 on Sepolia is **fully exposed**, because the same key controls the same address everywhere and a testnet transaction is just as revealing as a mainnet one.

**With the Subgraph configured**, upgrade from a boolean to detail: the recovered public key itself, the first exposing block, and the transaction hash to link in the report. That is what the Substreams module produces and it is why the indexer stays load-bearing rather than decorative.

Both modes feed this. Repo mode passes the addresses from PQG-011. Chain mode passes the terminal EOAs from the authority graph. Same oracle, same finding format.

---

## 6. Scoring

```
risk = exposure × value_at_risk × (1 − fixability)
```

- `exposure` in `{0, 0.5, 1}`: never signed anywhere, signed on a testnet only, signed on a mainnet.
- `value_at_risk`: chain mode reads the balance of the controlled contracts. Repo mode has none, so it degrades to severity ordering and says so rather than inventing a number.
- `fixability` in `[0, 1]`: 1 for an authority path a guard can protect, 0 for an immutable pairing verifier or already-published ECIES ciphertext.

The `(1 − fixability)` term is what makes the ranking honest. A critical-severity finding you can fix in three transactions should rank below a medium-severity one that is permanent, and no other tool in this space does that.

---

## 7. Output

| Flag | Format | Purpose |
|---|---|---|
| default | text | ranked findings, colour by severity, remediation line each |
| `--sarif` | SARIF 2.1.0 | GitHub Security tab, same channel CodeQL uses, no dashboard needed |
| `--cbom` | CycloneDX 1.6 | cryptographic bill of materials, legible outside crypto |
| `--json` | raw | for the MCP server and the API |

Exit codes: `0` clean, `1` findings at or above `--fail-on` (default `critical`), `2` tool error. Distinguishing 1 from 2 is what makes the GitHub Action trustworthy, since a network failure must never read as a clean scan.

Suppression via `.nonce0ignore` with rule ID plus glob, and `--baseline` to accept existing findings and fail only on new ones. Without a baseline nobody adopts a scanner into an existing codebase.

---

## 8. Build order

1. Rule catalog and the finding schema. Everything else is shaped by it.
2. Repo mode tier 1 and the text reporter. This is a useful tool already.
3. The Solidity lexer, tier 2. Accuracy jump.
4. PQG-011 address extraction plus the nonce-based exposure oracle. **This is the moment it stops being a linter.**
5. SARIF and the GitHub Action.
6. Chain mode: RPC client, opcode walker, EIP-1967 slots.
7. Authority traversal and the Safe path.
8. Subgraph upgrade for exposure detail.
9. CBOM.

Steps 1 to 4 are a day and produce something you would install. Everything after is depth.

**Test fixtures before rules.** Build `test/fixtures/` with one deliberately vulnerable Solidity contract, one clean contract that should produce zero findings, a deploy script with a hardcoded owner, and a mock JSON-RPC server returning canned `eth_getCode` and nonce responses. The clean-contract fixture matters most, because a scanner that flags everything is the failure mode you will not notice from the inside.
