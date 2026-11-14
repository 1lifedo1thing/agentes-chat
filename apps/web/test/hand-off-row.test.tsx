import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, RunConsultation } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const QUESTION = "Relatório de vendas de outubro: total por região e o que mudou desde setembro.";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

/** Atlas's request to Ada for me, as its row lands in my DM with Ada (`hand_off`), open or settled. */
function withHandOff(status: "open" | "answered" | "failed", question = QUESTION) {
  const state = seedState();
  const channelId = seedDm(
    state,
    { type: "agent", id: ADA_ID },
    { ago: 30, body: "Bom dia. Hoje cuido das métricas." },
  );
  const refs: Record<string, string> = {
    consultationId: "c-handed",
    askerAgentId: ATLAS_ID,
    agentId: ADA_ID,
    kind: "note",
    status,
    question,
    createdAt: ago(240),
    ...(status === "open" ? {} : { answeredAt: ago(60) }),
  };
  const row: Message = {
    id: "m-handed",
    channelId,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "atlas: x",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { notice: { kind: "hand_off", text: `"${question}"`, from: "@atlas", refs } },
    createdAt: ago(240),
  };
  state.messages.push(row);
  if (status === "answered")
    state.messages.push({
      id: "m-told",
      channelId,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "O Atlas me pediu o relatório de vendas de outubro. Já está no Drive em Vendas/Outubro.",
      mentionedAgentIds: [],
      agentRunId: "r-told",
      meta: {},
      createdAt: ago(50),
    });
  const consultation: RunConsultation = {
    id: "c-handed",
    kind: "note",
    runId: "r-atlas",
    agentId: ATLAS_ID,
    consultedAgentId: ADA_ID,
    consultedRunId: "r-ada",
    status: status === "open" ? "open" : status,
    waiting: null,
    question,
    answer: status === "answered" ? "Pronto. Está no Drive em Vendas/Outubro." : null,
    createdAt: ago(240),
    answeredAt: status === "open" ? null : ago(60),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  state.consultationConversations = {
    "c-handed": {
      consultation,
      messages: [
        {
          id: "dm-note",
          channelId: "dm-atlas-ada",
          threadId: null,
          author: { type: "agent", id: ATLAS_ID },
          body: question,
          mentionedAgentIds: [],
          agentRunId: "r-atlas",
          meta: {},
          createdAt: ago(240),
        },
      ],
    },
  };
  return state;
}

const open = async (state: ReturnType<typeof seedState>) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(3);
  return r;
};
const row = () => document.querySelector(".consult-pair__row") as HTMLElement | null;

describe("another agent's request in my DM with the agent it went to", () => {
  test("one quiet row: who asked whom and what, then how long it took; a click opens the exchange", async () => {
    await open(withHandOff("answered"));
    expect(row()?.textContent).toContain("Atlas");
    expect(row()?.querySelector(".consult-pair__asked")?.textContent).toBe("pediu à");
    expect(row()?.textContent).toContain("Relatório de vendas de outubro");
    expect(row()?.textContent).toContain("levou 3 min");
    // The agent's own message about it follows, as any message.
    expect(document.body.textContent).toContain("Já está no Drive em Vendas/Outubro.");
    await act(async () => fireEvent.click(row() as HTMLElement));
    await settle(3);
    const dialog = document.querySelector(".ac-dialog.consult-dialog");
    expect(dialog?.textContent).toContain("Atlas");
    expect(dialog?.textContent).toContain("Só leitura.");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("while it is out, the row says nothing about its state", async () => {
    await open(withHandOff("open"));
    expect(row()?.textContent).toContain("Relatório de vendas de outubro");
    expect(row()?.textContent).not.toContain("trabalhando");
    expect(row()?.querySelector(".consult-pair__time")).toBeNull();
    expect(row()?.className).not.toContain("consult-pair__row--live");
  });

  test("one that couldn't finish says so", async () => {
    await open(withHandOff("failed"));
    expect(row()?.textContent).toContain("não terminou");
  });

  test("a long request: its subject, as every pair row names one (the whole request opens with the exchange)", async () => {
    const long = `${"Consolidar as vendas de todas as regiões ".repeat(4)}fim`;
    await open(withHandOff("answered", long));
    expect(row()?.textContent).toContain("Consolidar as vendas de todas as regiões");
    expect(row()?.textContent).toContain("levou 3 min");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });
});
