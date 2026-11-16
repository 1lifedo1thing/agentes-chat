import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  buildRunContext,
  CONFIDENTIAL_STUB,
  createConnectorToolSource,
  createToolGateway,
  markThreadConfidential,
  messageLink,
  messageView,
  moveToBackground,
  sealStragglers,
  type ToolContext,
} from "../src";
import { inertLinks } from "../src/format";
import { closeWorlds } from "./autonomy/harness";
import { CANARY, VAULT_HOST, type VaultWorld, vaultWorld } from "./confidential-fixtures";

// ADR 0189: a server the operator vouches for marks a tool result as confidential. The run that read it goes on
// reading and answers under the message that asked it, and outside that thread no reader of a message is given the
// thread's words. Fixtures only (no real model): what is checked is what the engine stores and hands on.

afterEach(closeWorlds);

const READ = { name: "vault_read_record", input: { id: "r1" } };

const steps = (w: VaultWorld, handle = "kai") => w.runs(handle).then((runs) => w.steps(runs.map((r) => r.id)));
const sealedThreads = (w: VaultWorld) => w.db.select().from(schema.confidentialThreads);

describe("the mark", () => {
  test("from a listed server: the step carries it, the model reads the text, the reply goes under the message that asked and carries it", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: "The customer wrote it twice." }] },
    });
    const asked = await w.say("@kai what does record r1 say?");
    await w.settle();

    const result = (await steps(w)).find((s) => s.kind === "tool_result" && s.data.name === READ.name);
    expect(result?.data.data).toMatchObject({ confidential: true, outside: true });
    // Its own model was handed the words.
    expect(w.turnsOf("kai").join("\n")).toContain(CANARY);

    const [reply] = await w.posts("kai");
    expect(reply?.threadId).toBe(asked.id);
    expect(reply?.meta.confidential).toBe(true);
    expect(await sealedThreads(w)).toEqual([
      expect.objectContaining({ rootMessageId: asked.id, channelId: w.channelId, connectionIds: [w.connectionId] }),
    ]);
  });

  test("the thread is sealed from its root: a message's body is the stub for whatever reads it, and whole for the people who read the conversation", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `It says ${CANARY}: see https://example.com/?q=${CANARY}` }] },
    });
    const asked = await w.say("@kai here is what they pasted: the invoice came twice. Read record r1.");
    await w.settle();

    const rows = await w.stored();
    const root = rows.find((m) => m.id === asked.id);
    const reply = rows.find((m) => m.authorType === "agent");
    // The root was written before any mark: sealed with the rest.
    expect(root?.body).toBe(CONFIDENTIAL_STUB);
    expect(root?.meta.confidential).toBe(true);
    expect(reply?.body).toBe(CONFIDENTIAL_STUB);
    for (const m of [root, reply])
      expect(JSON.stringify({ ...m, meta: { ...m?.meta, sealedBody: "" } })).not.toContain("invoice");
    // People read the words, and never get the seal's own copy beside them.
    const seen = rows.map(messageView);
    expect(seen.find((m) => m.id === asked.id)?.body).toContain("the invoice came twice");
    expect(seen.find((m) => m.id === reply?.id)?.body).toContain(`It says ${CANARY}`);
    expect(JSON.stringify(seen.map((m) => m.meta))).not.toContain("sealedBody");
    // An address the run wrote is no link in any app.
    expect(seen.find((m) => m.id === reply?.id)?.body).toContain(`\`https://example.com/?q=${CANARY}\``);
  });

  test("the same key from a server the operator did not list changes nothing", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      listed: false,
      script: { kai: [{ calls: [READ] }, { text: "The customer wrote it twice." }] },
    });
    const asked = await w.say("@kai what does record r1 say?");
    await w.settle();

    const result = (await steps(w)).find((s) => s.kind === "tool_result" && s.data.name === READ.name);
    expect(result?.data.data).not.toHaveProperty("confidential");
    const rows = await w.stored();
    // As before: the reply in the main timeline, every body as written, no mark anywhere.
    expect(rows.map((m) => [m.threadId, m.body])).toEqual([
      [null, "@kai what does record r1 say?"],
      [null, "The customer wrote it twice."],
    ]);
    expect(rows.find((m) => m.id === asked.id)?.meta).toEqual({});
    expect(JSON.stringify(rows)).not.toMatch(/confidential|sealedBody/);
    expect(await sealedThreads(w)).toEqual([]);
  });

  test("a run that reads no confidential result answers where it always did, and its messages are stored as written", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [{ name: "vault_list_records", input: {} }] }, { text: "Two records." }] },
    });
    await w.say("@kai which records are there?");
    await w.settle();
    const rows = await w.stored();
    expect(rows.map((m) => [m.threadId, m.body])).toEqual([
      [null, "@kai which records are there?"],
      [null, "Two records."],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/confidential|sealedBody/);
    expect(await sealedThreads(w)).toEqual([]);
  });
});

