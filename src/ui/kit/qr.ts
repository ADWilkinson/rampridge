/**
 * Minimal QR Code encoder (ISO/IEC 18004, Model 2), byte mode, versions 1-40,
 * all four error-correction levels, automatic mask selection. Written for
 * RampRidge so payment deep links can be scanned from the Payment scroll
 * without a dependency. Pure: no DOM.
 *
 * The block tables below are the standard's error-correction characteristics
 * (table 9). Everything else is computed.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  version: number;
  ecc: QrEcc;
  mask: number;
  size: number;
  /** Row-major, true = dark module. */
  modules: boolean[];
}

const ECC_ORDINAL: Readonly<Record<QrEcc, number>> = { L: 0, M: 1, Q: 2, H: 3 };
/** Format-information bits for each level (the standard's encoding, not the ordinal). */
const ECC_FORMAT_BITS: Readonly<Record<QrEcc, number>> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 is unused so the arrays are indexed by version.
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const ECC_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function table(t: readonly (readonly number[])[], ecc: QrEcc, version: number): number {
  return t[ECC_ORDINAL[ecc]]![version]!;
}

/** Modules available for data and ECC after function patterns, in bits. */
function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8) - table(ECC_PER_BLOCK, ecc, version) * table(ECC_BLOCKS, ecc, version);
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// --- GF(256) Reed-Solomon -------------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = Array.from({ length: divisor.length }, () => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = result[i]! ^ gfMul(coef, factor);
    });
  }
  return result;
}

// --- Encoding --------------------------------------------------------------

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function interleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const blocks = table(ECC_BLOCKS, ecc, version);
  const eccLen = table(ECC_PER_BLOCK, ecc, version);
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const block = [...dat];
    if (i < shortBlocks) block.push(0); // placeholder so every block has equal length
    all.push([...block, ...rsRemainder(dat, divisor)]);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]!);
    });
  }
  return out;
}

class Grid {
  readonly size: number;
  readonly dark: boolean[];
  readonly fixed: boolean[];
  constructor(size: number) {
    this.size = size;
    this.dark = Array.from({ length: size * size }, () => false);
    this.fixed = Array.from({ length: size * size }, () => false);
  }
  set(x: number, y: number, dark: boolean): void {
    const i = y * this.size + x;
    this.dark[i] = dark;
    this.fixed[i] = true;
  }
  get(x: number, y: number): boolean {
    return this.dark[y * this.size + x]!;
  }
  clone(): Grid {
    const g = new Grid(this.size);
    for (let i = 0; i < this.dark.length; i++) {
      g.dark[i] = this.dark[i]!;
      g.fixed[i] = this.fixed[i]!;
    }
    return g;
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  pos.forEach((ay, i) => {
    pos.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  drawFormat(g, "L", 0); // reserve the format areas; overwritten later
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, bit);
      g.set(b, a, bit);
    }
  }
}

function drawFormat(g: Grid, ecc: QrEcc, mask: number): void {
  const n = g.size;
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true); // the dark module
}

function drawCodewords(g: Grid, codewords: readonly number[]): void {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!g.fixed[y * n + x] && i < codewords.length * 8) {
          g.dark[y * n + x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  const fn = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      const i = y * g.size + x;
      if (!g.fixed[i] && fn(x, y)) g.dark[i] = !g.dark[i];
    }
  }
}

/** Penalty score from the standard's four rules; lower scans more reliably. */
function penalty(g: Grid): number {
  const n = g.size;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= n; i++) {
      if (!pattern.every((p, k) => get(i + k) === p)) continue;
      const before = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const after = i + 11 <= n && [7, 8, 9, 10].every((k) => !get(i + k));
      if (before) score += 40;
      if (after) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => g.get(x, y));
  for (let x = 0; x < n; x++) line((y) => g.get(x, y));
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = g.get(x, y);
      if (c === g.get(x + 1, y) && c === g.get(x, y + 1) && c === g.get(x + 1, y + 1)) score += 3;
    }
  }
  const dark = g.dark.filter(Boolean).length;
  const total = n * n;
  score += Math.floor(Math.abs(dark * 100 - total * 50) / (total * 5)) * 10;
  return score;
}

/**
 * Encodes `text` (UTF-8, byte mode) at the smallest version that fits.
 * Throws when the text is too long for version 40 at the chosen level.
 */
export function encodeQr(text: string, ecc: QrEcc = "M", minVersion = 1): QrMatrix {
  const bytes = utf8(text);
  let version = Math.max(1, Math.min(40, minVersion));
  for (; version <= 40; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version, ecc) * 8) break;
  }
  if (version > 40) throw new Error("QR: data too long");

  const capacity = dataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);
  pushBits(bits, 0, Math.min(4, capacity - bits.length));
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) pushBits(bits, pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]!;
    data.push(b);
  }

  const size = version * 4 + 17;
  const base = new Grid(size);
  drawFunctionPatterns(base, version);
  drawCodewords(base, interleave(data, version, ecc));

  let best: { mask: number; score: number; dark: boolean[] } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = base.clone();
    applyMask(g, mask);
    drawFormat(g, ecc, mask);
    const score = penalty(g);
    if (!best || score < best.score) best = { mask, score, dark: g.dark };
  }
  return { version, ecc, mask: best!.mask, size, modules: best!.dark };
}

/** SVG path data ("M x y h1 v1 h-1 z" per dark run) for a matrix with a quiet zone. */
export function qrPath(qr: QrMatrix, border = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y * qr.size + x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.modules[y * qr.size + x + run]) run++;
      parts.push(`M${x + border} ${y + border}h${run}v1h${-run}z`);
      x += run;
    }
  }
  return parts.join("");
}
