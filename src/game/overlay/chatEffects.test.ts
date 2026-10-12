import { describe, expect, it } from "vitest";
import { CHAT_MOTIONS } from "@shared/chat";
import { CHAT_LIFETIME_MS, chatColour, cssColour, glyphOffset, motionAmplitude, scrollLeft, slideOffset, textCycle } from "./chatEffects";

describe("chat colours", () => {
  it("uses the client's fixed colours", () => {
    expect(chatColour("yellow", 0)).toBe(0xffff00);
    expect(chatColour("red", 0)).toBe(0xff0000);
    expect(chatColour("green", 0)).toBe(0x00ff00);
    expect(chatColour("cyan", 0)).toBe(0x00ffff);
    expect(chatColour("purple", 0)).toBe(0xff00ff);
    expect(chatColour("white", 0)).toBe(0xffffff);
  });

  it("flashes every 10 client cycles (200 ms)", () => {
    expect(chatColour("flash1", 0)).toBe(0xff0000);
    expect(chatColour("flash1", 200)).toBe(0xffff00);
    expect(chatColour("flash2", 0)).toBe(0x0000ff);
    expect(chatColour("flash2", 210)).toBe(0x00ffff);
    expect(chatColour("flash3", 0)).toBe(0x00b000);
    expect(chatColour("flash3", 399)).toBe(0x80ff80);
  });

  it("glows through the client's colour ramps over the message's life", () => {
    const at = (fraction: number) => fraction * CHAT_LIFETIME_MS;
    expect(chatColour("glow1", 0)).toBe(0xff0000);
    expect(chatColour("glow1", at(50 / 150))).toBe(0xffff00);
    expect(chatColour("glow1", at(100 / 150))).toBe(0x00ff00);
    expect(chatColour("glow2", 0)).toBe(0xff0000);
    expect(chatColour("glow2", at(50 / 150))).toBe(0xff00ff);
    expect(chatColour("glow2", at(100 / 150))).toBe(0x0000ff);
    expect(chatColour("glow3", 0)).toBe(0xffffff);
    expect(chatColour("glow3", at(50 / 150))).toBe(0x00ff00);
    expect(chatColour("glow3", at(100 / 150))).toBe(0xffffff);
    for (let t = 0; t < CHAT_LIFETIME_MS; t += 33) {
      for (const c of ["glow1", "glow2", "glow3"] as const) {
        const rgb = chatColour(c, t);
        expect(rgb).toBeGreaterThanOrEqual(0);
        expect(rgb).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it("formats CSS colours", () => {
    expect(cssColour(0xff00)).toBe("#00ff00");
    expect(cssColour(0xff00)).toBe(cssColour(0xff00));
  });
});

describe("chat motions", () => {
  const o = { x: 0, y: 0 };
  it("waves within 5 px", () => {
    for (let i = 0; i < 40; i++) {
      glyphOffset("wave", i, i * 37, o);
      expect(o.x).toBe(0);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(5);
      glyphOffset("wave2", i, i * 37, o);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(5);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(5);
    }
  });

  it("never moves a glyph further than the amplitude stacking reserves", () => {
    for (const motion of [...CHAT_MOTIONS, null]) {
      const amp = motionAmplitude(motion);
      for (let elapsed = 0; elapsed < CHAT_LIFETIME_MS; elapsed += 7) {
        for (let i = 0; i < 60; i++) {
          glyphOffset(motion, i, elapsed, o);
          expect(Math.abs(o.x), `${motion} x`).toBeLessThanOrEqual(amp.x);
          expect(Math.abs(o.y), `${motion} y`).toBeLessThanOrEqual(amp.y);
        }
      }
    }
    expect(motionAmplitude("scroll")).toEqual({ x: 0, y: 0 });
  });

  it("shake decays to nothing", () => {
    glyphOffset("shake", 3, CHAT_LIFETIME_MS * 0.9, o);
    expect(o.y).toBe(0);
  });

  it("scroll moves the text right to left through a 100 px window", () => {
    expect(scrollLeft(80, 0)).toBe(50);
    expect(scrollLeft(80, CHAT_LIFETIME_MS)).toBeLessThan(-80 + 1 - 50 + 5);
    expect(scrollLeft(80, CHAT_LIFETIME_MS / 2)).toBeLessThan(scrollLeft(80, CHAT_LIFETIME_MS / 4));
  });

  it("slide drops in and out", () => {
    expect(slideOffset(0)).toBe(-25);
    expect(slideOffset(CHAT_LIFETIME_MS / 2)).toBe(0);
    expect(slideOffset(CHAT_LIFETIME_MS - 1)).toBeGreaterThan(0);
  });

  it("text cycles span the lifetime", () => {
    expect(textCycle(0)).toBe(0);
    expect(textCycle(CHAT_LIFETIME_MS)).toBe(149);
  });
});
