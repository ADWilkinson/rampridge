import { ApiError } from "@/net/http";
import { checkName, renameSession } from "@/net/session";
import type { NameAvailability } from "@/ui/screens/NameField";

/**
 * Display names. "Check availability" only asks the session API; the name is
 * claimed when the player accepts it (the design screen's Accept, the rename
 * window's Set name), so Skip and Cancel leave the old name in place.
 */

/** The session API's reason a name can't be had, or null for any other error (network, server). */
export function nameRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === "name_taken") return "That name is taken.";
  if (err.code === "bad_request") return err.message;
  return null;
}

/** Availability for the name field, without claiming the name. Other errors throw (the field shows them). */
export async function checkNameAvailability(name: string): Promise<NameAvailability> {
  try {
    await checkName(name);
    return { available: true };
  } catch (err) {
    const reason = nameRefusal(err);
    if (reason !== null) return { available: false, reason };
    throw err;
  }
}

/**
 * Claims `name` for this session. Resolves to the reason when the name was
 * refused (taken since the check, or against the rules), or undefined once
 * it is set; other errors throw.
 */
export async function claimName(name: string): Promise<string | undefined> {
  try {
    await renameSession(name);
    return undefined;
  } catch (err) {
    const reason = nameRefusal(err);
    if (reason !== null) return reason;
    throw err;
  }
}
