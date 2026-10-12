import { describe, expect, it } from "vitest";
import type { MerchantTarget, OpenInterface } from "@/ui/interfaces/context";
import { introLoggedIn, introScript } from "@/ui/interfaces/info/introScript";
import type { TxSender } from "@/wallet/types";
import { MAX_LINE_CHARS, MAX_OPTIONS, isInterfaceId, nodeActions, scriptTargets, splitWarning, validateScript, type DialogueAction, type DialogueScript } from "./script";
import { bankerScript, merchantScript } from "./scripts";

const MERCHANT: MerchantTarget = { kind: "merchant", merchantId: "revolut:GBP", name: "Revolut merchant", platform: "revolut", currency: "GBP" };

const SCRIPTS: readonly [string, DialogueScript][] = [
  ["banker", bankerScript("Banker")],
  ["merchant", merchantScript("Revolut merchant", MERCHANT, "Revolut")],
  ["merchant without an offer", merchantScript("Merchant", undefined, null)],
  ["intro (logged out)", introScript({ loggedIn: false })],
  ["intro (logged in)", introScript({ loggedIn: true })],
];

/** Follows options by label from the start, through every NPC/player line, to the first exit. */
function follow(script: DialogueScript, ...labels: string[]): { action: DialogueAction; seen: string[] } {
  let id = script.start;
  const seen: string[] = [];
  const pending = [...labels];
  for (let guard = 0; guard < 50; guard++) {
    const node = script.nodes[id];
    if (!node) throw new Error(`missing node ${id}`);
    seen.push(id);
    let action: DialogueAction;
    if (node.kind === "options") {
      const label = pending.shift();
      const option = node.options.find((o) => o.label === label);
      if (!option) throw new Error(`no option "${String(label)}" at ${id}: ${node.options.map((o) => o.label).join(" / ")}`);
      action = option.action;
    } else {
      action = node.next;
    }
    if (action.type !== "goto") return { action, seen };
    id = action.node;
  }
  throw new Error("conversation did not end");
}

function opened(action: DialogueAction): OpenInterface {
  if (action.type !== "open") throw new Error(`expected open, got ${action.type}`);
  return action.target;
}

