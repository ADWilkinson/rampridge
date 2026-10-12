/**
 * One tab per player. Tabs in the same browser profile share the session and
 * so the same pid; if two of them kept a presence, the one that closed would
 * send a leave that removes the player from the other. Each tab that starts a
 * presence claims the lock for its pid on a BroadcastChannel (or, without
 * one, a localStorage key whose `storage` events reach the other tabs). The
 * newest claim wins: older tabs stop their presence without leaving and say
 * the player is in another tab.
 */

export interface LockClaim {
  type: "claim";
  pid: string;
  /** Random id of the claiming tab. */
  tab: string;
  /** Local ms when claimed; ties break on `tab`. */
  at: number;
}

/** Messages between tabs. Delivery never includes the sender. */
export interface LockBus {
  post(message: LockClaim): void;
  listen(handler: (message: LockClaim) => void): () => void;
}

export const PRESENCE_CHANNEL = "rampridge.presence";

function isClaim(value: unknown): value is LockClaim {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "claim" && typeof v.pid === "string" && typeof v.tab === "string" && typeof v.at === "number";
}

/** The bus between this browser's tabs, or null when neither BroadcastChannel nor storage events exist. */
export function browserLockBus(name = PRESENCE_CHANNEL): LockBus | null {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(name);
    return {
      post: (message) => channel.postMessage(message),
      listen: (handler) => {
        const onMessage = (event: MessageEvent) => {
          if (isClaim(event.data)) handler(event.data);
        };
        channel.addEventListener("message", onMessage);
        return () => channel.removeEventListener("message", onMessage);
      },
    };
  }
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  return {
    post: (message) => {
      try {
        localStorage.setItem(name, JSON.stringify(message));
      } catch {
        // Storage blocked: this tab cannot tell the others, which is the old behaviour.
      }
    },
    listen: (handler) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key !== name || !event.newValue) return;
        try {
          const message: unknown = JSON.parse(event.newValue);
          if (isClaim(message)) handler(message);
        } catch {
          // Not ours.
        }
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}

function randomTabId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when claim `a` is newer than claim `b`. */
function newer(a: Pick<LockClaim, "at" | "tab">, b: Pick<LockClaim, "at" | "tab">): boolean {
  return a.at > b.at || (a.at === b.at && a.tab > b.tab);
}

export type LockState = "idle" | "held" | "lost";

export class PresenceLock {
  private claim: LockClaim | null = null;
  private lost = false;
  private readonly listeners = new Set<() => void>();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly bus: LockBus | null,
    private readonly tab: string = randomTabId(),
    private readonly clock: () => number = Date.now,
  ) {}

  /** idle: no presence here. held: this tab is the player's presence. lost: another tab took over. */
  get state(): LockState {
    if (this.lost) return "lost";
    return this.claim ? "held" : "idle";
  }

  /** Takes the lock for `pid` (newest tab wins), telling any other tab holding it to stand down. */
  acquire(pid: string): void {
    this.unlisten ??= this.bus?.listen((message) => this.receive(message)) ?? null;
    const at = Math.max(this.clock(), this.claim ? this.claim.at + 1 : 0);
    this.claim = { type: "claim", pid, tab: this.tab, at };
    this.lost = false;
    this.bus?.post(this.claim);
  }

  /** Gives the lock up quietly (this tab stopped playing). */
  release(): void {
    this.claim = null;
    this.lost = false;
  }

  /** Called once each time another tab takes the lock away. */
  onLost(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(message: LockClaim): void {
    const mine = this.claim;
    if (!mine || this.lost || message.tab === this.tab || message.pid !== mine.pid || !newer(message, mine)) return;
    this.lost = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("Presence lock listener failed:", err);
      }
    }
  }
}

let shared: PresenceLock | null = null;

/** This tab's lock, created on first use. */
export function presenceLock(): PresenceLock {
  shared ??= new PresenceLock(browserLockBus());
  return shared;
}

/** This tab's lock if a presence ever created it; never creates one. */
export function peekPresenceLock(): PresenceLock | null {
  return shared;
}

/** Replaces this tab's lock (tests). */
export function setPresenceLock(lock: PresenceLock | null): void {
  shared = lock;
}
