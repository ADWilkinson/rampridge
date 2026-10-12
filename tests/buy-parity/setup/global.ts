/**
 * Starts the two local services the parity suites need, and stops them after:
 *
 * 1. A read-only JSON-RPC proxy to the Base mainnet RPC in FORK_UPSTREAM_RPC_URL
 *    (archive-capable, e.g. an Alchemy endpoint) on PARITY_UPSTREAM_PORT
 *    (default 8559). It holds that URL, so the API key in it never appears in
 *    anvil's arguments, in a process listing or in an error message (anvil and
 *    viem echo the URL they failed on). It refuses every method that could send
 *    or sign, so nothing a test does can reach Base mainnet.
 * 2. anvil on PARITY_FORK_PORT (default 8558) forking Base at the latest block
 *    through that proxy. No --auto-impersonate: every fork transaction is signed
 *    by a key the test holds; accounts are funded with anvil_setBalance.
 *
 * Ports are confined to 8550-8559, or 8570-8579 so that two runs on one
 * machine can each have their own. Other local test runs may reuse any node
 * already answering on their own default port, so this setup marks its fork
 * (a random balance at FORK_MARKER, handed to the suites with `provide`) and
 * the suites refuse to run on a fork without that mark.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/** Address whose fork balance identifies this run's anvil (no key, never used on mainnet). */
export const FORK_MARKER = "0x00000000000000000000000000000000ba11ad01";

const BASE_CHAIN_ID = 8453;

/** JSON-RPC methods the proxy never forwards to mainnet. */
const BLOCKED_METHODS = /^(eth_send|eth_sign|personal_|wallet_|eth_accounts|eth_requestAccounts|eth_submit|anvil_|hardhat_|evm_)/;

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || !((value >= 8550 && value <= 8559) || (value >= 8570 && value <= 8579))) {
    throw new Error(`${name} must be a port in 8550-8559 or 8570-8579 (got ${process.env[name]})`);
  }
  return value;
}

function upstreamUrl(): string {
  const url = process.env.FORK_UPSTREAM_RPC_URL?.trim();
  if (!url) {
    throw new Error("FORK_UPSTREAM_RPC_URL is not set: export an archive-capable Base mainnet RPC URL first (see vitest.parity.config.ts).");
  }
  return url;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("<upstream>") : text;
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
      signal: AbortSignal.timeout(3_000),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? Number(BigInt(body.result)) : null;
  } catch {
    return null;
  }
}

function blocked(body: unknown): string | null {
  const calls = Array.isArray(body) ? body : [body];
  for (const call of calls) {
    const method = call && typeof call === "object" ? (call as { method?: unknown }).method : undefined;
    if (typeof method !== "string") return "missing method";
    if (BLOCKED_METHODS.test(method)) return method;
  }
  return null;
}

function startProxy(listenPort: number, upstream: string): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
          return;
        }
        const refused = blocked(parsed);
        if (refused) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: (parsed as { id?: unknown }).id ?? null,
              error: { code: -32601, message: `parity proxy refuses ${refused}: Base mainnet is read-only here` },
            }),
          );
          return;
        }
        try {
          const upstreamRes = await fetch(upstream, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
            signal: AbortSignal.timeout(120_000),
          });
          const text = await upstreamRes.text();
          res.writeHead(upstreamRes.status, { "content-type": "application/json" });
          res.end(redact(text, upstream));
        } catch (error) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: (parsed as { id?: unknown }).id ?? null,
              error: { code: -32603, message: redact(`upstream failed: ${String(error)}`, upstream) },
            }),
          );
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
}

let proxy: Server | null = null;
let anvil: ChildProcess | null = null;

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function setup(project: TestProject): Promise<void> {
  const forkPort = port("PARITY_FORK_PORT", 8558);
  const upstreamPort = port("PARITY_UPSTREAM_PORT", 8559);
  const upstream = upstreamUrl();
  const proxyUrl = `http://127.0.0.1:${upstreamPort}`;
  const forkUrl = `http://127.0.0.1:${forkPort}`;

  if ((await chainId(forkUrl)) !== null) {
    throw new Error(`Port ${forkPort} is already serving JSON-RPC; stop it or set PARITY_FORK_PORT.`);
  }

  proxy = await startProxy(upstreamPort, upstream);
  if ((await chainId(proxyUrl)) !== BASE_CHAIN_ID) throw new Error("The mainnet proxy does not answer Base (8453).");

  anvil = spawn(anvilBinary(), ["--fork-url", proxyUrl, "--port", String(forkPort), "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  anvil.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited (${anvil.exitCode}): ${redact(stderr, upstream).slice(0, 500)}`);
    if ((await chainId(forkUrl)) === BASE_CHAIN_ID) {
      const marker = `0x1${randomBytes(12).toString("hex")}`;
      await rpc(forkUrl, "anvil_setBalance", [FORK_MARKER, marker]);
      project.provide("parityForkMarker", marker);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await teardown();
  throw new Error("anvil did not start within 90 s");
}

export async function teardown(): Promise<void> {
  if (anvil) {
    const child = anvil;
    anvil = null;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }
  if (proxy) {
    const server = proxy;
    proxy = null;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}
