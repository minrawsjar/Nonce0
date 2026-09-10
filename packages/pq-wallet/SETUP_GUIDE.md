# PQ wallet setup guide

The local demo can run now. The smart-account page is implemented, but connecting it to Arc requires new contract deployments and a compatible bundler/sponsor. Your three earlier Arc addresses do not supply the new account-bound registry and factory.

## 1. Prerequisites

Use Node 24 LTS for the documented test commands (the package itself requires >=22.18), npm, Git, and Foundry's `forge`, `cast`, and `anvil`. The development machine already used Node 24.10.0 and Foundry 1.3.2 successfully. Check your installation:

```bash
node --version
npm --version
forge --version
cast --version
anvil --version
```

These instructions use the current local checkout. The latest smart-account changes must be included in your checkout if setting up another machine; they were not automatically committed or pushed by the implementation task.

## 2. Install and open the pages

```bash
cd /home/manan/Desktop/Opaque
git submodule update --init contracts/lib/forge-std
cd packages/pq-wallet
npm ci
npm run dev
```

Open:

- `http://127.0.0.1:4173/` — the working simulated demo.
- `http://127.0.0.1:4173/live` — the smart-account wallet. Controls are intentionally disabled until verified configuration is supplied.

Stop the server with Ctrl+C. If the port is occupied, use `npm run dev -- --port 4174` and open that port. Keep using the same hostname and port for a wallet: browser storage belongs to that origin.

## 3. Test the real contracts locally

From `packages/pq-wallet`:

```bash
npm run typecheck
npm run build:demo
npm test
npm run test:account
npm run test:account-integration
```

Run `test:account` before `test:account-integration`: it builds the EntryPoint and test-sponsor artifacts required by the integration test. Foundry may download the pinned Solidity compiler on the first build.

The integration test starts Anvil, deploys real EntryPoint/account/registry contracts, exercises transactions, and stops the local chain afterward. Its bundler RPC and sponsor are explicitly test harnesses. This is an automated test, not a persistent interactive local-network launcher.

To include the actual browser flow in a clean profile:

```bash
npx playwright install chromium
PQ_ACCOUNT_INTEGRATION=1 PQ_ACCOUNT_BROWSER=1 \
  node --test --test-isolation=none test/account-integration.test.ts
```

If Chromium is already installed elsewhere, set `PQ_CHROMIUM_EXECUTABLE` to its executable instead of downloading it. No wallet extension is installed for this test.

## 4. Obtain Arc transaction-delivery and sponsorship services

Before deployment, the infrastructure owner must provide:

| Setting | Meaning |
|---|---|
| Arc RPC URL | Reads chain data; currently documented primary endpoint is `https://rpc.testnet.arc.io` |
| EntryPoint address | A verified **v0.7** EntryPoint deployment on chain 5042002 |
| Bundler URL | Accepts the custom account's v0.7 UserOperations |
| Sponsor RPC URL | Provides the implemented `pm_sponsorUserOperation` response format |
| Paymaster address | Funded contract paying the sponsored transaction fees |