describe("the thread", () => {
  test("what the agent posted before stays in the main timeline; a later run of the thread reads it whole; a run asked elsewhere in the channel reads the stub and answers in the main timeline", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: {
        kai: [
          { text: "Hello." },
          { calls: [READ] },
          { text: `The record holds ${CANARY}.` },
          { text: "As I said above." },
          { text: "Nothing about that here." },
        ],
      },
    });
    await w.say("@kai hello");
    await w.settle();
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const [hello, finding] = await w.posts("kai");
    expect([hello?.threadId, hello?.body, hello?.meta.confidential]).toEqual([null, "Hello.", undefined]);
    expect(finding?.threadId).toBe(asked.id);

    // A follow-up under the message that asked: the same thread, read whole by the run the lock holds.
    const before = w.turnsOf("kai").length;
    await w.say("@kai and what did it hold?", { threadId: asked.id });
    await w.settle();
    const inThread = w.turnsOf("kai").slice(before).join("\n");
    expect(inThread).toContain(`The record holds ${CANARY}.`);
    expect(inThread).toContain("and what did it hold?");
    const followUp = (await w.posts("kai")).at(-1);
    expect([followUp?.threadId, followUp?.meta.confidential, followUp?.body]).toEqual([
      asked.id,
      true,
      CONFIDENTIAL_STUB,
    ]);

    // Another top-level message of the same channel: the first thread is among the channel's newest messages.
    const elsewhere = w.turnsOf("kai").length;
    await w.say("@kai what did the other thread find?");
    await w.settle();
    const outside = w.turnsOf("kai").slice(elsewhere).join("\n");
    expect(outside).not.toContain(CANARY);
    expect(outside).not.toContain("and what did it hold?");
    expect(outside).toContain(CONFIDENTIAL_STUB);
    const last = (await w.posts("kai")).at(-1);
    expect([last?.threadId, last?.body, last?.meta.confidential]).toEqual([
      null,
      "Nothing about that here.",
      undefined,
    ]);
  });

  test("a run that reads a message of the thread by its link, or finds it by its words, is given the stub and stays free", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { contextTools: true },
      script: {
        kai: ({ n }) =>
          n === 1
            ? { calls: [READ] }
            : n === 2
              ? { text: `The record holds ${CANARY}.` }
              : n === 3
                ? {
                    calls: [
                      { name: "read_conversation", input: { message: link } },
                      { name: "search_context", input: { query: CANARY, kinds: ["message"] } },
                    ],
                  }
                : { text: "I can't read that from here." },
      },
    });
    let link = "";
    const asked = await w.say(`@kai read record r1 about ${CANARY}`);
    await w.settle();
    const [finding] = await w.posts("kai");
    link = messageLink(w.org.id, { channelId: w.channelId, threadId: asked.id, id: finding?.id ?? "" });

    await w.say("@kai open that link");
    await w.settle();
    const calls = (await w.calls("kai")).slice(1);
    expect(calls.map((c) => [c.name, c.isError])).toEqual([
      ["read_conversation", false],
      ["search_context", false],
    ]);
    expect(JSON.stringify(calls)).not.toContain(CANARY);
    expect(calls[0]?.result).toContain(CONFIDENTIAL_STUB);
    const last = (await w.posts("kai")).at(-1);
    expect([last?.threadId, last?.meta.confidential]).toEqual([null, undefined]);
    expect(await sealedThreads(w)).toHaveLength(1);
  });
});

