declare module "vitest" {
  export interface ProvidedContext {
    /** Hex balance this run's global setup put on FORK_MARKER (tests/buy-parity/setup/global.ts). */
    parityForkMarker: string;
  }
}

export {};
