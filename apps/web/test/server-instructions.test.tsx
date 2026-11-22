import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { MOCK_INSTRUCTIONS, WORST_INSTRUCTIONS } from "./fakes/custom-connectors";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;

/** A server by address connected (the fake signs in at once), then its review: "Ajustar" on its confirmation. */
async function review(serverUrl: string) {
  const state = seedState();
  const api = createFakeApi(state);
  const res = await api.customConnectors.connect(ORG_ID, { serverUrl, label: "Tickets", returnTo: "/" });
  if (res.status !== "connected") throw new Error("expected connected");
  await renderApp(`/org/${ORG_ID}/settings?connected=custom:${res.server.id}`, { api });
  await settle(8);
  await click(within(flow()).getByRole("button", { name: "Ajustar" }));
  await settle(4);
  return state;
}

/** What the review saved on Continuar. */
const saved = (state: ReturnType<typeof seedState>) =>
  state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2] as Record<string, unknown> | undefined;

describe("a server's own instructions in its review", () => {
  test("the worst a server sends: its first 4,000 characters as they are, cut, in the well (first: the screen CI measures)", async () => {
    await review("https://oauth.worst.example.com/mcp");
    const notes = within(flow()).getByRole("region", { name: "Instruções do servidor" });
    expect(notes.textContent).toContain("Cortado em 4.000 caracteres");
    const text = notes.querySelector(".cflow-notes__text") as HTMLElement;
    expect(WORST_INSTRUCTIONS.length).toBeGreaterThan(4000);
    expect(text.textContent).toBe(WORST_INSTRUCTIONS.slice(0, 4000));
    // Long, it scrolls inside: the keys reach it in every browser.
    expect(text.tabIndex).toBe(0);
  });

  test("the setting under the tools: on, its size, the text as agents read it; turned off, saved with Continuar", async () => {
    const state = await review("https://oauth.rules.example.com/mcp");
    const notes = within(flow()).getByRole("region", { name: "Instruções do servidor" });
    // The title is the switch's label; what it does is behind its ⓘ.
    const use = within(notes).getByRole("switch", { name: "Instruções do servidor" });
    expect(use.getAttribute("aria-checked")).toBe("true");
    expect(within(notes).getByRole("button", { name: "Sobre Instruções do servidor" })).toBeTruthy();
    expect(notes.textContent).toContain(`${MOCK_INSTRUCTIONS.length} de 4.000 caracteres`);
    const text = notes.querySelector(".cflow-notes__text") as HTMLElement;
    expect(text.textContent).toBe(MOCK_INSTRUCTIONS);
    expect(text.hasAttribute("data-off")).toBe(false);

    await click(use);
    expect(use.getAttribute("aria-checked")).toBe("false");
    expect(notes.textContent).toContain("Os agentes não recebem este texto.");
    expect(notes.textContent).not.toContain("de 4.000 caracteres");
    // Still there, faded.
    expect(text.textContent).toBe(MOCK_INSTRUCTIONS);
    expect(text.hasAttribute("data-off")).toBe(true);

    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(saved(state)).toMatchObject({ useInstructions: false });
  });

  test("a server that sends none: one line, no switch, and the save leaves the setting as it was", async () => {
    const state = await review("https://oauth.plain.example.com/mcp");
    expect(flow().textContent).toContain("Instruções do servidor");
    expect(flow().textContent).toContain("O servidor não manda instruções.");
    expect(within(flow()).queryByRole("switch", { name: "Instruções do servidor" })).toBeNull();
    expect(flow().querySelector(".cflow-notes__text")).toBeNull();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(saved(state)).toBeDefined();
    expect(saved(state)).not.toHaveProperty("useInstructions");
  });

  test("the words in English, the size cut at the limit", () => {
    const en = createI18n("en").t as TFunction;
    expect(en("toolReview.instructions.title")).toBe("Server instructions");
    expect(en("toolReview.instructions.chars", { used: "1,234", max: "4,000" })).toBe("1,234 of 4,000 characters");
    expect(en("toolReview.instructions.cut", { max: "4,000" })).toBe("Cut at 4,000 characters");
    expect(en("toolReview.instructions.off")).toBe("Agents don't get this text.");
    expect(en("toolReview.instructions.none")).toBe("The server sends no instructions.");
  });
});
