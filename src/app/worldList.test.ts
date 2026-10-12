import { describe, expect, it } from "vitest";
import { afterHop, markFull, worldRows } from "./worldList";

describe("World Switcher rows", () => {
  it("lists the open worlds in order with their counts", () => {
    expect(
      worldRows(
        [
          { id: 303, players: 12, full: false },
          { id: 301, players: 200, full: true },
          { id: 302, players: 140, full: false },
        ],
        302,
      ),
    ).toEqual([
      { id: 301, players: 200, full: true, closed: false },
      { id: 302, players: 140, full: false, closed: false },
      { id: 303, players: 12, full: false, closed: false },
    ]);
  });

  it("keeps the player's own world on the list after it was closed", () => {
    expect(worldRows([{ id: 301, players: 3, full: false }], 304)).toEqual([
      { id: 304, players: null, full: false, closed: true },
      { id: 301, players: 3, full: false, closed: false },
    ]);
  });

  it("counts a hop that just landed until the server's next count, and shows a refused world as full", () => {
    const list = [
      { id: 301, players: 8, full: false },
      { id: 302, players: 9, full: false },
      { id: 303, players: 0, full: false },
    ];
    expect(afterHop(list, 302, 303, 10)).toEqual([
      { id: 301, players: 8, full: false },
      { id: 302, players: 8, full: false },
      { id: 303, players: 1, full: false },
    ]);
    expect(afterHop(list, 303, 302, 10)).toEqual([
      { id: 301, players: 8, full: false },
      { id: 302, players: 10, full: true },
      { id: 303, players: 0, full: false },
    ]);
    expect(markFull(list, 302)[1]).toEqual({ id: 302, players: 9, full: true });
  });
});
