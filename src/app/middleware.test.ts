import { describe, expect, it } from "vitest";
import middleware, { config, isDocumentRequest, skewCookie } from "../../middleware";

const ENABLED = { VERCEL_SKEW_PROTECTION_ENABLED: "1", VERCEL_DEPLOYMENT_ID: "dpl_7hQx2Yb9" };

function request(headers: Record<string, string>, method = "GET"): Request {
  return new Request("https://www.rampridge.xyz/", { method, headers });
}

describe("skewCookie (the root middleware.ts)", () => {
  it("pins a page load's build chunks to the deployment that served it", () => {
    expect(skewCookie(request({ "sec-fetch-dest": "document" }), ENABLED)).toBe("__vdpl=dpl_7hQx2Yb9; Path=/assets; HttpOnly; Secure; SameSite=Lax");
  });

  it("scopes the pin to /assets so reloads, API calls and game files reach the latest release", () => {
    expect(skewCookie(request({ "sec-fetch-dest": "document" }), ENABLED)).toContain("Path=/assets;");
  });

  it("leaves fetches, subresources and non-GET requests alone", () => {
    expect(skewCookie(request({ "sec-fetch-dest": "empty", accept: "text/html" }), ENABLED)).toBeNull();
    expect(skewCookie(request({ "sec-fetch-dest": "image" }), ENABLED)).toBeNull();
    expect(skewCookie(request({ "sec-fetch-dest": "document" }, "POST"), ENABLED)).toBeNull();
  });

  it("recognises a navigation from a browser without Fetch Metadata by its Accept header", () => {
    expect(isDocumentRequest(request({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isDocumentRequest(request({ accept: "*/*" }))).toBe(false);
  });

  it("does nothing unless Skew Protection is on and the deployment id is sane", () => {
    const doc = request({ "sec-fetch-dest": "document" });
    expect(skewCookie(doc, {})).toBeNull();
    expect(skewCookie(doc, { ...ENABLED, VERCEL_SKEW_PROTECTION_ENABLED: "0" })).toBeNull();
    expect(skewCookie(doc, { ...ENABLED, VERCEL_DEPLOYMENT_ID: "dpl; Path=/" })).toBeNull();
  });
});

describe("middleware", () => {
  it("only runs on page paths, never on the API, build output or game files", () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/terms")).toBe(true);
    expect(pattern.test("/api/act")).toBe(false);
    expect(pattern.test("/assets/index-abc.js")).toBe(false);
    expect(pattern.test("/game/world/varrock-west-bank.glb")).toBe(false);
  });

  it("continues the request untouched when there is nothing to pin (Skew Protection off in tests)", () => {
    expect(middleware(request({ "sec-fetch-dest": "document" }))).toBeUndefined();
  });
});
