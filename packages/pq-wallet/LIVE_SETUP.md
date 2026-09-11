# Arc Testnet setup for the no-MetaMask smart account

**Self-funded activation update:** the wallet now simulates the unchanged signed request with `eth_call` to the real EntryPoint's `handleOps`, avoiding the hosted estimator that rewrites signed gas/fee fields. The default verification budget is 600000. Read-only Arc simulation against the configured deployed contracts with public test keys and simulated funding passed at 600000 and failed at 499999. The same self-funded flow is tested locally. This is not evidence of hosted bundler admission or an actual Arc transaction; the bundler still independently validates submission.

If your browser already saved a request with the old budget, retain the keys and funded address. After that request expires and Refresh confirms unchanged chain state, use **Discard unsigned or expired request**, then activate once to sign the new budget. Discarding does not restore the previously consumed signing slot.

This guide deploys the new experimental smart-account contracts and connects the existing browser wallet. It does not deploy the old registry or pool again. The custom account has passed local EntryPoint/browser tests; a real Arc bundler with this custom account has not yet been validated. Complete provider compatibility and contract review before treating the deployment as ready for users. Use test funds only.

## 1. Prepare the repository

Use the checkout containing the new implementation. The smart-account files were created locally and have not been committed/pushed by this implementation task; an older GitHub checkout may not contain them.

```bash
cd /home/manan/Desktop/Opaque
node --version
forge --version
cast --version
git submodule update --init contracts/lib/forge-std
npm ci --prefix packages/pq-wallet
npm run typecheck --prefix packages/pq-wallet
npm run build:demo --prefix packages/pq-wallet
PQ_ACCOUNT_TESTS=true forge test --root contracts --ffi --match-contract OpaquePqAccountTest
```

Use Node >=22.18; Node 24 was tested. Foundry provides forge, cast and anvil. If missing, follow https://getfoundry.sh/introduction/installation/ rather than installing an unrelated npm package named forge. FFI is used only by the committed helper to generate public deterministic test signatures.

Expected: typecheck/build succeed and all 16 account contract tests pass (including a 1,024-run fuzz test).

## 2. Configure the bundler (self-funded fees)

The wallet pays network fees from its own native Arc test USDC balance. No paymaster, sponsorship policy, sponsorship API key or MetaMask is required.

The sample configuration uses Pimlico's public bundler and EntryPoint v0.7 below. Read-only RPC checks confirmed chain ID 5042002, supported EntryPoint membership and deployed EntryPoint bytecode. No API key was needed for those checks. These checks do not establish that the bundler accepts this custom PQ account.

Before live use, verify simulation of the account's large signature, external registry storage access, factory deployment and gas budget. Resolve any provider staking/admission requirements. Generic network support is insufficient.

In the following commands, replace placeholders. Keep URLs containing API credentials in your terminal/local ignored config, never in a public commit.

```bash
export ARC_RPC='https://rpc.testnet.arc.network'
export PQ_BUNDLER_URL='https://public.pimlico.io/v2/5042002/rpc'
cast chain-id --rpc-url "$ARC_RPC"
cast rpc --rpc-url "$PQ_BUNDLER_URL" eth_chainId
cast rpc --rpc-url "$PQ_BUNDLER_URL" eth_supportedEntryPoints
```

Expected chain ID: decimal `5042002`, hexadecimal `0x4cef52`. Choose the provider's verified v0.7 EntryPoint from the returned list; membership alone does not identify the version.

```bash
export PQ_ENTRYPOINT='0x0000000071727De22E5E9d8BAf0edAc6f37da032'
cast code "$PQ_ENTRYPOINT" --rpc-url "$ARC_RPC"
```

The result must contain contract bytecode, not `0x`. Compare its provenance against the provider's official deployment and the pinned v0.7 code. Then record its observed hash:

```bash
export PQ_ENTRYPOINT_CODEHASH="$(cast keccak "$(cast code "$PQ_ENTRYPOINT" --rpc-url "$ARC_RPC")")"
```

This hash pins the observed code; merely calculating it does not prove the deployment is trustworthy.

## 3. Create and fund an operator deployment account

This account pays to deploy the shared contracts. It is not the user's PQ wallet and has no owner/upgrade authority in the new account contracts. No MetaMask is needed.

Create an encrypted Foundry keystore:

```bash
mkdir -p "$HOME/.foundry/keystores"
cast wallet new "$HOME/.foundry/keystores" arc-deployer
export PQ_DEPLOYER="$(cast wallet address --account arc-deployer)"
```

