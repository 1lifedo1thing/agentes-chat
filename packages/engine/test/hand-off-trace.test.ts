import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import { addChannelMember, createAgent, drainOutbox, handedConversation, openDm, postPersonMessage } from "../src";
import { isQuietNotice } from "../src/notices";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Work one agent hands another for a person happens in the two agents' DM, which no person reads. The agent that got
 * it remembers it in its own DM with that person, and for handed work it tells them itself.
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
  test("handed work: the agent tells the person itself, and remembers it in their DM", async () => {
    const { prompts, ada } = await handOff("tell_agent");
    const inAgentsDm = prompts.find((p) => p.system.includes(AGENTS_DM))?.system ?? "";
    expect(inAgentsDm).toContain(
      "This is work handed to you: once it is done, tell ana what came of it yourself with `send_dm`, then answer here in one line.",
    );
    expect(inAgentsDm).not.toContain("even unasked");

    const later = await askInDm(f, f.owner.id, ada.id, prompts);
    expect(later).toContain("# What other agents asked of you for ana");
    expect(later).toContain(
      '- @dev handed you, 0 min ago: "Faz o relatório de vendas de outubro." → you answered "Pronto: está no Drive em Vendas/Outubro, subiu 12%."',
    );
  });

  test("a question: the answer still goes up, and the agent remembers it too", async () => {
    const { prompts, ada } = await handOff("ask_agent");
    const inAgentsDm = prompts.find((p) => p.system.includes(AGENTS_DM))?.system ?? "";
    expect(inAgentsDm).not.toContain("This is work handed to you");
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

/** The hand-off rows (`hand_off` notices) in the workspace, with where they are. */
const traces = async () =>
  (await f.db.select().from(schema.messages)).flatMap((m) => {
    const n = (m.meta as { notice?: { kind: string; refs: Record<string, string> } }).notice;
    return n?.kind === "hand_off" ? [{ message: m, refs: n.refs }] : [];
  });

describe("its trace in the DM of the agent that got it", () => {
  test("one quiet row in that agent's DM with the person, settled in place once the work ends", async () => {
    const { ada } = await handOff("tell_agent");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    const rows = await traces();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatchObject({ channelId: dm.id, authorAgentId: ada.id });
    expect(rows[0]?.refs).toMatchObject({
      consultationId: consultation?.id,
      askerAgentId: f.agent.id,
      agentId: ada.id,
      kind: "note",
      status: "answered",
      question: "Faz o relatório de vendas de outubro.",
    });
    expect(Date.parse(rows[0]?.refs.answeredAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(rows[0]?.refs.createdAt ?? ""),
    );
    // Quiet: no unread, no preview, no notification.
    expect(isQuietNotice(rows[0]?.message.meta)).toBe(true);
    const notified = await f.db.select().from(schema.notifications);
    expect(notified.filter((n) => (n.source as { channelId?: string }).channelId === dm.id)).toEqual([]);
    // It woke nobody: Ada ran once, in the agents' DM.
    const adaRuns = (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === ada.id);
    expect(adaRuns.map((r) => r.channelId)).toEqual([consultation?.channelId ?? ""]);
  });

  test("it opens the exchange for the person who reads where it was handed off, never for someone who doesn't", async () => {
    const { ada } = await handOff("ask_agent");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ada.id });
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    const id = consultation?.id ?? "";
    const opened = await handedConversation(f.db, f.org.id, dm.id, id, f.owner.id);
    expect(opened?.consultation).toMatchObject({ id, consultedAgentId: ada.id, status: "answered" });
    expect(opened?.messages.map((m) => m.body)).toContain("Onde está o relatório de vendas de outubro?");
    // Someone who doesn't read #general, where it was asked.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect(await handedConversation(f.db, f.org.id, dm.id, id, bia.id)).toBeNull();
    // A DM it left no trace in.
    const biaDm = await openDm(f.db, bia.id, f.org.id, { agentId: ada.id });
    expect(await handedConversation(f.db, f.org.id, biaDm.id, id, f.owner.id)).toBeNull();
  });

  test("none when the person may not talk to the agent that got it", async () => {
    const { ada } = await handOff("tell_agent");
    expect(await traces()).toHaveLength(1);
    await f.db.delete(schema.messages).where(eq(schema.messages.id, (await traces())[0]?.message.id ?? ""));
    // The same note within the hour is dropped unless the first one never got done.
    await f.db.update(schema.agentConsultations).set({ status: "expired" });
    // Only its owner now: work handed to it for anyone else leaves no trace.
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, ada.id));
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: lia.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, lia.id, f.org.id, f.general.id, {
      body: "@dev pede pra Ada o relatório de vendas de outubro",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentConsultations)).length).toBe(2);
    expect(await traces()).toEqual([]);
  });
});
