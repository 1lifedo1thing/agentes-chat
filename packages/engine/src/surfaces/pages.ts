import { randomUUID } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  count,
  type Database,
  type Executor,
  eq,
  gt,
  isNull,
  like,
  lt,
  lte,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { decideApproval, getApproval } from "../approvals";
import { randomToken, safeEqual, sha256 } from "../crypto";
import { emailAssistant, emailLocale, queueEmail } from "../email";
import { ForbiddenError, NotFoundError, TooManyError, ValidationError } from "../errors";
import { publicPageLink } from "../message-links";
import { getMembership } from "../organizations";
import { surfaceOn } from "./config";

/**
 * Pages of ours opened from a link sent on the outside chat surface, and the PIN that confirms a sensitive act there
 * (ADR 0226). A link is one page: opened once within `PAGE_FIRST_OPEN_MS`, then open for its kind's time in the
 * browser that opened it. It ends early with the surface link (an unlink, a new password, "This wasn't me", a
 * block), and when the person can no longer see what it shows. The URL is never fetched by the server's own GET:
 * the page posts the token, so a chat app's link preview opens nothing.
 */

const { surfacePageLinks, surfaceLinks, verifications, users } = schema;

export type PageKind = "confirm" | "screen" | "control";

export const PAGE_FIRST_OPEN_MS = 10 * 60_000;
/** How long a page stays open after its first open. */
export const PAGE_OPEN_MS: Record<PageKind, number> = {
  confirm: 60 * 60_000,
  screen: 30 * 60_000,
  control: 15 * 60_000,
};
const PAGE_KEEP_MS = 24 * 3_600_000;
export const PIN_TRIES = 3;
export const PIN_LOCK_MS = 15 * 60_000;
const PIN_RESET_MS = 60 * 60_000;
/** Reset emails a person gets an hour, whichever addresses or pages ask: the per-IP limit alone lets one mail-bomb them. */
const PIN_EMAILS_PER_HOUR = 3;
const PIN_SHAPE = /^\d{6}$/;

type PageRow = typeof surfacePageLinks.$inferSelect;
type LinkRow = typeof surfaceLinks.$inferSelect;
type PageDeps = { db: Database; pubsub: PubSub; now?: () => Date };

const gone = () => new NotFoundError("This link ran out. Ask for it again in the chat.", "surface.page_gone");
const pinResetId = (token: string) => `surface-pin:${sha256(token)}`;

/** A new page link for the person of `linkId`: its URL, with a token that is shown once and kept only hashed. */
export async function mintPageLink(
  db: Executor,
  input: { orgId: string; linkId: string; userId: string; kind: PageKind; targetId: string },
): Promise<string> {
  const token = randomToken(32);
  await db.insert(surfacePageLinks).values({ ...input, tokenHash: sha256(token) });
  return publicPageLink(`/surface-page?token=${token}`);
}

/**
 * The confirm page of an approval the person decides now; null when it waits on someone else or was already decided,
 * so its card opens the app instead of asking for a PIN that can't decide it.
 */
export async function confirmPageLink(
  db: Database,
  input: { orgId: string; linkId: string; userId: string; approvalId: string },
): Promise<string | null> {
  const decides = await getApproval(db, input.userId, input.orgId, input.approvalId).then(
    (a) => a.canDecide && a.status === "pending",
    () => false,
  );
  if (!decides) return null;
  const { approvalId, ...rest } = input;
  return mintPageLink(db, { ...rest, kind: "confirm", targetId: approvalId });
}

/**
 * The page behind `token`, live for this browser. Unopened, it opens now for the browser that gets the returned
 * `secret`, once and within `PAGE_FIRST_OPEN_MS`; opened, only `secret` reopens it, until its kind's time is up.
 * `firstOpen: false` refuses an unopened link: only the page's own first load opens it.
 */
async function livePage(
  db: Database,
  token: string,
  secret: string | null,
  at: Date,
  firstOpen: boolean,
): Promise<{ page: PageRow; link: LinkRow; secret: string | null }> {
  if (!surfaceOn()) throw gone();
  const [found] = await db
    .select({ page: surfacePageLinks, link: surfaceLinks })
    .from(surfacePageLinks)
    .innerJoin(surfaceLinks, eq(surfaceLinks.id, surfacePageLinks.linkId))
    .where(eq(surfacePageLinks.tokenHash, sha256(token)));
  if (found?.link.status !== "active" || found.link.orgId !== found.page.orgId) throw gone();
  if (!(await getMembership(db, found.page.userId, found.page.orgId))) throw gone();
  let { page } = found;
  if (!page.openedAt) {
    if (!firstOpen || at.getTime() - page.createdAt.getTime() > PAGE_FIRST_OPEN_MS) throw gone();
    const fresh = randomToken(32);
    const [opened] = await db
      .update(surfacePageLinks)
      .set({ openedAt: at, browserHash: sha256(fresh) })
      .where(and(eq(surfacePageLinks.id, page.id), isNull(surfacePageLinks.openedAt)))
      .returning();
    if (opened) return { page: opened, link: found.link, secret: fresh };
    // Another browser opened it a moment ago.
    const [now] = await db.select().from(surfacePageLinks).where(eq(surfacePageLinks.id, page.id));
    if (!now) throw gone();
    page = now;
  }
  if (!secret || !page.browserHash || !safeEqual(sha256(secret), page.browserHash)) {
    throw new ForbiddenError(
      "This link was opened on another device. Ask for a new one in the chat.",
      "surface.page_elsewhere",
    );
  }
  if (!page.openedAt || at.getTime() - page.openedAt.getTime() > PAGE_OPEN_MS[page.kind]) throw gone();
  return { page, link: found.link, secret: null };
}

