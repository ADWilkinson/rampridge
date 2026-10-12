/**
 * Dev harness for the asset bake (dev/bake.html). Each page renders one
 * baked output so it can be screenshotted headlessly; document.title flips
 * to READY (or ERROR) when the frame is final.
 *
 * Pages: ?page=world (default) | minimap | sprites | items | ui
 */
const hudEl = document.getElementById("hud")!;
const hud = (s: string) => {
  hudEl.textContent += s + "\n";
};

async function main() {
  const page = new URLSearchParams(location.search).get("page") ?? "world";
  if (page === "world") await (await import("./world")).runWorld(hud);
  else if (page === "minimap") await (await import("./minimap")).runMinimap(hud);
  else if (page === "sprites") await (await import("./sprites")).runSprites(hud);
  else if (page === "ui") await (await import("./ui")).runUi(hud);
  else throw new Error(`unknown page ${page}`);
  document.title = "READY";
}

main().catch((e: unknown) => {
  hud(`ERROR ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  document.title = "ERROR";
});
