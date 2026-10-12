import { Group } from "three";
import { describe, expect, it } from "vitest";
import type { CharacterHandle, Locomotion } from "../osrs/types";
import type { WorldFrame } from "../world/coords";
import type { Motion } from "../world/motion";
import { Actor } from "./actor";

const frame: WorldFrame = { originX: 0, originY: 0, floorHeight: 0, heights: null };

function stubHandle() {
  const calls = { offset: 0, offsets: 0, locomotion: "idle" as Locomotion };
  const handle: CharacterHandle = {
    object: new Group(),
    height: 2,
    setLocomotion: (mode) => {
      calls.locomotion = mode;
    },
    setHeadingOffset: (radians) => {
      calls.offset = radians;
      calls.offsets++;
    },
    playEmote: () => {},
    playSequence: () => {},
    update: () => {},
    setAppearance: () => {},
    dispose: () => {},
  };
  return { handle, calls };
}

/** Advances the actor in 20 ms frames from `from` to `to` (ms). */
function run(actor: Actor, from: number, to: number): void {
  for (let t = from + 20; t <= to; t += 20) actor.update(frame, t, 0.02);
}

describe("Actor heading offset", () => {
  it("is about PI right after a reversal, then settles forward as the facing catches up", () => {
    const { handle, calls } = stubHandle();
    const actor = new Actor("player", "p", "P", handle, { x: 10, y: 10 }, frame);
    const east: Motion = { path: [10, 11, 12, 13, 14, 15, 16].map((x) => ({ x, y: 10 })), startedAt: 0, run: false };
    actor.setMotion(east, frame, 0, false);
    run(actor, 0, 1_200);
    expect(calls.locomotion).toBe("walk");
    expect(calls.offset).toBeCloseTo(0, 3);
    expect(actor.yaw).toBeCloseTo(Math.PI / 2, 3);

    // Turn back west from the tile reached.
    const here = actor.currentTile();
    const west: Motion = { path: [0, 1, 2, 3, 4].map((d) => ({ x: here.x - d, y: 10 })), startedAt: 1_200, run: false };
    actor.setMotion(west, frame, 1_200, false);
    actor.update(frame, 1_220, 0.02);
    expect(Math.abs(calls.offset)).toBeGreaterThan(Math.PI - 0.2);

    // 180 degrees at 32/2048 per 20 ms takes 640 ms.
    run(actor, 1_220, 1_900);
    expect(calls.offset).toBeCloseTo(0, 3);
  });

  it("reports a sidestep while turning a corner and 0 when standing", () => {
    const { handle, calls } = stubHandle();
    const actor = new Actor("player", "p", "P", handle, { x: 10, y: 10 }, frame);
    actor.setYaw(Math.PI); // facing north
    const east: Motion = { path: [10, 11, 12].map((x) => ({ x, y: 10 })), startedAt: 0, run: false };
    actor.setMotion(east, frame, 0, false);
    actor.update(frame, 20, 0.02);
    // Facing north while moving east: movement is to the right, a negative rotation.y offset.
    expect(calls.offset).toBeLessThan(-1.2);
    expect(calls.offset).toBeGreaterThan(-Math.PI / 2 - 1e-6);
    run(actor, 20, 2_000);
    expect(calls.locomotion).toBe("idle");
    expect(calls.offset).toBe(0);
  });
});
