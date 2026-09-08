# Project X contracts

Contract ownership is split deliberately: Manan owns wallet registry/validator contracts; Aditya owns the private-pool and ring-verifier contracts. Shared interfaces live in `src/interfaces` and are the only permitted cross-owner contract dependency.
