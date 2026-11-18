import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentEditors, OrgRole } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  createFakeApi,
  type FakeState,
  LODI_ID,
  ORG_ID,
  seedRoles,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * "Who can edit" (ADR 0085, addendum of 2026-11-17): who changes how an agent works (its instructions, role, skills and
 * routines) besides who looks after it. A row of the overview's "Who it works with" card, its dialog, and its own
 * section in Settings; its owner and who manages it change it, everyone else reads it.
 */

afterEach(() => cleanup());

const SUPPORT_ID = "role-support";

/** Acme with a "Suporte" role that gives nothing past posting; Ada is João's and answers everyone. I am Walter. */
function acme(editors?: AgentEditors) {
  const state = seedState();
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  const support = { ...admin, id: SUPPORT_ID, name: "Suporte", icon: "person", color: "teal", position: 1 };
  state.roles = [admin, { ...support, permissions: ["post"], hoist: false }, { ...everyone, position: 2 }];
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada && editors) ada.editors = editors;
  return state;
}
/** I am a member who holds no role past `everyone`: Ada answers me, I don't manage her. */
const asMember = (state: FakeState) => {
  const org = state.me?.organizations[0];
  if (org) org.role = "member";
  return state;
};
/** A personal workspace where I am alone, Ada mine. */
const alone = (editors?: AgentEditors) => {
  const state = acme(editors);
  const org = state.me?.organizations[0];
  if (org) org.mode = "personal";
  state.members = state.members.filter((m) => m.userId === state.me?.user.id);
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "u-walter";
  return state;
};

