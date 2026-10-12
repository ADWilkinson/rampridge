/**
 * Network guard for the fork e2e page, installed before any app module loads:
 *
 * - Attestation requests (https://attestation-service.zkp2p.xyz, its staging
 *   host, and the SDK's Railway fallback proxy) are rewritten to the dev
 *   server's mock service at /__e2e/attest. The real service is never called.
 * - JSON-RPC to anything except the local anvil fork is refused, so no read
 *   or write can reach Base mainnet (the app's public client falls back to
 *   mainnet.base.org when its RPC fails; here that fallback is blocked).
 * - Curator (api.zkp2p.xyz) and the indexer pass through untouched: quotes,
 *   /v3/sign and payee lookups are the real production API.
 */

export interface GuardLog {
  attestation: Array<{ from: string; to: string; status?: number }>;
  blocked: string[];
  curator: Array<{ method: string; path: string; status?: number }>;
}

const ATTESTATION_ORIGINS = [
  "https://attestation-service.zkp2p.xyz",
  "https://attestation-service-staging.zkp2p.xyz",
  "https://attestation-service-proxy.up.railway.app",
];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function installNetworkGuard(forkRpcUrl: string): GuardLog {
  const log: GuardLog = { attestation: [], blocked: [], curator: [] };
  const realFetch = window.fetch.bind(window);
  const fork = new URL(forkRpcUrl);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = urlOf(input);
    let url: URL;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return realFetch(input, init);
    }

    const attest = ATTESTATION_ORIGINS.find((origin) => url.origin === origin);
    if (attest) {
      const to = `/__e2e/attest${url.pathname}${url.search}`;
      const entry: GuardLog["attestation"][number] = { from: url.href, to };
      log.attestation.push(entry);
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      const response = await realFetch(to, { method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers: init?.headers, body });
      entry.status = response.status;
      return response;
    }

    const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text().catch(() => "") : "";
    const isRpc = body.includes('"jsonrpc"');
    if (isRpc && url.origin !== fork.origin) {
      log.blocked.push(`${url.origin} ${body.slice(0, 120)}`);
      throw new TypeError(`e2e guard: JSON-RPC to ${url.host} blocked (fork only)`);
    }

    if (url.host === "api.zkp2p.xyz") {
      const entry: GuardLog["curator"][number] = { method: init?.method ?? "GET", path: url.pathname };
      log.curator.push(entry);
      const response = await realFetch(input, init);
      entry.status = response.status;
      return response;
    }
    return realFetch(input, init);
  };
  return log;
}
