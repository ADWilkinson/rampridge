import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// public/game is decoded from the Old School RuneScape cache and is not in git (the assets are Jagex's).
if (!existsSync(fileURLToPath(new URL("./public/game/actors/actors.bin", import.meta.url)))) {
  console.log("public/game is not baked: tests that need the game assets are skipped. `bun run setup:assets` bakes them from the public OSRS cache.");
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "shared/**/*.test.ts", "api/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "scripts/bake/vendor/**"],
    environment: "node",
  },
});
