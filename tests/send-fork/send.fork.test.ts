/**
 * The app's USDC send against Base's real USDC and EntryPoint v0.6 on an
 * anvil fork: the same `sendUsdc`, `createSendChain` and wallet senders the
 * Send interface uses, from an external EOA and from a Coinbase Smart Wallet
 * built and driven the way Privy does it (viem `toCoinbaseSmartAccount` with
 * a Privy-style local owner, permissionless `createSmartAccountClient`,
 * `sendTransaction({ calls })`).
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, getAddress, http, type Address, type Hash, type Hex, type LocalAccount, type Transport } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { base } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { SPONSORED_CALL_TARGETS, USDC_ADDRESS } from "@/config";
import { WalletError } from "@/wallet/errors";
import {
  InsufficientUsdcError,
  RELEASE_PENDING_AFTER_MS,
  SendUnconfirmedError,
  canReleasePending,
  checkPendingSend,
  createPendingSendStore,
  createSendChain,
  sendUsdc,
  usdcTransferCall,
} from "@/wallet/send";
import { createExternalSender, createSmartSender } from "@/wallet/senders";
import type { NormalizedCall } from "@/wallet/sequence";
import {
  BUNDLER_PORT,
  coinbaseSmartWalletAbi,
  createForkBundler,
  forkClient,
  forkProvider,
  randomAddress,
  reader,
  setEthBalance,
  serveForkBundler,
  setUsdcBalance,
  usdcBalance,
} from "./fork";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const chain = createSendChain(forkClient);

function eoaSender(address: Address) {
  return createExternalSender(address, { getProvider: async () => forkProvider, switchToBase: async () => undefined }, { reader, receiptTimeoutMs: 60_000 });
}

/**
 * Privy's smart-wallet client, rebuilt on the fork: viem's Coinbase Smart
 * Wallet (version "1", Privy's default) whose owner is a local account that
 * only signs raw hashes (Privy's `secp256k1_sign`), in permissionless's smart
 * account client with fees at 175% of the estimate (Privy's CDP setting).
 * The adapter is WalletProvider's: `client.sendTransaction({ calls })`.
 */
async function privySmartWallet(options: { bundlerTransport?: (bundler: ReturnType<typeof createForkBundler>) => Transport } = {}) {
  const key = privateKeyToAccount(generatePrivateKey());
  const owner = {
    type: "local",
    source: "privy",
    address: key.address,
    publicKey: key.publicKey,
    sign: async ({ hash }: { hash: Hex }) => key.sign({ hash }),
  } as unknown as LocalAccount;
  const account = await toCoinbaseSmartAccount({ client: forkClient, owners: [owner], version: "1" });
  const bundler = createForkBundler();
  const client = createSmartAccountClient({
    account,
    chain: base,
    client: forkClient,
    bundlerTransport: options.bundlerTransport?.(bundler) ?? bundler.transport,
    userOperation: {
      estimateFeesPerGas: async () => {
        const fees = await forkClient.estimateFeesPerGas();
        return { maxFeePerGas: (fees.maxFeePerGas * 175n) / 100n, maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 175n) / 100n };
      },
    },
  });
  const batches: NormalizedCall[][] = [];
  const sender = createSmartSender(
    account.address,
    {
      async sendBatch(calls) {
        batches.push(calls);
        return client.sendTransaction({ calls });
      },
      signMessage: (message) => account.signMessage({ message }),
      signTypedData: () => Promise.reject(new Error("not used")),
      // WalletProvider's adapter: the smart account client's own transport is the bundler.
      bundlerRequest: ({ method, params }) => client.request({ method, params }),
    },
    { reader, receiptTimeoutMs: 60_000 },
  );
  return { account, sender, bundler, batches };
}

