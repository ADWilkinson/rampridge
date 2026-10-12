import { describe, expect, it } from "vitest";
import { ApiError } from "@/net/http";
import { RejoinNotice, isJoinRefusal } from "./session";

const FULL = "The bank is full right now. Try again in a few minutes.";
const NETWORK = "Too many players from your network are in the bank. Try again later.";
const full = () => new ApiError(429, "rate_limited", FULL, 60_000);

describe("isJoinRefusal", () => {
  it("is a 429 with a long wait: the room or network cap, or a ban", () => {
    expect(isJoinRefusal(full())).toBe(true);
    expect(isJoinRefusal(new ApiError(429, "rate_limited", NETWORK, 60_000))).toBe(true);
  });

  it("is not a throttle, a server failure or anything else", () => {
    expect(isJoinRefusal(new ApiError(429, "rate_limited", "You're doing that too quickly.", 400))).toBe(false);
    expect(isJoinRefusal(new ApiError(429, "rate_limited", "You're doing that too quickly."))).toBe(false);
    expect(isJoinRefusal(new ApiError(503, "server", "The RampRidge server is having trouble."))).toBe(false);
    expect(isJoinRefusal(new ApiError(0, "network", "Can't reach the RampRidge server."))).toBe(false);
    expect(isJoinRefusal(new Error(FULL))).toBe(false);
  });
});

describe("RejoinNotice", () => {
  const make = () => {
    const posted: string[] = [];
    const notice = new RejoinNotice((text) => posted.push(text));
    return { notice, posted };
  };

  it("posts the server's refusal once while heartbeats keep retrying", () => {
    const { notice, posted } = make();
    notice.inWorld = true;
    for (let i = 0; i < 5; i++) notice.note(full());
    expect(posted).toEqual([FULL]);
  });

  it("posts a different refusal once too", () => {
    const { notice, posted } = make();
    notice.inWorld = true;
    notice.note(full());
    notice.note(new ApiError(429, "rate_limited", NETWORK, 60_000));
    notice.note(full());
    expect(posted).toEqual([FULL, NETWORK]);
  });

  it("speaks again after the player got back in", () => {
    const { notice, posted } = make();
    notice.inWorld = true;
    notice.note(full());
    notice.reset();
    notice.note(full());
    expect(posted).toEqual([FULL, FULL]);
  });

  it("leaves a refused first entry to the title screen", () => {
    const { notice, posted } = make();
    notice.note(full());
    expect(posted).toEqual([]);
  });

  it("stays quiet for heartbeat failures that aren't refusals", () => {
    const { notice, posted } = make();
    notice.inWorld = true;
    notice.note(new ApiError(0, "network", "Can't reach the RampRidge server."));
    notice.note(new ApiError(429, "rate_limited", "You're doing that too quickly.", 300));
    expect(posted).toEqual([]);
  });
});
