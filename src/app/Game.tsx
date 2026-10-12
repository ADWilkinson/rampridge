import { useEffect, useRef, useState } from "react";
import type { Appearance } from "@shared/protocol";
import { track } from "@/lib/telemetry";
// Submodules, not the "@/net" barrel: it re-exports the realtime client, whose Firebase SDK loads on entry (./session).
import { ensureSession, getSession, type Session } from "@/net/session";
import { serverNow, useMe } from "@/net/store";
import { ChatPromptProvider } from "@/ui/kit";
import { CharacterDesign, TitleScreen } from "@/ui/screens";
import type { GameRuntime } from "./boot";
import { useBindBuySender } from "./buyFlow";
import { useBuyBinding } from "./earlierWallet";
import { EngineViewport } from "./EngineViewport";
import { loadWorldScreen, prefetchEntryCode, type WorldView } from "./entryCode";
import { GameProvider, closeInterface, describeError, gameMessage, openInterface } from "./gameContext";
import { afterPaintIdle } from "./idle";
import { InterfaceSlot, LIGHT_INTERFACES, loadInterfaces } from "./interfaces";
import { checkNameAvailability, claimName } from "./names";
import { placementOf, useOpenInterface } from "./openInterface";
import { WorldSession } from "./session";
import { SAFETY_LINE, takeWelcome, takeWorldRequest, WORLD_SWITCHER_HINT, worldWelcome } from "./share/arrival";
import { TOUCH_HINT, introSeen, loadAppearance, saveAppearance, takeTouchHint, useSettingsStore } from "./settings";
import { uiSounds } from "./sound";
import { useMerchants } from "./useMerchants";
import { hasPrivySession, isOAuthReturn, loadWalletStack, useAppWallet, useWalletBridge } from "./wallet";

/**
 * Title screen, first-visit character design and the game. Owns the entry
 * path: Play now (guest session) or Existing user (Privy login, then the same
 * path), the character design on a first visit, then joining the world.
 */

type Screen = { kind: "title" } | { kind: "design"; session: Session; appearance: Appearance } | { kind: "world" };

const LOGIN_TIMEOUT_MS = 20_000;
const LOGIN_UNAVAILABLE = "The login service didn't respond. Try again, or press Play now to play as a guest.";
const LOGIN_NOT_LOADED = "The login service didn't load. Check your connection and try again, or press Play now to play as a guest.";
const MODAL_CLOSE_GRACE_MS = 1_500;
const TERMS_HASH = "#terms";

function entryError(err: unknown): string {
  const reason = describeError(err);
  return `You could not enter the bank. ${reason}`;
}

/** Keeps the engine, sounds and page in step with the Settings tab. */
function useApplySettings(runtime: GameRuntime): void {
  const settings = useSettingsStore((s) => s.settings);
  useEffect(() => {
    runtime.engine.setSoundEnabled(settings.soundVolume > 0);
    uiSounds.setVolume(settings.soundVolume);
  }, [runtime, settings.soundVolume]);
  useEffect(() => {
    document.documentElement.classList.toggle("rs-reduced-motion", settings.reducedMotion);
    // The engine ORs this with the OS setting: overhead chat motion and fireworks stop too.
    runtime.engine.setReducedMotion(settings.reducedMotion);
  }, [runtime, settings.reducedMotion]);
  useEffect(() => {
    runtime.engine.setRunning(settings.running);
  }, [runtime, settings.running]);
}

/**
 * The design screen's live model, drawn by the character runtime the engine
 * uses. It sways side to side unless reduced motion is on (the Settings tab
 * or the OS), in which case it holds still facing front.
 */
function DesignPreview({ runtime, appearance }: { runtime: GameRuntime; appearance: Appearance }) {
  const el = useRef<HTMLDivElement>(null);
  const preview = useRef<ReturnType<GameRuntime["renderPreview"]> | null>(null);
  const latest = useRef(appearance);
  const reducedMotion = useSettingsStore((s) => s.settings.reducedMotion);
  useEffect(() => {
    latest.current = appearance;
    preview.current?.update(appearance);
  }, [appearance]);
  useEffect(() => {
    if (!el.current) return;
    const p = runtime.renderPreview(el.current, latest.current, { factory: runtime.factory, ...(reducedMotion ? { swaySeconds: 0 } : {}) });
    preview.current = p;
    return () => {
      p.dispose();
      preview.current = null;
    };
  }, [runtime, reducedMotion]);
  return <div ref={el} className="rr-design-preview" />;
}

