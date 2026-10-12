import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Money-path tests against Peer's real Base contracts on a local anvil fork.
 * See tests/fork/README.md. The app's modules read `VITE_BASE_RPC_URL`, so
 * pointing it at the fork routes every chain read and write there; Curator
 * (quotes, /v3/sign) stays the real production API.
 */
const FORK_PORT = process.env.FORK_PORT ?? "8547";
const FORK_RPC_URL = process.env.FORK_RPC_URL ?? `http://127.0.0.1:${FORK_PORT}`;

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    include: ["tests/fork/**/*.fork.test.ts"],
    environment: "node",
    globalSetup: ["tests/fork/setup/global.ts"],
    env: { VITE_BASE_RPC_URL: FORK_RPC_URL, FORK_RPC_URL },
    // One fork, mutated by every suite: files and tests run one at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 30_000,
  },
});
