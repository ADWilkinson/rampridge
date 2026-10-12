/**
 * Minimal reader for OSRS "if3" interface components (cache index 3): enough
 * of the header plus the graphic (type 5) and model (type 6) payloads to
 * reproduce an interface's artwork. Layout follows the client's
 * Widget.decodeIf3 (model ids are 32-bit since build 237).
 */
import { IndexType } from "../vendor/rs-map-viewer/src/rs/cache/IndexType";
import type { BakeCache } from "./cache";

export interface IfComponent {
  group: number;
  file: number;
  type: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sprite?: { id: number; tiled: boolean; flipH: boolean; flipV: boolean };
  model?: { id: number; offsetX: number; offsetY: number; xan: number; yan: number; zan: number; zoom: number };
}

export function readInterface(cache: BakeCache, group: number): IfComponent[] {
  const archive = cache.system.getIndex(IndexType.DAT2.interfaces).getArchive(group);
  const out: IfComponent[] = [];
  for (const file of archive.fileIds) {
    const data = archive.getFile(file)!.data;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (v.getUint8(0) !== 0xff) continue; // legacy if1 component
    let p = 1;
    const type = v.getUint8(p++);
    p += 2; // content type
    const x = v.getInt16(p);
    const y = v.getInt16(p + 2);
    const width = v.getUint16(p + 4);
    const height = type === 9 ? v.getInt16(p + 6) : v.getUint16(p + 6);
    p += 8;
    p += 4; // size and position modes
    p += 2; // parent
    p += 1; // hidden
    const c: IfComponent = { group, file, type, x, y, width, height };
    if (type === 5) {
      const id = v.getInt32(p);
      p += 4 + 2; // sprite, texture
      const tiled = v.getUint8(p++) === 1;
      p += 1 + 1 + 4; // opacity, border, shadow colour
      const flipV = v.getUint8(p++) === 1;
      const flipH = v.getUint8(p++) === 1;
      c.sprite = { id, tiled, flipH, flipV };
    } else if (type === 6) {
      const id = v.getInt32(p);
      const offsetX = v.getInt16(p + 4);
      const offsetY = v.getInt16(p + 6);
      const xan = v.getUint16(p + 8);
      const zan = v.getUint16(p + 10);
      const yan = v.getUint16(p + 12);
      const zoom = v.getUint16(p + 14);
      c.model = { id, offsetX, offsetY, xan, yan, zan, zoom };
    }
    out.push(c);
  }
  return out;
}
