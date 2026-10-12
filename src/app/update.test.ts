import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/net/http";
import { entryFromHtml, isNewBuildLive, runningEntry, updateStore, watchForUpdates } from "./update";

const built = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-DXQFb55c.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-dom-Dm__uAkl.js">
</head><body><div id="root"></div></body></html>`;

describe("entryFromHtml", () => {
  it("finds the built entry script whatever the attribute order", () => {
    expect(entryFromHtml(built)).toBe("/assets/index-DXQFb55c.js");
    expect(entryFromHtml(`<script src="/assets/index-a1.js" type="module"></script>`)).toBe("/assets/index-a1.js");
  });

  it("ignores the dev server's entry and non-module scripts", () => {
    expect(entryFromHtml(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
    expect(entryFromHtml(`<script src="/assets/legacy.js"></script>`)).toBeNull();
    expect(entryFromHtml("<html></html>")).toBeNull();
  });
});

describe("runningEntry", () => {
  it("reads the page's own module entry", () => {
    const script = { getAttribute: () => "/assets/index-DXQFb55c.js" };
    const doc = { querySelectorAll: () => [script] } as unknown as Pick<Document, "querySelectorAll">;
    expect(runningEntry(doc)).toBe("/assets/index-DXQFb55c.js");
  });
});

describe("isNewBuildLive", () => {
  it("is true only when the server's index.html loads a different entry", async () => {
    expect(await isNewBuildLive("/assets/index-old.js", () => Promise.resolve(built))).toBe(true);
    expect(await isNewBuildLive("/assets/index-DXQFb55c.js", () => Promise.resolve(built))).toBe(false);
  });

  it("reads a failed or unrecognisable answer as no update (a connection problem, not a release)", async () => {
    expect(await isNewBuildLive("/assets/index-old.js", () => Promise.reject(new Error("offline")))).toBe(false);
    expect(await isNewBuildLive("/assets/index-old.js", () => Promise.resolve("<h1>502 Bad Gateway</h1>"))).toBe(false);
  });

  it("never checks in development, where there is no built entry", async () => {
    const fetchHtml = vi.fn(() => Promise.resolve(built));
    expect(await isNewBuildLive(null, fetchHtml)).toBe(false);
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});

describe("the server's outdated answer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    updateStore.setState({ updated: false });
  });

  it("shows the reload notice, as a chunk from a replaced build does", async () => {
    const stop = watchForUpdates({ addEventListener: () => undefined });
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: false, code: "outdated", error: "RampRidge was updated. Reload the page to keep playing.", retryAfterMs: 600_000, now: 0 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(apiFetch("/act", { method: "POST" })).rejects.toMatchObject({ status: 429, code: "outdated" });
    expect(updateStore.getState().updated).toBe(true);
    stop();
  });

  it("leaves other refusals alone", async () => {
    const stop = watchForUpdates({ addEventListener: () => undefined });
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: false, code: "rate_limited", error: "The bank is full right now.", retryAfterMs: 60_000, now: 0 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(apiFetch("/act", { method: "POST" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(updateStore.getState().updated).toBe(false);
    stop();
  });
});
