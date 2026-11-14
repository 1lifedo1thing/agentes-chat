import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import { createAgent, drainOutbox, openDm, postPersonMessage } from "../src";
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
    reply: (req: ModelRequest) => {
      const system = systemText(req.system ?? "");
      const last = JSON.stringify(req.messages.at(-1)?.content);
      prompts.push({ system, last });
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (system.includes(AGENTS_DM)) return { chunks: ["Pronto: está no Drive em Vendas/Outubro, subiu 12%."] };
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
});