const go = async (query = "", state = acme(), agentId = ADA_ID) => {
  const r = await renderApp(`/org/${ORG_ID}/agents/${agentId}${query}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const updates = (state: FakeState) => state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2]);
/** The overview's "Who it works with" card. */
const withWhom = () => screen().getByRole("region", { name: "Com quem" });
/** The fact sheet's "Who can edit" row, if shown. */
const editorsRow = () => within(withWhom()).queryByRole("button", { name: "Quem pode editar" });
const rowValue = (row: Element | null) => row?.querySelector(".agp-cell__value")?.textContent;
const choice = (inside: HTMLElement, name: RegExp) =>
  within(within(inside).getByRole("radiogroup", { name: "Quem pode editar a Ada" })).getByRole("radio", { name });
const ONLY_WHO_LOOKS_AFTER = /^Só quem cuida da Ada/;
const ALSO_SOME = /^Também algumas pessoas ou cargos/;

describe("Who can edit on the overview's Who it works with card", () => {
  test("its row, after Who can talk: only who looks after it, or its owner then whom it names", async () => {
    await go();
    const rows = within(withWhom())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(rows.slice(0, 4)).toEqual(["Responsável", "Quem pode falar", "Quem pode editar", "Canais"]);
    expect(rowValue(editorsRow())).toBe("Só quem cuida dela");
    cleanup();
    await go("", acme({ userIds: ["u-walter"], roleIds: [SUPPORT_ID] }));
    expect(rowValue(editorsRow())).toBe("João, Walter e Suporte");
  });

  test("its dialog: the two choices; a role picked and saved sends the whole lists", async () => {
    const { state } = await go();
    const row = editorsRow() as HTMLElement;
    await click(row);
    expect(row.getAttribute("data-open")).toBe("true");
    const dialog = screen().getByRole("dialog", { name: "Quem pode editar a Ada" });
    expect(choice(dialog, ONLY_WHO_LOOKS_AFTER).getAttribute("aria-checked")).toBe("true");
    // Who looks after it, said by name; what editing is, and what stays with who edits agents.
    expect(dialog.textContent).toContain(
      "João, responsável, os administradores e quem edita agentes e fala com a Ada.",
    );
    expect(dialog.textContent).toContain(
      "Editar é mudar as instruções, a função, as skills e as rotinas da Ada. Apps, orçamento e responsável continuam com quem edita agentes.",
    );
    expect(within(dialog).queryByRole("region", { name: "Buscar cargos e pessoas" })).toBeNull();
    await click(choice(dialog, ALSO_SOME));
    const results = within(dialog).getByRole("region", { name: "Buscar cargos e pessoas" });
    // Its owner always edits: never a pick, said once.
    expect(dialog.textContent).toContain("João sempre pode, como responsável.");
    expect(results.textContent).not.toContain("João");
    expect([...results.querySelectorAll(".ac-picker-head")].map((h) => h.textContent)).toEqual([
      "CargosQuem tem o cargo pode editar, inclusive quem entrar nele depois.",
      "Pessoas",
    ]);
    await click(within(results).getByLabelText(/Suporte/));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(updates(state)).toEqual([{ editors: { userIds: [], roleIds: [SUPPORT_ID] } }]);
    expect(screen().queryByRole("dialog", { name: "Quem pode editar a Ada" })).toBeNull();
    expect(rowValue(editorsRow())).toBe("João e Suporte");
  });

  test("only who looks after it sends empty lists", async () => {
    const { state } = await go("", acme({ userIds: ["u-walter"], roleIds: [SUPPORT_ID] }));
    await click(editorsRow() as HTMLElement);
    const dialog = screen().getByRole("dialog", { name: "Quem pode editar a Ada" });
    expect(choice(dialog, ALSO_SOME).getAttribute("aria-checked")).toBe("true");
    await click(choice(dialog, ONLY_WHO_LOOKS_AFTER));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(updates(state)).toEqual([{ editors: { userIds: [], roleIds: [] } }]);
    expect(rowValue(editorsRow())).toBe("Só quem cuida dela");
  });

  test("the second choice with nobody picked changes nothing: Save and Cancel leave nothing behind", async () => {
    const { state } = await go();
    const open = async () => {
      await click(editorsRow() as HTMLElement);
      return screen().getByRole("dialog", { name: "Quem pode editar a Ada" });
    };
    for (const button of ["Salvar", "Cancelar"]) {
      const dialog = await open();
      await click(choice(dialog, ALSO_SOME));
      // Nobody picked names nobody, as the first choice does: nothing to save.
      expect(screen().queryByRole("region", { name: "Alterações não salvas", hidden: true })).toBeNull();
      await click(within(dialog).getByRole("button", { name: button }));
      await settle(4);
      expect(screen().queryByRole("dialog", { name: "Quem pode editar a Ada" })).toBeNull();
      expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
      // Opened again, it is as saved.
      const again = await open();
      expect(choice(again, ONLY_WHO_LOOKS_AFTER).getAttribute("aria-checked")).toBe("true");
      await click(within(again).getByRole("button", { name: "Cancelar" }));
    }
    expect(updates(state)).toEqual([]);
  });

  test("alone in a personal workspace the row shows only once it names someone", async () => {
    await go("", alone());
    expect(editorsRow()).toBeNull();
    cleanup();
    await go("", alone({ userIds: [], roleIds: [SUPPORT_ID] }));
    expect(rowValue(editorsRow())).toBe("Walter e Suporte");
  });
});

describe("Who can edit in Settings", () => {
  test("its own section after Who can talk, in the sections' nav; picking someone saves from the save bar", async () => {
    const { state } = await go("?tab=settings&sec=editors");
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    const items = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(items).toContain("Quem pode editar");
    expect(items.indexOf("Quem pode editar")).toBe(items.indexOf("Quem pode falar") + 1);
    const section = screen().getByRole("region", { name: "Quem pode editar a Ada" });
    expect(choice(section, ONLY_WHO_LOOKS_AFTER).getAttribute("aria-checked")).toBe("true");
    await click(choice(section, ALSO_SOME));
    await click(within(section).getAllByLabelText(/Walter/)[0] as HTMLElement);
    // What it was, under the choice and in the bar's list of changes.
    expect(section.textContent).toContain("Antes: Só quem cuida dela");
    const bar = screen().getByRole("region", { name: "Alterações não salvas" });
    expect(bar.textContent).toContain("Quem pode editar");
    await click(within(bar).getByRole("button", { name: "Ver" }));
    const list = screen().getByRole("dialog", { name: "O que mudou" });
    expect(list.textContent).toContain("Só quem cuida dela → João e Walter");
    await act(async () => fireEvent.keyDown(list, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "O que mudou" })).toBeNull();
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(6);
    expect(updates(state)).toEqual([{ editors: { userIds: ["u-walter"], roleIds: [] } }]);
  });

  test("in a personal workspace it is under Advanced", async () => {
    await go("?tab=settings&sec=editors", alone());
    expect(
      within(screen().getByRole("tablist", { name: "Seções da Ada" }))
        .getByRole("tab", { name: "Avançado" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen().getByRole("region", { name: "Quem pode editar a Ada" })).toBeTruthy();
  });
});

describe("Who can edit for who doesn't change it", () => {
  test("a member reads it: the summary and the note, no choices, Close only", async () => {
    await go("?tab=settings&sec=editors", asMember(acme({ userIds: [], roleIds: [SUPPORT_ID] })));
    const section = screen().getByRole("region", { name: "Quem pode editar a Ada" });
    expect(within(section).queryByRole("radiogroup")).toBeNull();
    expect(section.textContent).toContain("João e Suporte");
    expect(section.textContent).toContain("Admins e João mudam");
    expect(section.textContent).toContain("Editar é mudar as instruções");
    cleanup();
    await go("", asMember(acme()));
    expect(rowValue(editorsRow())).toBe("Só quem cuida dela");
    await click(editorsRow() as HTMLElement);
    const dialog = screen().getByRole("dialog", { name: "Quem pode editar a Ada" });
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: "Fechar" }).length).toBeGreaterThan(0);
  });

  test("someone it names edits its instructions, and reads who edits it", async () => {
    const { state } = await go("?tab=settings&sec=editors", asMember(acme({ userIds: ["u-walter"], roleIds: [] })));
    const section = screen().getByRole("region", { name: "Quem pode editar a Ada" });
    expect(within(section).queryByRole("radiogroup")).toBeNull();
    expect(section.textContent).toContain("João e Walter");
    cleanup();
    await go("?tab=instructions", state);
    const box = screen().getByRole("textbox", { name: "Instruções" });
    await act(async () => fireEvent.change(box, { target: { value: "Instruções de Ada.\nRevisa PRs pequenos." } }));
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(6);
    expect(updates(state)).toEqual([{ instructions: "Instruções de Ada.\nRevisa PRs pequenos." }]);
  });
});

describe("Who can edit on the team's right hand", () => {
  test("nobody edits how it works: no row and no section", async () => {
    const state = withRightHand(acme());
    await go("", state, LODI_ID);
    expect(screen().queryByRole("button", { name: "Quem pode editar" })).toBeNull();
    expect(document.body.textContent).not.toContain("Quem pode editar");
    cleanup();
    await go("?tab=settings&sec=editors", state, LODI_ID);
    expect(screen().queryByRole("region", { name: "Quem pode editar o Lodi" })).toBeNull();
    expect(document.body.textContent).not.toContain("Quem pode editar");
  });
});
