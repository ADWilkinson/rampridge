import { describe, expect, it } from "vitest";
import { isReferrerClass, referrerClass, REFERRER_CLASSES } from "./referrer";

const HOST = "www.rampridge.xyz";
const classify = (referrer: string, search = "") => referrerClass({ referrer, search, host: HOST });

describe("referrerClass", () => {
  it("reads a visit with no referrer and no campaign as direct", () => {
    expect(classify("")).toBe("direct");
  });

  it("classifies the referring host", () => {
    expect(classify("https://t.co/")).toBe("x");
    expect(classify("https://x.com/andrewwilkinson/status/1")).toBe("x");
    expect(classify("https://mobile.twitter.com/")).toBe("x");
    expect(classify("https://github.com/ADWilkinson/rampridge")).toBe("github");
    expect(classify("https://docs.peer.xyz/ecosystem")).toBe("peer");
    expect(classify("https://www.reddit.com/r/threejs/")).toBe("reddit");
    expect(classify("https://out.reddit.com/")).toBe("reddit");
    expect(classify("https://www.google.co.uk/")).toBe("search");
    expect(classify("https://www.bing.com/")).toBe("search");
    expect(classify("https://duckduckgo.com/")).toBe("search");
    expect(classify("https://search.brave.com/")).toBe("search");
    expect(classify("https://chatgpt.com/")).toBe("ai");
    expect(classify("https://gemini.google.com/")).toBe("ai");
    expect(classify("https://discourse.threejs.org/c/showcase/7")).toBe("threejs");
    expect(classify("https://javascriptweekly.com/issues/760")).toBe("newsletter");
    expect(classify("https://changelog.com/news/1")).toBe("newsletter");
    expect(classify("https://t.me/")).toBe("chat");
    expect(classify("https://andrewwilkinson.io/")).toBe("portfolio");
    expect(classify("https://www.galleonlabs.io/")).toBe("portfolio");
    expect(classify("https://example.org/")).toBe("other");
  });

  it("does not mistake a lookalike host for a known one", () => {
    expect(classify("https://notgithub.com/")).toBe("other");
    expect(classify("https://peer.xyz.example.org/")).toBe("other");
  });

  it("prefers the campaign source over the referrer", () => {
    expect(classify("https://t.co/", "?utm_source=github")).toBe("github");
    expect(classify("", "?utm_source=X&utm_medium=social")).toBe("x");
    expect(classify("", "?utm_source=peer_zh")).toBe("peer");
    expect(classify("", "?utm_source=threejs-forum")).toBe("threejs");
    expect(classify("", "?utm_source=javascriptweekly")).toBe("newsletter");
    expect(classify("", "?utm_source=graphics-programming-weekly")).toBe("newsletter");
    expect(classify("", "?utm_source=andrewwilkinson")).toBe("portfolio");
    expect(classify("", "?utm_source=news.ycombinator.com")).toBe("other");
    expect(classify("", "?utm_source=")).toBe("direct");
  });

  it("counts a shared trade link as share, whatever else it carries", () => {
    expect(classify("https://t.co/", "?from=share&world=302")).toBe("share");
    expect(classify("https://www.rampridge.xyz/t/abc123", "")).toBe("share");
  });

  it("counts the site's own pages as internal", () => {
    expect(classify("https://www.rampridge.xyz/terms")).toBe("internal");
  });

  it("survives a referrer that is not a URL", () => {
    expect(classify("not a url")).toBe("other");
  });

  it("only ever answers a listed class", () => {
    for (const referrer of ["", "https://t.co/", "junk", "https://www.rampridge.xyz/"]) {
      expect(isReferrerClass(classify(referrer))).toBe(true);
    }
    expect(isReferrerClass("hn")).toBe(false);
    expect(new Set(REFERRER_CLASSES).size).toBe(REFERRER_CLASSES.length);
  });
});
