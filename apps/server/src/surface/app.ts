import { schema } from "@agenteschat/db";
import {
  activeLink,
  claimLink,
  retryInSeconds,
  SURFACE_PREFIX,
  safeEqual,
  sha256,
  TooManyError,
  takeSurfaceCap,
  unlinkExternal,
} from "@agenteschat/engine";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, domainErrorResponse, errorResponse, routeOf, validationHook } from "../http/errors";
import { type AppDeps, json } from "../routes/app/context";

/** Whom a bridge call touched, filled by its route as it learns it; written to `surface_calls` after the answer. */
export interface SurfaceAudit {
  linkId?: string;
  userId?: string;
  orgId?: string;
  externalId?: string;
}

export type SurfaceEnv = { Variables: { audit: SurfaceAudit } };

const tags = ["Surface"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong bridge token"),
};

const CLAIMS_PER_SENDER = { limit: 5, windowMs: 3_600_000 };

const ExternalId = z.string().min(1).max(128).openapi({
  description:
    "The surface's stable, opaque id for the sender. Never a phone number or any address that can change hands.",
});

const Claim = z
  .object({
    externalId: ExternalId,
    display: z
      .string()
      .max(64)
      .nullable()
      .openapi({ description: "What the surface shows of the sender (a number, a handle). Shown only." }),
    profileName: z.string().max(64).nullable().openapi({ description: "The sender's own name there. Untrusted." }),
    code: z.string().min(1).max(32).openapi({ description: "As typed: case, spaces and dashes don't matter." }),
  })
  .strict()
  .openapi("SurfaceClaim");

const Claimed = z
  .object({
    status: z.literal("pending"),
    linkId: z.uuid(),
    expiresAt: z.string().openapi({ description: "The person confirms in the app before this." }),
    locale: z.string().openapi({ description: "The account's app language, for the service's own words." }),
  })
  .openapi("SurfaceClaimed");

const Unlink = z
  .object({ externalId: ExternalId, reason: z.enum(["asked", "identity_changed"]) })
  .strict()
  .openapi("SurfaceUnlink");

const Health = z
  .object({
    ok: z.literal(true),
    surface: z.string().openapi({ description: "This server's `SURFACE_NAME`." }),
    version: z.string(),
  })
  .openapi("SurfaceHealth");

/** The error code of an answer, read from its JSON body; null for a success or a body that isn't one of ours. */
async function errorCode(res: Response): Promise<string | null> {
  if (res.status < 400) return null;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

/**
 * The bridge for an outside chat surface (ADR 0187): what a separate service calls to carry linked people's
 * messages to and from their DM with the right hand, behind its own bearer token. Served only by the operator
 * listener (`operatorFetch`), never by `createApp`.
 */
export function createSurfaceApp(deps: AppDeps, token: string, version: string) {
  const api = new OpenAPIHono<SurfaceEnv>({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "surface", {
    type: "http",
    scheme: "bearer",
    description:
      "This server's `SURFACE_BRIDGE_TOKEN`. It opens only these routes; the operator API's tokens are refused here.",
  });
  // First, so refused and unknown calls are recorded too. After the answer, errors included; never the body.
  api.use("*", async (c, next) => {
    const audit: SurfaceAudit = {};
    c.set("audit", audit);
    try {
      await next();
    } finally {
      const status = c.res?.status ?? 500;
      try {
        await deps.db.insert(schema.surfaceCalls).values({
          method: c.req.method,
          route: routeOf(c),
          status,
          code: c.res ? await errorCode(c.res) : null,
          linkId: audit.linkId ?? null,
          userId: audit.userId ?? null,
          orgId: audit.orgId ?? null,
          externalHash: audit.externalId ? sha256(audit.externalId).slice(0, 16) : null,
        });
      } catch (error) {
        deps.log?.warn("surface call not recorded", { error, route: routeOf(c), status });
      }
    }
  });
  // Every path under the prefix, unknown ones and the document included, so nothing answers without it.
  api.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!safeEqual(given, token)) return apiError(c, 401, "unauthorized", "Missing or wrong bridge token");
    await next();
  });

  api.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags,
      summary: "Whether the bridge answers, and for which surface",
      responses: { 200: json(Health), 401: errors[401] },
    }),
    (c) => c.json({ ok: true as const, surface: deps.config.SURFACE_NAME ?? "", version }, 200),
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/claim",
      tags,
      summary: "A link code typed on the surface: a pending link the person confirms in the app",
      description:
        "Never makes a link active. Wrong, used and expired codes all answer `surface.code_gone`; each try counts against the sender's 5 an hour.",
      request: { body: { required: true, content: { "application/json": { schema: Claim } } } },
      responses: {
        201: json(Claimed),
        ...errors,
        404: errorResponse("Wrong, used or expired code (`surface.code_gone`)"),
        409: errorResponse("The sender is linked to another account (`surface.taken`)"),
        429: errorResponse("`surface.claim_limit` (this sender) or `surface.busy` (all senders), with `retryIn`"),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const audit = c.get("audit");
      audit.externalId = input.externalId;
      await takeSurfaceCap({ db: deps.db, rateLimiter: deps.adapters.rateLimiter, warn: deps.log?.warn }, "claims");
      const tries = await deps.adapters.rateLimiter.consume(
        `surface:claim:${sha256(input.externalId)}`,
        CLAIMS_PER_SENDER,
      );
      if (!tries.allowed) {
        throw new TooManyError("Too many codes from this sender", "surface.claim_limit", {
          retryIn: retryInSeconds(tries.resetAt),
        });
      }
      const { link, expiresAt, locale } = await claimLink({ db: deps.db, pubsub: deps.adapters.pubsub }, input);
      Object.assign(audit, { linkId: link.id, userId: link.userId, orgId: link.orgId ?? undefined });
      return c.json({ status: "pending" as const, linkId: link.id, expiresAt: expiresAt.toISOString(), locale }, 201);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/unlink",
      tags,
      summary: "End a sender's link: they asked, or their identity on the surface changed",
      description: "Pending links of the sender go too. A second call answers `none`.",
      request: { body: { required: true, content: { "application/json": { schema: Unlink } } } },
      responses: {
        200: json(z.object({ status: z.enum(["unlinked", "none"]) }).openapi("SurfaceUnlinked")),
        ...errors,
      },
    }),
    async (c) => {
      const { externalId, reason } = c.req.valid("json");
      const audit = c.get("audit");
      audit.externalId = externalId;
      const link = await activeLink(deps.db, externalId);
      if (link) Object.assign(audit, { linkId: link.id, userId: link.userId, orgId: link.orgId ?? undefined });
      const status = await unlinkExternal({ db: deps.db, pubsub: deps.adapters.pubsub }, externalId, reason);
      return c.json({ status }, 200);
    },
  );

  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat chat surface bridge",
      version,
      description:
        "For the separate service that carries linked people's messages between an outside chat surface and their DM with the workspace's right hand (ADR 0187). Every call is recorded (route, answer, whom it touched; never content).",
    },
    servers: [{ url: SURFACE_PREFIX }],
    security: [{ surface: [] }],
  });

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    deps.log?.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      route: routeOf(c),
      status: 500,
      error,
      stack: error.stack,
    });
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  app.route(SURFACE_PREFIX, api);
  app.notFound((c) => apiError(c, 404, "not_found", "Route not found"));
  return app;
}
