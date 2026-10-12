/**
 * The Vite dev server for dev/buy-e2e.html (dev/buy-e2e/vite.config.ts),
 * spawned in its own process group so every child dies with it.
 */

import { spawn, type ChildProcess } from "node:child_process";

export class ViteServer {
  readonly url: string;
  private proc: ChildProcess | null = null;
  output = "";

  constructor(
    readonly port: number,
    private readonly env: Record<string, string>,
    private readonly cwd: string,
  ) {
    if (port < 5290 || port > 5299) throw new Error("vite port must be 5290-5299");
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    this.proc = spawn("bunx", ["vite", "--config", "dev/buy-e2e/vite.config.ts"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, E2E_VITE_PORT: String(this.port), VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.proc.stdout?.on("data", (c: Buffer) => (this.output += c.toString()));
    this.proc.stderr?.on("data", (c: Buffer) => (this.output += c.toString()));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`vite exited: ${this.output.slice(-800)}`);
      try {
        const res = await fetch(`${this.url}/__e2e/config`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`vite did not start: ${this.output.slice(-800)}`);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc?.pid) return;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.url}${path}`);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
}
