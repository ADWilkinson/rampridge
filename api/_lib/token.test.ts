import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { ConfigError, sessionNotBefore } from "./env";
import { SESSION_TTL_SECONDS, signSession, verifySession } from "./token";
import { TEST_SECRET } from "./testing";

const now = 1_800_000_000_000;
const claims = { pid: "abcdefghij012345", name: "Zezima", wallet: null };

describe("session tokens", () => {
  it("round-trips claims", async () => {
    const token = await signSession(claims, TEST_SECRET, now);
    expect(await verifySession(token, TEST_SECRET, now + 1_000)).toEqual(claims);
    const withWallet = { ...claims, wallet: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
    expect(await verifySession(await signSession(withWallet, TEST_SECRET, now), TEST_SECRET, now)).toEqual(withWallet);
  });

  it("expires after 30 days", async () => {
    const token = await signSession(claims, TEST_SECRET, now);
    expect(await verifySession(token, TEST_SECRET, now + (SESSION_TTL_SECONDS - 60) * 1000)).not.toBeNull();
    expect(await verifySession(token, TEST_SECRET, now + (SESSION_TTL_SECONDS + 60) * 1000)).toBeNull();
  });

  it("rejects another secret, tampering and garbage", async () => {
    const token = await signSession(claims, TEST_SECRET, now);
    const other = new TextEncoder().encode("another-secret-that-is-also-32-bytes-long!!");
    expect(await verifySession(token, other, now)).toBeNull();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), pid: "zzzzzzzzzzzzzzzz" })).toString("base64url");
    expect(await verifySession(`${header}.${forged}.${signature}`, TEST_SECRET, now)).toBeNull();
    expect(await verifySession("not-a-token", TEST_SECRET, now)).toBeNull();
  });

  it("refuses tokens issued before SESSION_NOT_BEFORE", async () => {
    const token = await signSession(claims, TEST_SECRET, now);
    const issued = Math.floor(now / 1000);
    expect(await verifySession(token, TEST_SECRET, now, null)).toEqual(claims);
    expect(await verifySession(token, TEST_SECRET, now, issued)).toEqual(claims);
    expect(await verifySession(token, TEST_SECRET, now + 5_000, issued + 1)).toBeNull();
  });

  it("reads SESSION_NOT_BEFORE as unix seconds, failing loudly when malformed", () => {
    const saved = process.env.SESSION_NOT_BEFORE;
    try {
      delete process.env.SESSION_NOT_BEFORE;
      expect(sessionNotBefore()).toBeNull();
      process.env.SESSION_NOT_BEFORE = " 1800000000 ";
      expect(sessionNotBefore()).toBe(1_800_000_000);
      process.env.SESSION_NOT_BEFORE = "1800000000000";
      expect(() => sessionNotBefore()).toThrow(ConfigError);
      process.env.SESSION_NOT_BEFORE = "yesterday";
      expect(() => sessionNotBefore()).toThrow(/SESSION_NOT_BEFORE/);
    } finally {
      if (saved === undefined) delete process.env.SESSION_NOT_BEFORE;
      else process.env.SESSION_NOT_BEFORE = saved;
    }
  });

  it("carries the player's world, and reads a world it doesn't know as none", async () => {
    const inWorld = { ...claims, world: 302 };
    expect(await verifySession(await signSession(inWorld, TEST_SECRET, now), TEST_SECRET, now)).toEqual(inWorld);
    const iat = Math.floor(now / 1000);
    const unknown = await new SignJWT({ ...claims, world: 999 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("rampridge")
      .setAudience("rampridge-world")
      .setSubject(claims.pid)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(TEST_SECRET);
    expect(await verifySession(unknown, TEST_SECRET, now)).toEqual(claims);
  });

  it("rejects well-signed tokens with the wrong shape", async () => {
    const iat = Math.floor(now / 1000);
    const bad = await new SignJWT({ pid: "short", name: "x", wallet: null })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("rampridge")
      .setAudience("rampridge-world")
      .setSubject("short")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(TEST_SECRET);
    expect(await verifySession(bad, TEST_SECRET, now)).toBeNull();
  });
});
