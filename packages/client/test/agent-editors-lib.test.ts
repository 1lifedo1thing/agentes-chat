import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { Agent, OrgRole, OrgSummary, Proposal, ProposalSettingField } from "../src/api/types";
import { ADVANCED_SECTIONS, AGENT_SECTIONS, sameEditors } from "../src/lib/agent-edit";
import {
  canEditAudience,
  editorsMode,
  editorsOf,
  editorsPatch,
  editorsSummary,
  editorsValueOf,
  editsAgent,
  hiddenAgentIds,
  listsAgent,
  managesAgent,
  managesRoutinesOf,
} from "../src/lib/audience";
import { decidersOf } from "../src/lib/proposals";

// "Who can edit" (ADR 0085, addendum of 2026-11-17): who changes how an agent works (its instructions, role, skills and
// routines) besides its owner and who manages it.

const en = i18next.createInstance();
void en.init({ lng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
const t = en.t.bind(en) as TFunction;

const names: Record<string, string> = {
  "u-ana": "Ana Souza",
  "u-bruno": "Bruno Lima",
  "u-carla": "Carla",
  "u-davi": "Davi",
  "u-eva": "Eva",
};
const roleNames: Record<string, string> = { "r-support": "Support", "r-sales": "Sales" };
const nameOf = (id: string) => names[id];
const roleName = (id: string) => roleNames[id];

/** Iara, Ana's agent, as the server sends it to whoever looks at it. */
const iara = (over: Partial<Agent> = {}): Agent => ({
  id: "a-iara",
  name: "Iara",
  handle: "iara",
  role: "",
  instructions: "",
  model: "m",
  ownerUserId: "u-ana",
  hasCredential: false,
  monthlyBudgetUsd: null,
  createdAt: "",
  ...over,
});

describe("Who can edit: what it names", () => {
  test("editorsOf: the people and roles it names, never its owner; an older server names nobody", () => {
    expect(editorsOf(iara())).toEqual({ userIds: [], roleIds: [] });
    expect(editorsOf(iara({ editors: { userIds: ["u-bruno", "u-ana"], roleIds: ["r-support"] } }))).toEqual({
      userIds: ["u-bruno"],
      roleIds: ["r-support"],
    });
    // With no owner, nobody is left out.
    expect(editorsOf(iara({ ownerUserId: null, editors: { userIds: ["u-ana"], roleIds: [] } }))).toEqual({
      userIds: ["u-ana"],
      roleIds: [],
    });
  });

  test("its choice: 'people' once it names someone besides its owner, else only who looks after it", () => {
    expect(editorsMode({ userIds: [], roleIds: [] })).toBe("owner");
    expect(editorsMode({ userIds: ["u-bruno"], roleIds: [] })).toBe("people");
    expect(editorsMode({ userIds: [], roleIds: ["r-support"] })).toBe("people");
    expect(editorsValueOf(iara())).toEqual({ mode: "owner", userIds: [], roleIds: [] });
    expect(editorsValueOf(iara({ editors: { userIds: ["u-bruno"], roleIds: ["r-support"] } }))).toEqual({
      mode: "people",
      userIds: ["u-bruno"],
      roleIds: ["r-support"],
    });
    // Named before they became its owner: it names nobody else, so the choice shows nobody picked.
    expect(editorsValueOf(iara({ editors: { userIds: ["u-ana"], roleIds: [] } }))).toEqual({
      mode: "owner",
      userIds: [],
      roleIds: [],
    });
  });

  test("a save sends the whole lists under 'people'; only who looks after it names nobody, the picks set aside", () => {
    expect(editorsPatch({ mode: "people", userIds: ["u-bruno"], roleIds: ["r-support"] })).toEqual({
      userIds: ["u-bruno"],
      roleIds: ["r-support"],
    });
    expect(editorsPatch({ mode: "owner", userIds: ["u-bruno"], roleIds: ["r-support"] })).toEqual({
      userIds: [],
      roleIds: [],
    });
  });

  test("sameEditors compares whom it names, as sets: 'people' with nobody picked is only who looks after it", () => {
    const picked = { mode: "people" as const, userIds: ["u-bruno", "u-carla"], roleIds: ["r-support"] };
    expect(sameEditors(picked, { mode: "people", userIds: ["u-carla", "u-bruno"], roleIds: ["r-support"] })).toBe(true);
    expect(sameEditors(picked, { ...picked, userIds: ["u-bruno"] })).toBe(false);
    expect(sameEditors(picked, { ...picked, roleIds: [] })).toBe(false);
    expect(sameEditors(picked, { ...picked, mode: "owner" })).toBe(false);
    expect(
      sameEditors({ mode: "people", userIds: [], roleIds: [] }, { mode: "owner", userIds: ["u-bruno"], roleIds: [] }),
    ).toBe(true);
  });

  test("its summary: its owner first, then the people and roles, as the audience's; nobody else named", () => {
    expect(editorsSummary(t, iara(), nameOf)).toBe("Only who looks after it");
    expect(editorsSummary(t, iara({ editors: { userIds: ["u-bruno"], roleIds: [] } }), nameOf)).toBe(
      "Ana Souza and Bruno Lima",
    );
    expect(
      editorsSummary(t, iara({ editors: { userIds: ["u-bruno"], roleIds: ["r-support"] } }), nameOf, roleName),
    ).toBe("Ana Souza, Bruno Lima, and Support");
    // Past three names: the first two and how many more, people when it names no role.
    expect(
      editorsSummary(t, iara({ editors: { userIds: ["u-bruno", "u-carla", "u-davi"], roleIds: [] } }), nameOf),
    ).toBe("Ana Souza, Bruno Lima and 2 more people");
    expect(
      editorsSummary(
        t,
        iara({ editors: { userIds: ["u-bruno", "u-carla"], roleIds: ["r-support", "r-sales"] } }),
        nameOf,
        roleName,
      ),
    ).toBe("Ana Souza, Bruno Lima and 3 more");
    // Its owner named too is said once, and only the names we know.
    expect(editorsSummary(t, iara({ editors: { userIds: ["u-ana", "u-bruno", "u-gone"], roleIds: [] } }), nameOf)).toBe(
      "Ana Souza and Bruno Lima",
    );
    expect(editorsSummary(t, iara({ editors: { userIds: ["u-gone"], roleIds: [] } }), nameOf)).toBe(
      "Only who looks after it",
    );
    // With no owner: the people alone.
    expect(editorsSummary(t, iara({ ownerUserId: null, editors: { userIds: ["u-bruno"], roleIds: [] } }), nameOf)).toBe(
      "Bruno Lima",
    );
  });

  test("Settings has its section right after Who can talk, in Advanced for a personal workspace", () => {
    expect(AGENT_SECTIONS.indexOf("editors")).toBe(AGENT_SECTIONS.indexOf("audience") + 1);
    expect(ADVANCED_SECTIONS).toContain("editors");
  });
});

describe("Who can edit: what each person may do, from the server's flags", () => {
  const member: OrgSummary = { id: "org", name: "Acme", role: "member", permissions: ["read", "talk_to_agents"] };
  const keyHolder: OrgSummary = { ...member, permissions: ["read", "talk_to_agents", "manage_agents"] };

  test("manages, edits and sets up routines only where the server says so; absent is no", () => {
    expect(managesAgent(iara({ canManage: true }))).toBe(true);
    expect(managesAgent(iara())).toBe(false);
    expect(managesAgent(undefined)).toBe(false);
    expect(editsAgent(iara({ canEdit: true }))).toBe(true);
    expect(editsAgent(iara({ canEdit: false }))).toBe(false);
    expect(editsAgent(null)).toBe(false);
    expect(managesRoutinesOf(iara({ canManageRoutines: true }))).toBe(true);
    expect(managesRoutinesOf(iara())).toBe(false);
  });

  test("who talks to it and who edits it: its owner or who manages it, never the key alone nor a named editor", () => {
    expect(canEditAudience(member, iara(), "u-ana")).toBe(true);
    expect(canEditAudience(keyHolder, iara({ canManage: true }), "u-carla")).toBe(true);
    // "Edit agents" that doesn't reach it: someone's private agent.
    expect(canEditAudience(keyHolder, iara({ canManage: false }), "u-carla")).toBe(false);
    // Named in "Who can edit": they edit how it works, not who edits it.
    const named = iara({ canEdit: true, editors: { userIds: ["u-eva"], roleIds: [] } });
    expect(canEditAudience(member, named, "u-eva")).toBe(false);
  });

  test("whose lists show it: who it answers, who manages agents, and who edits it", () => {
    const locked = iara({ canTalk: false });
    expect(listsAgent(member, locked)).toBe(false);
    expect(listsAgent(member, { ...locked, canEdit: true })).toBe(true);
    expect(listsAgent(keyHolder, locked)).toBe(true);
    const nina = iara({ id: "a-nina", name: "Nina", canTalk: false, canEdit: true });
    expect(hiddenAgentIds(member, [locked, nina])).toEqual(new Set(["a-iara"]));
  });
});

describe("decidersOf: whom a row sent with Ask an admin went to", () => {
  const role = (id: string, permissions: string[], kind: OrgRole["kind"] = "custom") =>
    ({ id, name: id, kind, position: 1, color: "amber", icon: "shield", permissions }) as unknown as OrgRole;
  const roles = [
    role("r-makers", ["manage_agents"]),
    role("r-support", ["post"]),
    role("r-everyone", ["post", "talk_to_agents"], "everyone"),
  ];
  // Ana owns Iara; Bruno owns the workspace; Carla holds "Edit agents"; Davi is in Support; Eva holds no role.
  const people = [
    { userId: "u-ana", name: "Ana Souza", role: "member" as const, roleIds: [] },
    { userId: "u-bruno", name: "Bruno Lima", role: "owner" as const, roleIds: [] },
    { userId: "u-carla", name: "Carla", role: "member" as const, roleIds: ["r-makers"] },
    { userId: "u-davi", name: "Davi", role: "member" as const, roleIds: ["r-support"] },
    { userId: "u-eva", name: "Eva", role: "member" as const, roleIds: [] },
  ];
  const row = (field: ProposalSettingField, decider: Proposal["decider"] = { type: "admins" }) => ({
    decider,
    settings: [{ field, from: false, to: true, ...(field === "skill" ? { skillId: "s-sheets" } : {}) }],
  });
  const ownerOnly = { mode: "owner" as const, userIds: [], roleIds: [] };
  const editors = { userIds: ["u-eva"], roleIds: ["r-support"] };

  test("a skill row goes to who manages it, its owner and the people and roles its Who can edit names", () => {
    const privateIara = iara({ audience: ownerOnly, editors });
    expect(decidersOf(row("skill"), people, roles, privateIara)).toEqual(["Ana Souza", "Bruno Lima", "Davi", "Eva"]);
    // Sent to someone who doesn't see how it works, `editors` comes empty: only the rest.
    expect(decidersOf(row("skill"), people, roles, { ...privateIara, editors: { userIds: [], roleIds: [] } })).toEqual([
      "Ana Souza",
      "Bruno Lima",
    ]);
  });

  test("any other row: who manages it alone, its owner where they decide too; never its named editors", () => {
    const privateIara = iara({ audience: ownerOnly, editors });
    // "Edit agents" doesn't reach a private agent: Carla isn't asked.
    expect(decidersOf(row("model"), people, roles, privateIara)).toEqual(["Bruno Lima"]);
    expect(decidersOf(row("audience"), people, roles, privateIara)).toEqual(["Ana Souza", "Bruno Lima"]);
    // Answering everyone, the key reaches it.
    expect(decidersOf(row("model"), people, roles, iara({ editors }))).toEqual(["Bruno Lima", "Carla"]);
    // A row of its owner's: their name first.
    expect(
      decidersOf(row("audience", { type: "user", userId: "u-ana", name: "Ana Souza" }), people, roles, privateIara),
    ).toEqual(["Ana Souza", "Bruno Lima"]);
  });

  test("an AI account's row goes to its owner alone; an agent no longer here, to nobody", () => {
    expect(decidersOf(row("ai_account", { type: "account_owner" }), people, roles, iara({ editors }))).toEqual([
      "Ana Souza",
    ]);
    expect(decidersOf(row("skill"), people, roles, undefined)).toEqual([]);
  });
});
