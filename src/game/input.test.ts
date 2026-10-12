import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { keyBelongsToUi } from "./input";

/** The slice of the DOM keyBelongsToUi reads, so the rules run under node. */
class FakeElement {
  tagName: string;
  isContentEditable = false;
  parentElement: FakeElement | null = null;
  readonly attrs: Record<string, string>;
  readonly style = { overflowX: "visible", overflowY: "visible" };
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  ownerDocument = doc;

  constructor(tagName = "DIV", attrs: Record<string, string> = {}, parent: FakeElement | null = null) {
    this.tagName = tagName;
    this.attrs = attrs;
    this.parentElement = parent;
  }

  matches(selectors: string): boolean {
    return selectors.split(",").some((s) => {
      const m = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(s.trim());
      const value = m ? this.attrs[m[1]!] : undefined;
      return value !== undefined && (m![2] === undefined || value === m![2]);
    });
  }

  closest(selectors: string): FakeElement | null {
    if (this.matches(selectors)) return this;
    return this.parentElement ? this.parentElement.closest(selectors) : null;
  }
}

const doc: { body: FakeElement; documentElement: FakeElement } = { body: null!, documentElement: null! };
doc.documentElement = new FakeElement("HTML");
doc.body = new FakeElement("BODY", {}, doc.documentElement);

beforeAll(() => {
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("getComputedStyle", (el: FakeElement) => el.style);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const el = (tag: string, attrs: Record<string, string> = {}, parent: FakeElement = doc.body) => new FakeElement(tag, attrs, parent);

describe("keyBelongsToUi", () => {
  it("gives the camera keys pressed with nothing or a plain button focused", () => {
    expect(keyBelongsToUi(doc.body as unknown as EventTarget, "left")).toBe(false);
    expect(keyBelongsToUi(el("BUTTON") as unknown as EventTarget, "down")).toBe(false);
    expect(keyBelongsToUi(null, "up")).toBe(false);
  });

  it("leaves text fields their keys unless they opt in with data-world-keys", () => {
    expect(keyBelongsToUi(el("INPUT") as unknown as EventTarget, "left")).toBe(true);
    expect(keyBelongsToUi(el("TEXTAREA") as unknown as EventTarget, "up")).toBe(true);
    const zone = el("DIV", { "data-world-keys": "" });
    expect(keyBelongsToUi(el("INPUT", {}, zone) as unknown as EventTarget, "left")).toBe(false);
  });

  it("leaves arrow-driven widgets and data-ui-keys their keys", () => {
    const menu = el("DIV", { role: "menu" });
    expect(keyBelongsToUi(el("BUTTON", { role: "menuitem" }, menu) as unknown as EventTarget, "down")).toBe(true);
    expect(keyBelongsToUi(el("DIV", { role: "listbox" }) as unknown as EventTarget, "up")).toBe(true);
    expect(keyBelongsToUi(el("BUTTON", { role: "tab" }) as unknown as EventTarget, "right")).toBe(true);
    expect(keyBelongsToUi(el("SPAN", {}, el("DIV", { "data-ui-keys": "" })) as unknown as EventTarget, "left")).toBe(true);
  });

  it("leaves a scroll pane its keys on the axis it scrolls", () => {
    const pane = el("DIV");
    pane.style.overflowY = "auto";
    pane.scrollHeight = 400;
    pane.clientHeight = 100;
    const item = el("BUTTON", {}, pane);
    expect(keyBelongsToUi(item as unknown as EventTarget, "down")).toBe(true);
    expect(keyBelongsToUi(item as unknown as EventTarget, "left")).toBe(false);
    // A pane with nothing to scroll does not claim them.
    pane.scrollHeight = 100;
    expect(keyBelongsToUi(item as unknown as EventTarget, "down")).toBe(false);
  });
});
