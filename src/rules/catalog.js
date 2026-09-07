// The rule catalog. Pure data, no logic, no imports.
//
// Why data-only: the same rule IDs must appear in repo-mode findings and in
// chain-mode findings, so a team sees PQG-003 before deploy and recognises it
// after. Logic lives in engine.js; anything that needs a function is not a rule.
//
// fixability is the term that makes the ranking honest (docs/scanner-design.md §6):
//   risk = exposure x value_at_risk x (1 - fixability)
//   1.0 = a guard can protect this authority path today
//   0.0 = immutable verifier, or ciphertext already published on chain
// A critical finding you can close in three transactions ranks BELOW a medium
// one that is permanent. That inversion is the product.

/** @typedef {'critical'|'high'|'medium'|'low'} Severity */

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export const RULES = [
  {
    id: 'PQG-000',
    title: 'Unresolved authority',
    mode: 'chain',
    severity: 'high',
    fixability: 0.5,
    patterns: [],
    why:
      'A probe returned something the traverser does not understand, so the ownership ' +
      'graph below this node is unknown. An empty graph rendering as a clean bill of ' +
      'health is worse than an error, so this is emitted explicitly rather than skipped.',
    remediation:
      'Inspect this address manually. If it is a known pattern, add its probe to ' +
      'src/chain/authority.js so the traversal continues through it.',
  },
  {
    id: 'PQG-001',
    title: 'ECDSA signature recovery in a state-changing function',
    mode: 'repo',
    severity: 'critical',
    fixability: 1,
    patterns: [/\becrecover\s*\(/, /\bECDSA\s*\.\s*recover\b/, /\bSignatureChecker\b/, /\btryRecover\b/],
    languages: ['.sol'],
    // Tier 2 downgrades this when the match sits in a view/pure function.
    requiresStateChanging: true,
    why:
      'A recovered signer address is an authorisation decision made from a secp256k1 ' +
      'signature. A quantum adversary holding the signer key forges it.',
    remediation:
      'Add a PQ co-signature on this path with PQGuardCore. AND composition: the ' +
      'existing ECDSA check still applies, the hash-based one applies in addition.',
  },
  {
    id: 'PQG-002',
    title: 'EIP-712 / permit signature verification',
    mode: 'repo',
    severity: 'high',
    fixability: 1,
    patterns: [/\bpermit\s*\(/, /_hashTypedDataV4/, /\bDOMAIN_SEPARATOR\b/, /\bisValidSignature\b/],
    languages: ['.sol'],
    why:
      'Offchain-signed authorisations. The signature never touches the chain until ' +
      'settlement, so the attacker window is the mempool.',
    remediation: 'Bind a PQ co-signature to the original typed-data hash (PQPermitVerifier).',
  },
  {
    id: 'PQG-003',
    title: 'Pairing-based proof verification',
    mode: 'both',
    severity: 'high',
    fixability: 0,
    patterns: [/\bverifyProof\b/, /\bpairing\b/i, /\bbn254\b/i, /\balt_bn128\b/, /\bGroth16\b/i],
    languages: ['.sol'],
    precompiles: [0x06, 0x07, 0x08],
    why:
      'UNFIXABLE IF IMMUTABLE. If this verifier is deployed and non-upgradeable and ' +
      'quantum breaks the assumption it rests on, there is no patch.',
    remediation:
      'Containment only: cap outflow rate, add a delay window on large withdrawals. ' +
      'Turns an instant drain into something you have hours to notice.',
  },
  {
    id: 'PQG-004',
    title: 'KZG point evaluation',
    mode: 'both',
    severity: 'medium',
    fixability: 0.2,
    patterns: [/\bpointEvaluation\b/i, /\bkzg\b/i, /\bblobhash\b/i],
    languages: ['.sol'],
    precompiles: [0x0a],
    why: 'Protocol-layer commitment scheme. Not addressable from an application module.',
    remediation:
      'Track it in the CBOM and follow the L1 roadmap. Nothing to install here.',
  },
  {
    id: 'PQG-005',
    title: 'ECIES / ECDH / stealth address derivation',
    mode: 'repo',
    severity: 'high',
    fixability: 0,
    patterns: [/\bECIES\b/i, /\bECDH\b/i, /\bstealth(Address|MetaAddress)\b/i, /\bsharedSecret\b/i, /\bgetSharedSecret\b/],
    languages: ['.sol', '.ts', '.js'],
    why:
      'RETROACTIVE AND UNFIXABLE. Anything encrypted with this and already published ' +
      'on chain is harvested today and decrypted later. No module changes that.',
    remediation:
      'Rotate to a PQ KEM for anything not yet published. Treat everything already ' +
      'on chain as public. Do not claim you can restore its privacy.',
  },
  {
    id: 'PQG-006',
    title: 'Upgradeable proxy authority',
    mode: 'both',
    severity: 'critical',
    fixability: 1,
    patterns: [/\bUUPSUpgradeable\b/, /_authorizeUpgrade/, /\bupgradeTo(AndCall)?\s*\(/, /\bProxyAdmin\b/, /\bsetImplementation\b/],
    languages: ['.sol'],
    why:
      'This is the guard target. Whoever holds this key replaces the code and takes ' +
      'everything, with no exploit required.',
    remediation:
      'Install PQOwnableAdapter as the upgrade authority. One transferOwnership, no ' +
      'redeployment of your contracts.',
  },
  {
    id: 'PQG-007',
    title: 'Ownable / AccessControl authority',
    mode: 'both',
    severity: 'high',
    fixability: 1,
    patterns: [/\bonlyOwner\b/, /\bOwnable2?(Upgradeable)?\b/, /\btransferOwnership\s*\(/, /\bAccessControl\b/, /\bgrantRole\s*\(/],
    languages: ['.sol'],
    why: 'A single key authorises privileged calls. The whole authority path is one signature.',
    remediation: 'Route this owner through PQOwnableAdapter; register a key with PQKeyRegistry.',
  },
  {
    id: 'PQG-008',
    title: 'Uncapped value exit path',
    mode: 'both',
    severity: 'medium',
    fixability: 1,
    patterns: [/function\s+(withdraw|redeem|claim|emergencyWithdraw|sweep)\w*\s*\(/i],
    languages: ['.sol'],
    why:
      'Multiplies every finding above it. A broken key plus an uncapped exit is an ' +
      'instant drain rather than a detectable event.',
    remediation:
      'Add a rolling outflow ceiling and a delay window on large exits. Valuable on ' +
      'day one against any proving-system zero-day, quantum or not.',
  },
  {
    id: 'PQG-009',
    title: 'Trusted setup artifact present',
    mode: 'repo',
    severity: 'high',
    fixability: 0,
    patterns: [],
    filenames: [/\.ptau$/, /\.zkey$/, /verification_key\.json$/],
    why:
      'Toxic waste becomes recoverable. If the setup ceremony transcript is attackable, ' +
      'proof soundness goes with it and the verifier is usually immutable.',
    remediation: 'Containment only, as PQG-003. Record it in the CBOM.',
  },
  {
    id: 'PQG-010',
    title: 'Pedersen / ElGamal commitment in circuits',
    mode: 'repo',
    severity: 'high',
    fixability: 0.1,
    patterns: [/\bPedersen\b/i, /\bElGamal\b/i, /\bBabyJubJub\b/i, /\bcommitment\b/i],
    languages: ['.circom', '.nr'],
    why:
      'Binding and hiding break differently under a quantum adversary, and which one ' +
      'you lose depends on the scheme. Hiding breaks retroactively.',
    remediation:
      'Identify per scheme whether you rely on binding, hiding, or both. Hiding losses ' +
      'are retroactive and cannot be fixed.',
  },
  {
    id: 'PQG-011',
    title: 'Hardcoded EOA address in deploy script or config',
    mode: 'repo',
    severity: 'critical',
    fixability: 1,
    patterns: [/0x[0-9a-fA-F]{40}/],
    languages: ['.sol', '.ts', '.js', '.json', '.toml'],
    pathHints: [/deploy/i, /script/i, /config/i, /deployments?\//i, /\.env/],
    // The one that matters most and is the cheapest to implement: every address
    // extracted here is handed to the exposure oracle (src/exposure.js).
    feedsExposureOracle: true,
    why:
      'This address controls something, on every chain at once. Its key is exposed the ' +
      'first time it signs anywhere, including a testnet two years ago.',
    remediation:
      'Check its nonce on every chain, not just the one you deploy to. If any nonce is ' +
      'above zero, the public key is published permanently and the key needs a guard.',
  },
  {
    id: 'PQG-012',
    title: 'secp256k1 key material handled in application code',
    mode: 'repo',
    severity: 'medium',
    fixability: 1,
    patterns: [/new\s+Wallet\s*\(/, /privateKeyToAccount\s*\(/, /\bsecp256k1\b/, /\bsignMessage\s*\(/, /PRIVATE_KEY/],
    languages: ['.ts', '.js'],
    why: 'Signing keys constructed in application code, often from an env var.',
    remediation: 'Move to a hardware signer or a Safe; register the resulting authority with PQGuard.',
  },
];

export const RULES_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));
