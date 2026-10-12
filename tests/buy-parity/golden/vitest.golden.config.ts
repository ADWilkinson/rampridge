import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Runs the golden fulfilment replays on their own (no shared parity fork):
 *
 *   export FORK_UPSTREAM_RPC_URL=...   # an archive-capable Base mainnet RPC; never printed
 *   bunx vitest run -c tests/buy-parity/golden/vitest.golden.config.ts
 *
 * The suite starts its own read-only upstream proxy (GOLDEN_PROXY_PORT, 8554)
 * and anvil (GOLDEN_FORK_PORT, 8553) and stops both when it ends. It also
 * runs under the shared vitest.parity.config.ts.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../../src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../../../shared", import.meta.url)),
    },
  },
  test: {
    include: ["tests/buy-parity/golden/**/*.parity.test.ts"],
    environment: "node",
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 600_000,
    teardownTimeout: 30_000,
  },
});
