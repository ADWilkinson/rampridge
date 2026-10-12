import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { devApi } from "./scripts/dev-api.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command, mode }) => {
  // The shell first, then .env files, exactly as the dev API reads them (scripts/dev-api.ts), so the page
  // and the local API always agree on the database.
  const env = { ...loadEnv(mode, ROOT, ""), ...process.env };
  return {
    // devApi serves api/*.ts from the dev server only (apply: "serve"); production uses the Vercel functions.
    // It stays off (503) unless FIREBASE_DATABASE_EMULATOR_HOST or RAMPRIDGE_DEV_LIVE_DB=1 is set.
    plugins: [react(), devApi()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      },
    },
    define: {
      global: "globalThis",
      // Dev server only: the page reads the database emulator the local API writes to (src/config.ts), so a
      // local browser never watches the live database while its writes go to the emulator.
      ...(command === "serve"
        ? {
            "import.meta.env.VITE_RTDB_EMULATOR_HOST": JSON.stringify(
              env.VITE_RTDB_EMULATOR_HOST?.trim() || env.FIREBASE_DATABASE_EMULATOR_HOST?.trim() || "",
            ),
          }
        : {}),
    },
    build: {
      target: "es2022",
      sourcemap: true,
      chunkSizeWarningLimit: 4096,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
