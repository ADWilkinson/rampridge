import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Full-UI buy on a Base fork (tests/buy-parity/fork-ui-e2e). The driver spawns
 * anvil (ports 8550-8559), a Vite dev server for dev/buy-e2e.html (ports
 * 5290-5299) and headless Chrome, so files and tests run one at a time.
 *
 *   bunx vitest run --config dev/buy-e2e/vitest.e2e.config.ts
 */
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../../shared", import.meta.url)),
    },
  },
  test: {
    include: ["tests/buy-parity/fork-ui-e2e/**/*.e2e.ts"],
    environment: "node",
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 900_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    reporters: ["verbose"],
  },
});
