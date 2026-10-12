import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { create } from "zustand";
import { PleaseWait, useEscapeLayer } from "@/ui/kit";
import { HowItWorks } from "@/ui/screens";
import { useGame, type InterfaceId, type OpenInterface } from "@/ui/interfaces/context";
import { BUY_INTERFACES } from "./earlierWallet";
import { BuyInterfaceContext } from "./gameContext";
import { createInterfaceLoader, type AnyInterface, type LoadedModule, type WorldHook } from "./interfaceLoader";
import { placementOf, registerChatboxInterfaces, useOpenInterface } from "./openInterface";
import { markIntroSeen } from "./settings";
import { noteChunkFailure } from "./update";

/**
 * Discovers the trading interfaces. Each folder under src/ui/interfaces with
 * an index.ts exporting `interfaces` registers components by interface id;
 * the shell never imports them statically. Modules load lazily (their own
 * chunks): the light ones (info, dialogue) once the title is up, the trading
 * ones (bank, buy, which carry the Peer SDKs and the wallet code) once the
 * world is up, and any of them as soon as a player opens one of its
 * interfaces. A module that failed to download is retried when the player
 * next asks for one of its interfaces.
 */

const WORLD_HOOKS = ["useBuyOrderEvents"] as const;

const loader = createInterfaceLoader(import.meta.glob<LoadedModule>("/src/ui/interfaces/*/index.ts"), WORLD_HOOKS);

const modulePath = (folder: string) => `/src/ui/interfaces/${folder}/index.ts`;

/**
 * Which module draws an id, so opening it loads that module first instead of
 * waiting for all of them. Only a hint: an id it misses, or one its module no
 * longer registers, loads every module.
 */
const MODULE_OF: Partial<Record<InterfaceId, string>> = {
  intro: "info",
  "how-it-works": "info",
  terms: "info",
  dialogue: "dialogue",
  bank: "bank",
  sell: "bank",
  collection: "bank",
  exchange: "buy",
  trade: "buy",
  payment: "buy",
  verify: "buy",
};

/** The interfaces a player can open from the title or right after entering (no wallet code or Peer SDK). */
export const LIGHT_INTERFACES: readonly InterfaceId[] = ["intro", "terms", "dialogue"];

interface RegistryState {
  /** Every module has loaded (or failed to). */
  ready: boolean;
  components: Partial<Record<InterfaceId, AnyInterface>>;
  worldHooks: WorldHook[];
  /** Modules whose chunk failed on the last attempt; retried by the next loadInterfaces(). */
  failed: string[];
  /** Most attempts a still-failing module has had. */
  attempts: number;
}

export const useInterfaceRegistry = create<RegistryState>(() => ({ ready: false, components: {}, worldHooks: [], failed: [], attempts: 0 }));

/** The module paths drawing `ids`, or undefined (every module) when one isn't known. */
function modulesFor(ids: readonly InterfaceId[] | undefined): string[] | undefined {
  if (!ids) return undefined;
  const paths = new Set<string>();
  for (const id of ids) {
    const folder = MODULE_OF[id];
    const path = folder === undefined ? null : modulePath(folder);
    if (path === null || !loader.paths.includes(path)) return undefined;
    paths.add(path);
  }
  return [...paths];
}

/**
 * Loads the modules that draw `ids` (every interface module when omitted)
 * that are not loaded yet, retrying failed ones. The rest still register
 * when one fails.
 */
export function loadInterfaces(ids?: readonly InterfaceId[]): Promise<void> {
  return loadModules(modulesFor(ids));
}

/** True when the module that draws `id` failed on its last attempt. */
function moduleFailed(id: InterfaceId, failed: readonly string[]): boolean {
  const folder = MODULE_OF[id];
  return folder !== undefined && failed.includes(modulePath(folder));
}

async function loadModules(paths: readonly string[] | undefined): Promise<void> {
  const snapshot = await loader.load(paths);
  // Retries import the chunk URL directly, past Vite's preloadError event: check for a new release here too.
  if (snapshot.failed.length > 0) void noteChunkFailure();
  registerChatboxInterfaces(snapshot.chatboxIds);
  useInterfaceRegistry.setState({
    ready: snapshot.complete,
    components: snapshot.components,
    worldHooks: snapshot.worldHooks,
    failed: snapshot.failed,
    attempts: snapshot.attempts,
  });
}

/**
 * Makes sure the module drawing `id` is in: its own module first, then (if it
 * didn't register `id`) every module, so the registry reads complete and an
 * id nothing draws is reported instead of waiting forever.
 */
async function ensureInterface(id: InterfaceId): Promise<void> {
  await loadInterfaces([id]);
  const { components, failed } = useInterfaceRegistry.getState();
  // A module that failed is reported by MissingInterface (and retried on the next open), not by loading the rest.
  if (!components[id] && !moduleFailed(id, failed)) await loadInterfaces();
}

export const INTERFACE_LOAD_FAILED = "That interface couldn't be loaded. Check your connection, then try again.";
export const INTERFACE_LOAD_RELOAD = "That interface still couldn't be loaded. Check your connection, then reload the page.";
/** After this many failed attempts at a module, the player is told to reload instead. */
const RELOAD_AFTER_ATTEMPTS = 3;

