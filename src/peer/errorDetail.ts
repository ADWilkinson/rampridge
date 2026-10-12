/**
 * One-line technical descriptions of failures for logs and launch telemetry,
 * shared by the buy and sell flows. Never shown to players.
 */

import { report } from "@/lib/telemetry";
import { stackFrames } from "@/wallet/errors";

const URL_TEXT = /\bhttps?:\/\/([^\s/"'<>)]+)[^\s"'<>)]*/gi;
const REQUEST_METHOD_TEXT = /"method":"([A-Za-z0-9_]+)"/;
const MAX_DETAIL_LENGTH = 600;

/** The JSON-RPC method a viem transport error was raised for, when it recorded one. */
function requestMethod(record: Record<string, unknown>): string | null {
  const body = record.body;
  const method = body && typeof body === "object" && !Array.isArray(body) ? (body as { method?: unknown }).method : undefined;
  if (typeof method === "string") return method;
  if (!Array.isArray(record.metaMessages)) return null;
  for (const line of record.metaMessages) {
    const match = typeof line === "string" ? REQUEST_METHOD_TEXT.exec(line) : null;
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * One log line describing an error and its causes: each layer's name, code,
 * short message and failed JSON-RPC method, with a service's own words (viem
 * `details`) shown once. Never the full viem message, which carries request
 * bodies, and every URL is cut to its host because RPC, bundler and paymaster
 * URLs can contain API keys.
 */
export function technicalDetail(error: unknown): string {
  const layers: string[] = [];
  const seenDetails = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current) && layers.length < 8) {
    seen.add(current);
    if (typeof current !== "object") {
      layers.push(String(current));
      break;
    }
    const record = current as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const code = typeof record.code === "number" || typeof record.code === "string" ? ` [${record.code}]` : "";
    const method = requestMethod(record);
    const text =
      typeof record.shortMessage === "string"
        ? record.shortMessage
        : typeof record.message === "string"
          ? (record.message.split("\n")[0] ?? "")
          : "";
    let details = "";
    if (typeof record.details === "string" && record.details.trim() && record.details !== text && !seenDetails.has(record.details)) {
      seenDetails.add(record.details);
      details = ` (${record.details.trim()})`;
    }
    layers.push(`${name}${code}${method ? ` {${method}}` : ""}: ${text}${details}`);
    current = record.cause;
  }
  const line = layers.join(" <- ").replace(URL_TEXT, (_match, host: string) => `https://${host}/…`);
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH - 1)}…` : line;
}

/**
 * Sends a handled failure to launch telemetry (`report` in src/lib/telemetry)
 * with its technical detail as the message: viem's own message quotes request
 * URLs and bodies, while the detail names every layer of the cause chain with
 * URLs cut to their host. Only the thrown error's stack frames go with it.
 * `context` is a short label such as "buy.signal".
 */
export function reportFailure(error: unknown, context: string, detail: string = technicalDetail(error)): void {
  report({ message: detail, stack: stackFrames(error) }, context);
}