Choose a keystore password when prompted. Use the printed address at https://faucet.circle.com/ , selecting Arc Testnet. Fund enough test USDC for the deployment estimate plus a margin; the old deployment's cost is not an estimate for these new contracts.

```bash
cast balance "$PQ_DEPLOYER" --rpc-url "$ARC_RPC"
```

This is the native balance in 18-decimal base units. Arc uses native USDC for gas. Official network/funding details: https://docs.arc.io/arc/references/connect-to-arc .

## 4. Simulate deployment

Stay at the repository root. This command runs the deployment simulation without broadcasting:

```bash
forge script --root contracts contracts/script/DeployPqAccount.s.sol:DeployPqAccount \
  --rpc-url "$ARC_RPC" \
  --account arc-deployer \
  --sender "$PQ_DEPLOYER"
```

The script validates chain ID and the EntryPoint's code hash. It creates:

1. `AccountBoundPQKeyRegistry`.
2. `OpaquePqAccountFactory`.
3. The shared `OpaquePqAccount` implementation, created by the factory constructor.

A user's individual account is created later by the browser's activation request. There is no separate PQValidator deployment: validation is integrated into the account and registry.

Check the simulation result and estimated funding. Review the new registry/payload/epoch/lifecycle decisions with the contract owner before broadcasting; see ACCOUNT_IMPLEMENTATION.md. For provider compatibility, first use a fork/local deployment or provider simulation facilities, then repeat against the actual Arc deployment.

## 5. Broadcast the new deployment

After simulation and review succeed:

```bash
forge script --root contracts contracts/script/DeployPqAccount.s.sol:DeployPqAccount \
  --rpc-url "$ARC_RPC" \
  --account arc-deployer \
  --sender "$PQ_DEPLOYER" \
  --broadcast
```

Enter the keystore password when prompted. Save the returned registry and factory addresses and deployment receipts. Foundry records them in:

```text
contracts/broadcast/DeployPqAccount.s.sol/5042002/run-latest.json
```

A timeout does not necessarily mean deployment failed. Inspect receipts and the broadcast file before rerunning; do not accidentally create another deployment. Follow Foundry's resume process only for the recorded deployment after checking its status.

## 6. Read back addresses and code hashes

```bash
export PQ_REGISTRY='REPLACE_WITH_NEW_REGISTRY_ADDRESS'
export PQ_FACTORY='REPLACE_WITH_NEW_FACTORY_ADDRESS'
export PQ_IMPLEMENTATION="$(cast call "$PQ_FACTORY" 'implementation()(address)' --rpc-url "$ARC_RPC")"

cast call "$PQ_FACTORY" 'registry()(address)' --rpc-url "$ARC_RPC"
cast call "$PQ_FACTORY" 'entryPoint()(address)' --rpc-url "$ARC_RPC"
```

The returned registry/EntryPoint must match your selected configuration.

```bash
cast keccak "$(cast code "$PQ_REGISTRY" --rpc-url "$ARC_RPC")"
cast keccak "$(cast code "$PQ_FACTORY" --rpc-url "$ARC_RPC")"
cast keccak "$(cast code "$PQ_IMPLEMENTATION" --rpc-url "$ARC_RPC")"
```

Save these hashes. Self-funded mode does not need a paymaster address or hash.

Reject empty code at every address. Record source/compiler provenance and verify the new contract source through your explorer/provider's supported process; runtime hashes prevent accidental substitution but are not a security review.

## 7. Configure the wallet server

```bash
cd /home/manan/Desktop/Opaque/packages/pq-wallet
cp config/account.example.json .account-config.local.json
```

Edit `.account-config.local.json`. Replace every placeholder:

| Field | Value |
|---|---|
| `chainId` | `5042002` |
| `entryPointVersion` | `0.7` |
| `rpcUrl` | Arc RPC URL |
| `bundlerUrl` | Your provider's bundler URL |
| `entryPoint` | Verified v0.7 EntryPoint |
| `registry` | New account-bound registry |
| `factory` | New factory |
| `implementation` | Value returned by `implementation()` |
| `codeHashes.*` | The four observed and verified runtime hashes |
| `sponsorship.mode` | `self-funded` (no other sponsorship fields) |

The three old deployment addresses cannot substitute for the new registry/factory/implementation. The old pool and note verifier are not needed for a basic account transfer.

Retain the sample fee/gas ceilings initially; they are decimal strings and are not certified Arc estimates. If the real provider needs more, inspect the estimate and compatibility limits before changing them. In particular, increasing verification gas beyond a provider's admission limit does not solve incompatibility.