describe("a run that does not think through the Model Gateway", () => {
  /** A run of the world's agent, started by hand so its brain can be set. */
  async function runOf(w: VaultWorld, brain: string) {
    const asked = await w.say("read record r1");
    const [run] = await w.db
      .insert(schema.agentRuns)
      .values({
        orgId: w.org.id,
        agentId: w.agents.kai?.id ?? "",
        channelId: w.channelId,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        brain,
      })
      .returning();
    if (!run) throw new Error("no run");
    const ctx: ToolContext = {
      db: w.db,
      orgId: w.org.id,
      agentId: run.agentId,
      runId: run.id,
      channelId: w.channelId,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    return { run, ctx, asked };
  }
  const gatewayOf = (w: VaultWorld) =>
    createToolGateway({
      sources: [
        createConnectorToolSource({
          db: w.db,
          keyWrappers: [w.f.keyWrapper],
          publicUrl: "https://chat.example.com",
          resolveHost: async () => ["93.184.216.34"],
          connect: w.vault.connect,
          callerIdentity: new Map([[VAULT_HOST, "test-secret-".padEnd(32, "x")]]),
        }),
      ],
    });

  test("a program on a computer is given the stub for the result, and nothing is marked", async () => {
    const w = await vaultWorld({ agents: ["kai"] });
    const gateway = gatewayOf(w);
    for (const [brain, bridge] of [
      ["claude_code", undefined],
      ["model", { machineId: "m1" }],
    ] as const) {
      const { run, ctx } = await runOf(w, brain);
      const out = await gateway.invoke({ ...ctx, ...(bridge ? { bridge } : {}) }, { toolUseId: "t1", ...READ });
      expect(out).toMatchObject({ type: "result", output: { content: CONFIDENTIAL_STUB } });
      const kept = await w.steps([run.id]);
      expect(JSON.stringify(kept)).not.toContain(CANARY);
      expect(JSON.stringify(kept)).not.toContain('"confidential"');
    }
    expect(await sealedThreads(w)).toEqual([]);
    expect(JSON.stringify(await w.stored())).not.toMatch(/"confidential"|sealedBody/);
  });

  test("in a confidential thread its context holds the stub for the thread's own messages too", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `The record holds ${CANARY}.` }] },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const reply = await w.say("and then?", { threadId: asked.id });
    const [run] = await w.db
      .insert(schema.agentRuns)
      .values({
        orgId: w.org.id,
        agentId: w.agents.kai?.id ?? "",
        channelId: w.channelId,
        threadRootId: asked.id,
        triggerMessageId: reply.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const agent = w.agents.kai;
    if (!run || !agent) throw new Error("no run");
    const read = async (unseal: boolean) =>
      JSON.stringify((await buildRunContext(w.db, run, agent, { maxMessages: 30, unseal })).messages);
    const sealed = await read(false);
    expect(sealed).not.toContain(CANARY);
    expect(sealed).not.toContain("and then?");
    expect(sealed).toContain(CONFIDENTIAL_STUB);
    const whole = await read(true);
    expect(whole).toContain(`The record holds ${CANARY}.`);
    expect(whole).toContain("and then?");
  });
});

