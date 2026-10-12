import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Buy-path signal parity suites (tests/buy-parity/signal): RampRidge's buy code against
 * Peer's real Base contracts on a local anvil fork at the latest block, real
 * Curator quotes and /v3/sign signatures, and real Peer web app transactions
 * read from Base mainnet. Not part of `bun run test`: needs the network.
 *
 *   export FORK_UPSTREAM_RPC_URL=...   # an archive-capable Base mainnet RPC; never printed
 *   bunx vitest run -c vitest.parity.config.ts      # or: bun run test:parity
 *
 * The global setup starts a read-only JSON-RPC proxy to that RPC on
 * PARITY_UPSTREAM_PORT (8559) that holds the URL and refuses every send
 * method, and anvil on PARITY_FORK_PORT (8558) forking through that proxy
 * (no --auto-impersonate). Both stop when the run ends. Nothing is ever sent
 * to Base mainnet; every transaction lands on the fork only.
 */
const FORK_PORT = process.env.PARITY_FORK_PORT ?? "8558";
/**
 * Optional: run the suites against another copy of the app source, e.g. the
 * committed revision production serves instead of the working tree:
 *   git archive HEAD src shared | tar -x -C tests/buy-parity/.src-head
 *   PARITY_SRC_DIR=tests/buy-parity/.src-head bunx vitest run -c vitest.parity.config.ts
 * (the copy must sit inside the repo so its imports resolve node_modules).
 */
const SRC_DIR = process.env.PARITY_SRC_DIR
  ? fileURLToPath(new URL(`./${process.env.PARITY_SRC_DIR.replace(/^\.\//, "")}/`, import.meta.url))
  : fileURLToPath(new URL("./", import.meta.url));
const UPSTREAM_PORT = process.env.PARITY_UPSTREAM_PORT ?? "8559";

export default defineConfig({
  resolve: {
    alias: {
      "@": `${SRC_DIR}src`,
      "@shared": `${SRC_DIR}shared`,
    },
  },
  test: {
    include: ["tests/buy-parity/signal/**/*.parity.test.ts"],
    environment: "node",
    globalSetup: ["tests/buy-parity/setup/global.ts"],
    env: {
      // The app's own clients (src/config BASE_RPC_URL) read and write the fork.
      VITE_BASE_RPC_URL: `http://127.0.0.1:${FORK_PORT}`,
      PARITY_FORK_RPC_URL: `http://127.0.0.1:${FORK_PORT}`,
      // Base mainnet reads (real Peer web transactions) go through the read-only proxy.
      PARITY_MAINNET_RPC_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      PARITY_FORK_PORT: FORK_PORT,
      PARITY_UPSTREAM_PORT: UPSTREAM_PORT,
    },
    // One fork, mutated by every suite: files and tests run one at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 600_000,
    teardownTimeout: 30_000,
  },
});
