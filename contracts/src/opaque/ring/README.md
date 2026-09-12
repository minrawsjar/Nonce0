# Ring Contracts

The ring settlement path lives in [`../pool/`](../pool/): `PrivatePool.sol` holds the notes and `AttestedRingVerifier.sol` approves eight-member ring spends. This folder holds no contracts.

A spend verifies the attestation, checks that all eight commitments are real deposits, checks and sets the nullifier, and pays one denomination to the recipient. The nullifier is derived from the note secret and the pool only; the recipient is bound by the proof, never by the nullifier.
