import type { PlanUsage } from "@agenteschat/adapters";
import { and, type Executor, eq, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import { autoPlanModel, claudeCodeModel, NEXT_ACCOUNT_KINDS, planOf } from "@agenteschat/providers/plans";
import type { Agent } from "./agents";
import { type BrainPlan, computerBrainUnavailable, planIsOwners, storedPlanUsage } from "./brains/select";
import type { BrainAccount, BrainSession } from "./brains/types";
import { machineRule, mayUseDevice } from "./devices";
import type { MachineStatus } from "./machine-hub";
import { isRightHand } from "./right-hand";

const { agentRuns, machineAccounts, machines } = schema;

/** Where a spilled run thinks (`Transcript.spill`): `from` is the agent's own computer, which was full. */
export interface SpillRecord {
  from: string;
  to: string;
}

type SpillDeps = { db: Executor; machines?: { status(machineId: string): Promise<MachineStatus | null> } };

/**
 * The run's computer plan moved to `machineId`, on a sign-in there the agent's owner has (an account of theirs, else
 * the computer's own sign-in when they connected it): null when that plan can't think there now.
 */
export async function spillPlan(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  machineId: string,
  session: { id: string; resume: boolean },
): Promise<BrainPlan | null> {
  if (plan.kind === "model" || !deps.machines) return null;
  const [status, row] = await Promise.all([
    deps.machines.status(machineId).catch(() => null),
    deps.db
      .select({
        id: machineAccounts.id,
        label: machineAccounts.label,
        status: machineAccounts.status,
        provider: machineAccounts.provider,
      })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.orgId, agent.orgId),
          eq(machineAccounts.machineId, machineId),
          eq(machineAccounts.kind, plan.kind),
          eq(machineAccounts.status, "active"),
          eq(machineAccounts.createdBy, agent.ownerUserId ?? ""),
        ),
      )
      .limit(1)
      .then(([r]) => r),
  ]);
  const account: BrainAccount | undefined = row
    ? { id: row.id, label: row.label, status: "active", ...(row.provider ? { provider: row.provider } : {}) }
    : undefined;
  const usage = await storedPlanUsage(deps.db, agent.orgId, machineId, plan.kind, account?.id).catch(() => null);
  const model =
    plan.kind === "claude_code" && plan.model && !isAutoModel(plan.model)
      ? claudeCodeModel(planOf(account?.provider), plan.model)
      : plan.model;
  const ownersPlan = await planIsOwners(
    deps.db,
    { orgId: agent.orgId, ownerUserId: agent.ownerUserId },
    machineId,
    account,
  );
  if (computerBrainUnavailable(plan.kind, machineId, status, Date.now(), account, ownersPlan, usage, model))
    return null;
  const { account: _home, usage: _homeUsage, ...rest } = plan;
  return {
    ...rest,
    ...(model ? { model } : {}),
    session: { ...session, machineId, cwd: "" },
    ...(account ? { account } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * A run that went on with another account at its plan's limit (`Transcript.accountMove`, ADR 0041 §6). The agent's own
 * account never changes: the next run starts on it again.
 */
export interface AccountMove {
  /** The account the run started on: its agent's own. */
  from: string;
  to: string;
  /** Whose plan `to` is when that isn't the agent's owner: lent to the run, so it never spends paid extra usage. */
  lentBy?: string;
  /** Every account the run thought with or was refused on, `from` and `to` included: each at most once per run. */
  tried: string[];
}

/** Where `nextAccountPlan` landed: the plan on the next account, else how many accounts are all limited and the first reset. */
export type NextAccount = { plan: BrainPlan; lentBy: string | null } | { plan: null; chain: number; resetsAt?: string };

type SeatRow = { id: string; email: string | null; providerOrgId: string | null };
/** Two logins of one seat share its limits (`sameAccountWhere`): one email, in the same Claude organization when both know it. */
const sameSeat = (a: SeatRow, b: SeatRow) =>
  a.id === b.id ||
  (!!a.email &&
    a.email.toLowerCase() === b.email?.toLowerCase() &&
    (!a.providerOrgId || !b.providerOrgId || a.providerOrgId === b.providerOrgId));

/**
 * The next account a run at its plan's limit goes on with (ADR 0041 §6), on the same computer and of the same kind,
 * signed in with the CLI's own sign-in (never a key, which is paid by the token): one that serves this agent, its
 * owner's own first and then the others that serve everyone, each by `use_order`. Never a one-agent login another agent
 * thinks with, an account `tried` or one of their seats, nor one limited by what is stored: unknown usage is worth a
 * try (a setup token can't read its usage without a turn). `room`: what long work also needs of the stored usage.
 * The right hand goes on only with its plan's owner's accounts that may answer its person (`forPerson`).
 * Null plan: no such account, with how many accounts are limited (the tried ones counted) and the earliest reset.
 */
export async function nextAccountPlan(
  deps: SpillDeps,
  agent: Pick<Agent, "id" | "orgId" | "ownerUserId" | "brainAccountPinned" | "builtin">,
  plan: BrainPlan,
  tried: readonly string[],
  options: { room?: (usage: PlanUsage | null) => boolean; forPerson?: string | null } = {},
): Promise<NextAccount> {
  const machineId = plan.session?.machineId;
  const owner = agent.ownerUserId;
  const none = { plan: null, chain: 0 } as const;
  if (!machineId || !owner || !plan.account || plan.missionId || !NEXT_ACCOUNT_KINDS.includes(plan.kind)) return none;
  if (agent.brainAccountPinned || plan.account.provider) return none;
  const { agents, organizationMembers: members } = schema;
  const [status, rows] = await Promise.all([
    deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    deps.db
      .select({
        id: machineAccounts.id,
        label: machineAccounts.label,
        email: machineAccounts.email,
        providerOrgId: machineAccounts.providerOrgId,
        createdBy: machineAccounts.createdBy,
        usage: machineAccounts.usage,
      })
      .from(machineAccounts)
      // Its owner still in the workspace (`planIsOwners`).
      .innerJoin(members, and(eq(members.orgId, machineAccounts.orgId), eq(members.userId, machineAccounts.createdBy)))
      .where(
        and(
          eq(machineAccounts.orgId, agent.orgId),
          eq(machineAccounts.machineId, machineId),
          eq(machineAccounts.kind, plan.kind),
          eq(machineAccounts.status, "active"),
          isNull(machineAccounts.provider),
          sql`${machineAccounts.authMethod} is distinct from 'api_key'`,
          isRightHand(agent)
            ? and(
                eq(machineAccounts.createdBy, owner),
                options.forPerson === owner ? undefined : eq(machineAccounts.serves, "everyone"),
              )
            : or(eq(machineAccounts.createdBy, owner), eq(machineAccounts.serves, "everyone")),
          or(
            eq(machineAccounts.id, plan.account.id),
            eq(machineAccounts.shared, true),
            sql`not exists (select 1 from ${agents} a where a.org_id = ${machineAccounts.orgId}
              and a.brain_account_id = ${machineAccounts.id} and a.id <> ${agent.id} and a.archived_at is null)`,
          ),
        ),
      )
      .orderBy(
        sql`${machineAccounts.createdBy} = ${owner} desc`,
        sql`${machineAccounts.useOrder} asc nulls last`,
        machineAccounts.createdAt,
        machineAccounts.id,
      ),
  ]);
  const triedRows = rows.filter((r) => tried.includes(r.id));
  const now = Date.now();
  const chain: SeatRow[] = [];
  let earliest: number | null = null;
  for (const r of rows) {
    const account: BrainAccount = { id: r.id, label: r.label, status: "active" };
    const usage = (r.usage as PlanUsage | null) ?? null;
    const model = isAutoModel(plan.model) ? autoPlanModel(undefined, plan.model, usage) : plan.model;
    const why = computerBrainUnavailable(plan.kind, machineId, status, now, account, true, usage, model);
    const limited = why?.code === "plan_limit";
    if (limited || tried.includes(r.id)) {
      if (!chain.some((c) => sameSeat(c, r))) chain.push(r);
      const at = Date.parse(why?.resetsAt ?? "");
      if (limited && at > now && (earliest === null || at < earliest)) earliest = at;
    }
    if (why || tried.includes(r.id) || triedRows.some((t) => sameSeat(t, r))) continue;
    if (options.room && !options.room(usage)) continue;
    const { unavailable: _, usage: _usage, ...rest } = plan;
    return {
      plan: {
        ...rest,
        account,
        ...(plan.model ? { model: plan.model } : {}),
        ...(usage ? { usage } : {}),
        session: { ...(plan.session as BrainSession), id: Bun.randomUUIDv7(), resume: false },
      },
      lentBy: r.createdBy === owner ? null : r.createdBy,
    };
  }
  return {
    plan: null,
    chain: chain.length,
    ...(earliest !== null ? { resetsAt: new Date(earliest).toISOString() } : {}),
  };
}

/**
 * A resumed run's plan on the account it moved to (`AccountMove.to`), in the session it has there, with what keeps
 * that account from thinking now: null when the account is gone from the agent's computer or no longer serves it.
 */
export async function movedAccountPlan(
  deps: SpillDeps,
  agent: Pick<Agent, "orgId" | "ownerUserId">,
  plan: BrainPlan,
  accountId: string,
): Promise<BrainPlan | null> {
  const machineId = plan.session?.machineId;
  if (!machineId || plan.kind === "model") return null;
  const [row] = await deps.db
    .select({ id: machineAccounts.id, label: machineAccounts.label, status: machineAccounts.status })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, agent.orgId),
        eq(machineAccounts.id, accountId),
        eq(machineAccounts.machineId, machineId),
        eq(machineAccounts.kind, plan.kind),
      ),
    );
  if (!row || !(await planIsOwners(deps.db, agent, machineId, row))) return null;
  const account: BrainAccount = {
    id: row.id,
    label: row.label,
    status: row.status === "active" ? "active" : "signed_out",
  };
  const [status, usage] = await Promise.all([
    deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    storedPlanUsage(deps.db, agent.orgId, machineId, plan.kind, row.id).catch(() => null),
  ]);
  const model = isAutoModel(plan.model) ? autoPlanModel(undefined, plan.model, usage) : plan.model;
  const why =
    computerBrainUnavailable(plan.kind, machineId, status, Date.now(), account, true, usage, model) ??
    (plan.unavailable?.code === "plan_limit" ? null : (plan.unavailable ?? null));
  const { unavailable: _, usage: _usage, ...rest } = plan;
  return { ...rest, account, ...(usage ? { usage } : {}), ...(why ? { unavailable: why } : {}) };
}

