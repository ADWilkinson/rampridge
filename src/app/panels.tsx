import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { proveWallet } from "@/net/session";
import { useMe } from "@/net/store";
import { defaultPendingSellStore } from "@/peer/sell/persistence";
import { AccountPanel, type MenuEntry } from "@/ui/frame";
import { Sprite, TextButton, coinsSpriteFor, type ItemData } from "@/ui/kit";
// Deep imports, not the "@/wallet" barrel: the barrel re-exports the Privy wallet stack, which loads later (./wallet).
import type { AccountInfo, WalletContextValue } from "@/wallet";
import { useEthBalance, useUsdcBalance } from "@/wallet/balances";
import { formatEth, formatUsdc } from "@/wallet/format";
import { useActiveBuyOrder, useBuyFlowState, useBuyModule } from "./buyFlow";
import { paymentScrollExamine } from "./buyOrders";
import { EARLIER_COINS_NAME, EARLIER_USDC_MIN, earlierCoinsExamine } from "./earlierUsdc";
import { moveEarlierUsdc, type BuyBinding } from "./earlierWallet";
import { NO_WALLET_TEXT, describeError, gameMessage, loginWallet, openInterface, useNoWallet } from "./gameContext";

/**
 * Side panel content the shell owns: the inventory (the player's wallet as
 * items) and the account tab.
 */

export interface ItemAction extends MenuEntry {
  run: () => void;
}

export interface InventoryEntry {
  item: ItemData;
  /** Right-click options; the first is the left-click action. */
  actions: ItemAction[];
}

/** USDC in base units (6 decimals) as a plain decimal string ("1234.5"), for the orb. */
export function usdcDecimal(balance: bigint | undefined): string | null {
  return balance === undefined ? null : formatUnits(balance, 6);
}

function EtherIcon() {
  return (
    <svg className="rr-ether" width="36" height="32" viewBox="0 0 36 32" aria-hidden="true">
      <path d="M18 3 L27 16 L18 21 L9 16 Z" fill="#8c8c9c" stroke="#000" strokeWidth="1" />
      <path d="M18 3 L18 21 L9 16 Z" fill="#b8b8c8" />
      <path d="M9 18 L18 23 L27 18 L18 30 Z" fill="#6e6e80" stroke="#000" strokeWidth="1" />
      <path d="M9 18 L18 23 L18 30 Z" fill="#9a9aaa" />
    </svg>
  );
}

/**
 * The pending (unfinished) sell submission for this wallet, re-read on focus.
 * A submission still running in this tab isn't unfinished; only the sell
 * module knows that, and it is loaded only when there is a record to check,
 * so the cash SDK stays out of the game's startup code.
 */
function usePendingSell(address: string | null): boolean {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!address) {
      setPending(false);
      return;
    }
    let stopped = false;
    const read = () => {
      if (!defaultPendingSellStore().read(address)) {
        setPending(false);
        return;
      }
      import("@/peer/sell/submit").then(
        ({ isSellInFlight }) => {
          if (!stopped) setPending(Boolean(defaultPendingSellStore().read(address)) && !isSellInFlight(address));
        },
        // The sell code didn't download: the record still needs the player; the Bank retries the load.
        () => {
          if (!stopped) setPending(true);
        },
      );
    };
    read();
    const timer = window.setInterval(read, 15_000);
    window.addEventListener("focus", read);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [address]);
  return pending;
}

export interface InventoryState {
  entries: InventoryEntry[];
  notice: ReactNode;
  /** Wallet USDC for the orb, or null when there is no wallet. */
  usdc: string | null;
  /** Reminders for the chatbox: an order waiting for payment, an unfinished sell, USDC left in the earlier wallet. */
  buyOrder: { intentHash: string; expired: boolean; earlier: boolean } | null;
  pendingSell: boolean;
  /** USDC in the earlier wallet ("12.34"), when there is at least a cent of it. */
  earlierUsdc: string | null;
}

/** A logged-in account that has stayed without any wallet (not one whose wallet is still being created). */
export function useSettledNoWallet(wallet: WalletContextValue): boolean {
  const settled = useNoWallet((s) => s.settled);
  return wallet.status === "no_wallet" && settled;
}

