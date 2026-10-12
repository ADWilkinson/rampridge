#!/usr/bin/env node
/**
 * Records the launch-video beats from dev/capture.html, frame by frame.
 *
 *   node scripts/capture/record.mjs --base http://localhost:5199 \
 *     --beats exchange,trade --layouts desktop,phone --jobs 3
 *
 * Each recording runs in its own headless Chrome (fresh profile, deleted
 * afterwards), driven over CDP. The page clock is replaced by
 * scripts/capture/clock.js, so time only moves when the recorder steps it:
 * advance 1000/30 ms, grab the frame with Page.captureScreenshot, repeat.
 * Frames pipe into ffmpeg (libx264, yuv420p, crf 17, +faststart, 30 fps).
 * The game's original sounds are mixed in at the cues the page logged
 * (click, offer, coins, levelup...), with a -silent variant kept alongside.
 * Frames the beat marks as stills are also saved as full-resolution PNGs.
 *
 * Desktop: 960x540 CSS px at 2x = 1920x1080. Phone: 360x640 at 3x = 1080x1920.
 *
 * Output goes to --out, else $LAUNCH_DIR, else $TMPDIR/rampridge-launch (raw/
 * and stills/). CHROME_PATH and FFMPEG override the browser and ffmpeg binaries.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((a) => {
      const [k, ...v] = a.trim().split(/\s+/);
      return [k, v.join(" ") || "1"];
    }),
);
const BASE = args.base ?? "http://localhost:5199";
const OUT = args.out ?? process.env.LAUNCH_DIR ?? join(process.env.TMPDIR ?? "/tmp", "rampridge-launch");
const PROFILES = args.profiles ?? join(process.env.TMPDIR ?? "/tmp", "rampridge-capture-profiles");
const FPS = Number(args.fps ?? 30);
const JOBS = Number(args.jobs ?? 2);
const BEATS = (args.beats ?? "walkin,exchange,trade,payverify,sell,social,orbit").split(",");
const LAYOUTS = (args.layouts ?? "desktop,phone").split(",");
const KEEP_FRAMES = args.frames === "1";

const LAYOUT = {
  desktop: { width: 960, height: 540, scale: 2, mobile: false, tag: "16x9", out: [1920, 1080] },
  phone: { width: 360, height: 640, scale: 3, mobile: true, tag: "9x16", out: [1080, 1920] },
};

const CONTRACT_STILLS = new Set(["01-hero", "02-exchange", "03-trade", "04-payment", "05-fireworks", "06-bank", "07-phone-world", "08-phone-exchange"]);
const SOUNDS = JSON.parse(readFileSync(join(REPO, "public/game/sounds/manifest.json"), "utf8"));
const VOLUME = { click: 0.55, offer: 0.85, coins: 0.8, levelup: 0.75, trade: 0.7, collect: 0.75, open: 0.6, close: 0.6, error: 0.6 };
const CLOCK = readFileSync(join(HERE, "clock.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
      }
    };
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}, timeoutMs = 45_000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function launchChrome(profile, layout) {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--window-size=${layout.width},${layout.height}`,
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-color-profile=srgb",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  chrome.stderr.on("data", (d) => (log += d));
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  if (!existsSync(portFile)) throw new Error(`Chrome did not start: ${log.slice(-500)}`);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    page = list.find((t) => t.type === "page");
    if (!page) await sleep(100);
  }
  return { chrome, page };
}

// ---------------------------------------------------------------- encode

function encoder(file, layout) {
  const [w, h] = layout.out;
  const ff = spawn(
    FFMPEG,
    ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-vf", `scale=${w}:${h}:flags=lanczos:in_range=full:out_range=tv,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-r", String(FPS), "-movflags", "+faststart", file],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise((resolve, reject) => ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} for ${file}`)))));
  return {
    write: (buf) => new Promise((resolve) => (ff.stdin.write(buf) ? resolve() : ff.stdin.once("drain", resolve))),
    end: () => {
      ff.stdin.end();
      return done;
    },
  };
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/** Mixes the original sounds at their cues under the silent video. */
async function mix(silent, file, cues, seconds) {
  const kept = [];
  for (const c of cues.sort((a, b) => a.t - b.t)) {
    if (!SOUNDS[c.name]) continue;
    if (kept.some((k) => k.name === c.name && Math.abs(k.t - c.t) < 250)) continue;
    if (c.t < 0 || c.t > seconds * 1000) continue;
    kept.push(c);
  }
  const inputs = ["-i", silent];
  const filters = [];
  kept.forEach((c, i) => {
    inputs.push("-i", join(REPO, "public/game/sounds", SOUNDS[c.name]));
    const ms = Math.round(c.t);
    filters.push(`[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${VOLUME[c.name] ?? 0.7},adelay=${ms}|${ms}[a${i}]`);
  });
  const dur = seconds.toFixed(3);
  let graph;
  if (kept.length) {
    graph = `${filters.join(";")};${kept.map((_, i) => `[a${i}]`).join("")}amix=inputs=${kept.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=${dur}[out]`;
  } else {
    inputs.push("-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo");
    graph = `[1:a]anull[out]`;
  }
  await run(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[out]", "-t", dur, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", file]);
  return kept;
}

