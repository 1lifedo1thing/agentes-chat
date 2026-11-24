import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import path from "node:path";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { PAID_MOMENT_ONCE_MS } from "@/lib/paid-return";
import { STORAGE_KEYS } from "@/lib/storage";
import { createFakeApi, type FakeState, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

/*
 * The moment right after a paid Checkout (ADR 0079) where the workspace's pages land: the plan on, the team awake on
 * its sky, the purchase in one line and one way on. Once per payment, never on a plain visit, never two dialogs.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  sessionStorage.clear();
  localStorage.clear();
});

const TITLE = "O seu time está de pé";
const BETA = "Você chegou cedo. Que bom.";
const CONNECT = "Conecte uma IA para o seu time pensar";
const SETTINGS = `/org/${ORG_ID}/settings/billing`;
const OTHER_ID = "00000000-0000-4000-8000-0000000000b2";
const PENDING = `${STORAGE_KEYS.paidMoment}.${ORG_ID}`;
const SHOWN = `${STORAGE_KEYS.paidMomentShown}.${ORG_ID}`;

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

  test("it belongs to its workspace: switching to another one leaves it behind", async () => {
    const state = workspace();
    state.me?.organizations.push({ id: OTHER_ID, name: "Beta", role: "owner" });
    const { router } = await open(state, `${SETTINGS}?paid=1`);
    expect(card()).toBeTruthy();
    await act(() => router.navigate({ href: `/org/${OTHER_ID}/settings/billing` }));
    await settle(8);
    expect(card()).toBeNull();
  });

  test("as it shows, the address forgets the return: a reload or Back to it shows nothing", async () => {
    const { router } = await open(workspace(), `${SETTINGS}?paid=1&plan=team&period=year&tab=x`);
    expect(card()).toBeTruthy();
    const search = router.state.location.search as Record<string, unknown>;
    expect([search.paid, search.plan, search.period]).toEqual([undefined, undefined, undefined]);
    expect(search.tab).toBe("x");
  });

  test("a return already shown leaves nothing kept for the tab", async () => {
    await open(held(workspace()), `${SETTINGS}?paid=1`);
    expect(sessionStorage.getItem(PENDING)).not.toBeNull();
    cleanup();
    // Shown meanwhile in another tab of this browser: the hold lifts, this tab shows nothing and keeps nothing.
    localStorage.setItem(SHOWN, String(Date.now()));
    await open(workspace(), `/org/${ORG_ID}/home`);
    expect(card()).toBeNull();
    expect(sessionStorage.getItem(PENDING)).toBeNull();
  });

  test("a second payment later the same day shows its own moment", async () => {
    localStorage.setItem(SHOWN, String(Date.now() - PAID_MOMENT_ONCE_MS - 1000));
    await open(workspace(), `${SETTINGS}?paid=1`);
    expect(card()).toBeTruthy();
    expect(PAID_MOMENT_ONCE_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  test("a dialog open as it comes stays above it: the card is drawn under every scrim", async () => {
    const root = path.join(import.meta.dir, "../../..");
    const layers = await Bun.file(path.join(root, "packages/ui/src/styles/layers.css")).text();
    const css = await Bun.file(path.join(root, "apps/web/src/components/arrival/arrival.css")).text();
    const token = (name: string) => Number(layers.match(new RegExp(`--z-${name}:\\s*(-?\\d+)`))?.[1]);
    const z = css.match(/\.paid-card\s*\{[^}]*z-index:\s*var\(--z-([\w-]+)\)/)?.[1] ?? "";
    expect(token(z)).toBeLessThan(token("scrim"));
    expect(token(z)).toBeGreaterThan(token("lifted"));
  });
});

describe("with the arrival (a workspace that opens right after its onboarding)", () => {
  test("the moment first, as a dialog, then the beta notice, then Connect an AI: one at a time", async () => {
    const { router } = await open(withoutAi(workspace()), `/org/${ORG_ID}?paid=1&arrival=1`);
    // Both marks leave the address together: neither brings the other back.
    expect(router.state.location.search).toEqual({});
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

describe("the worst case (measured by CI's geometry capture)", () => {
  test("a plan's longest name, a long first name and a long right hand's name, in German, at every width", async () => {
    const state = withRightHand(seedState(), { name: "Maximiliana Bartholomew-Fitzgerald" });
    state.authConfig = { billingUrl: "https://billing.example.com" };
    if (state.me) state.me.user.name = "Aleksandra Wiśniewska-Kowalczyk";
    // The plan list's longest name (`planOfferOf` takes up to 40 characters).
    const plan = "Unternehmen Plus mit eigenem Computer XL";
    globalThis.fetch = (async (_url: string) =>
      new Response(JSON.stringify({ recommended: "team", plans: [{ key: "business", name: plan }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await open(state, `${SETTINGS}?paid=1&plan=business&period=year`);
    await showIn(r.services, "de");
    const moment = card() as HTMLElement;
    expect(moment.textContent).toContain(`Zahlung bestätigt: ${plan}, jährliche Abrechnung.`);
    expect(moment.textContent).toContain("Hallo, Aleksandra");
    expect(
      within(moment).getByRole("button", { name: "Mit Maximiliana Bartholomew-Fitzgerald sprechen" }),
    ).toBeTruthy();
  });

  test("a workspace with no agents: the sky and the computer alone, and Connect an AI as the way on", async () => {
    await open(seedState({ agents: [] }), `${SETTINGS}?paid=1`);
    const moment = card() as HTMLElement;
    expect(moment.querySelector(".team-scene__agent")).toBeNull();
    expect(moment.querySelector(".ac-computer")).toBeTruthy();
    expect(within(moment).getByRole("button", { name: "Conectar uma IA" })).toBeTruthy();
  });
});
