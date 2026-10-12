import { useStore } from "zustand";
import { bootStore } from "./boot";
import { BootLoading } from "./BootLoading";
import { Game } from "./Game";

/** The loading screen until the engine and assets are in, then the game. */
export function App() {
  const runtime = useStore(bootStore, (s) => s.runtime);
  return runtime ? <Game runtime={runtime} /> : <BootLoading />;
}
