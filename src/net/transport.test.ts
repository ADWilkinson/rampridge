import { describe, expect, it } from "vitest";
import { applyStreamEvent, streamUrl } from "./transport";

describe("applyStreamEvent", () => {
  it("diffs a root snapshot into added, changed and removed children", () => {
    const children = new Map<string, unknown>();
    expect(applyStreamEvent(children, "put", "/", { a: { ls: 1 }, b: { ls: 2 } })).toEqual([
      { op: "added", key: "a", value: { ls: 1 } },
      { op: "added", key: "b", value: { ls: 2 } },
    ]);
    // A resync after reconnecting: b left, a changed, c arrived.
    expect(applyStreamEvent(children, "put", "/", { a: { ls: 5 }, c: { ls: 3 } })).toEqual([
      { op: "removed", key: "b", value: null },
      { op: "changed", key: "a", value: { ls: 5 } },
      { op: "added", key: "c", value: { ls: 3 } },
    ]);
    expect(applyStreamEvent(children, "put", "/", null)).toEqual([
      { op: "removed", key: "a", value: null },
      { op: "removed", key: "c", value: null },
    ]);
  });

  it("applies nested puts to one child", () => {
    const children = new Map<string, unknown>([["p1", { n: "Bob", ls: 1, a: { kits: [1, 2, 3] } }]]);
    expect(applyStreamEvent(children, "put", "/p1/ls", 9)).toEqual([
      { op: "changed", key: "p1", value: { n: "Bob", ls: 9, a: { kits: [1, 2, 3] } } },
    ]);
    expect(applyStreamEvent(children, "put", "/p2", { n: "Al" })).toEqual([{ op: "added", key: "p2", value: { n: "Al" } }]);
    expect(applyStreamEvent(children, "put", "/p2", null)).toEqual([{ op: "removed", key: "p2", value: null }]);
    expect(applyStreamEvent(children, "put", "/p3", null)).toEqual([]);
    expect(applyStreamEvent(children, "put", "/p1/ls", 9)).toEqual([]);
  });

  it("applies a patch as one change per child, with its final value", () => {
    const children = new Map<string, unknown>([["p1", { n: "Bob", ls: 1, e: "wave" }]]);
    expect(applyStreamEvent(children, "patch", "/p1", { ls: 2, e: null })).toEqual([
      { op: "changed", key: "p1", value: { n: "Bob", ls: 2 } },
    ]);
    expect(applyStreamEvent(children, "patch", "/", { p9: { n: "Zed" }, "p1/n": "Bobby" })).toEqual([
      { op: "added", key: "p9", value: { n: "Zed" } },
      { op: "changed", key: "p1", value: { n: "Bobby", ls: 2 } },
    ]);
    // A move: never the new path with the old start time.
    expect(applyStreamEvent(children, "patch", "/", { "p9/p": "1,1;1,2", "p9/t": 50, "p9/r": true })).toEqual([
      { op: "changed", key: "p9", value: { n: "Zed", p: "1,1;1,2", t: 50, r: true } },
    ]);
    // A patch that changes nothing, or clears everything.
    expect(applyStreamEvent(children, "patch", "/p9", { t: 50 })).toEqual([]);
    expect(applyStreamEvent(children, "patch", "/", { p9: null, p8: null })).toEqual([{ op: "removed", key: "p9", value: null }]);
  });
});

describe("streamUrl", () => {
  it("builds REST streaming URLs with an ordered window", () => {
    expect(streamUrl("https://rampridge-world.firebaseio.com/", "world/players")).toBe(
      "https://rampridge-world.firebaseio.com/world/players.json",
    );
    expect(streamUrl("https://rampridge-world.firebaseio.com", "world/chat", 50)).toBe(
      "https://rampridge-world.firebaseio.com/world/chat.json?orderBy=%22t%22&limitToLast=50",
    );
  });
});
