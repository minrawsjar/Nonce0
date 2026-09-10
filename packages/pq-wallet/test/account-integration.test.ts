import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { asAddress, asBytes32 } from '@opaque/protocol-types/codecs.js';
import { ArcChainAdapter, type ArcConfig } from '../src/arc-chain-adapter.ts';
import { AccountWalletController } from '../src/account-wallet.ts';
import { MemorySignerStore } from '../src/signer-state.ts';
import { MemoryAccountStore } from '../src/operation-outbox.ts';
import { packedGas, type PackedOperation } from '../src/user-operation.ts';

const enabled = process.env.PQ_ACCOUNT_INTEGRATION === '1';
const selfFunded = process.env.PQ_ACCOUNT_SELF_FUNDED === '1';
test('real_local_entrypoint_sponsored_bootstrap_transfer_rotation_and_outbox', { skip: !enabled, timeout: 180000 }, async () => {
  const port = await new Promise<number>(resolve => { const server = createNetServer(); server.listen(0, '127.0.0.1', () => {
    const p = (server.address() as { port: number }).port; server.close(() => resolve(p));
  }); });
  const node = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  // Anvil's documented public test key, never used on a non-loopback endpoint.
  const sender = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const walletClient = createWalletClient({ account: sender, transport: http(rpcUrl) });
  const load = async (path: string) => JSON.parse(await readFile(new URL(`../../../contracts/out/${path}`, import.meta.url), 'utf8'));
  const deploy = async (artifact: any, args: readonly unknown[] = []) => {
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args, chain: null });
    const receipt = await publicClient.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return asAddress(receipt.contractAddress!.toLowerCase());
  };
  let gateway: ReturnType<typeof createServer> | undefined;
  let dev: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let temporary: string | undefined;
  try {
    for (let i = 0; i < 40; i++) { try { await publicClient.getBlockNumber(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const epArtifact = await load('EntryPoint.sol/EntryPoint.json');
    const entryPoint = await deploy(epArtifact);
    const registry = await deploy(await load('AccountBoundPQKeyRegistry.sol/AccountBoundPQKeyRegistry.json'));
    const factoryArtifact = await load('OpaquePqAccountFactory.sol/OpaquePqAccountFactory.json');
    const factory = await deploy(factoryArtifact, [entryPoint, registry]);
    const implementation = asAddress((await publicClient.readContract({ address: factory, abi: factoryArtifact.abi, functionName: 'implementation' }) as string).toLowerCase());
    const paymaster = await deploy(await load('OpaquePqAccount.t.sol/TestSponsor.json'), [entryPoint]);
    await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract({ address: entryPoint, abi: epArtifact.abi,
      functionName: 'depositTo', args: [paymaster], value: 10n ** 18n, chain: null }) });
    const submitted = new Map<string, { tx: Hex; op: PackedOperation }>();
    const unpack = (r: any): PackedOperation => ({ sender: r.sender, nonce: BigInt(r.nonce), callData: r.callData,
      initCode: r.factory ? `0x${r.factory.slice(2)}${r.factoryData.slice(2)}` : '0x', signature: r.signature,
      accountGasLimits: packedGas(BigInt(r.verificationGasLimit), BigInt(r.callGasLimit)), preVerificationGas: BigInt(r.preVerificationGas),
      gasFees: packedGas(BigInt(r.maxPriorityFeePerGas), BigInt(r.maxFeePerGas)), paymasterAndData: r.paymaster
        ? `0x${r.paymaster.slice(2)}${BigInt(r.paymasterVerificationGasLimit).toString(16).padStart(32, '0')}${BigInt(r.paymasterPostOpGasLimit).toString(16).padStart(32, '0')}${r.paymasterData.slice(2)}` : '0x' });
    // Explicit test RPC harness: actual EntryPoint execution, fixed test gas estimates.
    // This is not evidence of production bundler simulation or ERC-7562 acceptance.
    gateway = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw); const { method, params } = request;
      let result: unknown;
      try {
        if (method === 'eth_chainId') result = '0x7a69';
        else if (method === 'eth_supportedEntryPoints') result = [entryPoint];
        else if (method === 'eth_estimateUserOperationGas') {
          if (selfFunded) {
            // A real EntryPoint eth_call rejects invalid signatures. This catches
            // the old dummy-signature preparation path without broadcasting.
            await publicClient.simulateContract({ address: entryPoint, abi: epArtifact.abi,
              functionName: 'handleOps', args: [[unpack(params[0])], sender.address], account: sender.address, gas: 4_000_000n });
          }
          result = { verificationGasLimit: '0x7a11f', callGasLimit: '0x7a120', preVerificationGas: '0x30d40' };
        }
        else if (method === 'pm_sponsorUserOperation') result = { paymaster, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x',
          verificationGasLimit: '0x7a11f', callGasLimit: '0x7a120', preVerificationGas: '0x30d40' };
        else if (method === 'eth_sendUserOperation') {
          const op = unpack(params[0]);
          const hash = await publicClient.readContract({ address: entryPoint, abi: epArtifact.abi, functionName: 'getUserOpHash', args: [op] }) as Hex;
          if (!submitted.has(hash)) {
            const tx = await walletClient.writeContract({ address: entryPoint, abi: epArtifact.abi, functionName: 'handleOps', args: [[op], sender.address], chain: null, gas: 4_000_000n });
            submitted.set(hash, { tx, op });
          }
          result = hash;
        } else if (method === 'eth_getUserOperationReceipt') {
          const found = submitted.get(params[0]); result = null;
          if (found) {
            const receipt = await publicClient.getTransactionReceipt({ hash: found.tx });
            const events = parseEventLogs({ abi: parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']), logs: receipt.logs });
            const event = events.find(e => e.args.userOpHash === params[0]);
            if (!event) throw new Error(`No operation event; bundle ${receipt.status}`);
            result = { userOpHash: params[0], entryPoint, sender: found.op.sender, nonce: `0x${found.op.nonce.toString(16)}`, success: event.args.success,
              receipt: { status: receipt.status === 'success' ? '0x1' : '0x0', transactionHash: found.tx, blockNumber: `0x${receipt.blockNumber.toString(16)}` } };
          }
        } else throw new Error('Unsupported test RPC');
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(e) } })); }
    });
    await new Promise<void>(resolve => gateway!.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const codeHash = async (address: Hex) => asBytes32(keccak256((await publicClient.getCode({ address }))!));
    const config: ArcConfig = { chainId: 31337, entryPointVersion: '0.7', entryPoint, registry, factory, implementation,
      rpcUrl, bundlerUrl: gatewayUrl, sponsorship: selfFunded ? { mode: 'self-funded' } : { mode: 'sponsored', url: gatewayUrl, paymaster, codeHash: await codeHash(paymaster) },
      codeHashes: { entryPoint: await codeHash(entryPoint), registry: await codeHash(registry), factory: await codeHash(factory), implementation: await codeHash(implementation) },
      maxFeePerGas: 100_000_000_000n, maxVerificationGas: 499999n, maxCallGas: 500000n, maxPreVerificationGas: 200000n };
    const network = new ArcChainAdapter(config), signers = new MemorySignerStore(), records = new MemoryAccountStore();
    const controller = new AccountWalletController(network, signers, records, async run => run());
    const created = await controller.wallet.create(); assert.equal(created.active, false);
    if (selfFunded) {
      await assert.rejects(controller.wallet.register(), /Fund this account/);
      assert.equal((await controller.wallet.getState()).localSigningReservations, 0n);
      await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: created.accountAddress, value: 10n ** 17n, chain: null }) });
    }
    if (selfFunded) {
      // Real funded counterfactual validation currently exceeds the pinned
      // 499999 budget. Keep this as an explicit integration blocker, not a
      // reason to raise the live provider limit or re-sign automatically.
      await assert.rejects(controller.wallet.register(), /AA26 over verificationGasLimit/);
      const pending = (await records.read())!.pending!;
      assert.equal(pending.phase, 'unknown');
      assert.ok(pending.signature);
      const used = (await controller.wallet.getState()).localSigningReservations;
      assert.equal(used, 1n);
      await assert.rejects(controller.wallet.register(), /AA26 over verificationGasLimit/);
      assert.equal((await controller.wallet.getState()).localSigningReservations, used);
      assert.equal((await records.read())!.pending!.signature, pending.signature);
      assert.equal((await network.observe(created.accountAddress)).deployed, false);
      return;
    }
    await controller.wallet.register();
    assert.equal((await controller.wallet.getState()).chainUseCount, 1n);
    await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: created.accountAddress, value: 10n ** 17n, chain: null }) });
    const recipient = asAddress('0x9999999999999999999999999999999999999999');
    const encoded = await controller.prepareTransfer(recipient, 123n);
    await controller.wallet.signUserOperation(encoded);
    const signatureCount = (await controller.wallet.getState()).localSigningReservations;
    // Recreate the application controller to model a refresh; same persisted stores.
    const reopened = new AccountWalletController(network, signers, records, async run => run());
    await reopened.wallet.signUserOperation(encoded); assert.equal((await reopened.wallet.getState()).localSigningReservations, signatureCount);
    await reopened.submitPending();
    await reopened.inspect();
    assert.equal(await publicClient.getBalance({ address: recipient }), 123n);
    await reopened.wallet.rotate(); assert.equal((await reopened.wallet.getState()).keyEpoch, 1n);
    assert.equal((await reopened.wallet.getState()).accountAddress, created.accountAddress);
    await reopened.wallet.disable(); assert.ok((await network.observe(created.accountAddress)).state!.disableAfter > 0n);
    if (process.env.PQ_ACCOUNT_BROWSER === '1') {
      console.info('Browser integration: SDK lifecycle passed; starting dev server');
      temporary = await mkdtemp(join(tmpdir(), 'opaque-account-browser-'));
      const configPath = join(temporary, 'account.json');
      await writeFile(configPath, JSON.stringify(config, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      const devPort = await new Promise<number>(resolve => { const socket = createNetServer(); socket.listen(0, '127.0.0.1', () => {
        const p = (socket.address() as { port: number }).port; socket.close(() => resolve(p));
      }); });
      dev = spawn(process.execPath, ['scripts/dev.ts', '--port', String(devPort), '--no-open'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, PQ_ACCOUNT_CONFIG: configPath }, stdio: 'ignore',
      });
      const url = `http://127.0.0.1:${devPort}/live`;
      for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
      browser = await chromium.launch({ headless: true, ...(process.env.PQ_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PQ_CHROMIUM_EXECUTABLE } : {}) });
      const page = await browser.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', e => console.info('Browser page error:', e.message));
      await page.goto(url);
      console.info('Browser integration: page loaded');
      await page.waitForFunction(() => !(document.getElementById('create') as HTMLButtonElement).disabled).catch(async error => { throw new Error(`${error.message}; page notice: ${await page.locator('#notice').textContent()}`); });
      assert.equal(await page.evaluate(() => 'ethereum' in window), false);
      console.info('Browser integration: configuration verified');
      await page.locator('#create').click();
      await page.waitForFunction(() => !(document.getElementById('activate') as HTMLButtonElement).disabled);
      console.info('Browser integration: local keys created');
      if (selfFunded) {
        const predicted = asAddress((await page.locator('#address').textContent())!.toLowerCase());
        await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: predicted, value: 10n ** 17n, chain: null }) });
      }
      await page.locator('#activate').click();
      await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Active');
      console.info('Browser integration: activation confirmed');
      const browserAccount = asAddress((await page.locator('#address').textContent())!.toLowerCase());
      await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: browserAccount, value: 10n ** 17n, chain: null }) });
      await page.locator('#recipient').fill(recipient);
      await page.locator('#amount').fill('0.000000000000000007');
      await page.locator('#prepare').click();
      await page.waitForFunction(() => !(document.getElementById('approve') as HTMLButtonElement).disabled);
      await page.locator('#approve').click();
      await page.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled);
      await page.reload();
      await page.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled);
      await page.locator('#submit').click();
      await page.waitForFunction(() => document.getElementById('notice')?.textContent?.includes('Request submitted'));
      assert.equal(await publicClient.getBalance({ address: recipient }), 130n);
      console.info('Browser integration: transfer confirmed');
      await page.locator('#rotate').click();
      await page.locator('#confirm-action').click();
      await page.waitForFunction(() => document.getElementById('notice')?.textContent?.includes('Key-management operation confirmed'));
      assert.equal((await network.observe(browserAccount)).epoch, 1n);
      await page.locator('#disable').click(); await page.locator('#confirm-action').click();
      await page.waitForFunction(() => document.getElementById('notice')?.textContent?.includes('Key-management operation confirmed'));
      assert.ok((await network.observe(browserAccount)).state!.disableAfter > 0n);
    }

  } finally {
    if (browser) await browser.close();
    if (dev) dev.kill('SIGTERM');
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
    node.kill('SIGTERM');
  }
});
