/**
 * Contact sheet of public/game/sprites/manifest.json: every sprite at 2x
 * (pixelated) with its name and size, on the interface backing colour.
 * Query: filter=<substring>, scale=<n>.
 */
interface Entry {
  file: string;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  id: number;
  frame: number;
}

export async function runSprites(hud: (s: string) => void): Promise<void> {
  const q = new URLSearchParams(location.search);
  const filter = q.get("filter") ?? "";
  const scale = Number(q.get("scale") ?? 2);
  const manifest = (await fetch("/game/sprites/manifest.json").then((r) => r.json())) as Record<string, Entry>;
  document.body.style.overflow = "auto";
  document.body.style.background = "#3e3529";
  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:28px 6px 6px;align-items:flex-end";
  document.body.appendChild(grid);
  const names = Object.keys(manifest).filter((n) => n.includes(filter));
  await Promise.all(
    names.map(async (name) => {
      const e = manifest[name]!;
      const cell = document.createElement("div");
      cell.style.cssText = "display:flex;flex-direction:column;align-items:center;font:11px monospace;color:#ff981f;max-width:220px";
      const img = new Image();
      img.src = `/game/sprites/${e.file}`;
      await img.decode();
      img.style.cssText = `image-rendering:pixelated;width:${Math.min(e.w * scale, 220)}px;outline:1px dashed #0006`;
      const label = document.createElement("div");
      label.textContent = `${name} ${e.w}x${e.h}`;
      label.style.cssText = "word-break:break-all;text-align:center";
      cell.append(img, label);
      grid.appendChild(cell);
    }),
  );
  hud(`${names.length} sprites`);
}
