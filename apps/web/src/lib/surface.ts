import { CONNECTOR_MARK } from "@agenteschat/client/lib/connected";
import { capitalize } from "@agenteschat/client/lib/format";

/** A link code lasts 10 minutes from when it is made (ADR 0187 §2). */
const CODE_MS = 10 * 60_000;

/**
 * The web's connector mark named like the surface (`/connectors/<name>.svg`), or null when its name can't name one.
 * The name is the operator's own, so the file may not exist: load it before showing it.
 */
export function surfaceMarkUrl(name: string): string | null {
  const url = `/connectors/${name.trim().toLowerCase()}.svg`;
  return CONNECTOR_MARK.test(url) ? url : null;
}

/** The surface's name for a message's `via` (its id, the name lower-cased): the server's when it matches, else the id. */
export function surfaceViaName(id: string, name: string | null | undefined, locale?: string): string {
  return name && name.toLowerCase() === id.toLowerCase() ? name : capitalize(id, locale);
}

/**
 * When a code runs out by this device's clock. The server's `expiresAt` may be on a clock ahead of ours, so it never
 * counts past 10 minutes from its arrival.
 */
export function codeEndsAt(expiresAt: string, now = Date.now()): number {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? Math.min(at, now + CODE_MS) : now + CODE_MS;
}
