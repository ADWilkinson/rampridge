/**
 * Advance widths from a TrueType font, so share cards can pick the largest
 * pixel-exact size a line fits at. Reads only `head`, `hhea`, `hmtx` and a
 * format 4 `cmap`, which is all the RuneScape fonts carry for text.
 */

export interface FontMetrics {
  unitsPerEm: number;
  /** Advance width in font units; the font's default glyph for unmapped characters. */
  advance(codePoint: number): number;
}

interface TableRecord {
  offset: number;
  length: number;
}

function tables(view: DataView): Map<string, TableRecord> {
  const count = view.getUint16(4);
  const out = new Map<string, TableRecord>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    out.set(tag, { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return out;
}

/** Unicode BMP code point -> glyph id from the first format 4 subtable (Windows Unicode, or Unicode). */
function cmapFormat4(view: DataView, cmap: TableRecord): (codePoint: number) => number {
  const subtables = view.getUint16(cmap.offset + 2);
  let sub = -1;
  for (let i = 0; i < subtables; i++) {
    const at = cmap.offset + 4 + i * 8;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const offset = cmap.offset + view.getUint32(at + 4);
    if (view.getUint16(offset) !== 4) continue;
    if ((platform === 3 && encoding === 1) || platform === 0) {
      sub = offset;
      break;
    }
  }
  if (sub < 0) return () => 0;
  const segCount = view.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segCount * 2 + 2;
  const deltas = starts + segCount * 2;
  const rangeOffsets = deltas + segCount * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let i = 0; i < segCount; i++) {
      const end = view.getUint16(ends + i * 2);
      if (codePoint > end) continue;
      const start = view.getUint16(starts + i * 2);
      if (codePoint < start) return 0;
      const delta = view.getInt16(deltas + i * 2);
      const rangeAt = rangeOffsets + i * 2;
      const rangeOffset = view.getUint16(rangeAt);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyph = view.getUint16(rangeAt + rangeOffset + (codePoint - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

export function readFontMetrics(data: ArrayBuffer | Uint8Array): FontMetrics {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = tables(view);
  const head = t.get("head");
  const hhea = t.get("hhea");
  const hmtx = t.get("hmtx");
  const cmap = t.get("cmap");
  if (!head || !hhea || !hmtx || !cmap) throw new Error("Font is missing a table needed to measure text");
  const unitsPerEm = view.getUint16(head.offset + 18);
  const metricsCount = view.getUint16(hhea.offset + 34);
  const glyphFor = cmapFormat4(view, cmap);
  const advanceOf = (glyph: number) => view.getUint16(hmtx.offset + Math.min(glyph, metricsCount - 1) * 4);
  return { unitsPerEm, advance: (codePoint) => advanceOf(glyphFor(codePoint)) };
}

/** Width of `text` in pixels at `size`. */
export function textWidth(metrics: FontMetrics, text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += metrics.advance(ch.codePointAt(0)!);
  return (units * size) / metrics.unitsPerEm;
}

/** The largest of `sizes` (largest first) that fits `maxWidth`, else the smallest. */
export function fitSize(metrics: FontMetrics, text: string, maxWidth: number, sizes: readonly number[]): number {
  for (const size of sizes) if (textWidth(metrics, text, size) <= maxWidth) return size;
  return sizes[sizes.length - 1]!;
}
