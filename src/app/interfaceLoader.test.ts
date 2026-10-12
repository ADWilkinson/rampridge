import { describe, expect, it, vi } from "vitest";
import { cacheBusted, createInterfaceLoader, failedModuleUrl, type LoadedModule } from "./interfaceLoader";

const Bank = () => null;
const Exchange = () => null;
const useBuyOrderEvents = () => undefined;

const quiet = { error: vi.fn(), warn: vi.fn() };

describe("createInterfaceLoader", () => {
  it("registers every module that loads and records the ones that fail", async () => {
    const loader = createInterfaceLoader(
      {
        "/src/ui/interfaces/bank/index.ts": () => Promise.resolve({ interfaces: { bank: Bank } } as LoadedModule),
        "/src/ui/interfaces/buy/index.ts": () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
      },
      ["useBuyOrderEvents"],
      { log: quiet },
    );
    const snapshot = await loader.load();
    expect(Object.keys(snapshot.components)).toEqual(["bank"]);
    expect(snapshot.failed).toEqual(["/src/ui/interfaces/buy/index.ts"]);
  });

  it("retries only the failed module on the next load and then registers it", async () => {
    const bank = vi.fn(() => Promise.resolve({ interfaces: { bank: Bank } } as LoadedModule));
    let buyAttempts = 0;
    const buy = vi.fn(() => {
      buyAttempts += 1;
      return buyAttempts === 1
        ? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
        : Promise.resolve({ interfaces: { exchange: Exchange }, useBuyOrderEvents, chatboxInterfaces: [] } as unknown as LoadedModule);
    });
    const loader = createInterfaceLoader({ "/a/bank/index.ts": bank, "/a/buy/index.ts": buy }, ["useBuyOrderEvents"], { log: quiet });

    await loader.load();
    const second = await loader.load();
    expect(bank).toHaveBeenCalledTimes(1);
    expect(buy).toHaveBeenCalledTimes(2);
    expect(Object.keys(second.components).sort()).toEqual(["bank", "exchange"]);
    expect(second.failed).toEqual([]);
    expect(second.worldHooks.map((h) => h.name)).toEqual(["useBuyOrderEvents"]);

    // Everything is in: further loads fetch nothing.
    await loader.load();
    expect(bank).toHaveBeenCalledTimes(1);
    expect(buy).toHaveBeenCalledTimes(2);
  });

  it("shares one attempt between concurrent loads", async () => {
    const load = vi.fn(() => Promise.resolve({ interfaces: { bank: Bank } } as LoadedModule));
    const loader = createInterfaceLoader({ "/a/bank/index.ts": load }, [], { log: quiet });
    await Promise.all([loader.load(), loader.load(), loader.load()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the first registration of an id, in path order, across retries", async () => {
    const First = () => null;
    const Second = () => null;
    let flaky = 0;
    const loader = createInterfaceLoader(
      {
        "/a/zeta/index.ts": () => Promise.resolve({ interfaces: { bank: Second } } as LoadedModule),
        "/a/alpha/index.ts": () => {
          flaky += 1;
          return flaky === 1 ? Promise.reject(new Error("offline")) : Promise.resolve({ interfaces: { bank: First } } as LoadedModule);
        },
      },
      [],
      { log: quiet },
    );
    expect((await loader.load()).components.bank).toBe(Second);
    expect((await loader.load()).components.bank).toBe(First);
  });

  it("re-imports a chunk the browser remembers as failed under a fresh URL, keeping the original URL", async () => {
    const chunk = "https://www.rampridge.xyz/assets/index-B1x2.js";
    const viaLoader = vi.fn(() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${chunk}`)));
    const urls: string[] = [];
    let clock = 1000;
    const importUrl = vi.fn((url: string) => {
      urls.push(url);
      return urls.length === 1
        ? Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`))
        : Promise.resolve({ interfaces: { exchange: Exchange } } as LoadedModule);
    });
    const loader = createInterfaceLoader({ "/a/buy/index.ts": viaLoader }, [], { log: quiet, importUrl, now: () => clock++ });

    expect((await loader.load()).attempts).toBe(1);
    const second = await loader.load();
    expect(second.failed).toEqual(["/a/buy/index.ts"]);
    expect(second.attempts).toBe(2);
    const third = await loader.load();
    expect(third.failed).toEqual([]);
    expect(third.attempts).toBe(0);
    expect(Object.keys(third.components)).toEqual(["exchange"]);
    expect(viaLoader).toHaveBeenCalledTimes(1);
    expect(urls).toEqual([`${chunk}?retry=1000`, `${chunk}?retry=1001`]);
  });

  it("loads only the modules asked for, and reads complete once every module has been tried", async () => {
    const bank = vi.fn(() => Promise.resolve({ interfaces: { bank: Bank } } as LoadedModule));
    const buy = vi.fn(() => Promise.resolve({ interfaces: { exchange: Exchange } } as LoadedModule));
    const loader = createInterfaceLoader({ "/a/bank/index.ts": bank, "/a/buy/index.ts": buy }, [], { log: quiet });
    expect(loader.paths).toEqual(["/a/bank/index.ts", "/a/buy/index.ts"]);

    const first = await loader.load(["/a/buy/index.ts", "/a/unknown/index.ts"]);
    expect(Object.keys(first.components)).toEqual(["exchange"]);
    expect(first.complete).toBe(false);
    expect(bank).not.toHaveBeenCalled();

    const all = await loader.load();
    expect(Object.keys(all.components).sort()).toEqual(["bank", "exchange"]);
    expect(all.complete).toBe(true);
    expect(buy).toHaveBeenCalledTimes(1);
  });

  it("counts a module that failed as tried, and shares an attempt between a subset and a full load", async () => {
    let release: (mod: LoadedModule) => void = () => undefined;
    const bank = vi.fn(() => Promise.reject(new TypeError("Importing a module script failed.")));
    const buy = vi.fn(() => new Promise<LoadedModule>((resolve) => (release = resolve)));
    const loader = createInterfaceLoader({ "/a/bank/index.ts": bank, "/a/buy/index.ts": buy }, [], { log: quiet });

    const subset = loader.load(["/a/buy/index.ts"]);
    const full = loader.load();
    release({ interfaces: { exchange: Exchange } } as LoadedModule);
    const [one, both] = await Promise.all([subset, full]);
    expect(buy).toHaveBeenCalledTimes(1);
    expect(one.components.exchange).toBe(Exchange);
    expect(both.failed).toEqual(["/a/bank/index.ts"]);
    expect(both.complete).toBe(true);
  });

  it("calls the module's loader again when the error names no URL", async () => {
    let calls = 0;
    const load = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new TypeError("Importing a module script failed.")) : Promise.resolve({ interfaces: { bank: Bank } } as LoadedModule);
    });
    const importUrl = vi.fn(() => Promise.reject(new Error("unused")));
    const loader = createInterfaceLoader({ "/a/bank/index.ts": load }, [], { log: quiet, importUrl });
    await loader.load();
    expect(Object.keys((await loader.load()).components)).toEqual(["bank"]);
    expect(importUrl).not.toHaveBeenCalled();
  });
});

describe("failedModuleUrl", () => {
  it("reads the chunk URL from Chrome's and Firefox's messages", () => {
    expect(failedModuleUrl(new TypeError("Failed to fetch dynamically imported module: https://x.test/assets/a-1.js"))).toBe("https://x.test/assets/a-1.js");
    expect(failedModuleUrl(new TypeError("error loading dynamically imported module: https://x.test/assets/a-1.js."))).toBe("https://x.test/assets/a-1.js");
    expect(failedModuleUrl(new TypeError("Importing a module script failed."))).toBeNull();
    expect(failedModuleUrl("nope")).toBeNull();
  });

  it("adds a query the browser hasn't seen", () => {
    expect(cacheBusted("https://x.test/a.js", 5)).toBe("https://x.test/a.js?retry=5");
    expect(cacheBusted("http://localhost:5173/src/a.ts?t=1", 5)).toBe("http://localhost:5173/src/a.ts?t=1&retry=5");
  });
});
