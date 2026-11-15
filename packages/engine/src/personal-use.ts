import { and, type Database, eq, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { namesLabel, namesOf } from "./approvals";
import { canTalkTo, speakerFor } from "./audience";
import { accountablePerson, type RunAuthority } from "./authority";
import { routineCreatorOf } from "./requester";
import { isRightHandId, rightHandReader } from "./right-hand";
import type { ToolContext } from "./tools/types";

/**
 * Who decides an action in one person's own mailbox or connection: that person (ADR 0038, ADR 0099 addendum). Asked
 * by them, admins may decide it too; asked by anyone else (or nobody), only they do: an action in their name is theirs
 * to approve. Once they left the workspace nobody could, so the usual rule (the agent's owner, admins) applies.
 */
export async function ownerApprovers(db: Database, orgId: string, ownerId: string, requestedBy: string | null) {
  const [member] = await db
    .select({ id: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, ownerId)));
  if (!member) return { ok: true as const, approvers: null };
  const own = requestedBy === ownerId;
  return {
    ok: true as const,
    approvers: {
      userIds: [ownerId],
      label: namesLabel(await namesOf(db, [ownerId])),
      requestedBy: own ? null : requestedBy,
      requesterDecides: false,
      ...(own ? {} : { required: true }),
    },
  };
}

/** The person a run answers for: who asked, else a routine's creator (as the gateway asks them). */
export const personOfRun = (authority: RunAuthority | null) =>
  authority ? (accountablePerson(authority) ?? routineCreatorOf(authority)) : null;

/**
 * Whether the person behind a run may use one person's own thing (a mailbox, a connection) through this agent: its
 * owner, or someone the agent answers directly, as its owner gave it access for (a consultation by someone outside
 * its audience doesn't count). Nobody behind the run (an agent's own work, a watch): a mailbox widens nobody's reach,
 * so it serves as its grant says (`nobody: true`); a connection serves nobody (`nobody: false`). The team's right
 * hand, which everyone talks to, uses one only for its owner, in their own DM with it (ADR 0137), and the team's only
 * with `rightHandTeam`. The returned check takes the thing's owner; null is the team's.
 */
export async function personalUseCheck(
  ctx: ToolContext,
  authority: RunAuthority | null,
  options: { nobody: boolean; rightHandTeam: boolean },
): Promise<(ownerId: string | null) => boolean> {
  if (await isRightHandId(ctx.db, ctx.orgId, ctx.agentId)) {
    const reader = await rightHandReader(ctx);
    return (ownerId) => (ownerId ? reader !== null && ownerId === reader : options.rightHandTeam);
  }
  const person = personOfRun(authority);
  if (!person) return (ownerId) => !ownerId || options.nobody;
  const agent = await getAgent(ctx.db, ctx.orgId, ctx.agentId);
  const direct = !!agent && canTalkTo(agent, person, await speakerFor(ctx.db, ctx.orgId, person));
  return (ownerId) => !ownerId || direct || ownerId === person;
}
