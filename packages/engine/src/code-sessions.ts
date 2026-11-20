import {
  type AgentScope,
  gitCheckoutDir,
  MISSION_WORKTREE_PROTOCOL,
  type PubSub,
  parseMissionWorktreeEnsured,
} from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNotNull, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { caches } from "./cache";
import { requireChannelAccess } from "./channels";
import { createAgentRuns } from "./dispatch";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { cutTextEnd } from "./format";
import { cloneOnMachine, type MachineGitDeps } from "./git/machine";
import { agentRepositoryList, parseRepo, repoInList } from "./git/repos";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { MachineOfflineError, MachinePausedError } from "./machines";
import { getMessage } from "./messages";
import { branchSlug } from "./mission-worktree";
import { can, getMembership } from "./organizations";

/*
 * Code sessions (ADR 0208): a request worked on in its own git worktree on the agent's computer. The session's
 * conversation is a thread in a channel of kind `code` (the task conversation's model, ADR 0145): runs, steering,
 * stop, approvals, live events and the thread screens work unchanged. Its agent answers there like in a DM, and its
 * computer brain works with the worktree as its folder (`codeSessionCwd`, read by `resolveBrain`).
 */

const { codeSessions, channels, channelMembers, messages, agentRuns, notifications } = schema;

export type CodeSessionRow = typeof codeSessions.$inferSelect;
export const CODE_WORKTREE_STATES = ["preparing", "ready", "failed", "removed"] as const;
export type CodeWorktreeState = (typeof CODE_WORKTREE_STATES)[number];
export const codeWorktreeStateOf = (v: unknown): CodeWorktreeState =>
  typeof v === "string" && (CODE_WORKTREE_STATES as readonly string[]).includes(v) ? (v as CodeWorktreeState) : "failed";

/**
 * The brains a code session can have: those that work on the agent's computer in the folder their turn names (the
 * worktree, `codeSessionCwd`). The other CLI brains start in the agent's folder whatever the turn says.
 */
export const CODE_BRAINS = ["claude_code", "codex"] as const;

/** `ensure` copies `.env*` files and may prune: more than a plain request (as for a mission). */
const ENSURE_TIMEOUT_MS = 120_000;
/** A clone still running on the computer is asked again this often, this many times. */
const CLONE_RETRY_MS = 15_000;
const CLONE_RETRIES = 40;
/** A git command for the panel (diff, status) never runs longer than this. */
const GIT_READ_SECONDS = 30;
/** The diff the panel reads: past this, the files are listed without their patch. */
const DIFF_MAX_CHARS = 1_500_000;
/** What a failed worktree keeps of the reason. */
const ERROR_CHARS = 2_000;
/** The request: as long as a chat message may be. */
const REQUEST_MAX_CHARS = 20_000;

