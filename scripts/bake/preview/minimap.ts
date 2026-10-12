/**
 * Minimap preview: the fixed-mode OSRS minimap assembled from the baked
 * assets exactly as interface 548 lays it out (cover at 0,0; map mask at
 * 25,5; compass mask at 0,0), with the map rotated by the camera yaw around
 * the player, map-function icons drawn unrotated, and NPC/player dots.
 * Query: x, y (player tile), yaw (degrees, 0 = north up), scale.
 */
interface SpriteEntry {
  file: string;
  w: number;
  h: number;
}
interface MinimapMeta {
  image: string;
  pixelsPerTile: number;
  minX: number;
  maxY: number;
  icons: { file: string; w: number; h: number; tile: { x: number; y: number } }[];
}
interface Meta {
  spawn: { x: number; y: number }[];
  bankers: { tile: { x: number; y: number } }[];
  merchantArea: { x: number; y: number }[];
}

const load = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });

export async function runMinimap(hud: (s: string) => void): Promise<void> {
  const q = new URLSearchParams(location.search);
  const [sprites, mm, meta] = await Promise.all([
    fetch("/game/sprites/manifest.json").then((r) => r.json() as Promise<Record<string, SpriteEntry>>),
    fetch("/game/world/minimap.json").then((r) => r.json() as Promise<MinimapMeta>),
    fetch("/shared/world-meta.json").then((r) => r.json() as Promise<Meta>),
  ]);
  const sprite = (name: string) => load(`/game/sprites/${sprites[name]!.file}`);
  const [map, cover, mask, compass, compassMask, dotPlayer, dotNpc, background] = await Promise.all([
    load(`/game/world/${mm.image}`),
    sprite("minimap_frame"),
    sprite("minimap_mask"),
    sprite("compass"),
    sprite("compass_mask"),
    sprite("mapdot_player"),
    sprite("mapdot_npc"),
    sprite("minimap_background"),
  ]);
  const icons = await Promise.all(mm.icons.map((i) => load(`/game/world/${i.file}`)));

  const player = { x: Number(q.get("x") ?? meta.spawn[0]!.x) + 0.5, y: Number(q.get("y") ?? meta.spawn[0]!.y) + 0.5 };
  const yaw = (Number(q.get("yaw") ?? 0) * Math.PI) / 180;
  const scale = Number(q.get("scale") ?? 3);
  const ppt = mm.pixelsPerTile;
  const toMap = (fx: number, fy: number) => ({ px: (fx - mm.minX) * ppt, py: (mm.maxY + 1 - fy) * ppt });

  // ---- the 172x156 fixed minimap ----------------------------------------
  const W = 172, H = 156;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(background, 0, 0);

  const view = document.createElement("canvas");
  view.width = mask.width;
  view.height = mask.height;
  const v = view.getContext("2d")!;
  v.imageSmoothingEnabled = false;
  v.fillStyle = "#000";
  v.fillRect(0, 0, view.width, view.height);
  const cx = view.width / 2, cy = view.height / 2;
  const p = toMap(player.x, player.y);
  // Rotate world points around the player by the camera yaw.
  const rot = (fx: number, fy: number) => {
    const m = toMap(fx, fy);
    const dx = m.px - p.px, dy = m.py - p.py;
    return { x: cx + dx * Math.cos(yaw) - dy * Math.sin(yaw), y: cy + dx * Math.sin(yaw) + dy * Math.cos(yaw) };
  };
  v.save();
  v.translate(cx, cy);
  v.rotate(yaw);
  v.drawImage(map, -p.px, -p.py);
  v.restore();
  mm.icons.forEach((icon, i) => {
    const c = rot(icon.tile.x + 0.5, icon.tile.y + 0.5);
    v.drawImage(icons[i]!, Math.round(c.x - icon.w / 2), Math.round(c.y - icon.h / 2));
  });
  const dot = (img: HTMLImageElement, fx: number, fy: number) => {
    const c = rot(fx, fy);
    v.drawImage(img, Math.round(c.x - 2), Math.round(c.y - 2));
  };
  for (const b of meta.bankers) dot(dotNpc, b.tile.x + 0.5, b.tile.y + 0.5);
  for (const t of meta.merchantArea.filter((_, i) => i % 7 === 0)) dot(dotNpc, t.x + 0.5, t.y + 0.5);
  for (const s of meta.spawn.slice(1, 3)) dot(dotPlayer, s.x + 0.5, s.y + 0.5);
  // the local player is the white square at the centre, as in the client
  v.fillStyle = "#fff";
  v.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 3, 3);
  v.globalCompositeOperation = "destination-out";
  v.drawImage(mask, 0, 0);
  ctx.drawImage(view, 25, 5);

  // compass: rotated with the camera, clipped by its mask
  const comp = document.createElement("canvas");
  comp.width = compassMask.width;
  comp.height = compassMask.height;
  const c2 = comp.getContext("2d")!;
  c2.translate(comp.width / 2, comp.height / 2);
  c2.rotate(yaw);
  c2.drawImage(compass, -compass.width / 2, -compass.height / 2);
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.globalCompositeOperation = "destination-out";
  c2.drawImage(compassMask, 0, 0);
  ctx.drawImage(comp, 0, 0);
  ctx.drawImage(cover, 0, 0);

  canvas.style.cssText = `width:${W * scale}px;image-rendering:pixelated;position:absolute;left:16px;top:32px`;
  document.body.appendChild(canvas);

  // ---- the raw baked image for reference --------------------------------
  const raw = document.createElement("canvas");
  raw.width = map.width;
  raw.height = map.height;
  const r = raw.getContext("2d")!;
  r.drawImage(map, 0, 0);
  mm.icons.forEach((icon, i) => {
    const m = toMap(icon.tile.x + 0.5, icon.tile.y + 0.5);
    r.drawImage(icons[i]!, Math.round(m.px - icon.w / 2), Math.round(m.py - icon.h / 2));
  });
  r.fillStyle = "#fff";
  r.fillRect(Math.round(p.px) - 1, Math.round(p.py) - 1, 3, 3);
  raw.style.cssText = `height:${H * scale}px;image-rendering:pixelated;position:absolute;left:${W * scale + 48}px;top:32px`;
  document.body.appendChild(raw);
  hud(`minimap player=${player.x - 0.5},${player.y - 0.5} yaw=${q.get("yaw") ?? 0} | right: baked minimap.png with icons`);
}
