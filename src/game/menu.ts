import type { StallSummary, Tile } from "@shared/protocol";
import type { MenuOption } from "./types";

/**
 * Right-click menus in the original's order: each entity under the cursor
 * contributes its options (closest first, Examine last), NPC and object
 * options sit above "Walk here", and plain players' options sit below it,
 * as the client deprioritises player actions. Players advertising a stall
 * are traders, so their options rank with the NPCs. A merchant standing on
 * a tile another player occupies yields to that player: its options drop to
 * the end, after "Walk here" and the player's own, so a click on the pair
 * never trades by accident. "Cancel" is appended by the UI.
 */

export type MenuHit =
  | { kind: "banker"; npcIndex: number; name: string; serves: boolean }
  | { kind: "booth"; boothIndex: number }
  | { kind: "merchant"; merchantId: string; name: string; sharesTile?: boolean }
  | { kind: "player"; pid: string; name: string; stall: StallSummary | null };

const PLATFORM_NAMES: Record<string, string> = {
  venmo: "Venmo",
  revolut: "Revolut",
  wise: "Wise",
  cashapp: "Cash App",
  "cash app": "Cash App",
  zelle: "Zelle",
  paypal: "PayPal",
  monzo: "Monzo",
  mercadopago: "Mercado Pago",
  chime: "Chime",
  n26: "N26",
  alipay: "Alipay",
  upi: "UPI",
  monobank: "Monobank",
  xmoney: "X Money",
};

export function platformName(platform: string): string {
  const known = PLATFORM_NAMES[platform.toLowerCase()];
  if (known) return known;
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** Whole USDC with thousands separators, as the stack size the game would show. */
export function formatUsdc(decimal: string): string {
  const whole = decimal.split(".")[0]!.replace(/^0+(?=\d)/, "") || "0";
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatRate(rate: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return rate;
  return n >= 100 ? n.toFixed(2) : n.toPrecision(4).replace(/\.?0+$/, "");
}

/** Overhead tag for a player's stall, e.g. "Selling 500 USDC". */
export function stallTag(stall: StallSummary): string {
  return `Selling ${formatUsdc(stall.available)} USDC`;
}

/** Menu suffix for a stall, e.g. "(500 USDC @ 0.79 GBP, Revolut)". */
export function stallSuffix(stall: StallSummary): string {
  return `(${formatUsdc(stall.available)} USDC @ ${formatRate(stall.rate)} ${stall.currency.toUpperCase()}, ${platformName(stall.platform)})`;
}

export const BANKER_EXAMINE = "Good with money.";
export const BOOTH_EXAMINE = "The bank teller will serve you from here.";

export function merchantExamine(name: string, platform: string, currency: string): string {
  return `${name}: sells USDC for ${currency.toUpperCase()} paid by ${platformName(platform)}.`;
}

export function playerExamine(name: string, stall: StallSummary | null): string {
  if (!stall) return `${name}, a fellow trader.`;
  return `${name} is selling ${formatUsdc(stall.available)} USDC for ${stall.currency.toUpperCase()} by ${platformName(stall.platform)} at ${formatRate(stall.rate)} ${stall.currency.toUpperCase()} each.`;
}

function optionsFor(hit: MenuHit): MenuOption[] {
  switch (hit.kind) {
    case "banker": {
      const target = { kind: "banker", npcIndex: hit.npcIndex } as const;
      const base = { targetName: hit.name, kind: "npc", target } as const;
      if (!hit.serves) return [{ ...base, verb: "Examine", interact: "examine" }];
      return [
        { ...base, verb: "Talk-to", interact: "talk" },
        { ...base, verb: "Bank", interact: "bank" },
        { ...base, verb: "Exchange", interact: "exchange" },
        { ...base, verb: "Examine", interact: "examine" },
      ];
    }
    case "booth": {
      const target = { kind: "booth", boothIndex: hit.boothIndex } as const;
      const base = { targetName: "Bank booth", kind: "object", target } as const;
      return [
        { ...base, verb: "Bank", interact: "bank" },
        { ...base, verb: "Exchange", interact: "exchange" },
        { ...base, verb: "Collect", interact: "collect" },
        { ...base, verb: "Examine", interact: "examine" },
      ];
    }
    case "merchant": {
      const target = { kind: "merchant", merchantId: hit.merchantId } as const;
      const base = { targetName: hit.name, kind: "npc", target } as const;
      return [
        { ...base, verb: "Trade", interact: "trade" },
        { ...base, verb: "Examine", interact: "examine" },
      ];
    }
    case "player": {
      const target = { kind: "player", pid: hit.pid } as const;
      const base = { targetName: hit.name, kind: "player", target } as const;
      const out: MenuOption[] = [];
      if (hit.stall) out.push({ ...base, verb: "Trade-with", interact: "trade-stall", suffix: stallSuffix(hit.stall) });
      out.push({ ...base, verb: "Follow", interact: "follow" });
      out.push({ ...base, verb: "Examine", interact: "examine" });
      return out;
    }
  }
}

/** Builds the menu for the entities under the cursor (closest first) and the floor tile, if any. */
export function buildMenu(hits: readonly MenuHit[], floor: Tile | null): MenuOption[] {
  const above: MenuOption[] = [];
  const below: MenuOption[] = [];
  const last: MenuOption[] = [];
  for (const hit of hits) {
    const list = hit.kind === "player" && !hit.stall ? below : hit.kind === "merchant" && hit.sharesTile ? last : above;
    list.push(...optionsFor(hit));
  }
  if (floor) {
    above.push({
      verb: "Walk here",
      targetName: "",
      kind: "tile",
      interact: "walk",
      target: { kind: "tile", tile: { x: floor.x, y: floor.y } },
    });
  }
  return above.concat(below, last);
}

/** Stable key for comparing hover results without deep equality. */
export function optionKey(option: MenuOption): string {
  const t = option.target;
  const id =
    t.kind === "banker"
      ? t.npcIndex
      : t.kind === "booth"
        ? t.boothIndex
        : t.kind === "merchant"
          ? t.merchantId
          : t.kind === "player"
            ? t.pid
            : `${t.tile.x},${t.tile.y}`;
  return `${option.verb}|${t.kind}|${id}|${option.targetName}|${option.suffix ?? ""}`;
}
