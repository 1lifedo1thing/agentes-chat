import { and, type Database, type Executor, eq, isNull, or, type SQL, schema } from "@agenteschat/db";
import { runAuthorityById } from "../authority";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { can, type Membership, requirePermission } from "../organizations";
import { ownerApprovers, personalUseCheck, personOfRun } from "../personal-use";
import { ALL_TOOLS, grantedScopeKeys, grantKey, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext, ToolDefinition } from "../tools/types";

const { connectorConnections } = schema;
type ConnectorConnection = typeof connectorConnections.$inferSelect;

/**
 * What a person may do with a connection (the Vault's split, ADR 0144; ADR 0099 addendum). A personal connection is
 * its person's: only they see its details, rename, reconnect, classify its tools or give it to agents. Who manages
 * connectors sees that it exists and may remove it or take it off an agent (`remove`), never read it. Moving it to the
 * team is its person's, when they also manage connectors. A team connection: every member sees it, who manages
 * connectors changes and removes it.
 */
export type ConnectionAct = "read" | "change" | "remove" | "move";

export function mayConnection(
  c: Pick<ConnectorConnection, "ownerUserId">,
  actorId: string,
  membership: Membership,
  act: ConnectionAct,
) {
  const manages = can(membership, "manage_connectors");
  if (c.ownerUserId) {
    if (c.ownerUserId === actorId) return act !== "move" || manages;
    return act === "remove" && manages;
  }
  return act === "read" || (act !== "move" && manages);
}

/** The connections of one owner: the team's (`null`), or one person's. */
export const connectionsOf = (owner: string | null): SQL =>
  owner ? eq(connectorConnections.ownerUserId, owner) : isNull(connectorConnections.ownerUserId);

/** The connections `actorId` sees in full: the team's and their own. */
export const seenBy = (actorId: string): SQL =>
  or(isNull(connectorConnections.ownerUserId), eq(connectorConnections.ownerUserId, actorId)) as SQL;

/** Whether a connection is someone other than `actorId`'s personal one. */
export const othersPersonal = (c: Pick<ConnectorConnection, "ownerUserId">, actorId: string) =>
  c.ownerUserId !== null && c.ownerUserId !== actorId;

/**
 * Who may connect for whom: a personal connection (`personal`) any member makes, a team one who manages connectors.
 * GitHub stays the team's: its git proxy, repository lists and webhooks read the workspace's one GitHub connection.
 */
export async function requireConnect(db: Executor, actorId: string, orgId: string, personal: boolean, connector = "") {
  if (personal && connector === "github") {
    // The apps offer GitHub for the team only, so only an API client meets this.
    throw new ValidationError("GitHub connects for the whole team only");
  }
  return requirePermission(db as Database, actorId, orgId, personal ? "read" : "manage_connectors");
}

/**
 * A live connection of the workspace, refused as `mayConnection` says: someone else's personal connection reads as
 * missing, so even its name isn't told, unless the act is one they may do.
 */
export async function connectionFor(db: Database, actorId: string, orgId: string, id: string, act: ConnectionAct) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [c] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, id),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!c) throw new NotFoundError("Connection not found");
  if (mayConnection(c, actorId, membership, act)) return c;
  if (othersPersonal(c, actorId) && !(act === "remove" && can(membership, "manage_connectors")))
    throw new NotFoundError("Connection not found");
  if (c.ownerUserId === actorId && act === "move")
    throw new ForbiddenError("Only people who manage connectors move a connection to the team");
  throw new ForbiddenError("Only people who manage connectors can change the team's connections");
}

/**
 * Of a workspace's connections, those a run may use (ADR 0099 addendum, the mailbox rule of ADR 0038): the team's,
 * and a personal one only on an agent with a grant of its own on it ("all tools" never covers someone's personal
 * connection) and only when `personalUseCheck` lets the run's person use it (never with nobody behind the run). The
 * person and grants are read only when a personal connection is among them, so the usual run pays nothing.
 * `person`: who the run answers for, which decides how its tools ask (`personalTool`).
 */
export async function usableConnections(ctx: ToolContext, connections: ConnectorConnection[]) {
  if (!connections.some((c) => c.ownerUserId)) return { connections, person: null, ownGrants: null };
  const authority = ctx.runId ? await runAuthorityById(ctx.db, ctx.orgId, ctx.runId) : null;
  const [check, keys] = await Promise.all([
    personalUseCheck(ctx, authority, { nobody: false, rightHandTeam: true }),
    grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId),
  ]);
  const ownGrants = new Set([...keys].filter((k) => k !== grantKey(null, ALL_TOOLS)));
  const held = (id: string) => [...ownGrants].some((k) => k.startsWith(`${id}|`) && !k.includes("|deny:"));
  return {
    connections: connections.filter((c) => !c.ownerUserId || (held(c.id) && check(c.ownerUserId))),
    person: personOfRun(authority),
    ownGrants,
  };
}

/**
 * A personal connection's tool as a run may hold it: only what the agent's own grants on it allow; its approvals are
 * its person's (`ownerApprovers`); someone else's call of a tool that isn't a read asks that person first, whatever
 * the agent's level (`asksOwner`); what it reads is marked as from outside, as a mailbox's is. A team connection's
 * tool as it is. Null: not allowed.
 */
export function personalTool(
  tool: ToolDefinition,
  connection: Pick<ConnectorConnection, "ownerUserId">,
  run: { person: string | null; ownGrants: Set<string> | null },
  reads: boolean,
): ToolDefinition | null {
  const owner = connection.ownerUserId;
  if (!owner) return tool;
  if (!run.ownGrants || !isAllowed(toolAccess(run.ownGrants, tool))) return null;
  const others = run.person !== owner && !reads;
  return {
    ...tool,
    ownerUserId: owner,
    approvers: (_input, ctx, requestedBy) => ownerApprovers(ctx.db, ctx.orgId, owner, requestedBy),
    ...(reads ? { readsOutside: true as const } : {}),
    ...(others ? { sensitive: true, asksOwner: true as const } : {}),
  };
}
