import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChatPromptProvider, useChatPrompt } from "@/ui/kit/ChatPrompt";
import { cx } from "@/ui/kit/cx";
import { useEscapeLayer, useLayoutMode } from "@/ui/kit/hooks";
import { Chatbox, type ChatboxProps } from "./Chatbox";
import { ClickBlocker } from "./ClickBlocker";
import { canHideHud, frameLayout } from "./frameLayout";
import { HudVisibilityContext, hudKeyAction, type HudVisibility } from "./hud";
import { HudHoverContext } from "./hudHover";
import type { MenuEntry } from "./menu";
import { MinimapPanel, type MinimapPanelProps } from "./MinimapPanel";
import { MouseoverText } from "./MouseoverText";
import { SidePanel, type SidePanelProps } from "./SidePanel";

export interface GameFrameProps {
  /** The engine's mount element; fills the window behind the HUD. */
  viewport?: ReactNode;
  /** The engine's `hover` event payload. */
  hover?: { first: MenuEntry; more: number } | null;
  minimap: MinimapPanelProps;
  chat: ChatboxProps;
  side: SidePanelProps;
  /** Open interfaces (Window, ParchmentScroll...), centred above the chatbox. */
  interfaces?: ReactNode;
  /** The open Choose Option menu (a <ContextMenu/>), drawn above everything. */
  menu?: ReactNode;
  /**
   * Swallow world input while true (e.g. while a transaction is pending):
   * clicks, taps, hover and zoom on the 3D view and walking by the minimap.
   * The HUD, chatbox, side panel and open interfaces stay usable.
   */
  blocking?: boolean;
  /** Lay out inside the parent (position: absolute) instead of the window. */
  contained?: boolean;
  className?: string;
}

/**
 * The resizable-classic game layout: 3D viewport underneath, mouseover text
 * top-left, minimap and orbs top-right, chatbox bottom-left, side panel
 * bottom-right, interfaces centred, the menu on top. Phones get a collapsed
 * one-line chat and a tab strip that opens the side panel as a sheet; held
 * sideways, the chat line and the strip share one bottom row so interfaces
 * keep the height. Props and callbacks only: the integrator wires the
 * engine, network and wallet.
 *
 * Desktop players can hide the HUD to film the bank (Alt+H, or Settings);
 * H or Esc brings it back, and so does any interface or chatbox question.
 * On monitors of 2200x1200 CSS pixels and up the HUD and interfaces draw at
 * 2x (--rs-ui-zoom in styles/tokens.css, UI_ZOOM_QUERY in kit/layout.ts).
 */
export function GameFrame(props: GameFrameProps) {
  return (
    <ChatPromptProvider>
      <GameFrameLayout {...props} />
    </ChatPromptProvider>
  );
}

/** True while `ref` has child elements (an interface is open in the host). */
function useHasChildren(ref: RefObject<HTMLElement | null>): boolean {
  const [has, setHas] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHas(el.childElementCount > 0);
    update();
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    return () => mo.disconnect();
  }, [ref]);
  return has;
}

