import { and, type Executor, eq, type SQL, schema, sql } from "@agenteschat/db";
import type { Agent } from "../agents";
import { runAuthorityById } from "../authority";
import type { AgentRun } from "../runs";
import { audienceAllowsSql } from "./serves";

const { machineAccounts } = schema;

/**
 * "Atender todos" at a run's start: an agent thinking with a plan account answers someone besides its own owner only
 * when the account's `reply` audience takes them. A run nobody is behind (a routine, a webhook) answers its owner's
 * work. The right hand follows "Usar em agentes" instead (`thinkingAgent`). Null: it may think.
 */
export async function replyRefusal(
  db: Executor,
  agent: Pick<Agent, "orgId" | "name" | "ownerUserId">,
  accountId: string,
  run: Pick<AgentRun, "orgId" | "id">,
): Promise<{ code: "plan_not_shared"; message: string } | null> {
  const person = (await runAuthorityById(db, run.orgId, run.id).catch(() => null))?.personId ?? null;
  if (!person || person === agent.ownerUserId) return null;
  const [row] = await db
    .select({ answers: audienceAllowsSql("reply", person) })
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, agent.orgId), eq(machineAccounts.id, accountId)));
  if (!row || row.answers) return null;
  return {
    code: "plan_not_shared",
    message: `${agent.name} thinks with a plan that answers only the agent's owner.`,
  };
}

/**
 * The same rule in SQL, for an `agents` row aliased `alias` and a person id expression who isn't its owner: it thinks
 * with no plan account, it is the right hand, or the account's `reply` audience takes them (`audienceSql` adds it).
 */
export function replyAllowsSql(alias: string, userId: SQL): SQL<boolean> {
  const a = sql.raw(alias);
  return sql<boolean>`(${a}.brain_account_id is null or ${a}.brain = 'model'
    or ${a}.builtin is not distinct from 'right_hand'
    or not exists (select 1 from machine_accounts reply_acct where reply_acct.org_id = ${a}.org_id and reply_acct.id = ${a}.brain_account_id
      and not ${audienceAllowsSql("reply", userId, "reply_acct")}))`;
}
