import type { BlobStore } from "@agenteschat/adapters";
import { count, type Database, eq, schema, sql } from "@agenteschat/db";
import { isAccentHex } from "@agenteschat/tokens/accent";
import { readImage } from "./avatars";
import { caches } from "./cache";
import { ConflictError, ValidationError } from "./errors";
import { normalizeHost } from "./net-guard";

const { hosts } = schema;

/** Where the pages on a registered host load its logo; the host is the request's own, never a parameter. */
export const HOST_LOGO_PATH = "/api/host-look/logo";

/** At most this many registered hosts on one server. */
export const HOSTS_MAX = 1000;

export type HostLook = typeof hosts.$inferSelect;

/**
 * The registered host a `Host` header names (ADR 0194), or null: the one resolver behind every check of a registered
 * host (the origin rule, sign-in, the links, the logo). Kept per process for 30 s and dropped on a write.
 */
export async function hostLook(db: Database, host: string | null | undefined): Promise<HostLook | null> {
  const h = normalizeHost(host);
  if (!h) return null;
  return (await caches.hosts.getOrLoad(
    h,
    async () => (await db.select().from(hosts).where(eq(hosts.host, h)))[0] ?? null,
  )) as HostLook | null;
}

/**
 * The one origin a registered host adds (ADR 0194): exactly `https://<host>`, and only on a request whose own `Host`
 * is that registered host, so a host's page never reaches another host's session. Forwarded-host headers are never
 * read. Null on any other request. The app API's CSRF check and the WebSocket upgrades take it through the
 * server's `requestOriginAllowed`, Better Auth through its `trustedOrigins`.
 */
export async function hostOrigin(db: Database, headers: Headers): Promise<string | null> {
  const look = await hostLook(db, headers.get("host"));
  return look ? `https://${look.host}` : null;
}

export const listHosts = (db: Database) => db.select().from(hosts).orderBy(hosts.host);

/** The host an operator names, or the refusal: not a hostname, or one of this server's own (`own`). */
function registrable(host: string, own: ReadonlySet<string>) {
  const h = normalizeHost(host);
  if (!h) throw new ValidationError("Not a hostname", "host.invalid");
  if (own.has(h)) throw new ValidationError("This server already answers on this host", "host.own");
  return h;
}

/**
 * Registers a host or replaces its look (the operator's `PUT /hosts/{host}`). `accent` and `logo` left out are left as
 * they are (none on a new host); null clears them. The logo takes a workspace logo's checks (`readImage`).
 */
export async function putHost(
  deps: { db: Database; blobs: BlobStore },
  own: ReadonlySet<string>,
  host: string,
  input: {
    name: string;
    accent?: string | null;
    logo?: { contentType: string; base64: string } | null;
  },
): Promise<HostLook> {
  const h = registrable(host, own);
  if (input.accent && !isAccentHex(input.accent)) throw new ValidationError("accent must be a #rrggbb color");
  const [before] = await deps.db.select().from(hosts).where(eq(hosts.host, h));
  if (!before) {
    const [{ n } = { n: 0 }] = await deps.db.select({ n: count() }).from(hosts);
    if (n >= HOSTS_MAX) throw new ConflictError(`At most ${HOSTS_MAX} hosts`, "host.too_many", { max: HOSTS_MAX });
  }
  let logo = before?.logo ?? null;
  if (input.logo) {
    const { body, type, file } = readImage({ imageBase64: input.logo.base64, contentType: input.logo.contentType }, "logo");
    logo = `host-logos/${h}/${file}`;
    await deps.blobs.put(logo, body, { contentType: type });
  } else if (input.logo === null) logo = null;
  const accent = input.accent === undefined ? (before?.accent ?? null) : (input.accent?.toLowerCase() ?? null);
  const [row] = await deps.db
    .insert(hosts)
    .values({ host: h, name: input.name, accent, logo })
    .onConflictDoUpdate({ target: hosts.host, set: { name: input.name, accent, logo, updatedAt: sql`now()` } })
    .returning();
  caches.hosts.delete(h);
  if (before?.logo && before.logo !== logo) await deps.blobs.delete(before.logo).catch(() => undefined);
  if (!row) throw new Error("host not saved");
  return row;
}

/** Forgets a host and its stored logo (the operator's `DELETE /hosts/{host}`). False when it wasn't registered. */
export async function deleteHost(deps: { db: Database; blobs: BlobStore }, host: string): Promise<boolean> {
  const h = normalizeHost(host);
  if (!h) return false;
  const [gone] = await deps.db.delete(hosts).where(eq(hosts.host, h)).returning();
  caches.hosts.delete(h);
  if (gone?.logo) await deps.blobs.delete(gone.logo).catch(() => undefined);
  return Boolean(gone);
}

/** The stored logo of the host a `Host` header names, or null (`HOST_LOGO_PATH`). */
export async function hostLogoFile(deps: { db: Database; blobs: BlobStore }, host: string | null | undefined) {
  const look = await hostLook(deps.db, host);
  if (!look?.logo) return null;
  return deps.blobs.get(look.logo);
}

/**
 * Where a person acting on `requestHost` is sent back to (ADR 0194): that host when it is a registered one, else
 * `publicUrl`. For the links a person follows from what they did there: a password reset, a confirmation, an
 * invitation.
 */
export async function baseUrlFor(db: Database, publicUrl: string, requestHost: string | null | undefined) {
  const look = await hostLook(db, requestHost);
  return look ? `https://${look.host}` : publicUrl.replace(/\/$/, "");
}