function isTextField(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** How long the "Interface hidden" hint shows after hiding the HUD. */
const HUD_HINT_MS = 3000;

function GameFrameLayout({ viewport, hover = null, minimap, chat, side, interfaces, menu, blocking = false, contained = false, className }: GameFrameProps) {
  const mode = useLayoutMode();
  const prompt = useChatPrompt();
  const [uiHover, setUiHover] = useState<MenuEntry | null>(null);
  const [chatExpanded, setChatExpanded] = useState(false);
  // A field in the chatbox has focus: on phones the chatbox rides on top of the on-screen keyboard (frame.css).
  const [chatFocus, setChatFocus] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const interfaceOpen = useHasChildren(host);
  const [hudHiddenWanted, setHudHidden] = useState(false);
  const [hudHint, setHudHint] = useState(false);
  const chatCovered = Boolean(chat.overlay) || Boolean(prompt?.current);
  const canHide = canHideHud(mode, interfaceOpen, chatCovered);

  // An interface opening puts the phone chatbox back to one line so the window gets the room.
  useEffect(() => {
    if (interfaceOpen) setChatExpanded(false);
  }, [interfaceOpen]);

  // Phones start with the side sheet put away (and put it away when the screen turns into a phone layout):
  // a caller's desktop default, such as the inventory open, would otherwise cover the view as a sheet.
  const sideRef = useRef(side);
  sideRef.current = side;
  const wasSheet = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const entered = mode.sheet && wasSheet.current !== true;
    wasSheet.current = mode.sheet;
    if (entered && sideRef.current.active !== null) sideRef.current.onChange(null);
  }, [mode.sheet]);

  const onHudHover = (entry: MenuEntry | null) => {
    setUiHover(entry);
    minimap.onHover?.(entry);
  };
  const first = uiHover ?? hover?.first ?? null;
  const more = uiHover ? 0 : (hover?.more ?? 0);

  const layout = frameLayout({
    mode,
    chatExpanded,
    chatCovered,
    sideOpen: side.active !== null && side.panels[side.active] !== undefined,
    interfaceOpen,
    hudHidden: hudHiddenWanted,
  });
  const hudHidden = layout.hudHidden;

  // An interface or a chatbox question brings the HUD back for good, so closing it never hides the HUD again.
  useEffect(() => {
    if (!canHide) setHudHidden(false);
  }, [canHide]);

  // Hidden: a short hint says how to get the HUD back, then the view is clean for filming.
  useEffect(() => {
    if (!hudHidden) {
      setHudHint(false);
      return;
    }
    setHudHint(true);
    const id = window.setTimeout(() => setHudHint(false), HUD_HINT_MS);
    return () => window.clearTimeout(id);
  }, [hudHidden]);

  // Esc shows the HUD again (an escape layer, so a Choose Option menu opened over the bare view closes first).
  useEscapeLayer(() => setHudHidden(false), hudHidden);

  // Alt+H hides, H or Alt+H shows. Bound before the chatbox's typing capture so a show key is never typed.
  const hudKeys = useRef({ hidden: hudHidden, canHide });
  hudKeys.current = { hidden: hudHidden, canHide };
  useLayoutEffect(() => {
    if (contained) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const { hidden, canHide: allowed } = hudKeys.current;
      const action = hudKeyAction(e, hidden, isTextField(e.target) || isTextField(document.activeElement));
      if (!action || (action === "hide" && !allowed)) return;
      e.preventDefault();
      setHudHidden(action === "hide");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [contained]);

  const hudControls = useMemo<HudVisibility>(() => ({ available: !mode.sheet, canHide, hide: () => setHudHidden(true) }), [mode.sheet, canHide]);

  return (
    <HudVisibilityContext.Provider value={hudControls}>
    <HudHoverContext.Provider value={onHudHover}>
      <div
        className={cx(
          "rs-gameframe rs-game",
          contained && "rs-gameframe--contained",
          ...layout.classes,
          blocking && "rs-gameframe--blocking",
          chatFocus && "rs-gameframe--chat-focus",
          className,
        )}
      >
        <div className="rs-gameframe__viewport">{viewport}</div>
        {blocking && <ClickBlocker className="rs-gameframe__blocker" />}
        {!mode.sheet && !hudHidden && <MouseoverText first={first} more={more} className="rs-gameframe__mouseover" />}
        {!contained && (
          <p className="rs-gameframe__hud-hint rs-b12 rs-shadow" role="status">
            {hudHint ? "Interface hidden. Press H or Esc to show it." : ""}
          </p>
        )}
        <div className="rs-gameframe__minimap">
          <MinimapPanel {...minimap} onHover={onHudHover} />
        </div>
        <div className="rs-gameframe__interfaces">
          <div ref={host} className="rs-window-host">
            {interfaces}
          </div>
        </div>
        <div
          className="rs-gameframe__chat"
          onFocus={(e) => setChatFocus(isTextField(e.target))}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setChatFocus(false);
          }}
        >
          <Chatbox {...chat} mobile={mode.sheet} expanded={chatExpanded} onExpandedChange={setChatExpanded} />
        </div>
        <div className="rs-gameframe__side">
          <SidePanel {...side} mobile={mode.sheet} />
        </div>
        {menu}
      </div>
    </HudHoverContext.Provider>
    </HudVisibilityContext.Provider>
  );
}
