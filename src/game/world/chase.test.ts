import { describe, expect, it } from "vitest";
import type { Tile } from "@shared/protocol";
import collision from "@shared/collision.json";
import metaJson from "@shared/world-meta.json";
import { Chase, REPLAN_MS } from "./chase";
import { CollisionMap } from "./collision";
import { adjacentGoal } from "./interaction";
import { motionEnd, nextStop, standingMotion, tileAt, type Motion } from "./motion";
import { findPath } from "./pathfinding";
import { parseWorldMeta } from "./worldMeta";

const meta = parseWorldMeta(metaJson);
const map = CollisionMap.from(collision);
map.setBounds(meta.bounds);

function route(from: Tile, to: Tile, startedAt: number): Motion {
  const path = findPath(map, from, to)!;
  return { path, startedAt, run: false };
}

function last(m: Motion): Tile {
  return m.path[m.path.length - 1]!;
}

/**
 * Runs a follower behind a leader the way the engine does (GameEngine.updatePending):
 * every frame it asks the Chase whether to route to the leader's destination,
 * and counts the routes it sends. `leaderMoves` are the leader's clicks.
 */
function simulate(leaderMoves: { at: number; to: Tile }[], followerStart: Tile, leaderStart: Tile, until: number, chase = new Chase()) {
  let leader = standingMotion(leaderStart, 0);
  let follower = standingMotion(followerStart, 0);
  const plans: { at: number; to: Tile }[] = [];
  const moves = [...leaderMoves];
  for (let now = 0; now <= until; now += 50) {
    while (moves.length > 0 && moves[0]!.at <= now) {
      const move = moves.shift()!;
      const stop = nextStop(leader, now);
      leader = route(stop.tile, move.to, stop.at);
    }
    const destination = last(leader);
    const goal = adjacentGoal(map, destination);
    const here = tileAt(follower, now);
    const walking = motionEnd(follower) > now;
    if (chase.shouldPlan(now, destination, goal, last(follower)) && (walking || !goal.reached(here.x, here.y))) {
      const stop = nextStop(follower, now);
      const path = findPath(map, stop.tile, goal)!;
      follower = { path, startedAt: stop.at, run: false };
      plans.push({ at: now, to: last(follower) });
    }
  }
  return { plans, leader, follower };
}

function adjacent(a: Tile, b: Tile): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

describe("Chase", () => {
  it("sends one route per destination of a walking leader, not one per step", () => {
    // The leader walks up the hall (8+ tiles, about 5 s), then turns back down part of it.
    const { plans, leader, follower } = simulate(
      [
        { at: 0, to: { x: 3182, y: 3445 } },
        { at: 7_000, to: { x: 3184, y: 3438 } },
      ],
      { x: 3182, y: 3434 },
      { x: 3182, y: 3436 },
      14_000,
    );
    expect(plans).toHaveLength(2);
    // Both routes end next to where the leader was going.
    expect(adjacent(plans[0]!.to, { x: 3182, y: 3445 })).toBe(true);
    expect(adjacent(plans[1]!.to, { x: 3184, y: 3438 })).toBe(true);
    // And the follower ends up beside the leader.
    expect(adjacent(tileAt(follower, 14_000), tileAt(leader, 14_000))).toBe(true);
  });

  it("keys on the destination: re-keying on the leader's current tile would send a route every re-plan", () => {
    // What the engine used to do: a new key every time the leader stepped onto a tile.
    const leader = route({ x: 3182, y: 3436 }, { x: 3182, y: 3445 }, 0);
    const chase = new Chase();
    let byTile = 0;
    let byDestination = 0;
    const tileChase = new Chase();
    for (let now = 0; now <= motionEnd(leader); now += 50) {
      const goal = adjacentGoal(map, last(leader));
      if (chase.shouldPlan(now, last(leader), goal, { x: 0, y: 0 })) byDestination++;
      const tile = tileAt(leader, now);
      if (tileChase.shouldPlan(now, tile, adjacentGoal(map, tile), { x: 0, y: 0 })) byTile++;
    }
    expect(byDestination).toBe(1);
    expect(byTile).toBeGreaterThan(3);
  });

  it("waits REPLAN_MS between routes when the destination keeps changing", () => {
    const chase = new Chase();
    const far = { x: 0, y: 0 };
    const goal = (t: Tile) => adjacentGoal(map, t);
    expect(chase.shouldPlan(0, { x: 3182, y: 3440 }, goal({ x: 3182, y: 3440 }), far)).toBe(true);
    // A new destination 300 ms later: held back.
    expect(chase.shouldPlan(300, { x: 3183, y: 3442 }, goal({ x: 3183, y: 3442 }), far)).toBe(false);
    expect(chase.shouldPlan(REPLAN_MS - 1, { x: 3183, y: 3442 }, goal({ x: 3183, y: 3442 }), far)).toBe(false);
    // Then sent once the interval has passed.
    expect(chase.shouldPlan(REPLAN_MS, { x: 3183, y: 3442 }, goal({ x: 3183, y: 3442 }), far)).toBe(true);
    expect(chase.plannedAt).toBe(REPLAN_MS);
    expect(chase.shouldPlan(REPLAN_MS + 2_000, { x: 3183, y: 3442 }, goal({ x: 3183, y: 3442 }), far)).toBe(false);
  });

  it("sends nothing when the route already ends next to the new destination", () => {
    const chase = new Chase();
    expect(chase.shouldPlan(0, { x: 3182, y: 3440 }, adjacentGoal(map, { x: 3182, y: 3440 }), { x: 3182, y: 3439 })).toBe(true);
    // The leader stops one tile on; the follower's route already ends beside that tile.
    const next = { x: 3183, y: 3439 };
    expect(chase.shouldPlan(5_000, next, adjacentGoal(map, next), { x: 3182, y: 3439 })).toBe(false);
    expect(chase.plannedAt).toBe(0);
  });
});
