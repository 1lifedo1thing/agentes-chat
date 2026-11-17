import type { PubSub } from "@agenteschat/adapters";
import { and, eq, isNull, schema } from "@agenteschat/db";
import { type ArtifactDeps, liveFileAccess } from "../artifacts";
import { openDm } from "../dms";
import { NotFoundError, ValidationError } from "../errors";
import type { Judge } from "../judge";
import { MAX_MESSAGE_LENGTH, postPersonMessage } from "../messages";
import type { Talker } from "../talker";

/**
 * "Ask an agent" from inside a live file (ADR 0194 §6): the person's own message to the agent, carrying the file
 * (`meta.artifacts`, so its card shows and the agent's context names it) and what they had selected
 * (`meta.liveRef`), sent where the agent can work on the file while everyone in it watches.
 */

/** What the person had selected when they asked, as the apps describe it (`meta.liveRef.selection`). */
export interface LiveAskSelection {
  /** How it reads: "Sheet 1!B2:C9", "slide 3", "2 images". */
  label: string;
  sheet?: string;
  range?: string;
  slide?: string;
  shapes?: string[];
}

export type LiveAskDeps = ArtifactDeps & { pubsub: PubSub; judge?: Judge; talker?: Talker };

const { agents, channels, channelMembers } = schema;

const textOf = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : undefined;

/** The selection as stored: known fields only, each cut to its size, ids only in `shapes`. */
export function cleanSelection(raw: LiveAskSelection | undefined): LiveAskSelection | undefined {
  const label = textOf(raw?.label, 200);
  if (!raw || !label) return undefined;
  const out: LiveAskSelection = { label };
  const sheet = textOf(raw.sheet, 100);
  const range = textOf(raw.range, 100);
  const slide = textOf(raw.slide, 100);
  if (sheet) out.sheet = sheet;
  if (range) out.range = range;
  if (slide) out.slide = slide;
  const shapes = Array.isArray(raw.shapes)
    ? raw.shapes.filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 200)
    : [];
  if (shapes.length > 0) out.shapes = shapes;
  return out;
}

/**
 * Sends the person's message to the agent about a live file they read, and returns it. Where it goes: the file's own
 * conversation when the person and the agent are both in it (a channel's message names the agent, in the thread the
 * file came from), else their DM with the agent (a file in the shared Drive, in someone else's DM, or in a
 * conversation the agent isn't in). Refused as "not found" for a file the person doesn't read (or that isn't a live
 * file) and an agent that isn't there; who may talk to the agent and post is the DM's and the post's own check.
 */
export async function askAgentAbout(
  deps: LiveAskDeps,
  userId: string,
  orgId: string,
  fileId: string,
  input: { agentId: string; text: string; selection?: LiveAskSelection },
): Promise<{ id: string; channelId: string; threadId: string | null }> {
  const text = input.text.trim();
  if (!text) throw new ValidationError("Say what the agent should do");
  if (text.length > MAX_MESSAGE_LENGTH) throw new ValidationError("That is too long to send");
  const access = await liveFileAccess(deps, { type: "person", userId }, orgId, fileId);
  if (!access || access.artifact.deletedAt) throw new NotFoundError("Artifact not found", "artifact.not_found");
  const [agent] = await deps.db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.id, input.agentId), isNull(agents.archivedAt), isNull(agents.deletedAt)),
    );
  if (!agent) throw new NotFoundError("Agent not found");
  const file = access.artifact;
  const selection = cleanSelection(input.selection);
  const meta = {
    liveRef: { artifactId: file.id, kind: access.kind, title: file.title, ...(selection ? { selection } : {}) },
    artifacts: [{ id: file.id, version: file.currentVersion, title: file.title }],
  };
  const here = file.channelId ? await whereItLives(deps, orgId, file.channelId, userId, agent.id) : null;
  if (here) {
    const sent = await postPersonMessage(deps, userId, orgId, here.channelId, {
      body: here.mention ? `@${agent.handle} ${text}` : text,
      threadId: file.threadId,
      meta,
    });
    return { id: sent.id, channelId: sent.channelId, threadId: sent.threadId ?? null };
  }
  const dm = await openDm(deps.db, userId, orgId, { agentId: agent.id }, { pubsub: deps.pubsub });
  const sent = await postPersonMessage(deps, userId, orgId, dm.id, { body: text, meta });
  return { id: sent.id, channelId: sent.channelId, threadId: sent.threadId ?? null };
}

/**
 * The file's conversation when the message can go there: a DM the agent is in (no mention needed), a task's
 * conversation (a mention admits the agent, ADR 0145), or a channel both the person and the agent are members of.
 * Null: the message goes to the person's DM with the agent instead.
 */
async function whereItLives(deps: LiveAskDeps, orgId: string, channelId: string, userId: string, agentId: string) {
  const [channel] = await deps.db
    .select({ kind: channels.kind, archivedAt: channels.archivedAt })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel || channel.archivedAt) return null;
  if (channel.kind === "task") return { channelId, mention: true };
  const members = await deps.db
    .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
    .from(channelMembers)
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId)));
  const agentIn = members.some((m) => m.agentId === agentId);
  if (!agentIn) return null;
  if (channel.kind === "dm") return members.some((m) => m.userId === userId) ? { channelId, mention: false } : null;
  return members.some((m) => m.userId === userId) ? { channelId, mention: true } : null;
}
