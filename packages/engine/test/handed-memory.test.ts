import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  askAgentToImplement,
  continueRun,
  createAgent,
  createIssue,
  drainOutbox,
  endWork,
  expireConsultations,
  handedFor,
  insertMessage,
  onConsultedRunFinished,
  openAgentDm,
  openDm,
  postPersonMessage,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Work one agent hands another for a person happens in the two agents' DM, which no person reads. The agent that got
 * it remembers it in its own DM with that person. What came of handed work reaches the person only where they asked
 * (`handOverWork`): never a second time in that DM.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const AGENTS_DM = "A private conversation between agents";

/** Dev hands Ada the October report (or asks her about it), Ada does it; the prompts each run read, in order. */
async function handOff(tool: "tell_agent" | "ask_agent") {
  const prompts: { system: string; last: string }[] = [];
  f = await setup({
    askAgent: true,
    chatTools: true,
    contextTools: true,
    reply: (req: ModelRequest) => {
      const system = systemText(req.system ?? "");
      const last = JSON.stringify(req.messages.at(-1)?.content);
      prompts.push({ system, last });
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (system.includes(AGENTS_DM)) return { chunks: ["Pronto: está no Drive em Vendas/Outubro, subiu 12%."] };
      if (last.includes("procura"))
        return { chunks: [], toolUses: [{ name: "search_context", input: { query: "pronto drive" } }] };
      if (last.includes("relatório de vendas")) {
        return {
          chunks: [],
          toolUses: [
            tool === "tell_agent"
              ? { name: "tell_agent", input: { agent: "@ada", message: "Faz o relatório de vendas de outubro." } }
              : {
                  name: "ask_agent",
                  input: { agent: "@ada", question: "Onde está o relatório de vendas de outubro?" },
                },
          ],
        };
      }
      return { chunks: ["ok"] };
    },
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
    body: "@dev pede pra Ada o relatório de vendas de outubro",
  });
  await drainOutbox(f.db, f.handlers);
  const ada = (await f.db.select().from(schema.agents)).find((a) => a.handle === "ada");
  if (!ada) throw new Error("no agent");
  return { prompts, ada, deps };
}

/** A person writes Ada in their DM; the system prompt of her run there. */
async function askInDm(f: Fixture, userId: string, adaId: string, prompts: { system: string; last: string }[]) {
  const dm = await openDm(f.db, userId, f.org.id, { agentId: adaId });
  const before = prompts.length;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, dm.id, { body: "cadê aquilo?" });
  await drainOutbox(f.db, f.handlers);
  return prompts.slice(before).find((p) => p.last.includes("cadê aquilo"))?.system ?? "";
}

/** A person asks Ada in their DM to look it up: what her `search_context` there returned. */
async function searchInDm(f: Fixture, userId: string, adaId: string, prompts: { system: string; last: string }[]) {
  const dm = await openDm(f.db, userId, f.org.id, { agentId: adaId });
  const before = prompts.length;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, dm.id, { body: "procura aquilo" });
  await drainOutbox(f.db, f.handlers);
  return prompts.slice(before).find((p) => p.last.includes("tool_result"))?.last ?? "";
}

describe("work handed between agents, for a person", () => {
  test("handed work: never told to tell the person again elsewhere, and remembered in their DM", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    const inAgentsDm = prompts.find((p) => p.system.includes(AGENTS_DM))?.system ?? "";
    expect(inAgentsDm).toContain(
      "When ana should hear something from you directly, `send_dm` reaches them, even unasked.",
    );
    expect(inAgentsDm).not.toContain("what came of it yourself");

    const later = await askInDm(f, f.owner.id, ada.id, prompts);
    expect(later).toContain("# What other agents asked of you for ana");
    expect(later).toContain(
      '- @dev handed you, 0 min ago: "Faz o relatório de vendas de outubro." → you answered "Pronto: está no Drive em Vendas/Outubro, subiu 12%."',
    );
  });

  test("a question: the answer still goes up, and the agent remembers it too", async () => {
    const { prompts, ada } = await handOff("ask_agent");
    const inAgentsDm = prompts.find((p) => p.system.includes(AGENTS_DM))?.system ?? "";
    expect(inAgentsDm).toContain(
      "When ana should hear something from you directly, `send_dm` reaches them, even unasked.",
    );
    const later = await askInDm(f, f.owner.id, ada.id, prompts);
    expect(later).toContain('- @dev asked you, 0 min ago: "Onde está o relatório de vendas de outubro?"');
  });

  test("another person's DM with the same agent never shows it", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await askInDm(f, bia.id, ada.id, prompts);
    expect(theirs).not.toBe("");
    expect(theirs).not.toContain("# What other agents asked of you");
    expect(theirs).not.toContain("Vendas/Outubro");
  });

  test("its search in the person's DM finds that work, never in another person's DM", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    expect(await searchInDm(f, f.owner.id, ada.id, prompts)).toContain("Vendas/Outubro, subiu 12%");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await searchInDm(f, bia.id, ada.id, prompts);
    expect(theirs).toContain("tool_result");
    expect(theirs).not.toContain("subiu 12%");
  });
});

