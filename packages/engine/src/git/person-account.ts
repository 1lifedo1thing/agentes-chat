import type { CommitAuthor } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { runAuthorityById, UUID } from "../authority";
import { TtlCache } from "../cache";
import type { ConnectorConnection } from "../connectors/connections";

const { agentRuns, channels, codeSessions, users } = schema;

/**
 * A person's own GitHub account in a code session (ADR 0215 §5a). A member may connect GitHub as their own
 * (`connector_connections.owner_user_id`, ADR 0099): it has no tools of its own and is never the workspace's GitHub.
 * It is who the work goes as when its person asks in a code session, on that session's repository alone:
 *
 * - the commits the agent makes are authored as them (`codeCommitAuthor`: their name and GitHub's no-reply address
 *   for that account, never their email), the agent still the co-author;
 * - the push of the session's branch reaches GitHub with their token (`personAccountOfPush`, in the git proxy);
 * - what the agent writes there (a pull request, a comment, an API commit) goes with their token too
 *   (`githubCallAuth`).
 *
 * Their token stays on the server, as the workspace's does: the agent's computer gets a name and an address. A run
 * nobody asked for (a routine, a check that woke the agent), another conversation, another repository, a person who
 * left or who connected no account: the workspace's GitHub, as before. In a session with several people it follows
 * who asked that turn, so nobody acts as someone else.
 */
export interface PersonAccount {
  personId: string;
  /** The session's repository, `owner/name`. */
  repo: string;
  connection: ConnectorConnection;
}

/** GitHub's id and login for an account, as its connection kept them when it was connected. */
const accountOf = (c: Pick<ConnectorConnection, "accountId" | "accountLabel">) =>
  c.accountId && /^\d{1,20}$/.test(c.accountId) && c.accountLabel && /^[A-Za-z0-9-]{1,39}$/.test(c.accountLabel)
    ? { id: c.accountId, login: c.accountLabel }
    : null;

/** A person's own live GitHub connection whose account is known, if any. */
export const ownGitHub = (connections: readonly ConnectorConnection[], personId: string) =>
  connections.find(
    (c) => c.connector === "github" && c.ownerUserId === personId && c.status === "active" && accountOf(c) !== null,
  ) ?? null;

// Who is behind a run and which session it is in never change: read once per run. The connection is read each time
// (`activeConnections` forgets it the moment it is removed).
const behind = new TtlCache<{ personId: string; repo: string } | null>(10 * 60_000);

/** The account a run's work on its code session's repository goes as, or null (the workspace's GitHub). */
export async function personAccountOfRun(
  db: Database,
  orgId: string,
  runId: string | null | undefined,
): Promise<PersonAccount | null> {
  if (!runId || !UUID.test(runId)) return null;
  const who = await behind.getOrLoad(`${orgId}:${runId}`, async () => {
    const [run] = await db
      .select({ repo: codeSessions.repo })
      .from(agentRuns)
      .innerJoin(channels, and(eq(channels.orgId, agentRuns.orgId), eq(channels.id, agentRuns.channelId)))
      .innerJoin(
        codeSessions,
        and(eq(codeSessions.orgId, agentRuns.orgId), eq(codeSessions.channelId, agentRuns.channelId)),
      )
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(channels.kind, "code")))
      .limit(1);
    // A project that lives only on the computer has no repository on GitHub.
    if (!run?.repo.includes("/")) return null;
    const authority = await runAuthorityById(db, orgId, runId);
    return authority.kind === "person" ? { personId: authority.personId, repo: run.repo } : null;
  });
  if (!who) return null;
  // Read when asked: the machine hub and the sandbox load this file, and these load them.
  const [{ activeConnections }, { getMembership }] = await Promise.all([
    import("../connectors/connections"),
    import("../organizations"),
  ]);
  const connection = ownGitHub(await activeConnections(db, orgId), who.personId);
  if (!connection || !(await getMembership(db, who.personId, orgId))) return null;
  return { ...who, connection };
}

/** Whether `repo` (`owner/name`, any capitals) is the repository a run's person acts as themselves on. */
export const onSessionRepo = (account: PersonAccount, repo: string) =>
  account.repo.toLowerCase() === repo.toLowerCase();

/**
 * The account a push goes as: every ref it updates is the branch of one code session of this agent on this
 * repository, and a person is behind the run working in that session now. The proxy's credential names the agent
 * and its computer, never a run, so the session is found by its branch.
 */
export async function personAccountOfPush(
  db: Database,
  push: { orgId: string; agentId: string; repo: string; refs: readonly string[] },
): Promise<PersonAccount | null> {
  const branches = new Set(push.refs.map((r) => (r.startsWith("refs/heads/") ? r.slice("refs/heads/".length) : "")));
  const [branch] = branches;
  if (branches.size !== 1 || !branch) return null;
  const [session] = await db
    .select({ channelId: codeSessions.channelId })
    .from(codeSessions)
    .where(
      and(
        eq(codeSessions.orgId, push.orgId),
        eq(codeSessions.agentId, push.agentId),
        eq(codeSessions.branch, branch),
        sql`lower(${codeSessions.repo}) = ${push.repo.toLowerCase()}`,
        isNull(codeSessions.archivedAt),
      ),
    )
    .limit(1);
  if (!session) return null;
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, push.orgId),
        eq(agentRuns.agentId, push.agentId),
        eq(agentRuns.channelId, session.channelId),
        inArray(agentRuns.status, ["running", "waiting_approval"]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const account = run ? await personAccountOfRun(db, push.orgId, run.id) : null;
  return account && onSessionRepo(account, push.repo) ? account : null;
}

/**
 * Who a run's commits are authored as, when it isn't the agent: the person who asked in a code session, by the
 * GitHub account they connected as their own. Sent with the session's turn and commands (`AgentScope.author`); the
 * agent still ends each commit with its own `Co-authored-by` line.
 */
export async function codeCommitAuthor(
  db: Database,
  orgId: string,
  runId: string | null | undefined,
): Promise<CommitAuthor | null> {
  const account = await personAccountOfRun(db, orgId, runId);
  const github = account && accountOf(account.connection);
  if (!account || !github) return null;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, account.personId));
  const { trailerName } = await import("./signature");
  return {
    name: trailerName(person?.name ?? "") || github.login,
    email: `${github.id}+${github.login}@users.noreply.github.com`,
  };
}
