import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Address, Hash, PublicClient } from "viem";
import { walletQueryKeys } from "@/wallet/balances";
import { SponsorshipError } from "@/wallet/errors";
import { InsufficientUsdcError, createPendingSendStore, type PendingSend, type SendChain } from "@/wallet/send";
import type { TxSender } from "@/wallet/types";
import { GameContext, type GameContextValue } from "../context";
import { SendDepsProvider } from "./deps";
import { initialSendState, sendFailure, type SendState } from "./model";
import { ReceiveInterface } from "./ReceiveInterface";
import { SendInterface } from "./SendInterface";

/**
 * Every Send and Receive screen rendered to HTML (no browser): what the
 * player reads in each state, and that Confirm starts off.
 */

const FROM = "0x2a9e8fa175F45b235efDdD97d2727741EF4Eee63" as Address;
const TO = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address;
const TX = `0x${"12".repeat(32)}` as Hash;

const chain: SendChain = {
  usdcBalance: async () => 125_400_000n,
  ethBalance: async () => 0n,
  blockNumber: async () => 1n,
  code: async () => "0x",
  simulate: async () => undefined,
  estimateFee: async () => 1n,
  receipt: async () => null,
  transfers: async () => [],
};

function sender(kind: TxSender["kind"] = "smart"): TxSender {
  return { address: FROM, kind, sponsored: kind === "smart", sendCalls: async () => Promise.reject(new Error("unused")) } as unknown as TxSender;
}

function game(walletSender: TxSender | null): GameContextValue {
  const noop = () => undefined;
  return {
    sender: walletSender,
    walletReady: true,
    login: noop,
    publicClient: {} as PublicClient,
    me: null,
    open: noop,
    close: noop,
    message: noop,
    playSound: noop,
    celebrate: noop,
    announce: async () => undefined,
    setStall: async () => undefined,
    stallDepositId: null,
  };
}

function render(element: ReactElement, opts: { sender?: TxSender | null; initial?: SendState; pending?: PendingSend } = {}): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(walletQueryKeys.usdcBalance(FROM), 125_400_000n);
  const pending = createPendingSendStore(null);
  if (opts.pending) pending.write(opts.pending);
  const walletSender = opts.sender === undefined ? sender() : opts.sender;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        GameContext.Provider,
        { value: game(walletSender) },
        createElement(SendDepsProvider, { value: { chain, pending, initial: opts.initial } }, element),
      ),
    ),
  );
}