export interface SurfacePageView {
  kind: PageKind;
  /** When the page stops opening. */
  expiresAt: string;
  surface: string;
  pin: { set: boolean; lockedUntil: string | null };
  approval: {
    id: string;
    /** The tool and its input, as the app's card words its title in the reader's language. */
    tool: string;
    params: Record<string, unknown>;
    title: string;
    detail: string;
    why: string | null;
    kind: string;
    titleParams: Record<string, string | number | boolean>;
    status: string;
    canDecide: boolean;
    approverLabel: string | null;
  } | null;
}

async function viewOf(db: Database, page: PageRow, link: LinkRow, at: Date): Promise<SurfacePageView> {
  let approval: SurfacePageView["approval"] = null;
  if (page.kind === "confirm") {
    // Lost access to it (left the conversation, the workspace's rules changed) ends the page.
    const a = await getApproval(db, page.userId, page.orgId, page.targetId).catch((error: unknown) => {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) throw gone();
      throw error;
    });
    approval = {
      id: a.id,
      tool: a.tool,
      params: a.params,
      title: a.title,
      detail: a.detail,
      why: a.why,
      kind: a.kind,
      titleParams: a.titleParams,
      status: a.status,
      canDecide: a.canDecide,
      approverLabel: a.approvers?.label ?? null,
    };
  }
  const opened = page.openedAt ?? at;
  const locked = link.pinLockedUntil && link.pinLockedUntil > at ? link.pinLockedUntil.toISOString() : null;
  return {
    kind: page.kind,
    expiresAt: new Date(opened.getTime() + PAGE_OPEN_MS[page.kind]).toISOString(),
    surface: surfaceOn()?.name ?? "",
    pin: { set: link.pinHash !== null, lockedUntil: locked },
    approval,
  };
}

/** The page's first load, or a reload in the browser that opened it. `secret` comes back once, on the first. */
export async function openSurfacePage(
  deps: { db: Database; now?: () => Date },
  token: string,
  secret: string | null,
): Promise<{ view: SurfacePageView; secret: string | null }> {
  const at = deps.now?.() ?? new Date();
  const live = await livePage(deps.db, token, secret, at, true);
  return { view: await viewOf(deps.db, live.page, live.link, at), secret: live.secret };
}

/**
 * Checks the person's PIN, or keeps it as their PIN when they have none yet (the first sensitive act chooses it).
 * `PIN_TRIES` wrong ones in a row lock it for `PIN_LOCK_MS`.
 */
export async function checkPin(db: Executor, link: LinkRow, pin: string, at: Date): Promise<void> {
  if (link.pinLockedUntil && link.pinLockedUntil > at) {
    throw new TooManyError("Too many wrong PINs. Try again later.", "surface.pin_locked", {
      until: link.pinLockedUntil.toISOString(),
    });
  }
  if (!PIN_SHAPE.test(pin)) throw new ValidationError("The PIN has six digits", "surface.pin_shape");
  if (!link.pinHash) {
    const hash = await Bun.password.hash(pin);
    const [set] = await db
      .update(surfaceLinks)
      .set({ pinHash: hash, pinFailures: 0, pinLockedUntil: null })
      .where(and(eq(surfaceLinks.id, link.id), isNull(surfaceLinks.pinHash)))
      .returning();
    if (set) return;
    // Chosen at the same moment on another page: this one is checked against it.
    const [now] = await db.select().from(surfaceLinks).where(eq(surfaceLinks.id, link.id));
    if (!now?.pinHash) throw gone();
    return checkPin(db, now, pin, at);
  }
  // The try is taken before the slow check, so tries sent at once can't run past the lock.
  const [tried] = await db
    .update(surfaceLinks)
    .set({ pinFailures: sql`${surfaceLinks.pinFailures} + 1` })
    .where(
      and(
        eq(surfaceLinks.id, link.id),
        lt(surfaceLinks.pinFailures, PIN_TRIES),
        or(isNull(surfaceLinks.pinLockedUntil), lte(surfaceLinks.pinLockedUntil, at)),
      ),
    )
    .returning({ failures: surfaceLinks.pinFailures, pinHash: surfaceLinks.pinHash });
  if (!tried) {
    const [now] = await db.select().from(surfaceLinks).where(eq(surfaceLinks.id, link.id));
    const until =
      now?.pinLockedUntil && now.pinLockedUntil > at ? now.pinLockedUntil : new Date(at.getTime() + PIN_LOCK_MS);
    throw new TooManyError("Too many wrong PINs. Try again later.", "surface.pin_locked", {
      until: until.toISOString(),
    });
  }
  if (!tried.pinHash) return checkPin(db, { ...link, pinHash: null }, pin, at);
  if (await Bun.password.verify(pin, tried.pinHash)) {
    await db.update(surfaceLinks).set({ pinFailures: 0 }).where(eq(surfaceLinks.id, link.id));
    return;
  }
  const failures = tried.failures;
  if (failures >= PIN_TRIES) {
    const until = new Date(at.getTime() + PIN_LOCK_MS);
    await db.update(surfaceLinks).set({ pinFailures: 0, pinLockedUntil: until }).where(eq(surfaceLinks.id, link.id));
    throw new TooManyError("Too many wrong PINs. Try again later.", "surface.pin_locked", {
      until: until.toISOString(),
    });
  }
  throw new ForbiddenError("Wrong PIN", "surface.pin_wrong", { left: PIN_TRIES - failures });
}

