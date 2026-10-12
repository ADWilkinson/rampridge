/**
 * The golden suite's own Base fork, independent of any other parity suite:
 *
 * - a read-only JSON-RPC proxy (GOLDEN_PROXY_PORT, default 8554) that holds
 *   the upstream RPC URL (lib/rpc.ts) and refuses every send/sign method, so nothing can ever
 *   reach Base mainnet; historical reads (traces, receipts) go through it too.
 * - anvil (GOLDEN_FORK_PORT, default 8553) forking through that proxy with
 *   --auto-impersonate, re-pointed per case with anvil_reset to the block
 *   before the real fulfilment.
 *
 * Both are started by `startGoldenFork()` and stopped by its `stop()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { Rpc } from "./decode";
import { jsonRpc, scrub, upstreamRpcUrl } from "./rpc";

export const GOLDEN_FORK_PORT = Number(process.env.GOLDEN_FORK_PORT ?? 8553);
export const GOLDEN_PROXY_PORT = Number(process.env.GOLDEN_PROXY_PORT ?? 8554);
export const GOLDEN_FORK_URL = `http://127.0.0.1:${GOLDEN_FORK_PORT}`;
export const GOLDEN_PROXY_URL = `http://127.0.0.1:${GOLDEN_PROXY_PORT}`;

/** Anything that could sign, send or touch accounts is refused by the proxy. */
const REFUSED = /send|sign|submit|personal_|wallet_|eth_accounts|eth_coinbase|anvil_|hardhat_|evm_|txpool_/i;

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
}

function refusal(req: JsonRpcRequest) {
  return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `golden proxy refuses ${String(req.method)}` } };
}

export const refusedMethods: string[] = [];

async function startProxy(upstream: string): Promise<Server> {
  // Captured now, before any test replaces fetch: the proxy's own upstream traffic is not the app's.
  const upstreamFetch = globalThis.fetch.bind(globalThis);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let parsed: JsonRpcRequest | JsonRpcRequest[];
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        res.writeHead(400).end();
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const blocked = list.filter((r) => typeof r.method !== "string" || REFUSED.test(r.method));
      if (blocked.length > 0) {
        for (const r of blocked) refusedMethods.push(String(r.method));
        const body = Array.isArray(parsed) ? list.map(refusal) : refusal(parsed);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        return;
      }
      try {
        const upstreamRes = await upstreamFetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed),
          signal: AbortSignal.timeout(120_000),
        });
        const text = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { "content-type": "application/json" }).end(text);
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), upstream);
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(GOLDEN_PROXY_PORT, "127.0.0.1", () => resolve());
  });
  return server;
}

function anvilBinary(): string {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const foundry = join(homedir(), ".foundry", "bin", "anvil");
  return existsSync(foundry) ? foundry : "anvil";
}

async function answersChainId(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? Number(BigInt(body.result)) : null;
  } catch {
    return null;
  }
}

export interface GoldenFork {
  /** JSON-RPC to the fork. */
  fork: Rpc;
  /** Read-only JSON-RPC to Base mainnet (through the proxy). */
  mainnet: Rpc;
  /** Re-forks Base at `blockNumber` (state after that block). */
  resetTo(blockNumber: number): Promise<void>;
  snapshot(): Promise<Hex>;
  revert(id: Hex): Promise<void>;
  stop(): Promise<void>;
}

export async function startGoldenFork(initialBlock: number): Promise<GoldenFork> {
  if ((await answersChainId(GOLDEN_FORK_URL)) !== null) {
    throw new Error(`${GOLDEN_FORK_URL} is already in use; set GOLDEN_FORK_PORT to a free port (8550-8559).`);
  }
  const upstream = upstreamRpcUrl();
  const proxy = await startProxy(upstream);
  let child: ChildProcess | null = null;
  let stderr = "";
  /** Why the last anvil exited, when it was not stopped by us (e.g. killed by another process). */
  let lastExit: string | null = null;

  const spawnAnvil = async (blockNumber: number) => {
    stderr = "";
    const proc = spawn(
      anvilBinary(),
      [
        "--fork-url",
        GOLDEN_PROXY_URL,
        "--fork-block-number",
        String(blockNumber),
        "--port",
        String(GOLDEN_FORK_PORT),
        "--auto-impersonate",
        "--no-storage-caching",
        "--silent",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code, signal) => {
      if (child === proc) {
        child = null;
        lastExit = `anvil exited unexpectedly (code ${code}, signal ${signal}): ${scrub(stderr.slice(-500), upstream)}`;
      }
    });
    child = proc;
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (proc.exitCode !== null || child !== proc) {
        throw new Error(lastExit ?? `anvil exited (${proc.exitCode}): ${scrub(stderr.slice(0, 500), upstream)}`);
      }
      if ((await answersChainId(GOLDEN_FORK_URL)) === 8453) return;
      if (Date.now() > deadline) throw new Error("anvil did not start within 90 s");
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const stop = async () => {
    const c = child;
    child = null;
    if (c) {
      c.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  };

  try {
    await spawnAnvil(initialBlock);
  } catch (error) {
    await stop();
    throw error;
  }

  const raw = jsonRpc(GOLDEN_FORK_URL);
  // A dead fork names why it died instead of a bare "fetch failed".
  const fork: Rpc = async <T>(method: string, params: unknown[]) => {
    if (!child) throw new Error(`fork is down (${lastExit ?? "stopped"}); ${method} not sent`);
    try {
      return await raw<T>(method, params);
    } catch (error) {
      if (!child && lastExit) throw new Error(`${lastExit} (during ${method})`);
      throw error;
    }
  };
  return {
    fork,
    mainnet: jsonRpc(GOLDEN_PROXY_URL),
    async resetTo(blockNumber) {
      if (!child) {
        // Killed from outside (another suite's cleanup): start again at the requested block.
        await spawnAnvil(blockNumber);
        return;
      }
      await fork("anvil_reset", [{ forking: { jsonRpcUrl: GOLDEN_PROXY_URL, blockNumber } }]);
    },
    snapshot: () => fork<Hex>("evm_snapshot", []),
    async revert(id) {
      const ok = await fork<boolean>("evm_revert", [id]);
      if (!ok) throw new Error(`evm_revert ${id} failed`);
    },
    stop,
  };
}