const send = (opts: Parameters<typeof render>[1] = {}) => render(createElement(SendInterface, { open: { id: "send" } }), opts);
/** Visible text, tags removed. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("Send interface", () => {
  it("asks a logged-out player to log in", () => {
    const html = send({ sender: null });
    expect(text(html)).toContain("Send USDC");
    expect(text(html)).toContain("Log in to trade.");
  });

  it("shows the balance, the quick amounts and the address field", () => {
    const html = send();
    const t = text(html);
    expect(t).toContain("You have 125.40 USDC");
    for (const label of ["All", "+10", "+100", "Continue"]) expect(t).toContain(label);
    expect(html).toMatch(/inputmode="decimal"/i);
    expect(html).toContain('placeholder="0x..."');
    expect(t).toContain("Names like .eth aren't supported.");
  });

  it("checks a typed address", () => {
    const valid = text(send({ initial: initialSendState({ amount: "25", to: TO.toLowerCase() }) }));
    expect(valid).toContain("Valid Base address.");
    const typo = text(send({ initial: initialSendState({ amount: "25", to: TO.replace("dA6", "da6") }) }));
    expect(typo).toContain("doesn't match its checksum");
    const self = text(send({ initial: initialSendState({ amount: "25", to: FROM }) }));
    expect(self).toContain("That's your own wallet.");
    const tooMuch = text(send({ initial: initialSendState({ amount: "200", to: TO }) }));
    expect(tooMuch).toContain("You only have 125.40 USDC.");
  });

  it("reviews the whole send with Confirm off at first", () => {
    const html = send({ initial: { amountText: "25", toText: TO, screen: { step: "review", amount: 25_000_000n, to: TO } } });
    const t = text(html);
    expect(t).toContain("Are you sure you want to send this?");
    expect(t).toContain("Amount: 25.00 USDC");
    expect(t).toContain("0xd8dA 6BF2 6964 aF9D 7eEd 9e03 E534 15D3 7aA9 6045");
    expect(t).toContain("Network: Base");
    expect(t).toContain("Network fee: Free (the bank pays it)");
    expect(t).toContain("Sends can't be undone. Only send to an address that accepts USDC on Base.");
    expect(html).toMatch(/class="sd-review__warn rs-b12 rs-c-red/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-send-confirm=""/);
    expect(html).toMatch(/<button[^>]*data-send-back=""/);
  });

  it("checks the fee for a wallet that pays its own gas", () => {
    const t = text(send({ sender: sender("external"), initial: { amountText: "25", toText: TO, screen: { step: "review", amount: 25_000_000n, to: TO } } }));
    expect(t).toContain("Network fee: Checking");
  });

  it("waits while sending, then shows the result", () => {
    const sending = text(send({ initial: { amountText: "25", toText: TO, screen: { step: "sending", amount: 25_000_000n, to: TO } } }));
    expect(sending).toContain("Sending 25.00 USDC to 0xd8dA…6045");
    expect(sending).toContain("Please wait");
    const successHtml = send({ initial: { amountText: "", toText: "", screen: { step: "success", sent: { hash: TX, amount: 25_000_000n, to: TO } } } });
    expect(text(successHtml)).toContain("You sent 25.00 USDC to 0xd8dA…6045.");
    expect(successHtml).toContain(`href="https://basescan.org/tx/${TX}"`);
    expect(text(successHtml)).toContain("Done");
  });

  it("explains a failure with the next step", () => {
    const failure = sendFailure(new SponsorshipError());
    if (failure.kind !== "error") throw new Error("expected an error");
    const t = text(send({ initial: { amountText: "25", toText: TO, screen: { step: "error", failure, amount: 25_000_000n, to: TO } } }));
    expect(t).toContain("The bank couldn't pay the network fee for this send right now, so nothing was sent.");
    expect(t).toContain("Try again later, or log in with your own wallet");
    expect(t).toContain("Try again");
    const usdc = sendFailure(new InsufficientUsdcError(10_000_000n, 25_000_000n));
    if (usdc.kind !== "error") throw new Error("expected an error");
    const u = text(send({ initial: { amountText: "25", toText: TO, screen: { step: "error", failure: usdc, amount: 25_000_000n, to: TO } } }));
    expect(u).toContain("You only have 10.00 USDC now, less than this send.");
    expect(u).toContain("Back");
  });

  it("opens on an earlier unconfirmed send before anything else", () => {
    const record: PendingSend = { from: FROM, to: TO, amount: 25_000_000n, startedAt: Date.now(), fromBlock: 1n, balanceBefore: 125_400_000n, hash: TX, userOpHash: null };
    const html = send({ pending: record, initial: initialSendState({ amount: "5", to: TO }) });
    const t = text(html);
    expect(t).toContain("Your send hasn't been confirmed yet.");
    expect(t).toContain("25.00 USDC to 0xd8dA…6045");
    expect(t).toContain("Check again");
    expect(t).not.toContain("Continue");
    expect(html).toContain(`https://basescan.org/tx/${TX}`);
    // Nothing is offered to send again until a check has run and found no sign of it.
    expect(t).not.toContain("Let me send again");
  });

  it("links the wallet's USDC history for an unconfirmed send with no transaction yet (a smart wallet's user operation)", () => {
    const record: PendingSend = {
      from: FROM,
      to: TO,
      amount: 25_000_000n,
      startedAt: Date.now() - 60 * 60_000,
      fromBlock: 1n,
      balanceBefore: 125_400_000n,
      hash: null,
      userOpHash: TX,
    };
    const html = send({ pending: record });
    expect(html).toContain(`href="https://basescan.org/address/${FROM}#tokentxns"`);
    expect(text(html)).toContain("Your USDC history on Basescan");
    expect(text(html)).not.toContain("wallet's activity");
    expect(text(html)).not.toContain("Let me send again");
  });

  it("labels All by what it does: it fills in the amount, it doesn't send", () => {
    const html = send();
    expect(html).toContain('aria-label="Fill in all your USDC"');
    expect(html).not.toMatch(/aria-label="Send all/);
  });
});

describe("Receive interface", () => {
  it("shows the checksummed address in groups, Copy, a QR code and the Base-only warning", () => {
    const html = render(createElement(ReceiveInterface, { open: { id: "receive" } }));
    const t = text(html);
    expect(t).toContain("Receive USDC");
    expect(t).toContain("0x2a9e 8fa1 75F4 5b23 5efD dD97 d272 7741 EF4E ee63");
    expect(t).toContain("Copy address");
    expect(html).toContain('aria-label="QR code of your wallet address"');
    expect(t).toContain("Send only USDC on Base to this address. Other tokens or networks may be lost.");
    expect(t).toContain("smart wallet, set up for your email or Google login. It needs no ETH");
  });

  it("tells an external wallet it pays its own fees", () => {
    const t = text(render(createElement(ReceiveInterface, { open: { id: "receive" } }), { sender: sender("external") }));
    expect(t).toContain("This is your own wallet. Sending from it needs a little ETH on Base for network fees.");
  });
});
