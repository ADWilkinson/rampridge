import { useStore } from "zustand";
// The loader's styles and component without the screens and kit barrels, which belong to the game chunk.
// oxlint-disable-next-line import/no-unassigned-import
import "@/ui/kit/kit.css";
// oxlint-disable-next-line import/no-unassigned-import
import "@/ui/screens/screens.css";
import { LoadingScreen } from "@/ui/screens/LoadingScreen";
import { bootStore, startBoot } from "./boot";

/** The classic loading bar, driven by the boot progress (code, world, characters, sprites, fonts). */
export function BootLoading() {
  const { fraction, label, error } = useStore(bootStore);
  return <LoadingScreen progress={fraction} label={label} error={error} onRetry={() => void startBoot()} />;
}
