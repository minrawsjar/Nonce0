# Aditya - ring and pool contracts

Implement the fixed-denomination USDC pool and verifier adapter here. `spend` must atomically verify the proof, validate exactly eight distinct commitments, check and set the nullifier, and settle pooled USDC to the public recipient.

The nullifier is derived only from note secret and pool identity. Recipient/payment context are bound by the proof, not included in the nullifier.
