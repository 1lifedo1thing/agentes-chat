import {
  archiveCodeSession,
  type CodeSessionDeps,
  codeSessionDiff,
  codeSessionGit,
  codeStartOptions,
  createCodeSession,
  getCodeSession,
  listCodeSessions,
  postPersonMessage,
  renameCodeSession,
  retryCodeSession,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Code"];

const CodeSession = z
  .object({
    id: z.uuid(),
    channelId: z.uuid().openapi({ description: "The session's conversation (a channel of kind `code`)." }),
    rootId: z.uuid().openapi({ description: "Its root message: the session is that thread's replies." }),
    title: z.string(),
    repo: z.string().openapi({ description: "`owner/name`." }),
    branch: z.string().nullable(),
    baseBranch: z.string().nullable(),
    agentId: z.uuid(),
    machineId: z.uuid().nullable(),
    worktree: z.object({
      state: z.enum(["preparing", "ready", "failed", "removed"]),
      error: z.string().nullable(),
    }),
    pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
    stat: z.object({
      files: z.number().int(),
      added: z.number().int(),
      removed: z.number().int(),
      at: z.string().nullable(),
    }),
    work: z.enum(["preparing", "failed", "working", "waiting", "idle"]).openapi({
      description: "What it is doing now: its worktree being prepared or failed, a live run, waiting on you, or idle.",
    }),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    lastAt: z.string(),
  })
  .openapi("CodeSession");

const SessionParams = OrgParams.extend({ sessionId: z.uuid() });

const CodeDiff = z
  .object({
    scope: z.enum(["base", "uncommitted"]),
    base: z.object({ branch: z.string().nullable(), sha: z.string().nullable() }),
    files: z.array(
      z.object({
        path: z.string(),
        patch: z.string(),
        added: z.number().int(),
        removed: z.number().int(),
        untracked: z.boolean().optional(),
      }),
    ),
    added: z.number().int(),
    removed: z.number().int(),
    truncated: z.boolean(),
  })
  .openapi("CodeDiff");

const CodeGit = z
  .object({
    uncommitted: z.number().int(),
    ahead: z.number().int(),
    upstream: z.boolean(),
    pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
    next: z.enum(["commit", "push", "pr", "merge"]).nullable(),
  })
  .openapi("CodeGit");

/**
 * Code sessions (ADR 0208): a request worked on in its own git worktree on the agent's computer, with its own
 * conversation. The conversation itself goes through the chat's routes (`…/channels/{channelId}/messages` with the
 * root as the thread); these routes open, list, rename and close sessions and read git in their worktree.
 */
export function codeSessionRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const sessions = (): CodeSessionDeps => ({
    db,
    pubsub: adapters.pubsub,
    hub: deps.extras?.sandbox?.machines?.hub ?? null,
    git: deps.extras?.sandbox?.git ?? null,
    ...(deps.log ? { log: deps.log } : {}),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions",
      tags,
      security,
      summary: "The code sessions I take part in, most recent activity first",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ sessions: z.array(CodeSession) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ sessions: await listCodeSessions(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/start",
      tags,
      security,
      summary: "Where a session can start: the agents that think on a computer, with the repositories each may use",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                repos: z.array(z.string()),
                any: z.boolean().openapi({ description: "Its list allows repositories it doesn't name." }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await codeStartOptions(db, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/code-sessions",
      tags,
      security,
      summary: "Opens a code session: its conversation now, its worktree on the agent's computer right after",
      request: {
        params: OrgParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                agentId: z.uuid(),
                repo: z.string().min(3).max(200),
                text: z.string().min(1).max(20_000).openapi({ description: "The request: the first message." }),
              }),
            },
          },
        },
      },
      responses: { 201: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const user = c.get("user");
      const session = await createCodeSession(
        {
          ...sessions(),
          postRequest: (channelId, rootId, text) =>
            postPersonMessage(
              {
                db,
                pubsub: adapters.pubsub,
                judge: deps.extras?.context?.judge,
                talker: deps.extras?.talker,
                gifs: adapters.gifs,
              },
              user.id,
              orgId,
              channelId,
              { body: text, threadId: rootId },
            ),
        },
        user.id,
        orgId,
        c.req.valid("json"),
      );
      deps.wakeWorkers?.();
      return c.json(session, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}",
      tags,
      security,
      summary: "One code session",
      request: { params: SessionParams },
      responses: { 200: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(await getCodeSession(db, c.get("user").id, orgId, sessionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/code-sessions/{sessionId}",
      tags,
      security,
      summary: "Renames a code session",
      request: {
        params: SessionParams,
        body: { content: { "application/json": { schema: z.object({ title: z.string().min(1).max(120) }) } } },
      },
      responses: { 200: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const { title } = c.req.valid("json");
      return c.json(await renameCodeSession(sessions(), c.get("user").id, orgId, sessionId, title), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/retry",
      tags,
      security,
      summary: "Prepares a failed session's worktree again",
      request: { params: SessionParams },
      responses: { 200: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const session = await retryCodeSession(sessions(), c.get("user").id, orgId, sessionId);
      deps.wakeWorkers?.();
      return c.json(session, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/code-sessions/{sessionId}",
      tags,
      security,
      summary: "Closes a code session: out of the list, its worktree removed from the computer (the branch stays)",
      request: { params: SessionParams },
      responses: { 204: { description: "Closed" }, ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      await archiveCodeSession(sessions(), c.get("user").id, orgId, sessionId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/diff",
      tags,
      security,
      summary: "The session's change, read with git in its worktree: since its base, or only what isn't committed",
      request: {
        params: SessionParams,
        query: z.object({ scope: z.enum(["base", "uncommitted"]).default("base") }),
      },
      responses: { 200: json(CodeDiff), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const { scope } = c.req.valid("query");
      return c.json(await codeSessionDiff(sessions(), c.get("user").id, orgId, sessionId, scope), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/git",
      tags,
      security,
      summary: "Where the session's git stands, and the next step its button offers",
      request: { params: SessionParams },
      responses: { 200: json(CodeGit), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(await codeSessionGit(sessions(), c.get("user").id, orgId, sessionId), 200);
    },
  );

  return app;
}