Self-funded requests sign these configured gas budgets before simulation. This account cannot execute with the dummy signature normally used for unsigned estimation. The wallet saves the real signature, simulates the unchanged request against EntryPoint, then submits the same bytes to the bundler. It never automatically changes the gas or signs a replacement. The preflight checks validation; the confirmed receipt determines whether execution succeeded. A rejected simulation still consumes one local signing slot; retry uses the saved signature. An insufficient signed budget requires expiry and safe abandonment before preparing another operation. Gas budgets can affect fees, including unused-gas penalties, so these defaults are not optimized live estimates.

This specific filename is ignored by Git. Provider URLs are kept by the local Node server and replaced with same-origin proxy URLs in the browser configuration.

## 8. Run the connectivity/deployment check

```bash
export PQ_ACCOUNT_CONFIG="$PWD/.account-config.local.json"
node scripts/check-account-network.ts
```

Expected output includes:

```json
{
  "network": 5042002,
  "deploymentAndEntryPointChecks": "PASS",
  "customBundlerSimulation": "NOT_ESTABLISHED_BY_THIS_CHECK",
  "g2Passed": false
}
```

This checks chain ID, bytecode hashes, factory relationships and bundler EntryPoint support. It does not prove sponsorship, ERC-7562 storage/stake compliance, or successful execution. A failure must be resolved before enabling the page; do not disable the checks.

## 9. Start and activate the wallet

```bash
npm run dev
```

Open **http://127.0.0.1:4173/live**. The default `/` route remains the simulated demo.

1. Click **Create wallet**. PQ secrets are generated locally; the screen shows the predicted smart-account address.
2. Copy the displayed predicted address and fund it with Arc test USDC using https://faucet.circle.com/ or another testnet account. This address can receive funds before deployment. Keep the same browser keys and deployment configuration after funding.
3. Click **Refresh** and confirm a positive balance. It must cover the activation estimate; a positive balance alone does not guarantee enough funds.
4. Click **Activate account**. Your account pays gas from its balance; the PQ-signed request deploys/registers it.
5. Wait for **Active** and confirmed activity. A request hash or successful connectivity check alone is not activation.
6. If activation fails with a funding, provider gas, stake or signature-estimation error, pause and resolve provider compatibility. Retrying with new signatures repeatedly can burn limited key capacity.

## 10. Fund the account and test a transfer

1. Copy the smart-account address from the page.
2. Top up Arc test USDC if needed. Leave enough for network fees as well as the transfer amount; do not send the entire balance.
3. Click **Refresh** and check the balance.
4. Enter a controlled recipient address and a small amount, such as `0.001` USDC.
5. Click **Review transfer**, verify recipient/amount, then **Approve with PQ key**.
6. Click **Submit / retry exact request** and refresh for confirmation.
7. Check the operation result, explorer transaction and recipient balance change.

The page sends native USDC using 18-decimal amounts internally. It does not yet send a pool note or provide anonymous spending.

## 11. Check rotation and record evidence

Rotate after the first successful transfer, confirm that the account address stays the same and the key generation changes, then send another small transfer. Save the operation/transaction hashes and actual gas/provider results for review.

Do not disable your first live test account unless you intend to exercise the real waiting period. Arc has no demo time-advance button. The next-key takeover flow needs the locally stored next key and an elapsed on-chain 30-day timelock.

Keep the same browser profile, hostname and port. Clearing browser storage can lose the keys; copying an old signing-state backup is not a safe recovery procedure.

## Troubleshooting

| Message/symptom | Next check |
|---|---|
| Not configured | Start the server with `PQ_ACCOUNT_CONFIG` pointing to the filled local file. |
| Unverified deployment | Address/code hash/source mismatch; check network and factory relationships. |
| Unsupported EntryPoint | Provider must support the pinned v0.7 deployment. |
| Insufficient funds / prefund | Fund the displayed account address with more native Arc test USDC and refresh. Activation also costs gas. |
| Gas estimate exceeds limits | Measure actual account validation and provider limits; do not blindly raise limits. |
| Request is pending/unknown | Refresh/query receipts, then retry the exact signed bytes if appropriate. |
| Prepared operation is stale | Discard an unsigned request, or wait for signed-request expiry and safe state confirmation before discarding. Used capacity remains used. |
| Included but execution failed | Inspect the per-operation failure; bundle success does not mean the transfer succeeded. |
| Signer state unsafe | Stop signing and investigate local/chain inconsistency; do not reset counters. |

The main external prerequisite is a verified compatible Arc v0.7 bundler. Deployment alone cannot replace that service integration.