/**
 * The player's wallet as inventory items: coins (USDC), ether, USDC left in
 * the earlier wallet, and open orders as scrolls and notes. `buy` says whose
 * buy order to show (the earlier wallet's while the buy flow is on it).
 */
export function useInventory(wallet: WalletContextValue, buy: BuyBinding, now: number): InventoryState {
  const address = wallet.authenticated ? wallet.address : null;
  const usdc = useUsdcBalance(address);
  const eth = useEthBalance(address);
  const earlierBalance = useUsdcBalance(wallet.authenticated ? wallet.fallbackEoa : null);
  const buyOwner = wallet.authenticated ? buy.owner : null;
  const { order } = useActiveBuyOrder(buyOwner);
  const buyKey = buyOwner ? buyOwner.toLowerCase() : null;
  const buyStep = useBuyFlowState((s) => (buyKey && s.owner === buyKey ? s.step : null), null);
  // Loaded whenever there is an order: the order comes from it.
  const buyModule = useBuyModule((s) => s.mod);
  const pendingSell = usePendingSell(address);
  const noWallet = useSettledNoWallet(wallet);
  const canSell = wallet.status === "ready";
  const earlierWallet = buy.earlier;
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  });

  return useMemo(() => {
    const entries: InventoryEntry[] = [];
    if (usdc.data !== undefined && usdc.data > 0n) {
      const whole = Number(usdc.data / 1_000_000n);
      const examine = `${formatUsdc(usdc.data)} USDC in your wallet on Base.`;
      const actions: ItemAction[] = [{ verb: "Examine", targetName: "Coins", kind: "item", run: () => gameMessage(examine) }];
      if (canSell) actions.push({ verb: "Sell", targetName: "Coins", kind: "item", run: () => openInterface({ id: "sell" }) });
      if (canSell) actions.push({ verb: "Send", targetName: "Coins", kind: "item", run: () => openInterface({ id: "send" }) });
      entries.push({
        item: { key: "usdc", name: "Coins", icon: <Sprite name={coinsSpriteFor(whole)} />, quantity: whole, stackable: true, examine },
        actions,
      });
    }
    let earlierUsdc: string | null = null;
    if (earlierBalance.data !== undefined && earlierBalance.data >= EARLIER_USDC_MIN) {
      const whole = Number(earlierBalance.data / 1_000_000n);
      earlierUsdc = formatUsdc(earlierBalance.data);
      const examine = earlierCoinsExamine(earlierUsdc);
      const name = EARLIER_COINS_NAME;
      entries.push({
        item: { key: "usdc-earlier", name, icon: <Sprite name={coinsSpriteFor(whole)} />, quantity: whole, stackable: true, examine },
        actions: [
          { verb: "Move", targetName: name, kind: "item", run: () => void moveEarlierUsdc(() => walletRef.current) },
          { verb: "Examine", targetName: name, kind: "item", run: () => gameMessage(examine) },
        ],
      });
    }
    if (eth.data !== undefined && eth.data > 0n) {
      const examine = `${formatEth(eth.data)} ETH in your wallet on Base, used to pay gas.`;
      entries.push({
        item: { key: "eth", name: "Ether", icon: <EtherIcon />, examine },
        actions: [{ verb: "Examine", targetName: "Ether", kind: "item", run: () => gameMessage(examine) }],
      });
    }
    let buyOrder: InventoryState["buyOrder"] = null;
    if (order && order.status === "active" && buyModule) {
      const expired = order.expiresAt <= now;
      buyOrder = { intentHash: order.intentHash, expired, earlier: earlierWallet };
      const examine = paymentScrollExamine(buyModule.getPaymentInstructions(order), buyStep, expired);
      entries.push({
        item: { key: "order", name: "Payment scroll", icon: <Sprite name="itemClueScroll" />, examine, selected: true },
        actions: [
          { verb: "Read", targetName: "Payment scroll", kind: "item", run: () => openInterface({ id: "payment" }) },
          { verb: "Examine", targetName: "Payment scroll", kind: "item", run: () => gameMessage(examine) },
        ],
      });
    }
    if (pendingSell) {
      const examine = "Your sell order hasn't finished listing. Open the bank to check it.";
      entries.push({
        item: { key: "sell", name: "Sell order", icon: <Sprite name="itemBankNote" />, examine, selected: true },
        actions: [
          { verb: "Check", targetName: "Sell order", kind: "item", run: () => openInterface({ id: "bank" }) },
          { verb: "Examine", targetName: "Sell order", kind: "item", run: () => gameMessage(examine) },
        ],
      });
    }

    let notice: ReactNode = null;
    if (!wallet.authenticated) {
      notice = (
        <>
          Log in to see your wallet.
          <br />
          <TextButton tone="yellow" onClick={() => loginWallet(wallet)}>
            Log in
          </TextButton>
        </>
      );
    } else if (noWallet) {
      notice = (
        <>
          {NO_WALLET_TEXT}
          <br />
          <TextButton tone="yellow" onClick={() => loginWallet(wallet)}>
            Log in again
          </TextButton>
        </>
      );
    } else if (!address || usdc.isPending) notice = "Loading your wallet...";
    else if (usdc.isError) notice = "Couldn't read your wallet balance. Retrying...";
    else if (entries.length === 0) notice = "Your wallet has no USDC yet.";

    // react-query keeps the last balance while it refetches (or a refetch fails), so the orb only
    // goes empty before the first read of this address.
    return { entries, notice, usdc: address ? usdcDecimal(usdc.data) : null, buyOrder, pendingSell, earlierUsdc };
  }, [usdc.data, usdc.isPending, usdc.isError, eth.data, earlierBalance.data, order, buyStep, buyModule, pendingSell, canSell, noWallet, earlierWallet, wallet, address, now]);
}

