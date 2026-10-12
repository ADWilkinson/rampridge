import { describe, expect, it } from "vitest";

import { createPose, mixPose, TRANSFORM_ROTATE, TRANSFORM_TRANSLATE } from "./animation";
import type { OsrsCharacter } from "./character";
import { OsrsCharacterFactory, provideActors } from "./factory";
import { EMOTE_SEQUENCES, PLAYER_ANIMS } from "./sequences";
import { loadBakedActors } from "./testing";
import { Track } from "./track";

// The baked actors.bin is not committed (it is Jagex's data): the tests that animate the real
// models skip until `bun run setup:assets` has baked it.
const baked = await loadBakedActors();
const loaded = baked ? provideActors(baked) : null!;
const factory = new OsrsCharacterFactory({ sequenceBlendMs: 0 });
if (baked) factory.attach(loaded);

/** Which sequence is driving the model right now. */
function shownSequence(c: OsrsCharacter): number {
  const internals = c as unknown as { actionTrack: Track | null; movementTrack: Track | null };
  return (internals.actionTrack ?? internals.movementTrack)!.clip.id;
}

describe.skipIf(!baked)("Track timing", () => {
  it("loops locomotion and ends one-shot emotes after their frames", () => {
    const walk = new Track(loaded.clips.get(PLAYER_ANIMS.walk)!, true);
    walk.advance(960 * 3 + 10);
    expect(walk.finished).toBe(false);
    expect(walk.frame).toBe(0);

    const wave = loaded.clips.get(EMOTE_SEQUENCES.wave)!;
    const total = Array.from(wave.durations).reduce((a, b) => a + b, 0);
    expect(total).toBe(1760);
    const t = new Track(wave, false);
    t.advance(total - 1);
    expect(t.finished).toBe(false);
    t.advance(2);
    expect(t.finished).toBe(true);
  });
});

describe("pose interpolation", () => {
  it("takes the short way round for rotations and lerps offsets", () => {
    const types = new Uint8Array([TRANSFORM_ROTATE, TRANSFORM_TRANSLATE]);
    const a = createPose(0, 2);
    const b = createPose(0, 2);
    a.present.set([1, 1]);
    b.present.set([1, 0]);
    a.x[0] = 250;
    b.x[0] = 6;
    a.y[1] = 10;
    const out = createPose(0, 2);
    mixPose(out, a, b, 0.5, types);
    expect(out.x[0]).toBeCloseTo(256);
    expect(out.y[1]).toBeCloseTo(5);
    expect(out.present[1]).toBe(1);
  });
});

describe.skipIf(!baked)("OsrsCharacter", () => {
  const player = () => factory.createPlayer(factory.randomAppearance("test")) as OsrsCharacter;

  it("stands on the tile centre with a human height", () => {
    const c = player();
    expect(c.height).toBeGreaterThan(1.2);
    expect(c.height).toBeLessThan(2);
    expect(c.object.children).toHaveLength(1);
  });

  it("picks idle, walk, run, turn and the strafe walks from the heading", () => {
    const c = player();
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.idle);
    c.setLocomotion("walk");
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walk);
    c.setHeadingOffset(Math.PI / 2);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walkLeft);
    c.setHeadingOffset(-Math.PI / 2);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walkRight);
    c.setHeadingOffset(Math.PI);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walkBack);
    c.setLocomotion("run");
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walkBack);
    c.setHeadingOffset(0.1);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.run);
    c.setLocomotion("turn");
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.turn);
  });

  it("plays an emote once, then returns to locomotion; moving cancels it", () => {
    const c = player();
    c.playEmote("cheer");
    expect(shownSequence(c)).toBe(EMOTE_SEQUENCES.cheer);
    c.update(1);
    expect(shownSequence(c)).toBe(EMOTE_SEQUENCES.cheer);
    c.update(1.5);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.idle);

    c.playEmote("dance");
    c.setLocomotion("walk");
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walk);
    // An emote requested mid-walk never shows (held, then cancelled by the next step).
    c.playEmote("wave");
    c.update(0.1);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.walk);
    c.setLocomotion("idle");
    c.update(0.1);
    expect(shownSequence(c)).toBe(PLAYER_ANIMS.idle);
  });

  it("holds a precedence-1 sequence while moving when it cannot be cancelled", () => {
    const c = player();
    const internals = c as unknown as { actionTrack: Track | null };
    c.playEmote("cheer");
    c.update(0.5);
    const frame = internals.actionTrack!.frame;
    // A sequence that survives movement (priority 0) but pauses while moving (precedenceAnimating 1).
    const held = new Track({ ...internals.actionTrack!.clip, priority: 0 }, false);
    held.frame = frame;
    internals.actionTrack = held;
    c.setLocomotion("walk");
    c.update(0.5);
    expect(internals.actionTrack).toBe(held);
    expect(held.frame).toBe(frame);
    c.setLocomotion("idle");
    c.update(0.5);
    expect(held.frame).toBeGreaterThan(frame);
  });

  it("moves vertices when animating and keeps them finite", () => {
    const c = player();
    const mesh = c.object.children[0] as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
    const before = Float32Array.from(mesh.geometry.attributes.position.array);
    c.playEmote("jump");
    c.update(0.3);
    const after = mesh.geometry.attributes.position.array;
    let moved = 0;
    for (let i = 0; i < after.length; i++) {
      expect(Number.isFinite(after[i])).toBe(true);
      if (Math.abs(after[i]! - before[i]!) > 1e-3) moved++;
    }
    expect(moved).toBeGreaterThan(after.length / 4);
  });

  it("rebuilds the model for a new appearance and survives bad remote data", () => {
    const c = player();
    c.setAppearance({ body: 1, kits: [3, 4, 5, 2, 1, 6, 1], colors: [10, 4, 7, 2, 5] });
    c.update(0.1);
    // Out-of-range indices are clamped instead of throwing.
    c.setAppearance({ body: 0, kits: [999, -4, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 99] });
    c.update(0.1);
    expect(c.height).toBeGreaterThan(1);
    c.dispose();
  });

  it("creates the bankers with their cache scale", () => {
    for (const id of [2897, 2898, 8666]) {
      const npc = factory.createNpc(id);
      npc.update(0.5);
      expect(npc.height).toBeGreaterThan(1.2);
    }
    expect(() => factory.createNpc(1)).toThrow(/not in the actor bake/);
    expect(factory.npcName(2897)).toBe("Banker");
  });
});
