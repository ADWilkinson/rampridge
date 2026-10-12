/**
 * Fork e2e harness entry (dev/buy-e2e.html). Order matters: the network
 * guard and the simulated Peer extension are installed before any app module
 * is evaluated, then the real buy UI and store mount over a TxSender that
 * sends to the local anvil fork.
 *
 * Query parameters (the driver sets them; a reload keeps them):
 *   buyer=0x...        the player's address (anvil impersonates it; one fake Revolut account per buyer)
 *   ext=ready|missing|needs_connection|decline|outdated   the extension's state
 *   extVersion=0.7.3   reported extension version
 *   captureMs=1500     how long the "provider tab" takes to return payments
 *   clock=0            ms added to the page clock (expiry scenarios)
 *   open=exchange      interface open on load
 */

import type { Address } from "viem";
import { installPeerExtensionSim, type ExtensionMode } from "./extensionSim";
import { installNetworkGuard } from "./guard";

const params = new URLSearchParams(window.location.search);
const buyer = params.get("buyer") as Address | null;
if (!buyer || !/^0x[0-9a-fA-F]{40}$/.test(buyer)) throw new Error("buy-e2e: ?buyer=0x... is required");
const mode = (params.get("ext") ?? "ready") as ExtensionMode;
const config = (await (await fetch("/__e2e/config")).json()) as { forkRpcUrl: string; chainId: number };
const guard = installNetworkGuard(config.forkRpcUrl);
const clock = { offset: Number(params.get("clock") ?? "0") || 0, now: () => Date.now() + clock.offset };
const ext = installPeerExtensionSim({
  mode,
  version: params.get("extVersion") ?? (mode === "outdated" ? "0.5.4" : "0.7.3"),
  captureDelayMs: Number(params.get("captureMs") ?? "1500"),
  revolutCookie: buyer.toLowerCase(),
  now: clock.now,
});

const { mountHarness } = await import("./app");
mountHarness({ buyer, forkRpcUrl: config.forkRpcUrl, guard, clock, ext, open: params.get("open") ?? "exchange" });
