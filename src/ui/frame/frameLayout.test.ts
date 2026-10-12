import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UI_ZOOM, UI_ZOOM_QUERY, layoutMode, uiZoomFor } from "@/ui/kit/layout";
import { canHideHud, frameLayout } from "./frameLayout";

const desktop = layoutMode(false, false);
const portrait = layoutMode(true, false);
const sideways = layoutMode(false, true);
const closed = { chatExpanded: false, chatCovered: false, sideOpen: false };

describe("frameLayout", () => {
  it("adds nothing on desktop, where the chatbox always shows", () => {
    expect(frameLayout({ mode: desktop, ...closed, chatCovered: true, sideOpen: true })).toEqual({ chatOpen: true, hudHidden: false, classes: [] });
  });

  it("keeps the phone chatbox to one line until opened or covered", () => {
    expect(frameLayout({ mode: portrait, ...closed })).toEqual({ chatOpen: false, hudHidden: false, classes: ["rs-gameframe--mobile"] });
    expect(frameLayout({ mode: portrait, ...closed, chatExpanded: true }).classes).toEqual(["rs-gameframe--mobile", "rs-gameframe--chat-open"]);
  });

  it("opens the chatbox for a prompt or dialogue so interfaces refit above it", () => {
    const layout = frameLayout({ mode: portrait, ...closed, chatCovered: true });
    expect(layout.chatOpen).toBe(true);
    expect(layout.classes).toEqual(["rs-gameframe--mobile", "rs-gameframe--chat-open", "rs-gameframe--chat-covered"]);
  });

  it("marks an open side sheet so it draws above interfaces", () => {
    expect(frameLayout({ mode: portrait, ...closed, sideOpen: true }).classes).toContain("rs-gameframe--sheet-open");
  });

  it("uses the compact bottom row on a phone held sideways", () => {
    expect(frameLayout({ mode: sideways, ...closed }).classes).toEqual(["rs-gameframe--mobile", "rs-gameframe--compact"]);
    expect(frameLayout({ mode: sideways, ...closed, chatCovered: true, sideOpen: true }).classes).toEqual([
      "rs-gameframe--mobile",
      "rs-gameframe--compact",
      "rs-gameframe--chat-open",
      "rs-gameframe--chat-covered",
      "rs-gameframe--sheet-open",
    ]);
  });

  it("hides the minimap and orbs under an open interface on an upright phone only", () => {
    expect(frameLayout({ mode: portrait, ...closed, interfaceOpen: true }).classes).toContain("rs-gameframe--iface-open");
    expect(frameLayout({ mode: portrait, ...closed, interfaceOpen: false }).classes).not.toContain("rs-gameframe--iface-open");
    // Sideways the interface layer stops left of the minimap column; on desktop it never reaches it.
    expect(frameLayout({ mode: sideways, ...closed, interfaceOpen: true }).classes).not.toContain("rs-gameframe--iface-open");
    expect(frameLayout({ mode: desktop, ...closed, interfaceOpen: true }).classes).toEqual([]);
  });

  it("hides the HUD on desktop when asked, unless an interface is open or the chatbox asks something", () => {
    expect(frameLayout({ mode: desktop, ...closed, hudHidden: true })).toEqual({ chatOpen: true, hudHidden: true, classes: ["rs-gameframe--hud-hidden"] });
    expect(frameLayout({ mode: desktop, ...closed, hudHidden: true, interfaceOpen: true }).hudHidden).toBe(false);
    expect(frameLayout({ mode: desktop, ...closed, hudHidden: true, chatCovered: true }).hudHidden).toBe(false);
    expect(frameLayout({ mode: desktop, ...closed, hudHidden: false }).classes).toEqual([]);
  });

  it("never hides the HUD on a phone, which has no key to bring it back", () => {
    expect(canHideHud(portrait, false, false)).toBe(false);
    expect(canHideHud(sideways, false, false)).toBe(false);
    expect(canHideHud(desktop, false, false)).toBe(true);
    const layout = frameLayout({ mode: portrait, ...closed, hudHidden: true });
    expect(layout.hudHidden).toBe(false);
    expect(layout.classes).not.toContain("rs-gameframe--hud-hidden");
  });
});

describe("big-monitor zoom", () => {
  it("doubles the interface from 2200x1200 CSS pixels", () => {
    expect(uiZoomFor(2560, 1440)).toBe(UI_ZOOM);
    expect(uiZoomFor(2200, 1200)).toBe(2);
    expect(uiZoomFor(2199, 1440)).toBe(1);
    expect(uiZoomFor(2560, 1199)).toBe(1);
    expect(uiZoomFor(1920, 1080)).toBe(1);
  });

  it("uses the same query in the stylesheet as in layout.ts", () => {
    const css = readFileSync(path.resolve(__dirname, "../../styles/tokens.css"), "utf8");
    expect(css).toContain(`@media ${UI_ZOOM_QUERY} {`);
    expect(css).toMatch(new RegExp(`--rs-ui-zoom: ${UI_ZOOM};`));
  });
});

