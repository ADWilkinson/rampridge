/**
 * In-memory Db with Realtime Database semantics that matter to the handlers:
 * nulls delete, empty objects vanish, multi-path updates are atomic, push keys
 * sort chronologically. Used by tests; never by a deployed function.
 */

import type { Db, QueryOptions, TransactionOutcome } from "./db.js";

type Tree = Record<string, unknown>;

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** JSON round-trip with nulls and empty objects removed, as the database stores data. */
function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map(normalise);
    return items.every((item) => item === null) ? null : items;
  }
  if (typeof value === "object") {
    const out: Tree = {};
    for (const [key, child] of Object.entries(value as Tree)) {
      const n = normalise(child);
      if (n !== null) out[key] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class MemoryDb implements Db {
  root: Tree = {};
  private pushCounter = 0;
  /** Set to make every call fail, to exercise error paths. */
  failWith: Error | null = null;

  constructor(initial: Tree = {}) {
    this.root = (normalise(initial) as Tree | null) ?? {};
  }

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  read(path: string): unknown {
    let node: unknown = this.root;
    for (const seg of segments(path)) {
      if (node === null || typeof node !== "object") return null;
      node = (node as Tree)[seg];
      if (node === undefined) return null;
    }
    return node ?? null;
  }

  write(path: string, value: unknown): void {
    const segs = segments(path);
    const normalised = normalise(value);
    if (segs.length === 0) {
      this.root = (normalised as Tree | null) ?? {};
      return;
    }
    const parents: Tree[] = [this.root];
    let node: Tree = this.root;
    for (const seg of segs.slice(0, -1)) {
      const next = node[seg];
      if (next === null || typeof next !== "object") {
        if (normalised === null) return;
        node[seg] = {};
      }
      node = node[seg] as Tree;
      parents.push(node);
    }
    const last = segs[segs.length - 1]!;
    if (normalised === null) delete node[last];
    else node[last] = normalised;
    // Remove parents left empty by a delete.
    for (let i = parents.length - 1; i > 0; i--) {
      if (Object.keys(parents[i]!).length > 0) break;
      delete parents[i - 1]![segs[i - 1]!];
    }
  }

  async get<T>(path: string): Promise<T | null> {
    this.check();
    return clone(this.read(path)) as T | null;
  }

  async set(path: string, value: unknown): Promise<void> {
    this.check();
    this.write(path, value);
  }

  async update(updates: Record<string, unknown>): Promise<void> {
    this.check();
    for (const [path, value] of Object.entries(updates)) this.write(path, value);
  }

  async remove(path: string): Promise<void> {
    this.check();
    this.write(path, null);
  }

  async increment(path: string, delta: number): Promise<void> {
    this.check();
    const current = this.read(path);
    this.write(path, (typeof current === "number" ? current : 0) + delta);
  }

  async push(path: string, value: unknown): Promise<string> {
    this.check();
    const key = this.key();
    this.write(`${path}/${key}`, value);
    return key;
  }

  key(): string {
    this.pushCounter += 1;
    return `-m${String(this.pushCounter).padStart(10, "0")}`;
  }

  async transaction<T>(
    path: string,
    update: (current: T | null) => T | null | undefined,
  ): Promise<TransactionOutcome<T>> {
    this.check();
    const current = clone(this.read(path)) as T | null;
    const next = update(current);
    if (next === undefined) return { committed: false, value: current };
    this.write(path, next);
    return { committed: true, value: clone(this.read(path)) as T | null };
  }

  async query<T>(path: string, options: QueryOptions): Promise<Array<[string, T]>> {
    this.check();
    const node = this.read(path);
    if (node === null || typeof node !== "object") return [];
    let entries = Object.entries(clone(node) as Tree);
    const child = options.orderByChild;
    if (child) {
      const valueOf = (v: unknown) => {
        const n = v !== null && typeof v === "object" ? (v as Tree)[child] : undefined;
        return typeof n === "number" ? n : null;
      };
      // Children without the ordering value sort first, as in the database.
      entries.sort((a, b) => {
        const av = valueOf(a[1]);
        const bv = valueOf(b[1]);
        if (av === bv) return a[0] < b[0] ? -1 : 1;
        if (av === null) return -1;
        if (bv === null) return 1;
        return av - bv;
      });
      entries = entries.filter(([, v]) => {
        const n = valueOf(v);
        if (options.startAt !== undefined && (n === null || n < options.startAt)) return false;
        if (options.endAt !== undefined && n !== null && n > options.endAt) return false;
        return true;
      });
    } else {
      entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    if (options.limitToFirst !== undefined) entries = entries.slice(0, options.limitToFirst);
    if (options.limitToLast !== undefined) entries = entries.slice(-options.limitToLast);
    return entries as Array<[string, T]>;
  }
}
