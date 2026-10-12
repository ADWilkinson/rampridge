/**
 * Keeps the first download small: the title screen's static import graph
 * (src/main.tsx and the lazy shell it renders, src/app/AppRoot.tsx) must not
 * reach the Peer SDKs, the wallet stack, viem or the realtime client. Those
 * load once the title is up or the world is (entryCode.ts, World.tsx), or
 * when a player logs in or opens a trading interface (buyFlow.ts, wallet.ts,
 * interfaces.tsx). A static import of any of them from a title-path module
 * would put hundreds of kilobytes back in front of every first visit.
 *
 * A source-level walk: `import type` and dynamic `import()` don't count,
 * everything else (including `import { type X }`, which verbatimModuleSyntax
 * keeps as a side-effect import) does.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const ENTRIES = ["src/main.tsx", "src/app/AppRoot.tsx"];

/** Packages that must stay out of the title's download. */
const BANNED_PACKAGES = [/^@zkp2p\//, /^@privy-io\//, /^@walletconnect\//, /^@reown\//, /^firebase(\/|$)/, /^@firebase\//, /^viem(\/|$)/, /^ethers(\/|$)/, /^permissionless(\/|$)/];

/** Modules that load lazily on purpose, so nothing on the title path may import them statically. */
const LAZY_MODULES = [
  "src/peer/buy/index.ts",
  "src/peer/market.ts",
  "src/peer/platforms.ts",
  "src/peer/client.ts",
  "src/net/world.ts",
  "src/net/index.ts",
  "src/wallet/index.ts",
  "src/wallet/publicClient.ts",
  "src/wallet/balances.ts",
  "src/app/World.tsx",
  "src/app/walletStack.tsx",
];

const SPECIFIERS = [
  // import x from "y"; import { a } from "y"; import * as n from "y"; export { a } from "y"; export * from "y"
  /^\s*(import|export)\s+(type\s+)?(?:[\w$*\s{},]*?)\s*from\s*["']([^"']+)["']/gm,
  // import "y"
  /^\s*import\s+["']([^"']+)["']/gm,
];

function staticImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIERS[0]!)) if (!match[2]) out.push(match[3]!);
  for (const match of source.matchAll(SPECIFIERS[1]!)) out.push(match[1]!);
  return out;
}

function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith("@shared/")) base = path.join(ROOT, "shared", specifier.slice(8));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (/\.(tsx?|json)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  // Stylesheets and other assets: not code.
  return null;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Every module statically reachable from the entries, with one import chain to each package it uses. */
function walk(): { modules: Map<string, string[]>; packages: Map<string, string[]> } {
  const modules = new Map<string, string[]>();
  const packages = new Map<string, string[]>();
  const queue: [string, string[]][] = ENTRIES.map((e) => [path.join(ROOT, e), [e]]);
  while (queue.length > 0) {
    const [file, chain] = queue.shift()!;
    if (modules.has(file)) continue;
    modules.set(file, chain);
    if (!/\.tsx?$/.test(file)) continue;
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      const local = resolveLocal(file, specifier);
      if (local) {
        if (!modules.has(local)) queue.push([local, [...chain, path.relative(ROOT, local)]]);
      } else if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("@shared/")) {
        const name = packageName(specifier);
        if (!packages.has(name)) packages.set(name, [...chain, specifier]);
      }
    }
  }
  return { modules, packages };
}

describe("the title's static import graph", () => {
  const { modules, packages } = walk();

  it("finds the shell (sanity check of the walk)", () => {
    const reached = [...modules.keys()].map((m) => path.relative(ROOT, m));
    expect(reached).toEqual(expect.arrayContaining(["src/app/Game.tsx", "src/app/boot.ts", "src/ui/screens/TitleScreen.tsx", "src/net/session.ts"]));
    expect([...packages.keys()]).toEqual(expect.arrayContaining(["react", "zustand", "@tanstack/react-query"]));
  });

  it("leaves out the Peer SDKs, the wallet stack, viem and Firebase", () => {
    const offenders = [...packages.entries()].filter(([name]) => BANNED_PACKAGES.some((re) => re.test(name))).map(([, chain]) => chain.join(" -> "));
    expect(offenders).toEqual([]);
  });

  it("only reaches the lazy modules through dynamic imports", () => {
    const offenders = LAZY_MODULES.filter((m) => modules.has(path.join(ROOT, m))).map((m) => modules.get(path.join(ROOT, m))!.join(" -> "));
    expect(offenders).toEqual([]);
  });
});
