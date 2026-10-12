/**
 * JSON-RPC to the Base archive node the golden fixtures are read from
 * (GOLDEN_UPSTREAM_RPC_URL, else FORK_UPSTREAM_RPC_URL).
 * The URL usually carries an API key: it is never logged, and errors are scrubbed.
 */

import type { Rpc } from "./decode";

export function upstreamRpcUrl(): string {
  const url = process.env.GOLDEN_UPSTREAM_RPC_URL?.trim() || process.env.FORK_UPSTREAM_RPC_URL?.trim();
  if (!url) {
    throw new Error("Set FORK_UPSTREAM_RPC_URL (or GOLDEN_UPSTREAM_RPC_URL) to an archive-capable Base mainnet RPC URL.");
  }
  return url;
}

export function scrub(text: string, url: string = safeUpstream()): string {
  return url ? text.split(url).join("<upstream>") : text;
}

function safeUpstream(): string {
  try {
    return upstreamRpcUrl();
  } catch {
    return "";
  }
}

let id = 0;

export function jsonRpc(url: string): Rpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      let body: { result?: T; error?: { code: number; message: string } };
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 429 && attempt < 6) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        body = (await res.json()) as typeof body;
      } catch (error) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        throw new Error(scrub(`${method} failed: ${error instanceof Error ? error.message : String(error)}`, url));
      }
      if (body.error) {
        if (body.error.code === 429 && attempt < 6) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        throw new Error(scrub(`${method}: ${JSON.stringify(body.error)}`, url));
      }
      return body.result as T;
    }
  };
}

export function upstreamRpc(): Rpc {
  return jsonRpc(upstreamRpcUrl());
}
