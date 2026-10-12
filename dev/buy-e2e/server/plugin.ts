/**
 * Dev-server endpoints for the fork e2e (dev/buy-e2e.html), served by the
 * dedicated Vite config only:
 *
 *   GET  /__e2e/config                         fork RPC URL and chain id for the page
 *   GET  /__e2e/attest/enclave-key             the mock enclave upload key (SPKI DER, base64)
 *   POST /__e2e/attest/buyer/verify/:p/:a      the mock attestation service (./attestor.ts)
 *   GET  /__e2e/attest/log                     every verify decision, oldest first
 *   POST /__e2e/revolut/session                {cookie, transactions?}: open or reset a bank account
 *   POST /__e2e/revolut/pay                    {cookie, ...RevolutTransaction}: the buyer sends money
 *   GET  /__e2e/revolut/transactions           the account's last 20 transactions (x-e2e-revolut-cookie)
 *
 * The page rewrites https://attestation-service.zkp2p.xyz (and the SDK's
 * Railway fallback proxy) to /__e2e/attest, so the real service is never called.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { FakeRevolut, generateUploadKey, verifyBuyerTee, type RevolutTransaction, type VerifyDecision } from "./attestor.ts";

/** contracts-v2 addresses/base.json "UnifiedPaymentVerifierV3"; the driver checks the registry routes Revolut to it. */
export const UNIFIED_PAYMENT_VERIFIER_V3: Address = "0xC6F4a193576C60892a47e111Bb5706c30162502B";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function e2eServer(): Plugin {
  const witnessKey = process.env.E2E_WITNESS_KEY as Hex | undefined;
  const forkRpcUrl = process.env.VITE_BASE_RPC_URL ?? "";
  const verifier = (process.env.E2E_VERIFIER as Address | undefined) ?? UNIFIED_PAYMENT_VERIFIER_V3;
  const uploadKey = generateUploadKey();
  const bank = new FakeRevolut();
  const log: VerifyDecision[] = [];

  return {
    name: "rampridge-buy-e2e-server",
    apply: "serve",
    configureServer(server) {
      if (!witnessKey) throw new Error("E2E_WITNESS_KEY is required (the fork e2e driver sets it).");
      if (!/^http:\/\/(127\.0\.0\.1|localhost):855\d$/.test(forkRpcUrl)) {
        throw new Error(`VITE_BASE_RPC_URL must be the local anvil fork (127.0.0.1:8550-8559), got ${forkRpcUrl || "nothing"}.`);
      }
      const witness = privateKeyToAccount(witnessKey);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://local");
        if (!url.pathname.startsWith("/__e2e/")) return next();
        try {
          if (req.method === "GET" && url.pathname === "/__e2e/config") {
            return send(res, 200, { forkRpcUrl, chainId: 8453, witness: witness.address, verifier });
          }
          if (req.method === "GET" && url.pathname === "/__e2e/attest/enclave-key") {
            return send(res, 200, {
              publicKeyDerB64: uploadKey.publicKeyDer.toString("base64"),
              publicKeySha256Hex: uploadKey.publicKeySha256Hex,
            });
          }
          const verify = /^\/__e2e\/attest\/buyer\/verify\/([^/]+)\/([^/]+)$/.exec(url.pathname);
          if (req.method === "POST" && verify) {
            let body: unknown;
            try {
              body = await readJson(req);
            } catch {
              return send(res, 400, { success: false, message: "Invalid JSON", responseObject: null, statusCode: 400 });
            }
            const result = await verifyBuyerTee(decodeURIComponent(verify[1]!), decodeURIComponent(verify[2]!), body, {
              chainId: 8453,
              verifyingContract: verifier,
              witness,
              uploadKey,
              bank,
            });
            log.push(result.decision);
            return send(res, result.status, result.body);
          }
          if (req.method === "GET" && url.pathname === "/__e2e/attest/log") return send(res, 200, log);
          if (req.method === "POST" && url.pathname === "/__e2e/revolut/session") {
            const { cookie, transactions } = (await readJson(req)) as { cookie: string; transactions?: RevolutTransaction[] };
            bank.reset(cookie, transactions ?? []);
            return send(res, 200, { ok: true });
          }
          if (req.method === "POST" && url.pathname === "/__e2e/revolut/pay") {
            const { cookie, ...tx } = (await readJson(req)) as { cookie: string } & RevolutTransaction;
            bank.pay(cookie, tx);
            return send(res, 200, { ok: true });
          }
          if (req.method === "GET" && url.pathname === "/__e2e/revolut/transactions") {
            const cookie = String(req.headers["x-e2e-revolut-cookie"] ?? "");
            const list = bank.transactions(cookie);
            return list ? send(res, 200, list) : send(res, 401, { message: "Unauthorized" });
          }
          return send(res, 404, { message: "Unknown e2e endpoint" });
        } catch (error) {
          return send(res, 500, { message: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
