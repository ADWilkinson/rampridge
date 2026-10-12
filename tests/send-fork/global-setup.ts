/**
 * Starts (or reuses) the anvil fork of Base that the send fork test runs
 * against, on SEND_FORK_PORT (default 8560).
 *
 * - When a node on the port already answers chain id 8453 it is reused and
 *   left running.
 * - Otherwise anvil is spawned forking SEND_FORK_UPSTREAM_RPC_URL, else
 *   FORK_UPSTREAM_RPC_URL (a Base mainnet RPC), with --auto-impersonate so
 *   any address can send. It is stopped afterwards.
 *
 * The upstream URL usually carries an API key: it is passed to anvil and never logged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_CHAIN_ID = 8453;

export function forkPort(): string {
  return process.env.SEND_FORK_PORT ?? "8560";
}

function forkUrl(): string {
  return `http://127.0.0.1:${forkPort()}`;
}

function upstreamUrl(): string | null {
  return process.env.SEND_FORK_UPSTREAM_RPC_URL?.trim() || process.env.FORK_UPSTREAM_RPC_URL?.trim() || null;
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

export async function setup(): Promise<void> {
  const url = forkUrl();
  const existing = await chainId(url);
  if (existing === BASE_CHAIN_ID) return;
  if (existing !== null) throw new Error(`${url} answers chain ${existing}, not a Base fork (8453).`);
  const upstream = upstreamUrl();
  if (!upstream) {
    throw new Error("No Base fork: set FORK_UPSTREAM_RPC_URL or SEND_FORK_UPSTREAM_RPC_URL (see tests/send-fork/README.md).");
  }
  child = spawn(anvilBinary(), ["--fork-url", upstream, "--port", forkPort(), "--auto-impersonate", "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
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
