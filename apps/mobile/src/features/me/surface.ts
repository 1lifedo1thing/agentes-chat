import type { Agent, SurfaceLink, SurfaceLinkCode, SurfaceLinks } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import type { SurfaceRow } from "@agenteschat/client/lib/surface-links";
import { surfaceVia } from "@agenteschat/client/lib/via";
import type { TFunction } from "i18next";

/** Linking the outside chat surface (ADR 0187) on the phone: the row in Notificações and its sheet. */

export type LinkStep = "code" | "confirm" | "linked";

/** While the code waits to come back from the surface, the links are read this often besides the live event. */
export const LINK_POLL_MS = 3000;

/** A fresh code this long before the shown one runs out: someone still typing it never holds a dead one. */
export const RENEW_BEFORE_MS = 30_000;

/** The sheet's step: a pending link waits on the person's confirm, whatever else is linked. */
export function linkStep(row: SurfaceRow, linked: boolean): LinkStep {
  if (linked) return "linked";
  return row.kind === "pending" ? "confirm" : "code";
}

/** How long the server keeps a code. */
export const CODE_TTL_MS = 10 * 60_000;

/**
 * When the code stops working, on this device's clock: the server's `expiresAt`, unless the two clocks disagree so
 * much that it reads as gone or past the server's own 10 minutes; then 10 minutes from the answer. Read as-is, a phone
 * running minutes fast would ask for a new code on every repaint.
 */
export function codeDeadline(code: Pick<SurfaceLinkCode, "expiresAt">, receivedAt: number) {
  const left = Date.parse(code.expiresAt) - receivedAt;
  return left > 2 * RENEW_BEFORE_MS && left <= CODE_TTL_MS ? receivedAt + left : receivedAt + CODE_TTL_MS;
}

/** No code yet, or the shown one is about to run out. */
export const codeIsStale = (deadline: number | null, now: number) =>
  deadline === null || deadline - now <= RENEW_BEFORE_MS;

/** "Valid for 9:41" under the code. */
export const codeLeftText = (t: TFunction, deadline: number, now: number) =>
  t("openOnPhone.validFor", { time: formatTimeLeft(Math.max(0, deadline - now)) });

/** The workspace's right hand by name, or null while the agents load. */
export const assistantName = (agents: readonly Pick<Agent, "builtin" | "name">[] | undefined) =>
  agents?.find((a) => isRightHand(a))?.name ?? null;

/** Who sent the code, as the surface shows them: the display, else the profile name, else the surface itself. */
export const senderName = (link: Pick<SurfaceLink, "display" | "profileName">, surface: string) =>
  link.display ?? link.profileName ?? surface;

/** What the row says beside the surface's name. */
export function surfaceRowText(
  t: TFunction,
  row: Exclude<SurfaceRow, { kind: "hidden" }>,
  assistant: string | null,
): { sub?: string; below?: string; value?: string } {
  if (row.kind === "pending") return { sub: t("mobile.surface.rowPending") };
  if (row.kind === "active") {
    const { display, profileName } = row.link;
    return {
      sub: display ?? profileName ?? undefined,
      ...(display && profileName ? { below: profileName } : {}),
      value: t("mobile.surface.on"),
    };
  }
  return { ...(assistant ? { sub: t("mobile.surface.rowNone", { assistant }) } : {}), value: t("mobile.surface.link") };
}

/** The tag on a person's message written on the surface, or null. `data`: the links answer, for the surface's name. */
export function surfaceTagText(
  t: TFunction,
  meta: Record<string, unknown> | null | undefined,
  person: string,
  data: SurfaceLinks | null | undefined,
): { label: string; hint: string } | null {
  const via = surfaceVia(meta);
  if (!via) return null;
  const surface = data?.surface?.name ?? via.surface;
  return via.forwarded
    ? { label: t("surface.forwarded", { surface }), hint: t("surface.forwardedTip", { person, surface }) }
    : { label: t("surface.via", { surface }), hint: t("surface.viaTip", { person, surface }) };
}
