import { describe, expect, it } from "vitest";
import { parseSoundManifest } from "./audio";

describe("sound manifest", () => {
  it("reads name-to-file maps", () => {
    const m = parseSoundManifest({ coins: "coins.ogg", click: { file: "click.wav", id: 2266 } });
    expect(m.get("coins")).toBe("coins.ogg");
    expect(m.get("click")).toBe("click.wav");
  });

  it("reads lists and { sounds } wrappers", () => {
    const m = parseSoundManifest({ sounds: [{ name: "Coins", url: "/game/sounds/sfx_2585.wav" }, { id: 100, src: "sfx_100.wav" }] });
    expect(m.get("coins")).toBe("/game/sounds/sfx_2585.wav");
    expect(m.get("100")).toBe("sfx_100.wav");
  });

  it("ignores missing or malformed manifests", () => {
    expect(parseSoundManifest(null).size).toBe(0);
    expect(parseSoundManifest([1, 2]).size).toBe(0);
  });
});
