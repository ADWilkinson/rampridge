import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from "three";
import { BLOCKED, type CollisionMap, Flag } from "../world/collision";
import type { WorldFrame } from "../world/coords";

/**
 * ?debug=1 overlay of the collision grid: tile lines, blocked tiles in red
 * and walls in cyan, drawn just above the floor.
 */
export function buildDebugGrid(map: CollisionMap, frame: WorldFrame): { group: Group; dispose(): void } {
  const bounds = map.getBounds();
  const y = frame.floorHeight + 0.02;
  const sx = (tx: number) => tx - frame.originX;
  const sz = (ty: number) => -(ty - frame.originY);

  const grid: number[] = [];
  for (let x = bounds.minX; x <= bounds.maxX + 1; x++) grid.push(sx(x), y, sz(bounds.minY), sx(x), y, sz(bounds.maxY + 1));
  for (let ty = bounds.minY; ty <= bounds.maxY + 1; ty++) grid.push(sx(bounds.minX), y, sz(ty), sx(bounds.maxX + 1), y, sz(ty));

  const blocked: number[] = [];
  const walls: number[] = [];
  for (let ty = bounds.minY; ty <= bounds.maxY; ty++) {
    for (let tx = bounds.minX; tx <= bounds.maxX; tx++) {
      const f = map.get(tx, ty);
      const x0 = sx(tx);
      const x1 = sx(tx + 1);
      const z0 = sz(ty);
      const z1 = sz(ty + 1);
      if (f & BLOCKED) blocked.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1);
      const wy = y + 0.01;
      if (f & Flag.WALL_NORTH) walls.push(x0, wy, z1, x1, wy, z1);
      if (f & Flag.WALL_SOUTH) walls.push(x0, wy, z0, x1, wy, z0);
      if (f & Flag.WALL_EAST) walls.push(x1, wy, z0, x1, wy, z1);
      if (f & Flag.WALL_WEST) walls.push(x0, wy, z0, x0, wy, z1);
    }
  }

  const group = new Group();
  group.name = "debug-grid";
  const geometries: BufferGeometry[] = [];
  const materials = [
    new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false, fog: false }),
    new MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.35, depthWrite: false, fog: false }),
    new LineBasicMaterial({ color: 0x00ffff, fog: false }),
  ] as const;
  const make = (data: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(data, 3));
    geometries.push(g);
    return g;
  };
  group.add(new LineSegments(make(grid), materials[0]));
  group.add(new Mesh(make(blocked), materials[1]));
  group.add(new LineSegments(make(walls), materials[2]));
  for (const child of group.children) child.renderOrder = 10;

  return {
    group,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