describe("the seal", () => {
  test("a thread's messages leave the search index in the transaction that marks it, before any job runs", async () => {
    const w = await vaultWorld({ agents: ["kai"], script: { kai: [{ text: "Noted." }] } });
    const asked = await w.say(`@kai note this: ${CANARY}`);
    await w.settle();
    const indexed = async () => JSON.stringify(await w.db.select().from(schema.searchDocuments));
    expect(await indexed()).toContain(CANARY);
    await w.db.transaction((tx) =>
      markThreadConfidential(tx, { orgId: w.org.id, channelId: w.channelId, rootId: asked.id }),
    );
    expect(await indexed()).not.toContain(CANARY);
  });

  test("a note the server rewords in place shows its new text, and a message the mark missed is sealed by the sweep", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `The record holds ${CANARY}.` }] },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const [reply] = await w.posts("kai");
    const row = async (id: string) => {
      const found = (await w.stored()).find((m) => m.id === id);
      if (!found) throw new Error(`no message ${id}`);
      return found;
    };
    // The server writes a note's body again (a wait that ended).
    await w.db
      .update(schema.messages)
      .set({ body: "The provider answers again." })
      .where(eq(schema.messages.id, reply?.id ?? ""));
    expect(messageView(await row(reply?.id ?? "")).body).toBe("The provider answers again.");
    // Written while the mark was being committed: stored as typed.
    const [late] = await w.db
      .insert(schema.messages)
      .values({
        orgId: w.org.id,
        channelId: w.channelId,
        threadId: asked.id,
        authorType: "person",
        authorUserId: w.owner.id,
        body: "typed during the mark",
      })
      .returning();
    expect(await sealStragglers(w.db)).toBe(2);
    for (const [id, words] of [
      [reply?.id ?? "", "The provider answers again."],
      [late?.id ?? "", "typed during the mark"],
    ] as const) {
      const sealed = await row(id);
      expect([sealed.body, sealed.meta.confidential, messageView(sealed).body]).toEqual([
        CONFIDENTIAL_STUB,
        true,
        words,
      ]);
    }
    expect(await sealStragglers(w.db)).toBe(0);
  });

  test("a run of a confidential thread is not moved to the background: it answers in its thread", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: {
        kai: [
          { calls: [READ] },
          {
            calls: [
              { name: "ask_user", input: { question: "Go on?", why: "Only the person can say whether to go on." } },
            ],
          },
        ],
      },
    });
    await w.say("@kai read record r1 and ask me");
    await w.settle();
    const [run] = await w.runs("kai");
    expect(run?.status).toBe("waiting_input");
    expect(await moveToBackground({ db: w.db }, run?.id ?? "", { how: "auto", title: "Reading" })).toBeNull();
    expect((await w.runs("kai"))[0]?.workId).toBeNull();
  });
});

test("inertLinks: a link keeps its words, a bare address becomes code, code stays as written", () => {
  expect(inertLinks("see [the report](https://example.com/r?x=1) and https://example.com/a?b=c.")).toBe(
    "see the report and `https://example.com/a?b=c.`",
  );
  expect(inertLinks("![](https://example.com/p.png) [](https://example.com/q)")).toBe(
    "`https://example.com/p.png` `https://example.com/q`",
  );
  expect(inertLinks("run `curl https://example.com` then\n```\nhttps://example.com/x\n```")).toBe(
    "run `curl https://example.com` then\n```\nhttps://example.com/x\n```",
  );
  expect(inertLinks("no address here")).toBe("no address here");
});

test("a workspace's messages are untouched by the seal's statement when no thread is confidential", async () => {
  const w = await vaultWorld({ agents: ["kai"], script: { kai: [{ text: "Hi." }, { text: "In the thread." }] } });
  const top = await w.say("@kai hi");
  await w.settle();
  await w.say("@kai and here?", { threadId: top.id });
  await w.settle();
  const rows = await w.stored();
  expect(rows.map((m) => [m.threadId, m.body, m.meta.confidential])).toEqual([
    [null, "@kai hi", undefined],
    [null, "Hi.", undefined],
    [top.id, "@kai and here?", undefined],
    [top.id, "In the thread.", undefined],
  ]);
  const [agentRow] = await w.db.select().from(schema.messages).where(eq(schema.messages.authorType, "agent"));
  expect(agentRow?.meta).not.toHaveProperty("sealedBody");
});
