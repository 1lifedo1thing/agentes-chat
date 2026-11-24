import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  codeStartOptions,
  createCodeSession,
  insertMessage,
  postPersonMessage,
  releaseRequest,
  saveCodeSessionFile,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Who an agent answers holds in a code session too (ADR 0215 §2): opening one, the request that waited for the
 * worktree, a message in it and a file's save. And a message nobody answers there still gets its receipt settled.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Dev programs on a computer and answers only its owner. */
async function ownerOnlyAgent() {
  const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: machine?.id, ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
}

/** A session of Dev's the owner opened, with `userIds` called in. */
async function sessionWith(userIds: string[], worktreeState: "ready" | "preparing" = "ready") {
  const [channel] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: "code-1a2b3c4d",
      kind: "code",
      visibility: "private",
      createdByUserId: f.owner.id,
    })
    .returning();
  const channelId = channel?.id ?? "";
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Code session",
  });
  await f.db
    .insert(schema.channelMembers)
    .values([
      ...[f.owner.id, ...userIds].map((userId) => ({ orgId: f.org.id, channelId, userId })),
      { orgId: f.org.id, channelId, agentId: f.agent.id, autoReply: true },
    ]);
  const [session] = await f.db
    .insert(schema.codeSessions)
    .values({
      orgId: f.org.id,
      channelId,
      rootMessageId: root.id,
      agentId: f.agent.id,
      repo: "acme/app",
      repoDir: "repos/acme/app",
      title: "Fix the login",
      branch: "agentes/dev/fix-login-1a2b",
      worktreePath: ".worktrees/c-1a2b3c4d",
      worktreeState,
      createdBy: f.owner.id,
    })
    .returning();
  if (!session) throw new Error("no session");
  return session;
}

const runsIn = (channelId: string) =>
  f.db
    .select({ id: schema.agentRuns.id, triggerMessageId: schema.agentRuns.triggerMessageId })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.channelId, channelId)));

test("only someone the agent answers opens a session with it, or is offered it", async () => {
  f = await setup();
  await ownerOnlyAgent();
  const member = await addMember(f.db, f.org.id, "member");
  const deps = { db: f.db, pubsub: f.pubsub, postRequest: async () => {} };
  const input = { agentId: f.agent.id, repo: "hello-world", text: "Fix the login" };

  expect((await codeStartOptions(f.db, member.id, f.org.id)).agents).toEqual([]);
  await expect(createCodeSession(deps, member.id, f.org.id, input)).rejects.toMatchObject({ code: "audience.only" });
  expect(await f.db.select().from(schema.codeSessions)).toHaveLength(0);

  expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents.map((a) => a.agentId)).toEqual([f.agent.id]);
  const session = await createCodeSession(deps, f.owner.id, f.org.id, input);
  expect(session.agentId).toBe(f.agent.id);
});

test("in a session, a message from someone its agent doesn't answer starts no run and its receipt is settled", async () => {
  f = await setup();
  await ownerOnlyAgent();
  const member = await addMember(f.db, f.org.id, "member");
  const session = await sessionWith([member.id]);
  const events = f.listen(session.channelId);
  const deps = { db: f.db, pubsub: f.pubsub };
  const post = (userId: string, body: string) =>
    postPersonMessage(deps, userId, f.org.id, session.channelId, { body, threadId: session.rootMessageId });
  const routed = (messageId: string) => events.filter((e) => e.type === "message.routed" && e.messageId === messageId);

  const theirs = await post(member.id, "can you see this?");
  expect(await runsIn(session.channelId)).toHaveLength(0);
  expect(theirs.notices?.map((n) => n.code)).toEqual(["audience.only"]);
  expect(routed(theirs.id)).toMatchObject([{ pickedBy: [], seenBy: [], strategy: "none" }]);

  // The owner's goes to the session's agent, as before.
  const mine = await post(f.owner.id, "look here");
  expect((await runsIn(session.channelId)).map((r) => r.triggerMessageId)).toEqual([mine.id]);
  expect(routed(mine.id)).toMatchObject([{ pickedBy: [f.agent.id] }]);

  await expect(
    saveCodeSessionFile(deps, member.id, f.org.id, session.id, { path: "a.ts", content: "x", rev: "0" }),
  ).rejects.toMatchObject({ code: "audience.only" });
});

test("a worktree that becomes ready hands over the newest message of someone the agent answers", async () => {
  f = await setup();
  await ownerOnlyAgent();
  const member = await addMember(f.db, f.org.id, "member");
  const session = await sessionWith([member.id], "preparing");
  const events = f.listen(session.channelId);
  const deps = { db: f.db, pubsub: f.pubsub };
  const post = (userId: string, body: string) =>
    postPersonMessage(deps, userId, f.org.id, session.channelId, { body, threadId: session.rootMessageId });

  const mine = await post(f.owner.id, "fix the login");
  const theirs = await post(member.id, "and the sign-up too");
  // Nothing runs before the worktree, and neither message waits on a decision.
  expect(await runsIn(session.channelId)).toHaveLength(0);
  expect(events.filter((e) => e.type === "message.routed").map((e) => e.messageId)).toEqual([mine.id, theirs.id]);

  await releaseRequest(deps, session);
  expect((await runsIn(session.channelId)).map((r) => r.triggerMessageId)).toEqual([mine.id]);
  expect(events.filter((e) => e.type === "message.routed").at(-1)).toMatchObject({
    messageId: mine.id,
    pickedBy: [f.agent.id],
  });
});