Arc lists account-abstraction providers in its [official documentation](https://docs.arc.io/arc/tools/account-abstraction). Listing a provider does not establish support for this custom account or its 9,295-byte signature envelope.

The selected bundler must expose `eth_chainId`, `eth_supportedEntryPoints`, `eth_estimateUserOperationGas`, `eth_sendUserOperation`, and `eth_getUserOperationReceipt`. Verify actual admission rules, external registry storage/staking requirements and gas limits. The sponsor adapter expects split v0.7 paymaster fields plus operation gas estimates; a different provider API needs an adapter change.

The sponsor operator funds the paymaster's EntryPoint deposit and any required stake. That deposit pays fees, not the amount users transfer. Do not deploy the permissive `TestSponsor` from the test suite as the live service.

## 5. Deploy the new account contracts

This is the developer/operator step. An operator needs a conventional transaction-signing account to pay deployment fees; end users still do not need MetaMask or an Ethereum private key.

Have the new account-bound registry/payload/lifecycle decisions reviewed as described in `ACCOUNT_IMPLEMENTATION.md`. Obtain the EntryPoint from a trusted v0.7 deployment/provider record and verify its code/source. A code hash alone identifies code; it does not establish that the code is the intended implementation.

Set public deployment values in the shell:

```bash
export PQ_RPC_URL='https://rpc.testnet.arc.io'
export PQ_ENTRYPOINT='REPLACE_WITH_VERIFIED_V07_ENTRYPOINT'
export PQ_ENTRYPOINT_CODEHASH='REPLACE_WITH_VERIFIED_RUNTIME_CODE_HASH'
```

To inspect a contract's deployed runtime code and calculate its hash:

```bash
cast code "$PQ_ENTRYPOINT" --rpc-url "$PQ_RPC_URL"
```

A result of `0x` means there is no deployed code. For a verified nonempty result, calculate its fingerprint:

```bash
PQ_RUNTIME_CODE=$(cast code "$PQ_ENTRYPOINT" --rpc-url "$PQ_RPC_URL")
cast keccak "$PQ_RUNTIME_CODE"
```

Use an existing encrypted Foundry keystore. If importing the operator's existing deployment key, use the hidden terminal prompt:

```bash
cast wallet import pq-deployer --interactive
```

Keep private keys out of this repository and chat. Fund the operator address with test USDC using the [Circle faucet](https://faucet.circle.com/). Arc uses native USDC for fees; see [Arc connection details](https://docs.arc.io/arc/references/connect-to-arc).

Simulate the deployment first:

```bash
cd /home/manan/Desktop/Opaque/contracts
forge script script/DeployPqAccount.s.sol:DeployPqAccount \
  --rpc-url "$PQ_RPC_URL" --account pq-deployer
```

Once the simulation and review are satisfactory, this command actually deploys:

```bash
forge script script/DeployPqAccount.s.sol:DeployPqAccount \
  --rpc-url "$PQ_RPC_URL" --account pq-deployer --broadcast
```

Record the addresses from the successful deployment output and `contracts/broadcast/DeployPqAccount.s.sol/5042002/run-latest.json`:

- New `AccountBoundPQKeyRegistry`.
- New `OpaquePqAccountFactory`.
- Account implementation created by the factory.

You can read the implementation from the factory:

```bash
export PQ_FACTORY='REPLACE_WITH_NEW_FACTORY_ADDRESS'
cast call "$PQ_FACTORY" 'implementation()(address)' --rpc-url "$PQ_RPC_URL"
```

Record runtime code hashes for EntryPoint, registry, factory, implementation and paymaster using `cast code` followed by `cast keccak` as above. Check factory registry/EntryPoint getters and retain deployment/source provenance. Do not overwrite the earlier deployment addresses: these are separate contracts.

## 6. Configure your wallet server

```bash
cd /home/manan/Desktop/Opaque/packages/pq-wallet
cp config/account.example.json .account-config.local.json
```

Edit `.account-config.local.json`:

- Set `rpcUrl` to the verified Arc RPC endpoint, such as `https://rpc.testnet.arc.io`.
- Replace every address placeholder with the new deployment/provider address.
- Replace every `codeHashes` placeholder with its verified runtime hash.
- Add your bundler URL, sponsor URL, funded paymaster address and paymaster code hash.
- Keep `entryPointVersion` at `0.7` and `chainId` at `5042002`.
- Review gas/fee ceilings with the provider; the sample numbers are limits, not measured Arc guarantees.

The file is ignored by Git and stays on the server. The browser receives local proxy paths, not upstream provider URLs. Do not change the filename without also ensuring your chosen private configuration path is ignored.

Export its path and verify connectivity/deployment identity:

```bash
export PQ_ACCOUNT_CONFIG="$PWD/.account-config.local.json"
node scripts/check-account-network.ts
```

Expected output includes `deploymentAndEntryPointChecks: "PASS"`. It also reports that custom bundler simulation is not established by that check. Preparation of a real operation must still pass the provider's estimator; a successful code-hash check is not end-to-end acceptance.

## 7. Start and use the Arc wallet

In the same terminal, with `PQ_ACCOUNT_CONFIG` still exported:

```bash
npm run dev
```

Open `http://127.0.0.1:4173/live`, then:

1. Click **Create wallet**. PQ keys are generated locally and the real account address is calculated.
2. Click **Activate account**. The sponsor pays the initial network fee, and the bundler deploys/registers your account.
3. Wait for the page to show **Active**.
4. Send a small amount of test USDC to the displayed account address. Sponsorship pays gas, not transfer balances.
5. Enter a controlled recipient and amount, then click **Review transfer**.
6. Check the recipient and amount, then **Approve with PQ key**.
7. Click **Submit / retry exact request** and **Refresh** to check confirmation.
8. Check the actual transaction and recipient balance before treating the transfer as complete.

The current page sends native USDC with 18-decimal precision internally. Type normal amounts such as `0.01`; the UI converts them. The separate pool/token API uses six decimals and is not this transfer screen.

Rotation keeps the account address. Disable starts the real 30-day wait. There is no live time-advance button. Clearing browser storage can lose your keys; a new browser profile does not automatically recover the same wallet.

## Troubleshooting

| Message/symptom | Next action |
|---|---|
| Smart-account setup missing | Set `PQ_ACCOUNT_CONFIG`, complete its placeholders, and restart the server. |
| Unverified deployment / factory mismatch | Recheck addresses, chain, runtime code hashes and factory getters. |
| Bundler does not support EntryPoint | Obtain a provider endpoint supporting the exact pinned v0.7 deployment. |
| Sponsorship rejected | Check funding, account/factory policy and sponsor response compatibility. |
| Estimate exceeds limits | Investigate the actual estimate/provider limits; do not blindly raise caps. |
| Operation pending / unknown | Refresh and retry identical signed bytes. Do not keep creating new signatures. |
| Prepared request expired | Discard it through the UI when chain checks allow, then review a new request. Used signing capacity stays used. |
| Account has no transfer balance | Fund the displayed account with test USDC; sponsored fees do not fund transfers. |
| Local browser integration cannot launch | Install Playwright Chromium or provide `PQ_CHROMIUM_EXECUTABLE`. |
| Port 4173 occupied | Stop the previous server or use `--port 4174`; note the different browser storage origin. |

Current remaining setup work is provider/sponsor provisioning, reviewed new-contract deployment, and actual Arc acceptance tests. No turnkey public-bundler compatibility is claimed yet.