export interface CodeSessionDeps {
  db: Database;
  pubsub?: PubSub;
  /** Connected computers: makes the worktree and reads git there. */
  hub?: MachineCaller | null;
  /** Our public URL and secret, for the git proxy the clone goes through (`machineGitSetup`). */
  git?: MachineGitDeps["git"] | null;
  /** Our GitHub App, for fetching straight from GitHub where it is installed. */
  github?: MachineGitDeps["github"];
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/** The root message's `meta.codeSession`: never drawn, never routed. */
export interface CodeSessionMeta {
  sessionId: string;
  repo: string;
  title: string;
}

export function codeSessionOf(meta: unknown): CodeSessionMeta | null {
  const v = (meta as { codeSession?: unknown } | null)?.codeSession as Partial<CodeSessionMeta> | undefined;
  if (!v || typeof v.sessionId !== "string" || typeof v.repo !== "string") return null;
  return { sessionId: v.sessionId, repo: v.repo, title: typeof v.title === "string" ? v.title : "" };
}

const shortId = (id: string) => id.replace(/-/g, "").slice(-8);

/** The session's folder, relative to the agent's folder (`.worktrees/` stays out of git on the runner). */
export const codeWorktreePath = (sessionId: string) => `.worktrees/c-${shortId(sessionId)}`;

/**
 * `agentes/<handle>/<slug of the title>-<4 hex>`: under the agent's own prefix, the only new branches the git proxy
 * lets it push (`refRule`); the tail keeps two sessions with the same title apart.
 */
export const codeBranchName = (handle: string, title: string, sessionId: string) =>
  `agentes/${handle}/${branchSlug(title) || "work"}-${shortId(sessionId).slice(-4)}`;

/**
 * The session's name from the request: its first sentence of its first line, without a trailing period, capitalized,
 * at most 72 characters (cut at a word). People rename it.
 */
export function titleOfRequest(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const sentence = (/^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line).replace(/[.!?]+$/, "").trim();
  const clean = sentence.replace(/\s+/g, " ");
  const cut = clean.length > 72 ? `${clean.slice(0, 72).replace(/\s+\S*$/, "")}…` : clean;
  return cut ? cut.charAt(0).toLocaleUpperCase() + cut.slice(1) : "Code session";
}

/** The session's agent, for the chat's routing: what names nobody in the session is for it, once it can work. */
export const codeAgentSql = (channelId: SQL) =>
  sql`(select cs.agent_id from ${codeSessions} cs
    join ${schema.agents} ca on ca.id = cs.agent_id and ca.archived_at is null
    where cs.channel_id = ${channelId} and cs.archived_at is null and cs.worktree_state = 'ready' limit 1)`;

/**
 * Who a person names in a session's conversation joins it (ADR 0208): an agent of the workspace by its handle (so the
 * mention wakes it there), a person of the workspace too (they see and talk in the session from then on; what they
 * may do on the computer stays the computer's rule). Returns nothing; the members cache is dropped.
 */
export async function admitCodeMembers(db: Executor, orgId: string, channelId: string, handles: string[]) {
  const clean = [...new Set(handles.map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9_.-]+$/.test(h)))];
  if (clean.length === 0) return;
  const list = `{${clean.join(",")}}`;
  await db.execute(sql`insert into ${channelMembers} (org_id, channel_id, agent_id, auto_reply)
    select a.org_id, ${channelId}::uuid, a.id, true from ${schema.agents} a
    where a.org_id = ${orgId}::uuid and a.archived_at is null and a.deleted_at is null
      and lower(a.handle) = any(${list}::text[])
    on conflict do nothing`);
  await db.execute(sql`insert into ${channelMembers} (org_id, channel_id, user_id)
    select om.org_id, ${channelId}::uuid, om.user_id from ${schema.organizationMembers} om
    where om.org_id = ${orgId}::uuid and lower(om.handle) = any(${list}::text[])
    on conflict do nothing`);
  caches.channelMembers.delete(`${orgId}:${channelId}`);
}

/** The session whose conversation is `channelId`, if any. */
export async function codeSessionOfChannel(db: Executor, channelId: string): Promise<CodeSessionRow | null> {
  const [row] = await db.select().from(codeSessions).where(eq(codeSessions.channelId, channelId)).limit(1);
  return row ?? null;
}

/**
 * Where a computer brain's turn in this conversation works: the session's worktree once it is ready (relative to the
 * agent's folder, as the runner resolves it), else null (not a session's conversation, or its folder isn't there).
 */
export async function codeSessionCwd(db: Executor, channelId: string, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ path: codeSessions.worktreePath, state: codeSessions.worktreeState, agentId: codeSessions.agentId })
    .from(codeSessions)
    .where(and(eq(codeSessions.channelId, channelId), isNull(codeSessions.archivedAt)))
    .limit(1);
  if (!row || row.state !== "ready" || !row.path) return null;
  // Another agent called into the session works in its own folder: the worktree is on the session agent's computer.
  return row.agentId === agentId ? row.path : null;
}

/**
 * What a run in the session reads about it (in its context, never shown): the repository, the branch and where it
 * started, the folder it works in, and how to work there. `first`: the session's first turn (the project may need
 * installing).
 */
export async function codeSessionBrief(
  db: Executor,
  channelId: string,
  agentId: string,
  options: { first?: boolean } = {},
): Promise<string | null> {
  const row = await codeSessionOfChannel(db, channelId);
  if (!row || row.archivedAt) return null;
  const own = row.agentId === agentId;
  const lines = [
    "# This conversation: a code session",
    `A person opened this session to work on ${row.repo}: "${row.title}".`,
  ];
  if (own && row.worktreeState === "ready" && row.worktreePath) {
    lines.push(
      `You work in its own git worktree, \`${row.worktreePath}\` (your folder for this conversation), on branch \`${row.branch ?? "?"}\`, made from \`${row.baseBranch ?? "the default branch"}\`${row.baseSha ? ` at ${row.baseSha.slice(0, 7)}` : ""}.`,
      "Work like in a terminal with this person: read, change and run things in that folder, and say what you did in a few words. Don't touch other checkouts.",
      "Commit when a piece of work is done, with a short message. Push and open a pull request only when the person asks (the session's git button asks you in words).",
    );
    if (options.first && row.setupCommand)
      lines.push(`The worktree is new: install the project first if it needs it (\`${row.setupCommand}\`).`);
  } else if (own && row.worktreeState === "preparing") {
    lines.push("Its worktree is still being prepared on your computer; nothing to change yet.");
  } else if (!own) {
    lines.push(
      "Another agent works in this session's worktree; you were called in to help (read, review, test). Don't change its files.",
    );
  }
  return lines.join("\n");
}

