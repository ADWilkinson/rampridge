import { createContext, useContext } from "react";
import type { MenuEntry } from "./menu";

/** Lets HUD controls (orbs, emotes) set the top-left mouseover line inside GameFrame. */
export const HudHoverContext = createContext<((entry: MenuEntry | null) => void) | null>(null);

export function useHudHover(): ((entry: MenuEntry | null) => void) | null {
  return useContext(HudHoverContext);
}
