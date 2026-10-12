import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useWalletBridge } from "./wallet";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** The wallet stack (Privy and the wallet context), once `./wallet` has loaded its chunk. */
function WalletStackSlot() {
  const Stack = useWalletBridge((s) => s.Stack);
  return Stack ? <Stack /> : null;
}

/**
 * App-wide providers: react-query, and beside the app the wallet stack
 * (Privy login, embedded and smart wallets, the wallet behind
 * `useAppWallet()`), which loads after the title screen has painted.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  // One QueryClient per browser session, stable across re-renders.
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <WalletStackSlot />
    </QueryClientProvider>
  );
}
