import {
  confirmLink,
  decideOnSurfacePage,
  emailPinReset,
  listLinks,
  mintLinkCode,
  openSurfacePage,
  removeLink,
  requireSurface,
  resetSurfacePin,
  sha256,
  surfaceAllowed,
  surfaceOn,
  undoSurfaceLink,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { requestLimitIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Account"];

const CODES_PER_HOUR = { limit: 10, windowMs: 3_600_000 };
/** As "This wasn't me": room for a few retries, never for guessing a token. */
const UNDO_PER_IP = { limit: 10, windowMs: 10 * 60_000 };
/** A page reloads and decides a few times; its PIN has its own lock (three wrong ones). */
const PAGE_PER_IP = { limit: 30, windowMs: 10 * 60_000 };
const PIN_EMAILS_PER_IP = { limit: 3, windowMs: 3_600_000 };

const PageToken = z.object({ token: z.string().min(16).max(200) });
const SurfacePage = z
  .object({
    kind: z.enum(["confirm", "screen", "control"]),
    expiresAt: z.string(),
    surface: z.string(),
    pin: z.object({
      set: z.boolean().openapi({ description: "False: approving chooses the PIN." }),
      lockedUntil: z.string().nullable(),
    }),
    approval: z
      .object({
        id: z.uuid(),
        tool: z.string(),
        params: z.record(z.string(), z.unknown()),
        title: z.string(),
        detail: z.string(),
        why: z.string().nullable(),
        kind: z.string(),
        titleParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        status: z.string(),
        canDecide: z.boolean(),
        approverLabel: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("SurfacePage");
const pageGone = errorResponse(
  "Ran out, its link ended, or no longer visible (`surface.page_gone`); opened in another browser (`surface.page_elsewhere`, 403)",
);

/** The cookie that binds one page link to the browser that opened it first. */
const pageCookie = (token: string) => `surface_page_${sha256(token).slice(0, 16)}`;

const SurfaceLink = z
  .object({
    id: z.uuid(),
    status: z.enum(["pending", "active"]),
    display: z
      .string()
      .nullable()
      .openapi({ description: "What the surface shows of the sender: shown, never trusted." }),
    profileName: z.string().nullable().openapi({ description: "The sender's own name on the surface. Untrusted." }),
    orgId: z.uuid().nullable(),
    orgName: z.string().nullable(),
    createdAt: z.string(),
    confirmedAt: z.string().nullable(),
    expiresAt: z.string().nullable().openapi({ description: "Pending only: when it stops counting (10 minutes)." }),
  })
  .openapi("SurfaceLink");

const LinkParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });
const off = errorResponse("Outside chat surfaces are off on this server (`surface.off`)");

/**
 * Linking an outside chat surface to the account (ADR 0187): the person mints a code here, types it on the surface,
 * then confirms the sender it came from. Per person, not per workspace; the link answers in one workspace at a time.
 */
export function surfaceRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/me/surface-links", requireSession(deps.auth));
  app.use("/me/surface-links/*", requireSession(deps.auth));
  app.use("/organizations/*", requireSession(deps.auth));
  const linkDeps = {
    db,
    pubsub: adapters.pubsub,
    publicUrl: adapters.email.delivers === true ? deps.config.PUBLIC_URL : null,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/surface-links",
      tags,
      security,
      summary: "The outside chat surface this server bridges to, whether I may link it, and my links",
      description:
        "`surface` is null and `allowed` false when the bridge is off. `allowed` decides whether the apps offer linking. `links`: active first, then pending ones younger than 10 minutes.",
      responses: {
        200: json(
          z.object({
            surface: z.object({ name: z.string() }).nullable(),
            allowed: z.boolean(),
            links: z.array(SurfaceLink),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) => {
      const user = c.get("user");
      const surface = surfaceOn();
      if (!surface) return c.json({ surface: null, allowed: false, links: [] }, 200);
      return c.json(
        { surface: { name: surface.name }, allowed: surfaceAllowed(user.email), links: await listLinks(db, user.id) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/surface-link/code",
      tags,
      security,
      summary: "A code to type on the outside chat surface, linking it to me in this workspace",
      description:
        "Works for 10 minutes, once; earlier codes keep working until they expire. `openUrl` opens the surface with the code typed.",
      request: { params: OrgParams },
      responses: {
        201: json(z.object({ code: z.string(), openUrl: z.string(), expiresAt: z.string() })),
        401: errors[401],
        403: errorResponse("Not a member (`forbidden`), or not among who may link now (`surface.not_allowed`)"),
        404: off,
        409: errorResponse("The workspace's assistant can't talk to me (`surface.no_assistant`)"),
        429: errorResponse("More than 10 codes in an hour (`rate_limited`)"),
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const user = c.get("user");
      requireSurface();
      if (!surfaceAllowed(user.email)) {
        return apiError(c, 403, "surface.not_allowed", "Linking isn't open to this account yet");
      }
      if (!(await adapters.rateLimiter.consume(`surface-code:${user.id}`, CODES_PER_HOUR)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many codes. Try again later.");
      }
      const minted = await mintLinkCode(db, user.id, orgId);
      return c.json({ ...minted, expiresAt: minted.expiresAt.toISOString() }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/surface-links/{id}/confirm",
      tags,
      security,
      summary: "Confirm a pending link: the sender it shows is me",
      description:
        "Replaces my other link (or moves this sender's link to the pending one's workspace). The surface then says the link is active.",
      request: { params: LinkParams },
      responses: {
        200: json(SurfaceLink),
        401: errors[401],
        404: errorResponse(
          "Not mine, not pending or older than 10 minutes (`surface.link_gone`), or off (`surface.off`)",
        ),
        403: errorResponse("Not among who may link now (`surface.not_allowed`)"),
        409: errorResponse("`surface.taken`, `surface.no_workspace` or `surface.no_assistant`"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = c.get("user");
      if (surfaceOn() && !surfaceAllowed(user.email)) {
        return apiError(c, 403, "surface.not_allowed", "Linking isn't open to this account yet");
      }
      return c.json(await confirmLink(linkDeps, user.id, id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/surface-links/{id}",
      tags,
      security,
      summary: "Cancel a pending link or unlink an active one",
      request: { params: LinkParams },
      responses: {
        ...noContent,
        401: errors[401],
        404: errorResponse("Not mine (`surface.link_gone`), or off (`surface.off`)"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      requireSurface();
      await removeLink(linkDeps, c.get("user").id, id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-undo",
      tags,
      summary: "“Not you? Unlink it”: end the outside chat surface link the email told about",
      description:
        'Public, from the undo page the "linked" email links to (`/email-undo?kind=surface&token=`), never from the link itself: mail scanners open links. Once, within 7 days: ends that link if it is still active (`unlinked` false when it already ended); `surface` and `display` name what the email told about. 404 `surface.undo_gone` once used or run out. 10 tries per 10 minutes per IP address (429 `rate_limited`).',
      request: { body: body(z.object({ token: z.string().min(16).max(200) })) },
      responses: {
        ...errors,
        200: json(z.object({ unlinked: z.boolean(), surface: z.string(), display: z.string().nullable() })),
        404: errorResponse("Used or run out (`surface.undo_gone`)"),
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
      const limit = await adapters.rateLimiter.consume(`surface-undo:${ip}`, UNDO_PER_IP);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      return c.json(await undoSurfaceLink(linkDeps, c.req.valid("json").token), 200);
    },
  );

  const pageLimited = async (c: Context, key: string, limit: { limit: number; windowMs: number }) => {
    const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
    return !(await adapters.rateLimiter.consume(`${key}:${ip}`, limit)).allowed;
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-page/open",
      tags,
      summary: "Open a page the outside chat surface linked to",
      description:
        "Public (ADR 0226). The page posts its token: a chat app's link preview, which only GETs the page, opens nothing. The first open, within 10 minutes of the link, binds it to this browser with a cookie; then only that browser reopens it, for an hour (an agent's screen 30 minutes, control 15). It ends early when its surface link ends or the person can no longer see what it shows. 30 tries per 10 minutes per IP address.",
      request: { body: body(PageToken) },
      responses: {
        ...errors,
        200: json(SurfacePage),
        403: pageGone,
        404: pageGone,
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-page", PAGE_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token } = c.req.valid("json");
      const name = pageCookie(token);
      const opened = await openSurfacePage({ db }, token, getCookie(c, name) ?? null);
      if (opened.secret) {
        setCookie(c, name, opened.secret, {
          path: "/api/app/surface-page",
          httpOnly: true,
          secure: deps.config.PUBLIC_URL.startsWith("https://"),
          sameSite: "Strict",
          maxAge: Math.ceil((Date.parse(opened.view.expiresAt) - Date.now()) / 1000),
        });
      }
      return c.json(opened.view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-page/decide",
      tags,
      summary: "Approve (with my PIN) or refuse the action the page shows",
      description:
        "Only from the browser that opened the page. Approving takes the six-digit PIN; with none set yet, it becomes the PIN. Three wrong PINs lock approving for 15 minutes (`surface.pin_locked`, with `until`). Who may decide is the app's rule.",
      request: {
        body: body(
          PageToken.extend({
            decision: z.enum(["approve", "refuse"]),
            pin: z.string().max(20).optional(),
          }),
        ),
      },
      responses: {
        ...errors,
        200: json(SurfacePage),
        403: errorResponse(
          "`surface.pin_wrong` (with `left`), `surface.page_elsewhere`, or not one who decides it (`forbidden`)",
        ),
        404: pageGone,
        409: errorResponse("Already decided or expired (`conflict`)"),
        429: errorResponse("`surface.pin_locked` (with `until`) or `rate_limited`"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-page", PAGE_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token, decision, pin } = c.req.valid("json");
      const view = await decideOnSurfacePage(
        { db, pubsub: adapters.pubsub },
        token,
        getCookie(c, pageCookie(token)) ?? null,
        { decision, pin },
      );
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-page/forgot-pin",
      tags,
      summary: "Email me a link that clears my PIN",
      description: "Only from the browser that opened the page. 3 emails an hour per IP address.",
      request: { body: body(PageToken) },
      responses: {
        ...noContent,
        ...errors,
        403: pageGone,
        404: pageGone,
        429: errorResponse("Too many emails (`rate_limited`)"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-pin-email", PIN_EMAILS_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      const { token } = c.req.valid("json");
      await emailPinReset({ db, publicUrl: deps.config.PUBLIC_URL }, token, getCookie(c, pageCookie(token)) ?? null);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/surface-pin-reset",
      tags,
      summary: "Clear my PIN, from the emailed link",
      description:
        "Public, from the page the PIN email links to (`/email-undo?kind=surface-pin&token=`). Once, within an hour. 10 tries per 10 minutes per IP address.",
      request: { body: body(PageToken) },
      responses: {
        ...errors,
        200: json(z.object({ surface: z.string() })),
        404: errorResponse("Used or run out (`surface.pin_reset_gone`)"),
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      if (await pageLimited(c, "surface-pin-reset", UNDO_PER_IP)) {
        return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      }
      return c.json(await resetSurfacePin(db, c.req.valid("json").token), 200);
    },
  );

  return app;
}