export function Game({ runtime }: { runtime: GameRuntime }) {
  const wallet = useAppWallet();
  const loginModalOpen = useWalletBridge((s) => s.modalOpen);
  const walletStack = useWalletBridge((s) => s.stack);
  const me = useMe();
  const [screen, setScreen] = useState<Screen>({ kind: "title" });
  const [WorldScreen, setWorldScreen] = useState<WorldView | null>(null);
  const [busy, setBusy] = useState<"play" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [designError, setDesignError] = useState<string | null>(null);
  const [session] = useState(() => new WorldSession(runtime.engine));
  // An interface over the title (How it works, Terms) covers the box; the logo would show past the window's edges.
  const titleCovered = useOpenInterface((s) => s.current !== null && placementOf(s.current.id) === "window");
  const pendingLogin = useRef(false);
  const loginRequested = useRef(false);
  const modalWasOpen = useRef(false);
  const entering = useRef(false);
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  });

  useApplySettings(runtime);
  const merchants = useMerchants(runtime.engine, useSettingsStore((st) => st.settings.chatEffects));
  // The buy flow follows the player's wallet, or their earlier wallet while it holds an open order.
  const buy = useBuyBinding(wallet);
  useBindBuySender(buy.sender);

  useEffect(() => {
    runtime.engine.setClock(serverNow);
    uiSounds.listen();
    // Dev only: lets local browser checks find entities on screen (engine.projectTarget).
    if (import.meta.env.DEV) (window as Window & { __rrEngine?: GameRuntime["engine"] }).__rrEngine = runtime.engine;
  }, [runtime]);

  // Once the title is on screen: first what entering needs (the realtime client and the world screen), then
  // the light interfaces (Terms, the first-visit intro, the banker's dialogue). useMerchants starts after the
  // same step. The trading interfaces, the Peer SDKs and the wallet stack follow once the world is up (World),
  // or as soon as the player logs in or opens one. A returning player who is logged in gets the wallet stack
  // here, so their wallet is ready when they enter.
  useEffect(
    () =>
      afterPaintIdle(() => {
        void prefetchEntryCode().then(() => {
          void loadInterfaces(LIGHT_INTERFACES);
          if (hasPrivySession()) void loadWalletStack().catch(() => undefined);
        });
      }),
    [],
  );
  // At OAuth return the wallet stack loads straight away, so Privy can finish the login.
  useEffect(() => {
    if (isOAuthReturn()) void loadWalletStack().catch(() => undefined);
  }, []);

  // Terms open as an interface over the title (deep links to /terms or #terms too); closing clears the link
  // so the footer link works again.
  useEffect(() => {
    const check = () => {
      if (window.location.hash === TERMS_HASH || window.location.pathname === "/terms") openInterface({ id: "terms" });
    };
    check();
    window.addEventListener("hashchange", check);
    const unsubscribe = useOpenInterface.subscribe((state, prev) => {
      if (prev.current?.id !== "terms" || state.current?.id === "terms") return;
      if (window.location.hash === TERMS_HASH || window.location.pathname === "/terms") history.replaceState(null, "", "/");
    });
    return () => {
      window.removeEventListener("hashchange", check);
      unsubscribe();
    };
  }, []);

  /** Joins the world with this look and switches to the game screen. */
  const enter = async (current: Session, appearance: Appearance) => {
    const firstVisit = !introSeen();
    const view = loadWorldScreen();
    view.catch(() => undefined);
    // The server picks the world: the busiest with room, or the one a ?world= link (or shared trade) asks for.
    const requested = takeWorldRequest();
    const world = await session.enter(current, appearance, requested);
    let View: WorldView;
    try {
      // Normally already in: it downloads while the title shows.
      View = await view;
    } catch (err) {
      session.leave();
      throw err;
    }
    closeInterface();
    setWorldScreen(() => View);
    setScreen({ kind: "world" });
    // "Welcome to RampRidge. You are on World 302." ("You followed a trade ..." once for a shared trade link,
    // and "World 302 has no room, so you are on World 303." when the link's world could not take them).
    gameMessage(worldWelcome(takeWelcome(), world, requested));
    if (typeof requested === "number" && requested !== world) gameMessage(WORLD_SWITCHER_HINT);
    gameMessage(SAFETY_LINE);
    // Last, so the phone's one-line chatbox shows it once the intro is put away.
    if (takeTouchHint()) gameMessage(TOUCH_HINT);
    if (firstVisit) openInterface({ id: "intro" });
  };

  const play = async () => {
    if (entering.current) return;
    entering.current = true;
    track("play", { once: true });
    // Entering needs the realtime client and the world screen; they may still be waiting for an idle moment.
    void prefetchEntryCode();
    setBusy("play");
    setError(null);
    try {
      const current = await ensureSession();
      const stored = loadAppearance();
      if (!stored) {
        setDesignError(null);
        setScreen({ kind: "design", session: current, appearance: runtime.factory.randomAppearance(current.pid) });
        return;
      }
      await enter(current, stored);
    } catch (err) {
      console.warn("[entry]", err);
      setError(entryError(err));
    } finally {
      entering.current = false;
      setBusy(null);
    }
  };

  /** Accept (with the checked name) or Skip (name null: keep the generated one). */
  const acceptDesign = async (appearance: Appearance, name: string | null) => {
    if (entering.current) return;
    entering.current = true;
    setDesignError(null);
    setBusy("play");
    try {
      let current = getSession() ?? (await ensureSession());
      if (name !== null && name !== current.name) {
        // Claimed only now: someone may have taken it since the check.
        const refused = await claimName(name);
        if (refused) {
          setDesignError(refused);
          return;
        }
        current = getSession() ?? current;
      }
      saveAppearance(appearance);
      session.setAppearance(appearance);
      await enter(current, appearance);
      track("design_done");
      if (name === null) gameMessage("You can change your display name from the Account tab.");
    } catch (err) {
      console.warn("[entry]", err);
      setDesignError(entryError(err));
    } finally {
      entering.current = false;
      setBusy(null);
    }
  };

  const requestLogin = () => {
    if (loginRequested.current || !wallet.ready) return;
    loginRequested.current = true;
    wallet.login();
  };

  const existingUser = () => {
    setError(null);
    if (wallet.authenticated) {
      void play();
      return;
    }
    pendingLogin.current = true;
    loginRequested.current = false;
    setBusy("login");
    loadWalletStack().catch(() => {
      if (pendingLogin.current) stopWaitingForLogin(LOGIN_NOT_LOADED);
    });
    requestLogin();
  };

  const stopWaitingForLogin = (message: string | null) => {
    pendingLogin.current = false;
    loginRequested.current = false;
    setBusy(null);
    setError(message);
  };

  // Continue once Privy is ready (to open its modal), then once the player is logged in.
  useEffect(() => {
    if (!pendingLogin.current) return;
    if (wallet.authenticated) {
      pendingLogin.current = false;
      loginRequested.current = false;
      void play();
    } else if (wallet.ready) {
      requestLogin();
    }
  }, [wallet.authenticated, wallet.ready]);

  // The player closed the login modal without logging in. Privy can close the modal a moment before the
  // session reads as authenticated, so wait briefly before giving the buttons back.
  useEffect(() => {
    if (loginModalOpen) {
      modalWasOpen.current = true;
      return;
    }
    if (!modalWasOpen.current) return;
    modalWasOpen.current = false;
    const timer = window.setTimeout(() => {
      if (pendingLogin.current && !walletRef.current.authenticated) stopWaitingForLogin(null);
    }, MODAL_CLOSE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [loginModalOpen]);

  // Privy never became ready or never opened (blocked, offline): give the buttons back. The wait starts once
  // its code has downloaded, which on a slow connection can take a while by itself.
  useEffect(() => {
    if (busy !== "login" || loginModalOpen || walletStack !== "ready") return;
    const timer = window.setTimeout(() => {
      if (pendingLogin.current && !wallet.authenticated) stopWaitingForLogin(LOGIN_UNAVAILABLE);
    }, LOGIN_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [busy, loginModalOpen, walletStack, wallet.authenticated]);

  const logout = () => {
    session.leave();
    closeInterface();
    setScreen({ kind: "title" });
  };

  // Leaving the page while in the world: presence sends the leave beacon itself.
  useEffect(() => () => session.leave(), [session]);

  return (
    <GameProvider engine={runtime.engine} buy={buy}>
      {screen.kind === "world" && WorldScreen ? (
        <WorldScreen runtime={runtime} session={session} merchants={merchants} buy={buy} onLogout={logout} />
      ) : (
        <div className="rr-stage">
          <EngineViewport runtime={runtime} />
          {screen.kind === "title" && (
            <TitleScreen
              onPlay={() => void play()}
              onExistingUser={existingUser}
              onHowItWorks={() => openInterface({ id: "how-it-works" })}
              termsHref={TERMS_HASH}
              busy={busy}
              error={error}
              {...(titleCovered ? { className: "rr-title--covered" } : {})}
            />
          )}
          {screen.kind === "design" && (
            <div className="rr-overlay rs-window-host">
              <DesignScreen
                runtime={runtime}
                initial={screen.appearance}
                currentName={me?.name ?? screen.session.name}
                busy={busy === "play"}
                error={designError}
                onAccept={(appearance, name) => void acceptDesign(appearance, name)}
                onSkip={(appearance) => void acceptDesign(appearance, null)}
              />
            </div>
          )}
          <ChatPromptProvider>
            <div className="rr-overlay rr-overlay--top">
              <div className="rs-window-host">
                <InterfaceSlot placement="window" />
              </div>
            </div>
          </ChatPromptProvider>
        </div>
      )}
    </GameProvider>
  );
}

interface DesignScreenProps {
  runtime: GameRuntime;
  initial: Appearance;
  currentName: string;
  busy: boolean;
  error: string | null;
  onAccept: (appearance: Appearance, name: string) => void;
  onSkip: (appearance: Appearance) => void;
}

/** "Welcome to RampRidge": the original character designer, starting from a generated look. */
function DesignScreen({ runtime, initial, currentName, busy, error, onAccept, onSkip }: DesignScreenProps) {
  const [appearance, setAppearance] = useState(initial);
  const [name, setName] = useState(currentName);
  const [catalog] = useState(() => runtime.factory.designer());
  return (
    <CharacterDesign
      appearance={appearance}
      onChange={setAppearance}
      catalog={catalog}
      preview={<DesignPreview runtime={runtime} appearance={appearance} />}
      name={name}
      onNameChange={setName}
      onCheckName={checkNameAvailability}
      currentName={currentName}
      onAccept={(result) => onAccept(result.appearance, result.name)}
      onSkip={() => onSkip(appearance)}
      busy={busy}
      error={error}
    />
  );
}
