import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * The moment right after a paid Checkout (ADR 0079) where the workspace's pages land: the plan on, the team awake on
 * its sky, the purchase in one line and one way on. Once per payment, never on a plain visit, never two dialogs.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

const TITLE = "O seu time está de pé";
const BETA = "Você chegou cedo. Que bom.";
const CONNECT = "Conecte uma IA para o seu time pensar";
const SETTINGS = `/org/${ORG_ID}/settings/billing`;

const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const open = async (state: FakeState, path: string) => {
  const r = await renderApp(path, { api: createFakeApi(state) });
  await settle(8);
  return r;
};
const card = () => document.querySelector<HTMLElement>(".paid-card");
/** A workspace with its right hand, its plan in force. */
const workspace = () => withRightHand(seedState());
/** Every agent without an AI yet. */
const withoutAi = (state: FakeState) => {
  state.aiStatus = {
    any: false,
    agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai", reason: "no_key" })),
  };
  return state;
};
const held = (state: FakeState) => {
  const org = state.me?.organizations[0];
  if (org) org.standing = { state: "hold", reason: "payment" };
  return state;
};

describe("the paid moment in the workspace", () => {
  test("back on Settings: a card in the corner with the purchase and the one way on, once per payment", async () => {
    await open(workspace(), `${SETTINGS}?paid=1`);
    const moment = card();
    expect(moment).toBeTruthy();
    expect(within(moment as HTMLElement).getByRole("heading", { name: TITLE })).toBeTruthy();
    expect(moment?.textContent).toContain("Pagamento confirmado.");
    expect(moment?.querySelector(".paid-scene")).toBeTruthy();
    // Not a dialog: the page stays as it is.
    expect(screen().queryByRole("dialog")).toBeNull();
    cleanup();
    // The same return again (a reload, Back): nothing.
    await open(workspace(), `${SETTINGS}?paid=1`);
    expect(card()).toBeNull();
  });

  test("a plain visit shows nothing", async () => {
    await open(workspace(), SETTINGS);
    expect(card()).toBeNull();
  });

  test("while the hold lasts, nothing; once it lifts, the moment, on whatever page the tab is on", async () => {
    await open(held(workspace()), `${SETTINGS}?paid=1`);
    expect(card()).toBeNull();
    cleanup();
    // The address dropped `paid` (another page), the tab kept the return: the hold lifted, the moment shows.
    await open(workspace(), `/org/${ORG_ID}/home`);
    expect(card()).toBeTruthy();
  });

  test("its one way on: Connect an AI while agents have none, else the first conversation", async () => {
    await open(withoutAi(workspace()), `${SETTINGS}?paid=1`);
    await click(within(card() as HTMLElement).getByRole("button", { name: "Conectar uma IA" }));
    expect(card()).toBeNull();
    expect(screen().getByRole("dialog")).toBeTruthy();
    cleanup();
    localStorage.clear();

    const { router } = await open(workspace(), `${SETTINGS}?paid=1`);
    await click(within(card() as HTMLElement).getByRole("button", { name: "Falar com Lodi" }), 10);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    expect(card()).toBeNull();
  });

  test("closed, it stays closed", async () => {
    await open(workspace(), `${SETTINGS}?paid=1`);
    await click(within(card() as HTMLElement).getByRole("button", { name: "Fechar" }));
    expect(card()).toBeNull();
  });
});

describe("with the arrival (a workspace that opens right after its onboarding)", () => {
  test("the moment first, as a dialog, then the beta notice, then Connect an AI: one at a time", async () => {
    await open(withoutAi(workspace()), `/org/${ORG_ID}?paid=1&arrival=1`);
    const paid = screen().getByRole("dialog", { name: TITLE });
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    expect(card()).toBeNull();
    expect(paid.textContent).toContain("Pagamento confirmado.");
    await click(within(paid).getByRole("button", { name: /Continuar/ }));
    const beta = screen().getByRole("dialog", { name: BETA });
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    await click(within(beta).getByRole("button", { name: /Continuar/ }));
    expect(screen().getByRole("dialog", { name: CONNECT })).toBeTruthy();
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    expect(card()).toBeNull();
  });

  test("still held as the notice opens: the notice alone, no moment", async () => {
    await open(held(withoutAi(workspace())), `/org/${ORG_ID}?paid=1&arrival=1`);
    expect(screen().getByRole("dialog", { name: BETA })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: TITLE })).toBeNull();
    expect(card()).toBeNull();
  });
});