function HowItWorksFallback() {
  const { close } = useGame();
  return <HowItWorks onClose={close} />;
}

/** Shell-provided defaults used only when no module registers the id. */
const FALLBACKS: Partial<Record<InterfaceId, AnyInterface>> = {
  "how-it-works": HowItWorksFallback,
};

export function resolveInterface(id: InterfaceId, components: RegistryState["components"]): AnyInterface | null {
  return components[id] ?? FALLBACKS[id] ?? null;
}

const reportedMissing = new Set<InterfaceId>();

/**
 * The open id has no component. If a module failed to download, say so and
 * retry it so the next open works; otherwise (an id no module registers) log
 * it for developers. Either way the id is closed.
 */
function MissingInterface({ id }: { id: InterfaceId }) {
  const game = useGame();
  const failed = useInterfaceRegistry((s) => s.failed.length > 0);
  const attempts = useInterfaceRegistry((s) => s.attempts);
  useEffect(() => {
    // Only the first run for this open acts (StrictMode runs effects twice in development).
    if (useOpenInterface.getState().current?.id !== id) return;
    useOpenInterface.getState().set(null);
    if (failed) {
      game.message(attempts >= RELOAD_AFTER_ATTEMPTS ? INTERFACE_LOAD_RELOAD : INTERFACE_LOAD_FAILED);
      // Only the modules that failed: the ones not tried yet load on their own schedule.
      void loadModules(useInterfaceRegistry.getState().failed);
    } else if (!reportedMissing.has(id)) {
      reportedMissing.add(id);
      console.warn(`[interfaces] no module registers "${id}"; nothing to show`);
    }
  }, [id, failed, attempts, game]);
  return null;
}

/** How long a window waits for its code before saying so, so a quick download never flashes the message. */
const LOADING_NOTICE_MS = 400;

/** A window opened before its module has downloaded: "Please wait..." until it arrives (Esc still closes it). */
function InterfaceLoading({ onClose }: { onClose: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADING_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <>
      <EscapeCloses onClose={onClose} />
      {shown && <PleaseWait className="rs-c-yellow rs-shadow rs-p12" />}
    </>
  );
}

/** Esc closes the interface unless the interface handles Esc itself (its own layers sit above this one). */
function EscapeCloses({ onClose }: { onClose: () => void }) {
  useEscapeLayer(onClose);
  return null;
}

interface BoundaryProps {
  id: InterfaceId;
  onCrash: (id: InterfaceId) => void;
  children: ReactNode;
}

/** One broken interface must never take the world down with it. */
class InterfaceBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[interfaces] "${this.props.id}" crashed`, error, info.componentStack);
    this.props.onCrash(this.props.id);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * True when an interface for this placement is open, so its slot must be
 * mounted: to render it, to wait for its module, or to report a module that
 * failed to load (which closes it straight away).
 */
export function useHasInterface(placement: "chat" | "window"): boolean {
  const current = useOpenInterface((s) => s.current);
  return current !== null && placementOf(current.id) === placement;
}

/**
 * Renders the open interface if it belongs in this placement: "chat" for
 * chat-head dialogues (GameFrame's chat overlay), "window" for everything
 * else (GameFrame's centred interface layer).
 */
export function InterfaceSlot({ placement }: { placement: "chat" | "window" }) {
  const { current, key } = useOpenInterface();
  const registry = useInterfaceRegistry();
  const game = useGame();
  const openId = current && placementOf(current.id) === placement ? current.id : null;
  const registered = openId !== null && registry.components[openId] !== undefined;
  // An interface opened before its module loaded: fetch that module now (a shell fallback shows meanwhile).
  useEffect(() => {
    if (openId && !registered) void ensureInterface(openId);
  }, [openId, registered]);
  if (!current || placementOf(current.id) !== placement) return null;
  const Interface = resolveInterface(current.id, registry.components);
  if (!Interface) {
    if (registry.ready || moduleFailed(current.id, registry.failed)) return <MissingInterface id={current.id} />;
    return placement === "window" ? <InterfaceLoading onClose={game.close} /> : null;
  }
  const onCrash = () => {
    game.close();
    game.message("That interface stopped working. Try opening it again.");
  };
  const view = <Interface open={current as OpenInterface} />;
  return (
    <InterfaceBoundary key={key} id={current.id} onCrash={onCrash}>
      <EscapeCloses onClose={game.close} />
      {current.id === "intro" && <IntroShown />}
      {/* Buy interfaces trade from the buy binding's wallet (the earlier wallet while it holds the open order). */}
      {BUY_INTERFACES.has(current.id) ? <BuyInterfaceContext>{view}</BuyInterfaceContext> : view}
    </InterfaceBoundary>
  );
}

/** The first-visit welcome counts as seen once it has actually been shown. */
function IntroShown() {
  useEffect(() => markIntroSeen(), []);
  return null;
}

function WorldHookHost({ hook }: { hook: WorldHook }) {
  hook.use();
  return null;
}

/** Mounts the modules' world hooks once (inside the game, under GameContext). */
export function WorldHooks() {
  const hooks = useInterfaceRegistry((s) => s.worldHooks);
  return (
    <>
      {hooks.map((hook) => (
        <WorldHookHost key={hook.name} hook={hook} />
      ))}
    </>
  );
}