/**
 * The person decides the page's approval: approving takes their PIN (choosing it, the first time), refusing doesn't.
 * Who may decide is `decideApproval`'s answer, as in the app.
 */
export async function decideOnSurfacePage(
  deps: PageDeps,
  token: string,
  secret: string | null,
  input: { decision: "approve" | "refuse"; pin?: string },
): Promise<SurfacePageView> {
  const at = deps.now?.() ?? new Date();
  const { page, link } = await livePage(deps.db, token, secret, at, false);
  if (page.kind !== "confirm") throw gone();
  if (input.decision === "approve") await checkPin(deps.db, link, input.pin ?? "", at);
  await decideApproval(deps, page.userId, page.orgId, page.targetId, { decision: input.decision });
  const [after] = await deps.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, link.id));
  return viewOf(deps.db, page, after ?? link, at);
}

/** "Forgot your PIN?": an email to the account with a link that clears it, for an hour. */
export async function emailPinReset(
  deps: { db: Database; now?: () => Date; publicUrl: string },
  token: string,
  secret: string | null,
): Promise<void> {
  const at = deps.now?.() ?? new Date();
  const { link } = await livePage(deps.db, token, secret, at, false);
  const surface = surfaceOn();
  if (!surface) throw gone();
  const reset = randomToken(32);
  const value = JSON.stringify({ userId: link.userId, linkId: link.id });
  await deps.db.transaction(async (tx) => {
    const [sent] = await tx
      .select({ n: count() })
      .from(verifications)
      .where(
        and(
          like(verifications.identifier, "surface-pin:%"),
          eq(verifications.value, value),
          gt(verifications.createdAt, new Date(at.getTime() - PIN_RESET_MS)),
        ),
      );
    if ((sent?.n ?? 0) >= PIN_EMAILS_PER_HOUR) throw new TooManyError("Too many reset emails. Try again later.");
    const [user] = await tx
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, link.userId));
    if (!user) throw gone();
    await tx.insert(verifications).values({
      id: randomUUID(),
      identifier: pinResetId(reset),
      value,
      expiresAt: new Date(at.getTime() + PIN_RESET_MS),
      createdAt: at,
      updatedAt: at,
    });
    await queueEmail(tx, {
      orgId: null,
      key: `surface-pin:${sha256(reset)}`,
      to: [user.email],
      template: {
        assistant: await emailAssistant(tx, link.orgId),
        kind: "surface_pin_reset",
        locale: emailLocale(user.locale),
        surface: surface.name,
        url: `${deps.publicUrl.replace(/\/$/, "")}/email-undo?kind=surface-pin&token=${reset}`,
      },
    });
  });
}

/** The emailed link's page: once, within an hour, clears the PIN (and its lock); the next sensitive act sets a new one. */
export async function resetSurfacePin(db: Database, token: string): Promise<{ surface: string }> {
  const [row] = await db
    .delete(verifications)
    .where(eq(verifications.identifier, pinResetId(token)))
    .returning();
  let value: { userId?: unknown; linkId?: unknown } = {};
  try {
    value = row && row.expiresAt > new Date() ? (JSON.parse(row.value) as typeof value) : {};
  } catch {}
  if (typeof value.userId !== "string" || typeof value.linkId !== "string") {
    throw new NotFoundError("This link expired or was already used", "surface.pin_reset_gone");
  }
  await db
    .update(surfaceLinks)
    .set({ pinHash: null, pinFailures: 0, pinLockedUntil: null })
    .where(and(eq(surfaceLinks.id, value.linkId), eq(surfaceLinks.userId, value.userId)));
  return { surface: surfaceOn()?.name ?? "" };
}

/** Page links a day old: none of them opens anymore. */
export async function prunePageLinks(db: Executor): Promise<number> {
  const gone = await db
    .delete(surfacePageLinks)
    .where(lt(surfacePageLinks.createdAt, new Date(Date.now() - PAGE_KEEP_MS)))
    .returning({ id: surfacePageLinks.id });
  return gone.length;
}
