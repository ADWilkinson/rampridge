import { describe, expect, it } from "vitest";
import { encodeQr, qrPath } from "./qr";

function finderAt(m: { size: number; modules: boolean[] }, x0: number, y0: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (m.modules[(y0 + y) * m.size + x0 + x] !== (d !== 2)) return false;
    }
  }
  return true;
}

describe("encodeQr", () => {
  it("picks the smallest version that fits", () => {
    expect(encodeQr("HELLO", "L").version).toBe(1);
    expect(encodeQr("https://revolut.me/rampridge", "M").version).toBe(3);
    expect(encodeQr("y".repeat(1200), "M").version).toBe(29);
  });

  it("draws finder patterns, timing and the dark module", () => {
    const q = encodeQr("https://www.rampridge.xyz", "M");
    expect(q.size).toBe(q.version * 4 + 17);
    expect(finderAt(q, 0, 0)).toBe(true);
    expect(finderAt(q, q.size - 7, 0)).toBe(true);
    expect(finderAt(q, 0, q.size - 7)).toBe(true);
    for (let i = 8; i < q.size - 8; i++) expect(q.modules[6 * q.size + i]).toBe(i % 2 === 0);
    expect(q.modules[(q.size - 8) * q.size + 8]).toBe(true);
  });

  it("is deterministic and rejects oversize input", () => {
    expect(encodeQr("abc").modules).toEqual(encodeQr("abc").modules);
    expect(() => encodeQr("z".repeat(3000), "H")).toThrow();
  });

  it("emits one path run per dark span", () => {
    const q = encodeQr("A", "L");
    const path = qrPath(q, 4);
    expect(path.startsWith("M4 4h7v1h-7z")).toBe(true);
  });
});
