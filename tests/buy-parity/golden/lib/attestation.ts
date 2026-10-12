/**
 * Replaces ONLY the attestation service's HTTP call with the response a real
 * fulfilment proves it returned. Every other request (the fork, the Peer
 * indexer, Curator) goes to the real network through the original fetch.
 * Each attestation request is recorded for the parity assertions, and any
 * request to an attestation host while no response is armed fails loudly.
 */

import { vi } from "vitest";
import type { ReconstructedAttestationResponse } from "./decode";

export interface RecordedAttestationRequest {
  url: string;
  origin: string;
  path: string;
  method: string;
  body: {
    encryptedSessionMaterial?: unknown;
    params?: Record<string, unknown>;
    chainId?: unknown;
    intent?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

const ATTESTATION_HOST = /attestation-service/i;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export interface AttestationMock {
  requests: RecordedAttestationRequest[];
  /** Hosts (other than the fork and the attestation service) the code under test fetched. */
  otherHosts: Set<string>;
  /** Those requests, for diagnosis (URL and the first 300 characters of the body). */
  otherRequests: string[];
  arm(response: ReconstructedAttestationResponse): void;
  disarm(): void;
  /** Answers every request to these hosts with a 503, as during an outage (empty to stop). */
  outage(hosts: readonly string[]): void;
  restore(): void;
}

export function installAttestationMock(ignoreOrigins: readonly string[]): AttestationMock {
  const realFetch = globalThis.fetch.bind(globalThis);
  const requests: RecordedAttestationRequest[] = [];
  const otherHosts = new Set<string>();
  const otherRequests: string[] = [];
  let armed: ReconstructedAttestationResponse | null = null;
  let down = new Set<string>();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = urlOf(input);
    const parsed = new URL(url);
    if (ATTESTATION_HOST.test(parsed.host)) {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      const body = typeof raw === "string" ? (JSON.parse(raw) as RecordedAttestationRequest["body"]) : {};
      requests.push({ url, origin: parsed.origin, path: parsed.pathname, method: init?.method ?? "GET", body });
      if (!armed) {
        return new Response(JSON.stringify({ success: false, message: "golden replay: no attestation armed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(armed), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (down.has(parsed.host)) {
      otherRequests.push(`${url} (outage: 503)`);
      return new Response("service unavailable", { status: 503 });
    }
    if (!ignoreOrigins.includes(parsed.origin)) {
      otherHosts.add(parsed.host);
      otherRequests.push(`${url} ${typeof init?.body === "string" ? init.body.slice(0, 300) : ""}`);
    }
    return realFetch(input as RequestInfo, init);
  });
  return {
    requests,
    otherHosts,
    otherRequests,
    arm(response) {
      armed = response;
    },
    disarm() {
      armed = null;
    },
    outage(hosts) {
      down = new Set(hosts);
    },
    restore() {
      spy.mockRestore();
    },
  };
}
