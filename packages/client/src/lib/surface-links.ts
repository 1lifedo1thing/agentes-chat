import type { SurfaceLink, SurfaceLinks } from "../api/types";

/** What the outside chat surface's settings row shows (ADR 0187). `surface` is the server's name for it. */
export type SurfaceRow =
  | { kind: "hidden" }
  | { kind: "none"; surface: string }
  | { kind: "pending"; surface: string; link: SurfaceLink }
  | { kind: "active"; surface: string; link: SurfaceLink };

/**
 * Hidden unless the server bridges a surface and this account may link it. A pending link still in its 10 minutes
 * comes first, since it waits on the person's confirm; one past `expiresAt` counts as none.
 */
export function surfaceRowOf(data: SurfaceLinks | null | undefined, now = Date.now()): SurfaceRow {
  if (!data?.surface || !data.allowed) return { kind: "hidden" };
  const surface = data.surface.name;
  const pending = data.links.find((l) => l.status === "pending" && (!l.expiresAt || Date.parse(l.expiresAt) > now));
  if (pending) return { kind: "pending", surface, link: pending };
  const active = data.links.find((l) => l.status === "active");
  return active ? { kind: "active", surface, link: active } : { kind: "none", surface };
}
