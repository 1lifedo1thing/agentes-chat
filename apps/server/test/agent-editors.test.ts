import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * "Who can edit" over the API (ADR 0085, addendum of 2026-11-17): `PATCH …/agents/{id}` saves `editors`, and every
 * agent tells the person reading it what they may do with it (`canManage`, `canEdit`, `canManageRoutines`).
 */

let t: TestServer;
afterEach(() => t.close());

type Editors = { userIds: string[]; roleIds: string[] };
type ListedAgent = {
  id: string;
  instructions: string;
  seesDetails: boolean;
  canTalk: boolean;
  canManage: boolean;
  canEdit: boolean;
  canManageRoutines: boolean;
  editors: Editors;
};

const userIdOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** The owner's workspace and its Dev (theirs, answering everyone); Eva and Bia, members; Lara, "Edit agents". */
async function start() {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  const eva = await joinByInvitation(t, owner, orgId, "eva@example.com");
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const lara = await joinByInvitation(t, owner, orgId, "lara@example.com");
  const ids = {
    owner: await userIdOf(owner),
    eva: await userIdOf(eva),
    bia: await userIdOf(bia),
    lara: await userIdOf(lara),
  };
  const leads = await owner(`${org}/roles`, { json: { name: "Leads", permissions: ["manage_agents"] } });
  expect(leads.status).toBe(201);
  const { id: leadsId } = (await leads.json()) as { id: string };
  const given = await owner(`${org}/members/${ids.lara}/roles`, { method: "PUT", json: { roleIds: [leadsId] } });
  expect(given.status).toBe(200);
  const listed = async (b: Browser) =>
    ((await (await b(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents.find((a) => a.id === agentId);
  const patch = (b: Browser, json: unknown) => b(`${org}/agents/${agentId}`, { method: "PATCH", json });
  return { owner, eva, bia, lara, org, agentId, ids, listed, patch };
}

const rights = (a: ListedAgent | undefined) =>
  a && { canManage: a.canManage, canEdit: a.canEdit, canManageRoutines: a.canManageRoutines };

test('"Who can edit" is saved with PATCH and audited; each viewer reads what they may do with the agent', async () => {
  const { owner, eva, bia, lara, agentId, ids, listed, patch } = await start();
  const saved = await patch(owner, { editors: { userIds: [ids.eva, ids.owner], roleIds: [] } });
  expect(saved.status).toBe(200);
  // Its owner always edits it: naming them adds nothing.
  expect(((await saved.json()) as ListedAgent).editors).toEqual({ userIds: [ids.eva], roleIds: [] });
  const audit = await t.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "agent.editors_changed"), eq(schema.auditLog.targetId, agentId)));
  expect(audit).toMatchObject([{ actorId: ids.owner, details: { to: { userIds: [ids.eva], roleIds: [] } } }]);

  expect(rights(await listed(owner))).toEqual({ canManage: true, canEdit: true, canManageRoutines: true });
  // It answers everyone: "Edit agents" reaches it.
  expect(rights(await listed(lara))).toEqual({ canManage: true, canEdit: true, canManageRoutines: true });
  expect(rights(await listed(eva))).toEqual({ canManage: false, canEdit: true, canManageRoutines: true });
  expect(rights(await listed(bia))).toEqual({ canManage: false, canEdit: false, canManageRoutines: false });
  // Whoever sees how it works sees who edits it.
  expect((await listed(bia))?.editors).toEqual({ userIds: [ids.eva], roleIds: [] });

  // Eva edits how it works; what gives it more, and who edits it, aren't hers.
  const edited = await patch(eva, { instructions: "Responda em português.", role: "Revisora" });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({
    instructions: "Responda em português.",
    role: "Revisora",
    canEdit: true,
    canManage: false,
  });
  for (const json of [{ monthlyBudgetUsd: 10 }, { name: "Outro" }, { editors: { userIds: [], roleIds: [] } }])
    expect((await patch(eva, json)).status).toBe(403);
});

test('a member with "Edit agents" outside a private agent reads its public card and changes nothing of it', async () => {
  const { owner, eva, lara, org, agentId, ids, listed, patch } = await start();
  const kept = await patch(owner, {
    audience: { mode: "owner", userIds: [] },
    editors: { userIds: [ids.eva], roleIds: [] },
  });
  expect(kept.status).toBe(200);
  expect(await listed(lara)).toMatchObject({
    seesDetails: false,
    canTalk: false,
    canManage: false,
    canEdit: false,
    canManageRoutines: false,
    instructions: "",
    editors: { userIds: [], roleIds: [] },
  });
  expect(await (await lara(`${org}/agents/${agentId}`)).json()).toMatchObject({
    seesDetails: false,
    canManage: false,
    canEdit: false,
    canManageRoutines: false,
    editors: { userIds: [], roleIds: [] },
  });
  for (const json of [{ role: "QA" }, { monthlyBudgetUsd: 10 }, { editors: { userIds: [ids.lara], roleIds: [] } }])
    expect((await patch(lara, json)).status).toBe(403);
  // Who it names still sees how it works and edits it, without talking to it.
  expect(await listed(eva)).toMatchObject({ seesDetails: true, canTalk: false, canEdit: true, canManage: false });
  expect((await patch(eva, { role: "QA" })).status).toBe(200);
});

test('an agent made with "Who can edit" starts with it', async () => {
  const { owner, org, ids } = await start();
  const made = await owner(`${org}/agents`, {
    json: { name: "Iara", handle: "iara", editors: { userIds: [ids.eva], roleIds: [] } },
  });
  expect(made.status).toBe(201);
  expect(await made.json()).toMatchObject({
    editors: { userIds: [ids.eva], roleIds: [] },
    canManage: true,
    canEdit: true,
    canManageRoutines: true,
  });
});
