import { App } from "./App";
import { AppProviders } from "./providers";

/**
 * The game shell and react-query, loaded as one lazy chunk so the loading
 * screen paints before any of it downloads. The wallet stack (Privy) is a
 * further chunk that loads once the title screen has painted (`./wallet`).
 */
export default function AppRoot() {
  return (
    <AppProviders>
      <App />
    </AppProviders>
  );
}