const METHOD_LABELS: Record<AccountInfo["loginMethod"], string> = {
  email: "email",
  google: "Google",
  twitter: "X",
  apple: "Apple",
  peer: "Peer",
  wallet: "a wallet",
  other: "Privy",
};

export function loginMethodText(account: AccountInfo): string {
  return `Logged in with ${METHOD_LABELS[account.loginMethod]}: ${account.displayName}`;
}

/** Account tab: display name, wallet, Send and Receive, verification, login method and wallet logout. */
export function AccountTab({ wallet, onRename }: { wallet: WalletContextValue; onRename: () => void }) {
  const me = useMe();
  const [busy, setBusy] = useState<"verify" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = wallet.authenticated ? wallet.address : null;
  const verified = Boolean(address && me?.wallet && me.wallet === address.toLowerCase());
  const noWallet = useSettledNoWallet(wallet);

  const verify = async () => {
    setError(null);
    if (wallet.status === "reconnect") {
      setError("Reconnect your wallet, then verify it.");
      wallet.reconnect();
      return;
    }
    if (!wallet.sender) {
      setError("Your wallet is still being set up. Try again in a moment.");
      return;
    }
    setBusy("verify");
    try {
      await proveWallet(wallet.sender);
      gameMessage("Your wallet is verified.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setError(null);
    setBusy("logout");
    try {
      await wallet.logout();
      gameMessage("You have logged out of your wallet.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  // "Please wait" in place of Log in while the wallet loads. A settled walletless account is offered Log in
  // again instead; once the address is known, Verify and Log out stay usable even if the signer is slow.
  const loggingIn =
    !address && (wallet.status === "loading" || wallet.status === "preparing" || (wallet.status === "no_wallet" && !noWallet));
  return (
    <div className="rr-account">
      <AccountPanel
        displayName={me?.name ?? ""}
        world={me?.world ?? null}
        onRename={onRename}
        address={address}
        walletKind={wallet.kind ?? undefined}
        sponsored={wallet.sponsored}
        verified={verified}
        busy={busy ?? (loggingIn ? "login" : null)}
        error={error ?? (noWallet ? NO_WALLET_TEXT : null)}
        onLogin={() => loginWallet(wallet)}
        onVerify={() => void verify()}
        onLogoutWallet={() => void logout()}
        onSend={wallet.status === "ready" ? () => openInterface({ id: "send" }) : undefined}
        onReceive={wallet.status === "ready" ? () => openInterface({ id: "receive" }) : undefined}
        loginMethod={wallet.account ? loginMethodText(wallet.account) : null}
      />
    </div>
  );
}
