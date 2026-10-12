import { useLayoutEffect, useRef } from "react";
import type { GameRuntime } from "./boot";

/**
 * Where the 3D world shows. The engine renders into one host element for the
 * whole session; each screen (title, design, game) moves that element into
 * its own slot, so switching screens never recreates the WebGL context.
 */
export function EngineViewport({ runtime }: { runtime: GameRuntime }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    el.appendChild(runtime.host);
    runtime.ensureMounted();
    return () => {
      if (runtime.host.parentElement === el) el.removeChild(runtime.host);
    };
  }, [runtime]);
  return <div ref={slot} className="rr-viewport" />;
}
