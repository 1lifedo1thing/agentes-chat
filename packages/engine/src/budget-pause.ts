import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, like, not, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { agentManagerIds } from "./audience";
import { runChain } from "./authority";
import { publishMessageCreated } from "./events";
import { getMessage, insertMessage, messageView } from "./messages";
import { notify, resolveNotifications } from "./notifications";
import { personLocale } from "./requester";
import { bodyCode } from "./run-tools";
import { budgetPeriodOf, effectiveAgentBudget } from "./usage";

const { agentRuns, agents, notifications, outbox } = schema;

/** One `budget_paused` row per agent, month and budget: raised and paused again is news again. */
const groupOf = (agentId: string, period: string, budget: number) => `budget_paused:${agentId}:${period}:${budget}`;
const agentPrefix = (agentId: string) => `budget_paused:${agentId}:`;

/**
 * An agent's work stopped on its monthly budget (paused near it, or out of it). Its pause note went where the run
 * answers, often a DM between agents nobody reads, so:
 * - who manages the agent and the person behind the work get a `budget_paused` row (waiting, so it reaches their
 *   devices), once per agent, month and budget;
 * - the conversation the work started from (`runChain`'s person message) gets the same line once, written by the agent
 *   that answers there, when it is another conversation and `line` (a routine's run has no such conversation).
 */
export async function tellBudgetPause(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string },
  agent: { id: string; name: string; orgId: string; monthlyBudgetNanoUsd: number | null },
  percent: number,
  line: boolean,
) {
  const { db } = deps;
  const period = budgetPeriodOf(new Date());
  const budget = await effectiveAgentBudget(db, agent);
  const values = { agent: agent.name, percent: String(Math.floor(percent)) };
  const chain = await runChain(db, run.orgId, run.id);
  const root = chain?.rootMessageId ? await getMessage(db, run.orgId, chain.rootMessageId) : null;
  const rootRunId = chain?.runIds.at(-1);
  if (line && root && rootRunId && root.channelId !== run.channelId) {
    const [said] = await db
      .insert(outbox)
      .values({
        orgId: run.orgId,
        kind: "budget_pause.line",
        payload: { agentId: agent.id, channelId: root.channelId },
        status: "done",
        completedAt: new Date(),
        dedupeKey: `budget_pause.line:${agent.id}:${root.channelId}:${root.threadId ?? ""}:${period}:${budget}`,
      })
      .onConflictDoNothing()
      .returning({ id: outbox.id });
    const [answers] = said
      ? await db.select({ agentId: agentRuns.agentId }).from(agentRuns).where(eq(agentRuns.id, rootRunId))
      : [];
    if (answers) {
      const m = await insertMessage(db, {
        orgId: run.orgId,
        channelId: root.channelId,
        threadId: root.threadId,
        author: { type: "agent", agentId: answers.agentId, runId: null, hop: 0, stretchId: null },
        body: `${agent.name} paused this work · monthly budget at ${values.percent}%. It picks up when the budget renews, or sooner if it goes up.`,
        meta: { ...bodyCode("usage_paused_budget", values), budgetPause: { agentId: agent.id } },
      });
      if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(m));
    }
  }
  const [owner] = await db.select({ id: agents.ownerUserId }).from(agents).where(eq(agents.id, agent.id));
  const behind = root?.authorType === "person" ? root.authorUserId : null;
  const to = new Set([...(await agentManagerIds(db, run.orgId, agent.id)), owner?.id, behind]);
  for (const userId of to) {
    if (!userId) continue;
    const text = serverText(await personLocale(db, userId), "chat.body.usage_paused_budget", values);
    await notify(deps, {
      orgId: run.orgId,
      userIds: [userId],
      kind: "budget_paused",
      groupKey: groupOf(agent.id, period, budget),
      waiting: true,
      actor: { type: "agent", id: agent.id },
      source: {
        agentId: agent.id,
        label: agent.name,
        ...(root ? { channelId: root.channelId, ...(root.threadId ? { threadId: root.threadId } : {}) } : {}),
      },
      latest: { percent: Math.floor(percent), text },
    });
  }
}

/** The agents' budgets changed: their `budget_paused` rows are done (one that still pauses tells again, as news). */
export async function resolveBudgetPaused(deps: { db: Database; pubsub?: PubSub }, orgId: string, agentIds: string[]) {
  for (const id of agentIds) await resolveNotifications(deps, orgId, { groupKeyPrefix: agentPrefix(id) });
}

/** The agents on the workspace's default budget, whose rows a change of that default ends. */
export async function resolveDefaultBudgetPaused(deps: { db: Database; pubsub?: PubSub }, orgId: string) {
  const onDefault = await deps.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.monthlyBudgetNanoUsd)));
  await resolveBudgetPaused(
    deps,
    orgId,
    onDefault.map((a) => a.id),
  );
}

/** Back at work after a budget wait: rows of an earlier month are done (the budget renewed). */
export async function resolveEarlierBudgetPaused(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  agentId: string,
) {
  const old = await deps.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        isNull(notifications.doneAt),
        like(notifications.groupKey, `${agentPrefix(agentId)}%`),
        not(like(notifications.groupKey, `${agentPrefix(agentId)}${budgetPeriodOf(new Date())}:%`)),
      ),
    );
  if (old.length) await resolveNotifications(deps, orgId, { ids: old.map((r) => r.id) });
}
