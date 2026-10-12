/**
 * Server configuration, read lazily so a missing variable fails the request
 * that needs it with a clear 500 instead of crashing the function at import.
 * Values are never logged or echoed; errors name the variable only.
 */

export type ServerEnvName = "FIREBASE_SERVICE_ACCOUNT" | "SESSION_SECRET" | "BASE_RPC_URL" | "CRON_SECRET";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function requireEnv(name: ServerEnvName): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`Server misconfigured: ${name} is not set.`);
  return value;
}

/** HMAC key for session tokens; at least 32 bytes so HS256 has full strength. */
export function sessionSecret(): Uint8Array {
  const bytes = new TextEncoder().encode(requireEnv("SESSION_SECRET"));
  if (bytes.length < 32) throw new ConfigError("Server misconfigured: SESSION_SECRET must be at least 32 bytes.");
  return bytes;
}

export interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function serviceAccount(): ServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT"));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  }
  const sa = parsed as Partial<ServiceAccountJson> | null;
  if (!sa || typeof sa.project_id !== "string" || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new ConfigError("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key.");
  }
  return { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key };
}

export function baseRpcUrl(): string {
  const url = requireEnv("BASE_RPC_URL");
  if (!/^https?:\/\//.test(url)) throw new ConfigError("Server misconfigured: BASE_RPC_URL must be an http(s) URL.");
  return url;
}

export function cronSecret(): string {
  return requireEnv("CRON_SECRET");
}

/**
 * Optional SESSION_NOT_BEFORE (unix seconds): tokens issued before it are
 * refused, which signs everyone out after a database wipe without rotating
 * SESSION_SECRET. Unset means no cut-off.
 */
export function sessionNotBefore(): number | null {
  const raw = process.env.SESSION_NOT_BEFORE?.trim();
  if (!raw) return null;
  if (!/^\d{9,11}$/.test(raw)) {
    throw new ConfigError("Server misconfigured: SESSION_NOT_BEFORE must be a unix time in seconds.");
  }
  return Number(raw);
}
