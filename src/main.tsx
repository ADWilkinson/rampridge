// Buffer/process globals must exist before the wallet stack evaluates, so they stay in the entry chunk.
// Importing them only from the lazy app chunk is too late: a chunk's static imports evaluate before its
// own code, and the Peer SDK and Privy chunks read `process` at load (checked in a production build).
// oxlint-disable-next-line import/no-unassigned-import
import "@/lib/polyfills";
// oxlint-disable-next-line import/no-unassigned-import
import "@/styles/index.css";
// oxlint-disable-next-line import/no-unassigned-import
import "@/app/app.css";

import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BootLoading } from "@/app/BootLoading";
import { startBoot } from "@/app/boot";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { UpdateNotice, WebGLUnsupported } from "@/app/ErrorScreen";
import { watchForUpdates } from "@/app/update";
import { supportsWebGL2 } from "@/app/webgl";
import { installTelemetry, report } from "@/lib/telemetry";

// The wallet stack and the game shell load as their own chunk; the engine and three.js
// load in another (started by startBoot), so the loading bar paints straight away.
const AppRoot = lazy(() => import("@/app/AppRoot"));

// iOS Safari ignores user-scalable=no: without this a pinch on the HUD or a window zooms the whole page.
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
// A lazy chunk that fails because a new release is live gets a reload prompt instead of a broken screen.
watchForUpdates();
// Launch funnel counts and client errors (production on www.rampridge.xyz only; see lib/telemetry.ts).
installTelemetry();
// Vercel Web Analytics (cookie-less page views, referrers, countries and devices): the production host
// only, loaded after the page has finished loading so it never competes with the game's first paint.
if (import.meta.env.PROD && window.location.hostname === "www.rampridge.xyz") {
  window.addEventListener(
    "load",
    () => {
      void import("@vercel/analytics").then(({ inject }) => inject({ mode: "production" })).catch(() => undefined);
    },
    { once: true },
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");
const root = createRoot(container);

if (!supportsWebGL2()) {
  report(new Error("WebGL2 unsupported"), "webgl");
  root.render(<WebGLUnsupported />);
} else {
  void startBoot();
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <Suspense fallback={<BootLoading />}>
          <AppRoot />
        </Suspense>
      </ErrorBoundary>
      <UpdateNotice />
    </StrictMode>,
  );
}
