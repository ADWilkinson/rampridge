/**
 * localStorage helpers for per-device preferences. Every access is wrapped:
 * private windows and blocked storage throw, and the game must still run
 * (it just forgets the preference when the tab closes).
 */

export function readStored<T>(key: string, parse: (value: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: keep the value for this tab only.
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to remove.
  }
}
