import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The USDC send against Base's real USDC and ERC-4337 EntryPoint on a local
 * anvil fork (tests/send-fork/README.md). Not part of `bun run test`.
 */
const PORT = process.env.SEND_FORK_PORT ?? "8560";
const FORK_RPC_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../../shared", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["tests/send-fork/**/*.fork.test.ts"],
    environment: "node",
    globalSetup: ["tests/send-fork/global-setup.ts"],
    // Every chain read in the app's modules goes to the fork, never to mainnet.
    env: { VITE_BASE_RPC_URL: FORK_RPC_URL, SEND_FORK_RPC_URL: FORK_RPC_URL },
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
