import { mkdirSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { e2eServer } from "./server/plugin.ts";

/**
 * Dev server for the fork e2e harness (dev/buy-e2e.html). Started by
 * tests/buy-parity/fork-ui-e2e with VITE_BASE_RPC_URL pointing at the local
 * anvil fork and E2E_WITNESS_KEY set; never used for builds or deploys.
 *
 *   E2E_VITE_PORT=5290 VITE_BASE_RPC_URL=http://127.0.0.1:8550 E2E_WITNESS_KEY=0x... \
 *     bunx vite --config dev/buy-e2e/vite.config.ts
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
// E2E_SRC_DIR swaps in another copy of src/ (e.g. one with proposed fixes applied) without touching the repo.
const srcDir = process.env.E2E_SRC_DIR ?? fileURLToPath(new URL("../../src", import.meta.url));
const port = Number(process.env.E2E_VITE_PORT ?? "5290");
if (!(port >= 5290 && port <= 5299)) throw new Error("E2E_VITE_PORT must be 5290-5299");
// No .env files: the fork RPC must come from the driver's environment, never a stray VITE_BASE_RPC_URL.
const envDir = fileURLToPath(new URL("../../node_modules/.buy-e2e-env", import.meta.url));
mkdirSync(envDir, { recursive: true });

export default defineConfig({
  root,
  envDir,
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite-buy-e2e", import.meta.url)),
  plugins: [react(), e2eServer()],
  resolve: {
    alias: {
      "@": srcDir,
      "@shared": fileURLToPath(new URL("../../shared", import.meta.url)),
    },
  },
  define: { global: "globalThis" },
  server: {
    port,
    strictPort: true,
    host: "127.0.0.1",
    // Another workflow edits src/ while this runs: never hot-reload a page mid-scenario.
    hmr: false,
    watch: { ignored: ["**/*"] },
    fs: { allow: [root, srcDir] },
  },
  optimizeDeps: {
    entries: ["dev/buy-e2e.html"],
  },
});
