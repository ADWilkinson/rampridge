/**
 * Starts (or reuses) the anvil Base fork the fork suites run against.
 *
 * - FORK_RPC_URL (default http://127.0.0.1:$FORK_PORT, port 8547): when a
 *   node there already answers chain id 8453 it is reused and left running,
 *   re-forked at the latest block first (anvil_reset) unless FORK_KEEP_STATE=1.
 * - Otherwise anvil is spawned forking FORK_UPSTREAM_RPC_URL (an
 *   archive-capable Base mainnet RPC), with --auto-impersonate so any address
 *   can send. It is stopped afterwards.
 *
 * The upstream URL usually carries an API key: it is passed to anvil and never logged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_CHAIN_ID = 8453;

function forkPort(): string {
  return process.env.FORK_PORT ?? "8547";
}

function forkRpcUrl(): string {
  return process.env.FORK_RPC_URL ?? `http://127.0.0.1:${forkPort()}`;
}

function upstreamUrl(): string | null {
  return process.env.FORK_UPSTREAM_RPC_URL?.trim() || null;
}

function anvilBinary(): string {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const foundry = join(homedir(), ".foundry", "bin", "anvil");
  return existsSync(foundry) ? foundry : "anvil";
}

async function chainId(url: string): Promise<number | null> {
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

let child: ChildProcess | null = null;

/** Re-forks a reused node at the upstream's latest block, so live quotes match the fork's state. */
async function refork(url: string, upstream: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_reset", params: [{ forking: { jsonRpcUrl: upstream } }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as { error?: { message?: string } };
  if (body.error) throw new Error(`anvil_reset failed: ${body.error.message ?? "unknown error"}`);
}

export async function setup(): Promise<void> {
  const url = forkRpcUrl();
  const existing = await chainId(url);
  if (existing === BASE_CHAIN_ID) {
    // A reused fork drifts behind mainnet while Curator quotes live liquidity: start from the latest block
    // unless told to keep the node's state (FORK_KEEP_STATE=1, or no upstream to re-fork from).
    const upstream = upstreamUrl();
    if (upstream && process.env.FORK_KEEP_STATE !== "1") await refork(url, upstream);
    return;
  }
  if (existing !== null) throw new Error(`${url} answers chain ${existing}, not a Base fork (8453).`);

  const upstream = upstreamUrl();
  if (!upstream) {
    throw new Error(
      "No Base fork: start anvil yourself (see tests/fork/README.md) or set FORK_UPSTREAM_RPC_URL to an archive-capable Base RPC.",
    );
  }
  child = spawn(
    anvilBinary(),
    ["--fork-url", upstream, "--port", forkPort(), "--auto-impersonate", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      // anvil echoes its own arguments in some errors; never print the upstream key.
      throw new Error(`anvil exited (${child.exitCode}): ${stderr.split(upstream).join("<upstream>").slice(0, 500)}`);
    }
    if ((await chainId(url)) === BASE_CHAIN_ID) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error("anvil did not start within 60 s");
}

export async function teardown(): Promise<void> {
  if (!child) return;
  child.kill("SIGTERM");
  child = null;
}