describe("send from an external EOA", () => {
  it("sends exactly the attributed USDC.transfer the app builds, then All with no rounding", async () => {
    const eoa = randomAddress();
    const recipient = randomAddress();
    await setEthBalance(eoa, "1");
    await setUsdcBalance(eoa, USDC(100.123456));
    const sender = eoaSender(eoa);
    const pending = createPendingSendStore(null);

    const amount = USDC(25.5);
    const call = usdcTransferCall(getAddress(recipient), amount);
    // What the review shows: a fee estimate and a passing simulation, and the recipient is a plain wallet.
    await expect(chain.simulate(eoa, call)).resolves.toBeUndefined();
    const fee = await chain.estimateFee(eoa, call);
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThan(10n ** 15n);
    expect(await chain.code(recipient)).toBeUndefined();

    const startBlock = await forkClient.getBlockNumber();
    const sent = await sendUsdc({ sender, to: getAddress(recipient), amount, chain, pending });
    const tx = await forkClient.getTransaction({ hash: sent.hash });
    expect(tx.from.toLowerCase()).toBe(eoa.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(tx.input).toBe(call.data);
    expect(sent.receipt.status).toBe("success");
    expect(await usdcBalance(recipient)).toBe(amount);
    expect(await usdcBalance(eoa)).toBe(USDC(100.123456) - amount);
    expect(pending.read(eoa)).toBeNull();

    // A send whose outcome was lost is found again in the chain's history (real eth_getLogs, chunked).
    const settled = await checkPendingSend(
      { from: eoa, to: getAddress(recipient), amount, startedAt: Date.now(), fromBlock: startBlock, balanceBefore: USDC(100.123456), hash: null, userOpHash: null },
      chain,
    );
    expect(settled).toEqual({ status: "landed", hash: sent.hash });
    const byHash = await checkPendingSend(
      { from: eoa, to: getAddress(recipient), amount, startedAt: Date.now(), fromBlock: null, balanceBefore: USDC(100.123456), hash: sent.hash, userOpHash: null },
      chain,
    );
    expect(byHash).toEqual({ status: "landed", hash: sent.hash });

    // All: the exact remaining balance, 6 decimals and all.
    const rest = await usdcBalance(eoa);
    expect(rest).toBe(74_623_456n);
    await sendUsdc({ sender, to: getAddress(recipient), amount: rest, chain, pending });
    expect(await usdcBalance(eoa)).toBe(0n);
    expect(await usdcBalance(recipient)).toBe(amount + rest);
  });

  it("refuses an amount above the balance re-read before sending, and sends nothing", async () => {
    const eoa = randomAddress();
    await setEthBalance(eoa, "1");
    await setUsdcBalance(eoa, USDC(5));
    const nonce = await forkClient.getTransactionCount({ address: eoa });
    const error = await sendUsdc({ sender: eoaSender(eoa), to: getAddress(randomAddress()), amount: USDC(5.01), chain, pending: createPendingSendStore(null) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InsufficientUsdcError);
    expect(await forkClient.getTransactionCount({ address: eoa })).toBe(nonce);
    expect(await usdcBalance(eoa)).toBe(USDC(5));
  });
});

describe("send from a Coinbase Smart Wallet (Privy's smart wallet)", () => {
  it("runs as one user operation from the EntryPoint whose only call is the app's USDC.transfer", async () => {
    const { account, sender, bundler, batches } = await privySmartWallet();
    const recipient = getAddress(randomAddress());
    await setUsdcBalance(account.address, USDC(60));
    expect(await account.isDeployed()).toBe(false);
    const pending = createPendingSendStore(null);

    const first = await sendUsdc({ sender, to: recipient, amount: USDC(25), chain, pending });
    const second = await sendUsdc({ sender, to: recipient, amount: USDC(10.000001), chain, pending });

    expect(await usdcBalance(recipient)).toBe(USDC(25) + USDC(10.000001));
    expect(await usdcBalance(account.address)).toBe(USDC(60) - USDC(25) - USDC(10.000001));
    expect(pending.read(account.address)).toBeNull();

    const expected = [usdcTransferCall(recipient, USDC(25)), usdcTransferCall(recipient, USDC(10.000001))];
    expect(bundler.operations).toHaveLength(2);
    for (const [i, op] of bundler.operations.entries()) {
      const call = expected[i];
      if (!call) throw new Error("missing expected call");
      // The wallet adapter got exactly the call the app builds, and nothing else.
      expect(batches[i]).toEqual([{ to: call.to, data: call.data, value: 0n }]);
      // The operation's callData is Coinbase Smart Wallet execute(USDC, 0, that exact calldata).
      const decoded = decodeFunctionData({ abi: coinbaseSmartWalletAbi, data: op.userOperation.callData });
      expect(decoded.functionName).toBe("execute");
      const [target, value, data] = decoded.args as readonly [Address, bigint, Hex];
      expect(getAddress(target)).toBe(USDC_ADDRESS);
      expect(value).toBe(0n);
      expect(data).toBe(call.data);
      // The only call target is on the gas sponsor's allowlist.
      expect(SPONSORED_CALL_TARGETS.map((a) => a.toLowerCase())).toContain(target.toLowerCase());
      // It succeeds when the EntryPoint runs it, and in the bundle.
      expect(op.executeFromEntryPoint).toBe("ok");
      expect(op.userOperation.paymasterAndData).toBe("0x");
    }
    // The first operation deployed the account; the second ran on the deployed account.
    expect(bundler.operations[0]?.deploying).toBe(true);
    expect(bundler.operations[1]?.deploying).toBe(false);
    expect(await account.isDeployed()).toBe(true);

    // The app's receipt is the bundle transaction, scoped to this account's operation, with the transfer in it.
    for (const [i, sent] of [first, second].entries()) {
      expect(sent.hash).toBe(bundler.operations[i]?.bundleTx);
      const transfers = sent.receipt.logs.filter((log) => log.address.toLowerCase() === USDC_ADDRESS.toLowerCase());
      expect(transfers).toHaveLength(1);
      const settled = await checkPendingSend(
        { from: account.address, to: recipient, amount: sent.amount, startedAt: Date.now(), fromBlock: null, balanceBefore: 0n, hash: sent.hash as Hash, userOpHash: null },
        chain,
      );
      expect(settled).toEqual({ status: "landed", hash: sent.hash });
    }
  });

  it("simulates the transfer from the account before it is deployed, as the review does", async () => {
    const { account } = await privySmartWallet();
    await setUsdcBalance(account.address, USDC(1));
    // A counterfactual account is msg.sender in an eth_call like any address, so the review's check works before it exists.
    await expect(chain.simulate(account.address, usdcTransferCall(getAddress(randomAddress()), USDC(1)))).resolves.toBeUndefined();
    const balance = await forkClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    expect(balance).toBe(USDC(1));
  });
});

describe("a smart-wallet send whose outcome was lost", () => {
  it("is settled by its user operation (from the bundler) and by the Transfer history, and blocks a second send meanwhile", async () => {
    const { account, sender, bundler } = await privySmartWallet({
      // The bundler behind real HTTP, so the lost answer is a genuine viem HttpRequestError carrying the request.
      bundlerTransport: () => http(`http://127.0.0.1:${BUNDLER_PORT}`, { retryCount: 0 }),
    });
    const server = await serveForkBundler(bundler);
    try {
      const recipient = getAddress(randomAddress());
      await setUsdcBalance(account.address, USDC(40));
      const pending = createPendingSendStore(null);

      // The operation lands, but the bundler's answer to eth_sendUserOperation is lost (HTTP 502).
      server.loseNextSendAnswer();
      const error = await sendUsdc({ sender, to: recipient, amount: USDC(15), chain, pending }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WalletError);
      expect((error as WalletError).mayHaveLanded).toBe(true);
      expect(bundler.operations).toHaveLength(1);
      expect(await usdcBalance(recipient)).toBe(USDC(15));

      // The record keeps the operation's hash, computed from the request the app sent, before any transaction hash existed.
      const record = pending.read(account.address);
      expect(record).toMatchObject({ hash: null, userOpHash: bundler.operations[0]?.userOpHash, amount: USDC(15), to: recipient });
      if (!record) throw new Error("no pending record");

      // Nothing more can be sent until it is settled.
      const second = await sendUsdc({ sender, to: recipient, amount: USDC(1), chain, pending }).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(SendUnconfirmedError);
      expect(bundler.operations).toHaveLength(1);

      // The bundler settles it by the operation's hash...
      const bundleTx = bundler.operations[0]?.bundleTx;
      await expect(checkPendingSend(record, chain, { userOperationStatus: sender.userOperationStatus })).resolves.toEqual({ status: "landed", hash: bundleTx });
      // ...and so does the chain's Transfer history (real eth_getLogs) without it.
      await expect(checkPendingSend(record, chain)).resolves.toEqual({ status: "landed", hash: bundleTx });
    } finally {
      await server.close();
    }
  });

  it("offers another send only once the bundler has no record and the whole history since shows nothing", async () => {
    const { account, sender } = await privySmartWallet();
    await setUsdcBalance(account.address, USDC(40));
    const startedAt = Date.now() - RELEASE_PENDING_AFTER_MS;
    // An operation that never made it: the fork bundler has no record of this hash.
    const record = {
      from: account.address,
      to: getAddress(randomAddress()),
      amount: USDC(15),
      startedAt,
      fromBlock: (await forkClient.getBlockNumber()) - 5n,
      balanceBefore: USDC(40),
      hash: null,
      userOpHash: `0x${"5a".repeat(32)}` as Hash,
    };
    const check = await checkPendingSend(record, chain, { userOperationStatus: sender.userOperationStatus });
    expect(check).toMatchObject({ status: "pending", scanned: true, queued: false, balanceDropped: false });
    if (check.status !== "pending") throw new Error("expected pending");
    expect(canReleasePending(record, check, Date.now(), false)).toBe(true);

    // The balance is down by the amount since (it may have gone out some other way): no resend.
    await setUsdcBalance(account.address, USDC(25));
    const dropped = await checkPendingSend(record, chain, { userOperationStatus: sender.userOperationStatus });
    expect(dropped).toMatchObject({ status: "pending", balanceDropped: true });
    expect(canReleasePending(record, dropped.status === "pending" ? dropped : null, Date.now(), false)).toBe(false);
  });
});