/** One session as the apps show it. */
export interface CodeSessionView {
  id: string;
  channelId: string;
  rootId: string;
  title: string;
  repo: string;
  branch: string | null;
  baseBranch: string | null;
  agentId: string;
  machineId: string | null;
  worktree: { state: CodeWorktreeState; error: string | null };
  pr: { number: number; url: string | null } | null;
  stat: { files: number; added: number; removed: number; at: string | null };
  /** What it is doing now, for the list: preparing, failed, working (a live run), waiting (on this person), idle. */
  work: "preparing" | "failed" | "working" | "waiting" | "idle";
  createdBy: string | null;
  createdAt: string;
  lastAt: string;
}

function viewOf(
  row: CodeSessionRow,
  facts: { working: boolean; waiting: boolean; lastAt: Date | null },
): CodeSessionView {
  const state = codeWorktreeStateOf(row.worktreeState);
  const work =
    state === "preparing"
      ? "preparing"
      : state === "failed"
        ? "failed"
        : facts.waiting
          ? "waiting"
          : facts.working
            ? "working"
            : "idle";
  return {
    id: row.id,
    channelId: row.channelId,
    rootId: row.rootMessageId,
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    baseBranch: row.baseBranch,
    agentId: row.agentId,
    machineId: row.machineId,
    worktree: { state, error: row.worktreeError },
    pr: row.prNumber ? { number: row.prNumber, url: row.prUrl } : null,
    stat: { files: row.files, added: row.added, removed: row.removed, at: row.statAt?.toISOString() ?? null },
    work,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastAt: (facts.lastAt ?? row.updatedAt).toISOString(),
  };
}