describe.each(SCRIPTS)("%s dialogue", (_name, script) => {
  it("is structurally valid: every option leads somewhere valid and every path can end", () => {
    expect(validateScript(script)).toEqual([]);
  });

  it("opens only real interfaces", () => {
    for (const target of scriptTargets(script)) expect(isInterfaceId(target.id)).toBe(true);
  });

  it("keeps lines short enough for a phone chatbox and options within keys 1-5", () => {
    for (const node of Object.values(script.nodes)) {
      if (node.kind === "options") {
        expect(node.options.length).toBeGreaterThan(0);
        expect(node.options.length).toBeLessThanOrEqual(MAX_OPTIONS);
      } else {
        expect(node.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
      }
    }
  });
});

describe("banker dialogue", () => {
  const script = bankerScript("Banker");

  it("greets as in the original before offering options", () => {
    const greet = script.nodes[script.start];
    expect(greet).toMatchObject({ kind: "npc", text: "Good day, how may I help you?" });
  });

  it("hands each request to the matching bank interface", () => {
    expect(opened(follow(script, "I'd like to access my bank account, please.").action)).toEqual({ id: "bank" });
    expect(opened(follow(script, "I'd like to buy some coins.").action)).toEqual({ id: "exchange", side: "buy" });
    expect(opened(follow(script, "I'd like to sell my coins.").action)).toEqual({ id: "sell" });
    expect(follow(script, "Nothing, thanks.").action).toEqual({ type: "close" });
  });

  it("explains Peer in two pages, then offers How it works", () => {
    const { action, seen } = follow(script, "What is this place?", "Show me how it works");
    expect(opened(action)).toEqual({ id: "how-it-works" });
    const npcPages = seen.map((id) => script.nodes[id]).filter((n) => n?.kind === "npc");
    // The greeting plus the two explanation pages.
    expect(npcPages).toHaveLength(3);
    const explanation = npcPages
      .slice(1)
      .map((n) => (n && n.kind !== "options" ? n.text : ""))
      .join(" ");
    expect(explanation).toMatch(/pay the seller directly/);
    expect(explanation).toMatch(/Peer extension on a computer/);
    expect(explanation).toMatch(/contract on Base/);
    expect(explanation).toMatch(/Sellers lock USDC/);
  });

  it("can return to the main options after the explanation", () => {
    expect(follow(script, "What is this place?", "I'd like to ask something else.", "Nothing, thanks.").action).toEqual({ type: "close" });
  });

  it("restarts for a different banker", () => {
    expect(bankerScript("Banker").id).not.toBe(bankerScript("Head banker").id);
  });
});

describe("merchant dialogue", () => {
  it("offers its platform and currency, then opens the trade window against itself", () => {
    const script = merchantScript("Revolut merchant", MERCHANT, "Revolut");
    const offer = script.nodes[script.start];
    expect(offer).toMatchObject({ kind: "npc", text: "I've got USDC for GBP on Revolut. Want to trade?" });
    expect(opened(follow(script, "Trade").action)).toEqual({ id: "trade", target: MERCHANT });
    expect(follow(script, "Not now").action).toEqual({ type: "close" });
  });

  it("falls back to the platform id when the name is unknown", () => {
    const script = merchantScript("Merchant", { ...MERCHANT, platform: "newpay" }, null);
    expect(script.nodes[script.start]).toMatchObject({ text: "I've got USDC for GBP on newpay. Want to trade?" });
  });

  it("ends politely when there is no offer behind it", () => {
    const script = merchantScript("Merchant", undefined, null);
    expect(follow(script).action).toEqual({ type: "close" });
    expect(scriptTargets(script)).toEqual([]);
  });
});

describe("intro dialogue", () => {
  it("covers the welcome, where to trade, the safety rule and logging in in two pages, then ends with two options", () => {
    const script = introScript({ loggedIn: false });
    const { seen } = follow(script, "Got it");
    const text = seen
      .map((id) => script.nodes[id])
      .map((n) => (n && n.kind !== "options" ? n.text : ""))
      .join(" ");
    expect(text).toMatch(/Bank of RampRidge/);
    expect(text).toMatch(/peer-to-peer exchange/);
    expect(text).toMatch(/banker or use a bank booth/);
    expect(text).toMatch(/merchant's live offer/);
    expect(text).toMatch(/Never send money to anyone outside the bank interfaces/);
    expect(text).toMatch(/Log in with your email or wallet/);
    const last = script.nodes[seen[seen.length - 1]!];
    expect(last?.kind === "options" && last.options.map((o) => o.label)).toEqual(["Show me how it works", "Got it"]);
    expect(seen.filter((id) => script.nodes[id]?.kind === "npc")).toHaveLength(2);
  });

  it("marks only the safety rule as a warning, not the login sentence beside it", () => {
    const script = introScript({ loggedIn: false });
    const warnings = Object.values(script.nodes).filter((n) => n.kind !== "options" && n.warning);
    expect(warnings).toHaveLength(1);
    const [line] = warnings;
    if (!line || line.kind === "options") throw new Error("no warning line");
    const [, red, after] = splitWarning(line);
    expect(red).toBe("Never send money to anyone outside the bank interfaces. Trades only settle through the bank.");
    expect(after).toMatch(/Log in/);
  });

  it("opens How it works or closes", () => {
    const script = introScript({ loggedIn: true });
    expect(opened(follow(script, "Show me how it works").action)).toEqual({ id: "how-it-works" });
    expect(follow(script, "Got it").action).toEqual({ type: "close" });
  });

  it("does not ask a logged-in player to log in", () => {
    const script = introScript({ loggedIn: true });
    const text = Object.values(script.nodes)
      .map((n) => (n.kind !== "options" ? n.text : ""))
      .join(" ");
    expect(text).not.toMatch(/Log in/);
  });

  it("counts a player as logged in only once they have a wallet that can send", () => {
    // A guest: the wallet service has loaded (walletReady) but there is no sender.
    expect(introLoggedIn({ sender: null })).toBe(false);
    expect(introLoggedIn({ sender: {} as TxSender })).toBe(true);
    const guest = introScript({ loggedIn: introLoggedIn({ sender: null }) });
    const login = guest.nodes.safety;
    expect(login?.kind !== "options" && login?.text).toMatch(/Log in with your email or wallet when you're ready to trade\.$/);
  });

  it("keeps the same node ids whether or not the player is logged in, so logging in mid-intro keeps the place", () => {
    expect(Object.keys(introScript({ loggedIn: true }).nodes)).toEqual(Object.keys(introScript({ loggedIn: false }).nodes));
    expect(introScript({ loggedIn: true }).id).toBe(introScript({ loggedIn: false }).id);
  });
});

describe("validateScript", () => {
  const base: DialogueScript = {
    id: "t",
    npcName: "Banker",
    start: "a",
    nodes: { a: { kind: "npc", text: "Hello.", next: { type: "close" } } },
  };

  it("accepts a minimal script", () => {
    expect(validateScript(base)).toEqual([]);
  });

  it("reports a missing start node", () => {
    expect(validateScript({ ...base, start: "zz" })).toContain('start node "zz" is missing');
  });

  it("reports options that go nowhere", () => {
    const problems = validateScript({
      ...base,
      nodes: { a: { kind: "options", options: [{ label: "Go", action: { type: "goto", node: "b" } }] } },
    });
    expect(problems).toContain('a: goes to missing node "b"');
  });

  it("reports unknown interfaces and trades without a target", () => {
    const bogus = { id: "casino" } as unknown as OpenInterface;
    const trade = { id: "trade" } as unknown as OpenInterface;
    const problems = validateScript({
      ...base,
      nodes: {
        a: {
          kind: "options",
          options: [
            { label: "Gamble", action: { type: "open", target: bogus } },
            { label: "Trade", action: { type: "open", target: trade } },
          ],
        },
      },
    });
    expect(problems).toContain('a: opens unknown interface "casino"');
    expect(problems).toContain("a: opens a trade without a target");
  });

  it("reports unreachable nodes, loops with no exit and too many options", () => {
    const problems = validateScript({
      ...base,
      nodes: {
        a: { kind: "npc", text: "One.", next: { type: "goto", node: "b" } },
        b: { kind: "npc", text: "Two.", next: { type: "goto", node: "a" } },
        orphan: {
          kind: "options",
          options: ["1", "2", "3", "4", "5", "6"].map((label) => ({ label, action: { type: "close" } as const })),
        },
      },
    });
    expect(problems).toContain('orphan: is unreachable from "a"');
    expect(problems).toContain("a: never leads out of the conversation");
    expect(problems).toContain("b: never leads out of the conversation");
    expect(problems).toContain(`orphan: has 6 options (1-${MAX_OPTIONS} allowed)`);
  });

  it("reports a warning that is not part of its line", () => {
    const problems = validateScript({ ...base, nodes: { a: { kind: "npc", text: "Hello.", warning: "Goodbye.", next: { type: "close" } } } });
    expect(problems).toContain("a: its warning is not part of its text");
    expect(validateScript({ ...base, nodes: { a: { kind: "npc", text: "Hello. Careful.", warning: "Careful.", next: { type: "close" } } } })).toEqual([]);
  });

  it("splits a line around its warning", () => {
    expect(splitWarning({ text: "Hi. Careful. Bye.", warning: "Careful." })).toEqual(["Hi. ", "Careful.", " Bye."]);
    expect(splitWarning({ text: "All red.", warning: true })).toEqual(["", "All red.", ""]);
    expect(splitWarning({ text: "None." })).toEqual(["None.", "", ""]);
    expect(splitWarning({ text: "None.", warning: "Missing" })).toEqual(["None.", "", ""]);
  });

  it("reports empty, overlong and duplicate text", () => {
    const problems = validateScript({
      ...base,
      nodes: {
        a: { kind: "npc", text: "x".repeat(MAX_LINE_CHARS + 1), next: { type: "goto", node: "b" } },
        b: {
          kind: "options",
          options: [
            { label: "Same", action: { type: "close" } },
            { label: "Same", action: { type: "close" } },
            { label: " ", action: { type: "close" } },
          ],
        },
      },
    });
    expect(problems).toContain(`a: text is ${MAX_LINE_CHARS + 1} characters (max ${MAX_LINE_CHARS})`);
    expect(problems).toContain('b: repeats the option "Same"');
    expect(problems).toContain("b: has an option with no label");
  });

  it("lists the actions of every node kind", () => {
    expect(nodeActions({ kind: "player", text: "Hi.", next: { type: "close" } })).toEqual([{ type: "close" }]);
    expect(nodeActions({ kind: "options", options: [{ label: "A", action: { type: "close" } }] })).toEqual([{ type: "close" }]);
  });
});