// ---------------------------------------------------------------- record one

async function record(beat, layoutName) {
  const layout = LAYOUT[layoutName];
  const tag = `${beat}-${layout.tag}`;
  const profile = join(PROFILES, `${tag}-${process.pid}`);
  const t0 = Date.now();
  const { chrome, page } = await launchChrome(profile, layout);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  const consoleErrors = [];
  try {
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    });
    cdp.on("Runtime.exceptionThrown", (p) => consoleErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 300)));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: layout.width, height: layout.height, deviceScaleFactor: layout.scale, mobile: layout.mobile });
    if (layout.mobile) {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
      });
    }
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });
    await cdp.send("Page.navigate", { url: `${BASE}/dev/capture.html?beat=${beat}` });

    // Loading: real time passes for network and decoding; page time moves a frame per poll.
    const loadDeadline = Date.now() + 180_000;
    for (;;) {
      const s = await cdp
        .eval(`window.__clock ? window.__clock.advance(${1000 / FPS}).then(() => ({ ready: !!(window.__capture && window.__capture.ready), errors: window.__capture ? window.__capture.errors : [] })) : { ready: false, errors: [] }`)
        .catch(() => ({ ready: false, errors: [] }));
      if (s.errors?.length) throw new Error(`${tag}: page error: ${s.errors.join(" | ")}`);
      if (s.ready) break;
      if (Date.now() > loadDeadline) throw new Error(`${tag}: page never became ready. Console: ${consoleErrors.slice(-5).join(" | ")}`);
      await sleep(8);
    }

    const duration = await cdp.eval("window.__capture.duration");
    const frames = Math.round((duration / 1000) * FPS);
    const rawDir = join(OUT, "raw");
    const stillDir = join(OUT, "stills");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(join(stillDir, "extra"), { recursive: true });
    const silent = join(rawDir, `${tag}-silent.mp4`);
    const enc = encoder(silent, layout);
    const saved = new Set();
    const frameDir = KEEP_FRAMES ? join(PROFILES, `${tag}-frames`) : null;
    if (frameDir) mkdirSync(frameDir, { recursive: true });

    await cdp.eval("window.__capture.start()");
    for (let i = 0; i < frames; i++) {
      const t = (i * 1000) / FPS;
      const stills = await cdp.eval("window.__capture.stills");
      for (const st of stills) {
        if (st.t <= t + 0.5 && !saved.has(st.name)) {
          saved.add(st.name);
          const png = await cdp.send("Page.captureScreenshot", { format: "png" });
          const dest = CONTRACT_STILLS.has(st.name) ? join(stillDir, `${st.name}.png`) : join(stillDir, "extra", `${st.name}.png`);
          writeFileSync(dest, Buffer.from(png.data, "base64"));
        }
      }
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 94, optimizeForSpeed: true });
      const buf = Buffer.from(shot.data, "base64");
      if (frameDir && i % 15 === 0) writeFileSync(join(frameDir, `f${String(i).padStart(4, "0")}.jpg`), buf);
      await enc.write(buf);
      await cdp.eval(`window.__clock.advance(${1000 / FPS})`);
    }
    await enc.end();
    const bus = await cdp.eval("({ cues: window.__capture.cues, errors: window.__capture.errors, done: window.__capture.done })");
    const seconds = frames / FPS;
    const mixed = await mix(silent, join(rawDir, `${tag}.mp4`), bus.cues, seconds);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[capture] ${tag}: ${frames} frames, ${mixed.length} sounds (${mixed.map((c) => `${c.name}@${(c.t / 1000).toFixed(2)}`).join(" ")}), done=${bus.done}, ${secs}s${bus.errors.length ? `, ERRORS: ${bus.errors.join(" | ")}` : ""}`);
    if (consoleErrors.length) console.log(`[capture] ${tag} console errors: ${consoleErrors.slice(0, 4).join(" | ")}`);
    return { tag, ok: true, errors: bus.errors };
  } finally {
    cdp.close();
    chrome.kill("SIGKILL");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- queue

const queue = BEATS.flatMap((b) => LAYOUTS.map((l) => [b, l]));
const results = [];
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        last = await record(job[0], job[1]);
        if (!last.errors.length) break;
      } catch (e) {
        console.error(`[capture] ${job.join("/")} attempt ${attempt} failed: ${e.message}`);
        last = { tag: job.join("-"), ok: false, errors: [e.message] };
      }
    }
    results.push(last);
  }
}
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, worker));
const failed = results.filter((r) => !r.ok || r.errors.length);
console.log(`[capture] ${results.length - failed.length}/${results.length} clean`);
process.exit(failed.length ? 1 : 0);
