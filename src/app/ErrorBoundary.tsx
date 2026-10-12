import { Component, type ErrorInfo, type ReactNode } from "react";
import { report } from "@/lib/telemetry";
import { ErrorScreen } from "./ErrorScreen";
import { noteChunkFailure } from "./update";

interface State {
  error: Error | null;
}

function isChunkError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
}

/**
 * Top-level crash screen. Trades live on-chain and the buy and sell flows
 * persist their state before every transaction, so reloading is the safe
 * recovery; the copy points players back to the Exchange and Bank to check.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[app] crashed", error, info.componentStack);
    // In production React doesn't pass errors a boundary caught to window.onerror, so telemetry hears of them here.
    report(error, error instanceof Error && isChunkError(error) ? "chunk" : "boundary");
    // If a new release removed the chunk, UpdateNotice replaces this screen with the reload prompt.
    if (error instanceof Error && isChunkError(error)) void noteChunkFailure();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A chunk that failed to download is usually a dropped connection. When it was a new release,
    // noteChunkFailure confirms it with the server and UpdateNotice says so over this screen.
    const download = isChunkError(error);
    return (
      <ErrorScreen
        title={download ? "Part of the game didn't load." : "Something went wrong."}
        action={{ label: "Reload", onClick: () => window.location.reload() }}
      >
        <p>{download ? "Check your connection, then reload." : "The game hit an error and stopped. Reload to continue."}</p>
        <p>If you were in the middle of a trade, open the Exchange or the Bank after reloading to check where it is.</p>
      </ErrorScreen>
    );
  }
}
