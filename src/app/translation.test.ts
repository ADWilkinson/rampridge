import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

describe("browser translation", () => {
  // Chrome's translator replaces the text nodes React renders with <font> wrappers; React then throws
  // "Failed to execute 'removeChild'" the first time it removes one (the payment scroll's rules tick)
  // and the whole interface unmounts. The page opts out until it has its own translations.
  it("is switched off for the page", () => {
    expect(html).toMatch(/<html\b[^>]*\btranslate="no"/);
    expect(html).toMatch(/<meta\s+name="google"\s+content="notranslate"/);
  });
});