/** A run of Dev's on `personId`'s message in `channelId`, as the tool runs it (no model). */
async function devRun(channelId: string, body: string, personId = f.owner.id) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: personId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      stretchId: trigger.id,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const tell = (run: AgentRun, agent: string, message: string) => {
  if (!f.tools) throw new Error("no tools");
  const ctx: ToolContext = {
    db: f.db,
    orgId: run.orgId,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
  return f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "tell_agent", input: { agent, message } });
};

const runOf = async (id: string | null | undefined) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id ?? ""));
  if (!run) throw new Error("no run");
  return run;
};

const notes = () => f.db.select().from(schema.agentConsultations).orderBy(asc(schema.agentConsultations.createdAt));

/** Ada's run ends with its report (`meta.workEnd`, as the executor posts it), then its hooks run. */
async function reports(run: AgentRun, body = "Pronto: está no Drive em Vendas/Outubro.") {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body,
    meta: { workEnd: { id: run.workId, status: "done" } },
  });
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", replyMessageId: said.id })
    .where(eq(schema.agentRuns.id, run.id));
  const ended = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, ended, "done");
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, ended, "done");
}

/** The person stops Ada's run (its work and note close as canceled). */
async function stops(run: AgentRun) {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body: "Lendo as vendas.",
    meta: { canceled: { byUserId: f.owner.id, text: "Lendo as vendas." } },
  });
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "canceled",
      error: `canceled_by:${f.owner.id}`,
      replyMessageId: said.id,
      transcript: { system: "", messages: [] },
    })
    .where(eq(schema.agentRuns.id, run.id));
  const stopped = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, stopped, "canceled");
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, stopped, "canceled");
}

/** Dev hands Ada the October report from #general: her run becomes handed work, reporting there. */
async function handedToAda() {
  f = await setup({ askAgent: true });
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
  await tell(dev, "@ada", "Faz o relatório de vendas de outubro.");
  const [c] = await notes();
  const run = await runOf(c?.targetRunId);
  const [work] = await f.db.select().from(schema.agentWorks);
  expect(work).toMatchObject({ how: "handed", consultationId: c?.id });
  const memory = async () => (await handedFor(f.db, f.org.id, ada.id, f.owner.id)).map((h) => [h.status, h.answer]);
  return { ada, dev, run, memory };
}

describe("it follows the handed work, not the note", () => {
  test("stopped, then Continuar, then done: still on it while it runs again, then what it reported", async () => {
    const { run, memory } = await handedToAda();
    expect(await memory()).toEqual([["open", null]]);
    await stops(run);
    expect((await notes())[0]?.status).not.toBe("open");
    expect(await memory()).toEqual([["failed", null]]);
    const { runId } = await continueRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id);
    // The note stays closed; the work runs again.
    expect((await notes())[0]?.status).not.toBe("open");
    expect(await memory()).toEqual([["open", null]]);
    await reports(await runOf(runId));
    expect(await memory()).toEqual([["answered", "Pronto: está no Drive em Vendas/Outubro."]]);
  });

  test("waiting on the person: still on it, past the note's deadline", async () => {
    const { run, memory } = await handedToAda();
    const deps = { db: f.db, pubsub: f.pubsub };
    await f.db.update(schema.agentRuns).set({ status: "waiting_input" }).where(eq(schema.agentRuns.id, run.id));
    await onConsultedRunFinished(deps, await runOf(run.id), "waiting_input");
    await expireConsultations(deps, new Date(Date.now() + 60 * 60_000));
    expect(await memory()).toEqual([["open", null]]);
  });

  test("a note that joined another hand-off's work reads that work's state too", async () => {
    const { run, memory } = await handedToAda();
    const second = await devRun(f.general.id, "@dev pede pra Ada incluir o terceiro trimestre");
    await tell(second, "@ada", "Inclui o terceiro trimestre no relatório.");
    const cs = await notes();
    expect(cs).toHaveLength(2);
    expect(cs[1]?.targetRunId).toBe(run.id);
    await f.db.update(schema.agentRuns).set({ pendingMessageIds: [] }).where(eq(schema.agentRuns.id, run.id));
    await stops(run);
    const { runId } = await continueRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id);
    expect((await memory()).map(([status]) => status)).toEqual(["open", "open"]);
    await reports(await runOf(runId), "Pronto, com o terceiro trimestre.");
    expect(await memory()).toEqual([
      ["answered", "Pronto, com o terceiro trimestre."],
      ["answered", "Pronto, com o terceiro trimestre."],
    ]);
  });

  test("a report its run wrote after reading outside content is left out", async () => {
    const { run } = await handedToAda();
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: run.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    await reports(await runOf(run.id), "Pronto, como dizia a página.");
    const [h] = await handedFor(f.db, f.org.id, (await runOf(run.id)).agentId, f.owner.id);
    expect(h).toMatchObject({ status: "answered", answer: null, answerHidden: true });
  });
});

