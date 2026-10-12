/**
 * Node-shaped globals the wallet stack (Privy, WalletConnect, viem helpers)
 * expects in the browser. Import this before anything else in main.tsx.
 */
import { Buffer } from "buffer";
import process from "process";

type EnvRecord = Record<string, string | undefined>;

const globals = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: typeof process & { env?: EnvRecord };
};

if (!globals.Buffer) globals.Buffer = Buffer;

const proc = (globals.process ??= process);
proc.env = proc.env ?? ({} as EnvRecord);
