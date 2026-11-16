import { and, type Executor, eq, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { enqueue } from "./outbox";

const { agentRuns, confidentialThreads, messages } = schema;

/**
 * Confidential results (ADR 0187). A server the operator vouches for (`MCP_CALLER_IDENTITY`) marks a tool result as
 * confidential; the thread of the run that read it becomes a confidential thread (`confidential_threads`), from its
 * root. In such a thread:
 *
 * - every message is sealed: `messages.body` holds `CONFIDENTIAL_STUB` and the words live in `meta.sealedBody`, so
 *   whatever reads a message's body (another run's context, search, a summary, a notification) gets the stub
 *   without knowing about any of this. Only the people's view (`messageView`) and a model-brain run of that same
 *   thread (`buildRunContext`) read the words back (`unsealed`);
 * - a run sends nothing elsewhere (the Tool Gateway's lock) and answers in the thread.
 */

/** The key of a tool result's `_meta` that marks it confidential, when its server is one the operator listed. */
export const CONFIDENTIAL_META_KEY = "chat.agentes/confidential";

/** What stands in a confidential text's place for whoever may not read it. */
export const CONFIDENTIAL_STUB = "[confidential: readable only in its own thread]";

/** A confidential result or run, as a line about it says (a judge's tried lines, recent actions). */
export const CONFIDENTIAL_NOT_SHOWN = "(confidential, not shown)";

/** The refusal code of a tool a run may not call after it read a confidential result. Final for the turn's judge. */
export const CONFIDENTIAL_OUTBOUND = "confidential.outbound";

/**
 * How long a confidential thread's words are kept.
 * ponytail: a constant; a setting when an operator needs another number.
 */
export const CONFIDENTIAL_KEEP_DAYS = 60;

/** SQL: the thread rooted at `root` is confidential. */
export const confidentialThreadSql = (orgId: SQL, root: SQL): SQL =>
  sql`exists (select 1 from ${confidentialThreads} ct where ct.org_id = ${orgId} and ct.root_message_id = ${root})`;

export interface RunConfidentiality {
  /** What the run thinks with (`agent_runs.brain`); null before its first turn. */
  brain: string | null;
  /** The connections whose results marked the run's thread; null while the thread is not confidential. */
  connectionIds: string[] | null;
}

/** A run's thread as the confidential mark sees it, with the brain it thinks with; null when the run is gone. */
export async function runConfidentiality(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<RunConfidentiality | null> {
  const [row] = await db
    .select({ brain: agentRuns.brain, connectionIds: confidentialThreads.connectionIds })
    .from(agentRuns)
    .leftJoin(
      confidentialThreads,
      and(
        eq(confidentialThreads.orgId, agentRuns.orgId),
        eq(confidentialThreads.rootMessageId, agentRuns.threadRootId),
      ),
    )
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  return row ?? null;
}

/**
 * Makes a thread confidential, in the caller's transaction (with the step that carries the mark): its row, with the
 * connection that marked it, and on the first mark every message already there is sealed, the root included (it may
 * hold what a person pasted before any mark), and leaves the search index (its builder answers nothing for a sealed
 * message, so the queued job deletes the document).
 */
export async function markThreadConfidential(
  tx: Executor,
  thread: { orgId: string; channelId: string; rootId: string; connectionId?: string | null },
): Promise<void> {
  const connection = thread.connectionId ?? null;
  const [row] = rowsOf<{ created: boolean }>(
    await tx.execute(sql`insert into ${confidentialThreads} (org_id, channel_id, root_message_id, connection_ids)
      values (${thread.orgId}::uuid, ${thread.channelId}::uuid, ${thread.rootId}::uuid,
        array_remove(array[${connection}::uuid], null))
      on conflict (org_id, root_message_id) do update set connection_ids =
        case when ${connection}::uuid is null or ${connection}::uuid = any(${confidentialThreads}.connection_ids)
          then ${confidentialThreads}.connection_ids
          else array_append(${confidentialThreads}.connection_ids, ${connection}::uuid) end
      returning (xmax = 0) as created`),
  );
  if (!row?.created) return;
  const sealed = await tx
    .update(messages)
    .set({
      body: sql`case when ${messages.body} = '' then '' else ${CONFIDENTIAL_STUB} end`,
      meta: sql`${messages.meta} || jsonb_build_object('confidential', true)
        || case when ${messages.body} = '' then '{}'::jsonb else jsonb_build_object('sealedBody', ${messages.body}) end`,
    })
    .where(
      and(
        eq(messages.orgId, thread.orgId),
        eq(messages.channelId, thread.channelId),
        sql`(${messages.id} = ${thread.rootId}::uuid or ${messages.threadId} = ${thread.rootId}::uuid)`,
        sql`coalesce(${messages.meta}->>'confidential', '') <> 'true'`,
      ),
    )
    .returning({ id: messages.id });
  for (const m of sealed) {
    await enqueue(tx, { orgId: thread.orgId, kind: "search.index", payload: { kind: "message", sourceId: m.id } });
  }
}

type Meta = Record<string, unknown> | null | undefined;

/** A message of a confidential thread, or one a run of such a thread wrote (`meta.confidential`). */
export const isConfidential = (meta: Meta): boolean => meta?.confidential === true;

/**
 * A sealed message with its words back and nothing of the seal's copy left in its meta: what the people who read the
 * conversation see, and what a model-brain run of the same thread reads. Any other message as it is.
 */
export function unsealed<M extends { body: string; meta: Record<string, unknown> }>(m: M): M {
  const words = m.meta.sealedBody;
  if (typeof words !== "string") return m;
  const { sealedBody: _, ...meta } = m.meta;
  return { ...m, body: words, meta };
}