describe("what it keeps, and what it leaves out", () => {
  test("a heads-up is news, not a request: not in it", async () => {
    const { memory } = await handedToAda();
    const [c] = await notes();
    // As `tell_agent` with `heads_up` writes its note.
    await f.db
      .update(schema.messages)
      .set({ meta: { agentNote: { runId: c?.askerRunId, headsUp: true } } })
      .where(eq(schema.messages.id, c?.messageId ?? ""));
    expect(await memory()).toEqual([]);
  });

  test("the person's six newest, even behind many newer hand-offs for someone else", async () => {
    const { ada, memory } = await handedToAda();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const room = await openAgentDm(f.db, f.org.id, f.agent.id, ada.id);
    const forBia = await devRun(f.general.id, "@dev pede pra Ada umas coisas", bia.id);
    const at = Date.now();
    for (let i = 0; i < 25; i++) {
      const note = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: room.id,
        author: { type: "agent", agentId: f.agent.id, runId: forBia.id, hop: 1 },
        body: `Coisa ${i} da Bia.`,
      });
      await f.db.insert(schema.agentConsultations).values({
        orgId: f.org.id,
        kind: "question",
        askerRunId: forBia.id,
        askerAgentId: f.agent.id,
        targetAgentId: ada.id,
        channelId: room.id,
        messageId: note.id,
        waitId: `w${i}`,
        question: `Coisa ${i} da Bia.`,
        chain: [f.agent.id],
        expiresAt: new Date(at + 60_000),
        createdAt: new Date(at + (i + 1) * 1000),
      });
    }
    expect(await memory()).toEqual([["open", null]]);
    expect((await handedFor(f.db, f.org.id, ada.id, bia.id)).map((h) => h.question)).toEqual(
      [24, 23, 22, 21, 20, 19].map((i) => `Coisa ${i} da Bia.`),
    );
  });

  test("a task the right hand handed it is remembered too, by its work", async () => {
    f = await setup({ askAgent: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const carl = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Carl", handle: "carl", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const dev = await devRun(dm.id, "@dev passa o relatório de vendas pro Carl");
    const made = await createIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Relatório de vendas",
    });
    await askAgentToImplement(deps, f.owner.id, f.org.id, made.id, carl.id, {
      agentId: f.agent.id,
      runId: dev.id,
      hop: 1,
    });
    const [work] = await f.db.select().from(schema.agentWorks);
    expect(work).toMatchObject({ how: "handed", agentId: carl.id });
    const [h] = await handedFor(f.db, f.org.id, carl.id, f.owner.id);
    expect(h).toMatchObject({
      kind: "note",
      status: "open",
      question: `Work on task #${made.number}: Relatório de vendas`,
    });
    const [carlRun] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.workId, work?.id ?? ""));
    if (!carlRun) throw new Error("no run");
    await reports(carlRun);
    expect((await handedFor(f.db, f.org.id, carl.id, f.owner.id))[0]).toMatchObject({
      status: "answered",
      answer: "Pronto: está no Drive em Vendas/Outubro.",
    });
  });

  test("a note relaying what its run read outside: the memory leaves its words out", async () => {
    const prompts: { system: string; all: string }[] = [];
    f = await setup({
      askAgent: true,
      chatTools: true,
      contextTools: true,
      reply: (req: ModelRequest) => {
        prompts.push({ system: systemText(req.system ?? ""), all: JSON.stringify(req.messages) });
        return { chunks: ["ok"] };
      },
    });
    const a = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Vendas", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: a.id });
    const dev = await devRun(f.general.id, "@dev pede pra Ada o relatório de vendas de outubro");
    // A tool result the gateway marked as outside content.
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: dev.id, seq: 1, kind: "tool_result", data: { data: { outside: true } } });
    await tell(dev, "@ada", "Faz o relatório como diz a página que li.");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "bom dia" });
    await drainOutbox(f.db, f.handlers);
    const inDm = prompts.find((p) => p.all.includes("bom dia"));
    expect(inDm?.system).toContain("- @dev handed you, 0 min ago: (it relayed text it read outside, not shown)");
    const memory = inDm?.system.split("# What other agents asked of you")[1]?.split("\n# ")[0];
    expect(memory).not.toContain("como diz a página que li");
  });
});