/** Online computers of the workspace other than `home` that take spill-over for someone, with nothing in their line. */
const spillable = (orgId: string, home: string) =>
  and(
    eq(machines.orgId, orgId),
    ne(machines.id, home),
    isNull(machines.deletedAt),
    eq(machines.online, true),
    eq(machines.paused, false),
    eq(machines.execAllowed, true),
    sql`(${machines.spillOwn} or ${machines.spillOthers})`,
    sql`${machines.executors}->>'mode' is distinct from 'system'`,
    sql`not exists (select 1 from ${agentRuns} w where w.org_id = ${machines.orgId}
      and w.waiting_machine_id = ${machines.id} and w.status = 'waiting_input'
      and w.transcript->'waitingForBrain'->>'code' = 'busy')`,
  );

/** Whether a turn waiting behind others on `home` may find another computer (`spillTarget`): worth a look now. */
export async function spillMayHelp(db: Executor, orgId: string, home: string): Promise<boolean> {
  const [row] = await db.select({ id: machines.id }).from(machines).where(spillable(orgId, home)).limit(1);
  return row !== undefined;
}

/**
 * Spill-over: another online computer of the workspace that may think `personId`'s waited-on turn now, while the
 * agent's own (`plan.session.machineId`) is full. Its owner allowed it (`spill_own` for the owner's own turns,
 * `spill_others` for anyone's whose agents may use it), nothing waits in its line, and the agent's owner has a
 * sign-in there. A server install (an OS user per agent) is never one: the agent has no user of its own there.
 */
export async function spillTarget(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  personId: string,
  session: { id: string },
): Promise<{ machineId: string; plan: BrainPlan } | null> {
  const home = plan.session?.machineId;
  if (!home) return null;
  const candidates = await deps.db
    .select()
    .from(machines)
    .where(
      and(
        spillable(agent.orgId, home),
        sql`(${machines.spillOthers} or (${machines.spillOwn} and ${machines.pairedByUserId} = ${personId}))`,
      ),
    )
    .orderBy(
      sql`${machines.pairedByUserId} = ${personId} desc nulls last`,
      sql`${machines.size}->>'memoryGb' desc nulls last`,
    );
  for (const m of candidates) {
    if (m.pairedByUserId !== personId && !(await mayUseDevice(deps.db, agent.orgId, personId, machineRule(m))))
      continue;
    const moved = await spillPlan(deps, agent, plan, m.id, { id: session.id, resume: false });
    if (moved) return { machineId: m.id, plan: moved };
  }
  return null;
}