/** Live runs, what waits on `userId`, and the last message, for these sessions' conversations (one query each). */
async function factsFor(db: Executor, orgId: string, userId: string, rows: CodeSessionRow[]) {
  const ids = rows.map((r) => r.channelId);
  if (ids.length === 0) return new Map<string, { working: boolean; waiting: boolean; lastAt: Date | null }>();
  const [live, waiting, last] = await Promise.all([
    db
      .selectDistinct({ channelId: agentRuns.channelId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          inArray(agentRuns.channelId, ids),
          inArray(agentRuns.status, ["queued", "running", "waiting_approval"]),
        ),
      ),
    db
      .select({ channelId: sql<string>`${notifications.source}->>'channelId'` })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
          eq(notifications.waiting, true),
          isNull(notifications.doneAt),
          sql`${notifications.source}->>'channelId' in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      ),
    db
      .select({ channelId: messages.channelId, at: sql<Date>`max(${messages.createdAt})` })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.channelId, ids), isNull(messages.deletedAt)))
      .groupBy(messages.channelId),
  ]);
  const liveSet = new Set(live.map((r) => r.channelId));
  const waitSet = new Set(waiting.map((r) => r.channelId));
  const lastBy = new Map(last.map((r) => [r.channelId, r.at ? new Date(r.at) : null]));
  return new Map(
    ids.map((id) => [id, { working: liveSet.has(id), waiting: waitSet.has(id), lastAt: lastBy.get(id) ?? null }]),
  );
}

async function requireMember(db: Executor, userId: string, orgId: string) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  return membership;
}

/**
 * The sessions `userId` takes part in (a member of the conversation: who opened it and who was called in), newest
 * activity first, archived ones left out.
 */
export async function listCodeSessions(db: Database, userId: string, orgId: string): Promise<CodeSessionView[]> {
  await requireMember(db, userId, orgId);
  const rows = await db
    .select({ session: codeSessions })
    .from(codeSessions)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.channelId, codeSessions.channelId), eq(channelMembers.userId, userId)),
    )
    .where(and(eq(codeSessions.orgId, orgId), isNull(codeSessions.archivedAt)))
    .orderBy(desc(codeSessions.updatedAt))
    .limit(200);
  const sessions = rows.map((r) => r.session);
  const facts = await factsFor(db, orgId, userId, sessions);
  return sessions
    .map((s) => viewOf(s, facts.get(s.channelId) ?? { working: false, waiting: false, lastAt: null }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** One session, for whoever reads its conversation (the channel's own check, `requireChannelAccess`). */
export async function requireCodeSession(db: Database, userId: string, orgId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(codeSessions)
    .where(and(eq(codeSessions.id, sessionId), eq(codeSessions.orgId, orgId)))
    .limit(1);
  if (!row || row.archivedAt) throw new NotFoundError("Code session not found");
  await requireChannelAccess(db, userId, orgId, row.channelId);
  return row;
}

export async function getCodeSession(db: Database, userId: string, orgId: string, sessionId: string) {
  const row = await requireCodeSession(db, userId, orgId, sessionId);
  const facts = await factsFor(db, orgId, userId, [row]);
  return viewOf(row, facts.get(row.channelId) ?? { working: false, waiting: false, lastAt: null });
}

/** Tells the session's people its row changed (the list and the header refetch). */
async function announce(deps: Pick<CodeSessionDeps, "db" | "pubsub">, row: CodeSessionRow) {
  if (!deps.pubsub) return;
  const people = await deps.db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, row.channelId), sql`${channelMembers.userId} is not null`));
  for (const p of people) {
    if (p.userId)
      await publishUserEvent(deps.pubsub, row.orgId, p.userId, { type: "code_session.updated", sessionId: row.id });
  }
}

async function setSession(deps: Pick<CodeSessionDeps, "db" | "pubsub">, row: CodeSessionRow, patch: Partial<CodeSessionRow>) {
  const [fresh] = await deps.db
    .update(codeSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(codeSessions.id, row.id))
    .returning();
  const next = fresh ?? row;
  await announce(deps, next);
  return next;
}

export interface CreateCodeSessionInput {
  agentId: string;
  /** `owner/name` (or a GitHub URL). */
  repo: string;
  /** The request: the conversation's first message. */
  text: string;
}

/**
 * Opens a session: its conversation (a `code` channel with the person and the agent as members, and the root), the
 * row, then the request as the first reply through the chat's own path. The worktree is made after (`prepare`); the
 * request waits for it (`codeAgentSql` reads only a ready session) and goes to the agent once it is ready.
 */
export async function createCodeSession(
  deps: CodeSessionDeps & { postRequest: (channelId: string, rootId: string, text: string) => Promise<unknown> },
  userId: string,
  orgId: string,
  input: CreateCodeSessionInput,
): Promise<CodeSessionView> {
  const membership = await requireMember(deps.db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError("You can't post in this workspace");
  const text = input.text.trim();
  if (!text) throw new ValidationError("Say what to do", "code_session.empty");
  if (text.length > REQUEST_MAX_CHARS) throw new ValidationError("The request is too long", "code_session.too_long");
  const parsed = parseRepo(input.repo);
  if (!parsed) throw new ValidationError("repo must be owner/name", "code_session.bad_repo");
  const repo = `${parsed.owner}/${parsed.repo}`;
  const agent = await getAgentCached(deps.db, orgId, input.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!(CODE_BRAINS as readonly string[]).includes(agent.brain))
    throw new ValidationError("This agent doesn't think on a computer", "code_session.no_computer_brain", {
      agent: agent.name,
    });
  if (!agent.machineId)
    throw new ValidationError("This agent has no computer", "code_session.no_computer", { agent: agent.name });
  if (!repoInList(await agentRepositoryList(deps.db, orgId, agent.id), parsed.owner, parsed.repo))
    throw new ValidationError("This agent can't work in that repository", "code_session.repo_not_allowed", {
      agent: agent.name,
      repo,
    });

  const id = Bun.randomUUIDv7();
  const title = titleOfRequest(text);
  const row = await deps.db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId,
        // Internal (never listed): unique per workspace, readable in an agent's prompt.
        name: `code-${shortId(id)}`,
        kind: "code",
        visibility: "private",
        createdByUserId: userId,
      })
      .returning({ id: channels.id });
    if (!channel) throw new Error("channel insert returned nothing");
    // Written directly: the root is never shown, indexed, routed or notified.
    const [root] = await tx
      .insert(messages)
      .values({
        orgId,
        channelId: channel.id,
        authorType: "person",
        authorUserId: userId,
        body: `Code session: ${title}`.slice(0, 2_000),
        meta: { codeSession: { sessionId: id, repo, title } satisfies CodeSessionMeta },
      })
      .returning({ id: messages.id });
    if (!root) throw new Error("root insert returned nothing");
    await tx.insert(channelMembers).values([
      { orgId, channelId: channel.id, userId },
      { orgId, channelId: channel.id, agentId: agent.id, autoReply: true },
    ]);
    const [session] = await tx
      .insert(codeSessions)
      .values({
        id,
        orgId,
        channelId: channel.id,
        rootMessageId: root.id,
        agentId: agent.id,
        machineId: agent.machineId,
        repo,
        repoDir: gitCheckoutDir(repo),
        title,
        branch: codeBranchName(agent.handle, title, id),
        worktreePath: codeWorktreePath(id),
        worktreeState: "preparing",
        createdBy: userId,
      })
      .returning();
    if (!session) throw new Error("session insert returned nothing");
    return session;
  });
  await deps.postRequest(row.channelId, row.rootMessageId, text);
  await announce(deps, row);
  // The worktree is made in the background: the conversation shows it preparing meanwhile.
  void prepareCodeSession(deps, row.id).catch((error) =>
    deps.log?.warn("code session prepare failed", { sessionId: row.id, error: String(error) }),
  );
  return getCodeSession(deps.db, userId, orgId, row.id);
}

/** Sessions being prepared in this process (a second call while one runs does nothing). */
const preparing = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes the session's worktree on the agent's computer: the repository's checkout first (`git.sync`, through our
 * proxy), then the worktree on the session's branch (`mission.worktree`, ADR 0044), then the request goes to the
 * agent. Offline, paused or a runner too old: nothing changes (tried again when the computer is back,
 * `ensureCodeSessionsOn`). Idempotent.
 */
export async function prepareCodeSession(deps: CodeSessionDeps, sessionId: string): Promise<CodeSessionRow | null> {
  if (preparing.has(sessionId)) return null;
  preparing.add(sessionId);
  try {
    return await prepare(deps, sessionId);
  } finally {
    preparing.delete(sessionId);
  }
}

async function prepare(deps: CodeSessionDeps, sessionId: string): Promise<CodeSessionRow | null> {
  const [found] = await deps.db.select().from(codeSessions).where(eq(codeSessions.id, sessionId)).limit(1);
  let row = found ?? null;
  if (!row || row.archivedAt || row.worktreeState === "ready" || row.worktreeState === "removed") return row;
  const hub = deps.hub;
  if (!hub || !row.machineId) return row;
  const machineId = row.machineId;
  const status = await hub.status(machineId).catch(() => null);
  if (!status?.online || status.orgId !== row.orgId || status.protocol < MISSION_WORKTREE_PROTOCOL) return row;
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (!agent) return row;
  const scope: AgentScope = { id: agent.id, handle: agent.handle };
  if (row.worktreeState === "failed") row = await setSession(deps, row, { worktreeState: "preparing", worktreeError: null });

  // The checkout, cloned or brought up to date (a clone may still be running: asked again for a while).
  let repoDir = row.repoDir;
  if (deps.git) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const synced = await cloneOnMachine(
          { db: deps.db, hub, git: deps.git, github: deps.github ?? null },
          { orgId: row.orgId, agentId: row.agentId, machineId, scope },
          { repo: row.repo, dir: row.repoDir },
        );
        repoDir = synced.dir || row.repoDir;
        if (synced.status !== "cloning") break;
      } catch (error) {
        if (error instanceof MachineOfflineError || error instanceof MachinePausedError) return row;
        return failSession(deps, row, error instanceof Error ? error.message : String(error));
      }
      if (attempt >= CLONE_RETRIES) return failSession(deps, row, "The repository took too long to clone.");
      await sleep(CLONE_RETRY_MS);
    }
  }

  let reply: unknown;
  try {
    reply = await hub.call<"mission.worktree">(
      machineId,
      {
        op: "mission.worktree",
        action: "ensure",
        repo: repoDir,
        path: row.worktreePath ?? codeWorktreePath(row.id),
        branch: row.branch ?? codeBranchName(agent.handle, row.title, row.id),
        ...(row.baseSha ? { baseSha: row.baseSha } : {}),
        agent: scope,
      },
      { timeoutMs: ENSURE_TIMEOUT_MS },
    );
  } catch (error) {
    const code = error instanceof MachineRequestError ? error.code : null;
    if (
      error instanceof MachineOfflineError ||
      error instanceof MachinePausedError ||
      code === "timeout" ||
      code === "canceled" ||
      code === "paused"
    )
      return row;
    const message = error instanceof Error ? error.message : String(error);
    return failSession(deps, row, code === "not_git" ? "The repository's folder isn't a git repository." : message);
  }
  const got = parseMissionWorktreeEnsured(reply);
  row = await setSession(deps, row, {
    repoDir,
    worktreePath: got?.path || row.worktreePath,
    branch: got?.branch || row.branch,
    baseBranch: row.baseBranch ?? got?.baseBranch ?? null,
    baseSha: row.baseSha ?? got?.baseSha ?? null,
    setupCommand: got?.setupCommand ?? null,
    worktreeState: "ready",
    worktreeError: null,
  });
  await releaseRequest(deps, row);
  return row;
}

async function failSession(deps: CodeSessionDeps, row: CodeSessionRow, error: string) {
  return setSession(deps, row, { worktreeState: "failed", worktreeError: cutTextEnd(error, ERROR_CHARS) });
}

/**
 * Once the worktree is ready: the people's messages that waited for it go to the agent as one run (the newest
 * starts it; the run reads the thread). Nothing when a run already answered after them.
 */
async function releaseRequest(deps: CodeSessionDeps, row: CodeSessionRow) {
  const [lastPerson] = await deps.db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, row.orgId),
        eq(messages.channelId, row.channelId),
        eq(messages.threadId, row.rootMessageId),
        eq(messages.authorType, "person"),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!lastPerson) return;
  const [answered] = await deps.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, row.orgId),
        eq(agentRuns.channelId, row.channelId),
        eq(agentRuns.agentId, row.agentId),
        sql`${agentRuns.createdAt} >= ${lastPerson.createdAt}`,
      ),
    )
    .limit(1);
  if (answered) return;
  const message = await getMessage(deps.db, row.orgId, lastPerson.id);
  if (!message) return;
  const runs = await deps.db.transaction((tx) => createAgentRuns(tx, message, [row.agentId], "dm"));
  for (const run of runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: row.rootMessageId,
      agentId: run.agentId,
      runId: run.id,
    });
  }
}

/** The computer came back: its sessions still being prepared (or failed for a reason that may pass) try again. */
export async function ensureCodeSessionsOn(deps: CodeSessionDeps, machineId: string) {
  const rows = await deps.db
    .select({ id: codeSessions.id })
    .from(codeSessions)
    .where(
      and(
        eq(codeSessions.machineId, machineId),
        isNull(codeSessions.archivedAt),
        eq(codeSessions.worktreeState, "preparing"),
      ),
    );
  for (const r of rows) await prepareCodeSession(deps, r.id).catch(() => null);
}

/** "Tentar de novo" on a failed session: prepared again from where it stopped. */
export async function retryCodeSession(deps: CodeSessionDeps, userId: string, orgId: string, sessionId: string) {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  if (row.worktreeState !== "failed") throw new ConflictError("This session isn't failed", "code_session.not_failed");
  await setSession(deps, row, { worktreeState: "preparing", worktreeError: null });
  void prepareCodeSession(deps, row.id).catch(() => null);
  return getCodeSession(deps.db, userId, orgId, row.id);
}

/**
 * Where a person can start a session: the workspace's agents that think on a computer (Claude Code, Codex) and have
 * one, each with the repositories it may work in (`any`: its list allows more than it names, so any `owner/name` the
 * person types is tried).
 */
export async function codeStartOptions(db: Database, userId: string, orgId: string) {
  await requireMember(db, userId, orgId);
  const rows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        isNull(schema.agents.archivedAt),
        isNull(schema.agents.deletedAt),
        inArray(schema.agents.brain, [...CODE_BRAINS]),
        isNotNull(schema.agents.machineId),
      ),
    );
  const agents = [];
  for (const a of rows) {
    const list = await agentRepositoryList(db, orgId, a.id);
    const repos = list.filter((r) => !r.endsWith("/*"));
    agents.push({ agentId: a.id, repos, any: list.length === 0 || repos.length < list.length });
  }
  return { agents };
}

/** Renames the session (any member). */
export async function renameCodeSession(
  deps: Pick<CodeSessionDeps, "db" | "pubsub">,
  userId: string,
  orgId: string,
  sessionId: string,
  title: string,
) {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const clean = title.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) throw new ValidationError("A name is needed", "code_session.empty_title");
  await setSession(deps, row, { title: clean });
  return getCodeSession(deps.db, userId, orgId, sessionId);
}

/**
 * Closes the session: out of everyone's list, its conversation archived, and the worktree removed from the computer
 * (its branch stays: pushed work is not lost). Who opened it, or an administrator.
 */
export async function archiveCodeSession(deps: CodeSessionDeps, userId: string, orgId: string, sessionId: string) {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const membership = await requireMember(deps.db, userId, orgId);
  if (row.createdBy !== userId && !can(membership, "administrator"))
    throw new ForbiddenError("Only who opened the session closes it", "code_session.not_yours");
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await tx.update(codeSessions).set({ archivedAt: now, updatedAt: now }).where(eq(codeSessions.id, row.id));
    await tx.update(channels).set({ archivedAt: now }).where(eq(channels.id, row.channelId));
  });
  await announce(deps, row);
  if (deps.hub && row.machineId && row.worktreePath && row.worktreeState === "ready") {
    const agent = await getAgentCached(deps.db, orgId, row.agentId);
    if (agent)
      await deps.hub
        .call<"mission.worktree">(row.machineId, {
          op: "mission.worktree",
          action: "remove",
          repo: row.repoDir,
          path: row.worktreePath,
          // The branch stays: what was pushed (or only committed) is never lost with the folder.
          branch: row.branch ?? "",
          deleteBranch: false,
          agent: { id: agent.id, handle: agent.handle },
        })
        .then(() => deps.db.update(codeSessions).set({ worktreeState: "removed" }).where(eq(codeSessions.id, row.id)))
        .catch(() => null);
  }
}

/* ───────── git in the worktree, for the panel ───────── */

/** What the diff covers: everything since the base (committed or not), or only what isn't committed. */
export type CodeDiffScope = "base" | "uncommitted";

export interface CodeDiffFile {
  path: string;
  /** The file's unified patch (`diff --git …`); empty when the diff was too large to send. */
  patch: string;
  added: number;
  removed: number;
  /** Not tracked by git yet (a new file). */
  untracked?: boolean;
}

export interface CodeDiff {
  scope: CodeDiffScope;
  base: { branch: string | null; sha: string | null };
  files: CodeDiffFile[];
  added: number;
  removed: number;
  /** The patches were left out: too large to send. */
  truncated: boolean;
}

/** A read-only git command in the session's worktree, as its agent (the runner's command policy reads it as a read). */
async function gitRead(deps: CodeSessionDeps, row: CodeSessionRow, args: string): Promise<string> {
  if (!deps.hub || !row.machineId) throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
  if (row.worktreeState !== "ready" || !row.worktreePath)
    throw new ConflictError("The worktree isn't ready yet", "code_session.not_ready");
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  let out: { exitCode: number; stdout: string; stderr: string };
  try {
    out = await deps.hub.call<"exec">(row.machineId, {
      op: "exec",
      command: `git --no-pager ${args}`,
      cwd: row.worktreePath,
      timeoutSeconds: GIT_READ_SECONDS,
      stream: false,
      agent: { id: agent.id, handle: agent.handle },
    });
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError)
      throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
    throw error;
  }
  if (out.exitCode !== 0) throw new ConflictError(out.stderr.trim() || "git failed", "code_session.git_failed");
  return out.stdout;
}

/** Splits `git diff` output into one patch per file, with its line counts. */
export function splitPatch(text: string): CodeDiffFile[] {
  const files: CodeDiffFile[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const path = header?.[2] ?? header?.[1] ?? "?";
    let added = 0;
    let removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    files.push({ path, patch: chunk.replace(/\n$/, ""), added, removed });
  }
  return files;
}

/**
 * The session's change for the panel: against the base commit (everything since it started, committed or not) or
 * against HEAD (only what isn't committed), new untracked files included as whole-file additions. Also keeps the
 * list's counts up to date.
 */
export async function codeSessionDiff(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
  scope: CodeDiffScope,
): Promise<CodeDiff> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const against = scope === "base" ? row.baseSha || row.baseBranch || "HEAD" : "HEAD";
  const [tracked, untrackedList] = await Promise.all([
    gitRead(deps, row, `diff --no-color --no-ext-diff -M ${shellQuote(against)}`),
    gitRead(deps, row, "ls-files --others --exclude-standard -z"),
  ]);
  const files = splitPatch(tracked);
  const untracked = untrackedList.split("\0").filter(Boolean).slice(0, 200);
  for (const path of untracked) {
    // `git diff --no-index` exits 1 when files differ: read through `|| true` so the patch comes back.
    const patch = await gitRead(
      deps,
      row,
      `diff --no-color --no-index -- /dev/null ${shellQuote(path)} || true`,
    ).catch(() => "");
    const [file] = splitPatch(patch);
    files.push({ path, patch: file?.patch ?? "", added: file?.added ?? 0, removed: 0, untracked: true });
  }
  const size = files.reduce((n, f) => n + f.patch.length, 0);
  const truncated = size > DIFF_MAX_CHARS;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  if (scope === "base")
    await deps.db
      .update(codeSessions)
      .set({ files: files.length, added, removed, statAt: new Date() })
      .where(eq(codeSessions.id, row.id));
  return {
    scope,
    base: { branch: row.baseBranch, sha: row.baseSha },
    files: truncated ? files.map((f) => ({ ...f, patch: "" })) : files,
    added,
    removed,
    truncated,
  };
}

/** Single-quoted for the shell (git paths may have spaces). */
export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Where the session's git stands, for the header's button: changes not committed, commits not pushed (or not on any
 * remote branch yet), and the pull request when there is one. `next` is the step the button offers.
 */
export interface CodeGitState {
  uncommitted: number;
  ahead: number;
  upstream: boolean;
  pr: { number: number; url: string | null } | null;
  next: "commit" | "push" | "pr" | "merge" | null;
}

export async function codeSessionGit(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
): Promise<CodeGitState> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const status = await gitRead(deps, row, "status --porcelain=v1 --branch");
  const lines = status.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? (lines.shift() ?? "") : "";
  const uncommitted = lines.length;
  let upstream = /\.\.\.\S+/.test(head);
  const aheadMatch = /\[(?:[^\]]*?)ahead (\d+)/.exec(head);
  let ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  if (!upstream && row.branch) {
    // Pushed without tracking (`git push origin <branch>`): the remote branch's local copy says what is still ahead.
    const remote = `refs/remotes/origin/${row.branch}`;
    const known = await gitRead(deps, row, `rev-parse --verify --quiet ${shellQuote(remote)}`).catch(() => "");
    if (known.trim()) {
      upstream = true;
      const count = await gitRead(deps, row, `rev-list --count ${shellQuote(remote)}..HEAD`).catch(() => "0");
      ahead = Number(count.trim()) || 0;
    }
  }
  if (!upstream && row.baseSha) {
    const count = await gitRead(deps, row, `rev-list --count ${shellQuote(row.baseSha)}..HEAD`).catch(() => "0");
    ahead = Number(count.trim()) || 0;
  }
  const pr = row.prNumber ? { number: row.prNumber, url: row.prUrl } : null;
  // Sessions are made from GitHub repositories (`owner/name`), so a pushed branch can always become a pull request.
  const next = uncommitted > 0 ? "commit" : ahead > 0 ? "push" : pr ? "merge" : upstream ? "pr" : null;
  return { uncommitted, ahead, upstream, pr, next };
}

/**
 * The open session working on `branch` of `repo` (`owner/name`, in any case: GitHub's events spell it their way), if
 * any: what GitHub's events on that branch reach (a check that failed there, a pull request opened from it).
 */
export async function codeSessionOnBranch(
  db: Executor,
  orgId: string,
  repo: string,
  branch: string,
): Promise<CodeSessionRow | null> {
  const [row] = await db
    .select()
    .from(codeSessions)
    .where(
      and(
        eq(codeSessions.orgId, orgId),
        sql`lower(${codeSessions.repo}) = lower(${repo})`,
        eq(codeSessions.branch, branch),
        isNull(codeSessions.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Records the pull request opened from the session's branch (the agent's `open_pull_request`, or GitHub's event). */
export async function recordCodeSessionPr(
  deps: Pick<CodeSessionDeps, "db" | "pubsub">,
  orgId: string,
  repo: string,
  branch: string,
  pr: { number: number; url: string | null },
) {
  const row = await codeSessionOnBranch(deps.db, orgId, repo, branch);
  if (!row || (row.prNumber === pr.number && (row.prUrl === pr.url || !pr.url))) return row;
  return setSession(deps, row, { prNumber: pr.number, prUrl: pr.url });
}
