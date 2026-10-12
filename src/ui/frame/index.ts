/**
 * In-game frame: HUD layout, chatbox, minimap, side panel, menus. Props and
 * callbacks only; the integrator wires the engine, network and wallet.
 */
import "@/ui/kit";
import "./frame.css";

export { CHAT_BACKLOG, CHAT_TABS, appendLines, chatLine, fromChatRecord, fromWorldEvent, gameMessage, latestTime, lineText, linesForTab, tabOf, unreadTabs, worldEventText } from "./chat";
export type { ChatKind, ChatLine, ChatTab } from "./chat";
export { Chatbox, type ChatboxProps } from "./Chatbox";
export { ClickBlocker, type ClickBlockerProps } from "./ClickBlocker";
export { ContextMenu, type ContextMenuProps } from "./ContextMenu";
export { GameFrame, type GameFrameProps } from "./GameFrame";
export { HUD_HIDE_SHORTCUT, HudVisibilityContext, hudKeyAction, useHudVisibility, type HudVisibility } from "./hud";
export { HudHoverContext, useHudHover } from "./hudHover";
export { TARGET_COLORS, entryText, type MenuEntry } from "./menu";
export { COMPASS_CANVAS_SIZE, MINIMAP_SIZE, MinimapPanel, orbBalanceLabel, type MinimapPanelProps } from "./MinimapPanel";
export { MouseoverText, type MouseoverTextProps } from "./MouseoverText";
export { AccountPanel, type AccountPanelProps, type WalletKindLabel } from "./panels/AccountPanel";
export { EMOTE_LABELS, EmotesPanel, type EmotesPanelProps } from "./panels/EmotesPanel";
export { INVENTORY_SLOTS, InventoryPanel, type InventoryPanelProps } from "./panels/InventoryPanel";
export { LogoutPanel, type LogoutPanelProps } from "./panels/LogoutPanel";
export { SettingsPanel, type GameSettings, type SettingsPanelProps } from "./panels/SettingsPanel";
export { SIDE_TABS, SidePanel, type SidePanelProps, type SideTabId } from "./SidePanel";
