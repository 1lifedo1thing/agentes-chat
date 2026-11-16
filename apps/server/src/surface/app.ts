import { schema } from "@agenteschat/db";
import { SURFACE_PREFIX, safeEqual, sha256 } from "@agenteschat/engine";
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
