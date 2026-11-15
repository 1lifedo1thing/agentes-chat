import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ConnectorDeps,
  composioUserId,
  connectionFor,
  connectionViewFor,
  createAgentRuns,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  ensureRightHand,
  ForbiddenError,
  getAgentAccess,
  insertMessage,
  listConnections,
  type McpConnect,
  mayConnection,
  mcpSessionOver,
  moveConnectionToTeam,
  NotFoundError,
  openPersonAgentDm,
  orgOfComposioUser,
  RIGHT_HAND,
  removeMember,
  renameConnection,
  revokeConnection,
  setAgentAccess,
  type ToolContext,
  unaskedAtNever,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const depsOf = (fx: Fixture): ConnectorDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
});

/** An in-process MCP server shaped like Linear's: one read and one write. */
function fakeLinear() {
  const calls: string[] = [];
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "fake-linear", version: "1" });
    server.registerTool("list_issues", { description: "List issues", inputSchema: {} }, async () => {
      calls.push("list_issues");
      return { content: [{ type: "text", text: "ENG-1: fix sign-in" }] };
    });
    server.registerTool(
      "create_issue",
      { description: "Create an issue", inputSchema: { title: z.string() } },
      async () => {
        calls.push("create_issue");
        return { content: [{ type: "text", text: "Created ENG-2" }] };
      },
    );
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

/** A run of `agentId` on a message `author` wrote in `channelId` (nobody: an agent's own message woke it). */
async function runOf(agentId: string, author: string | null, channelId = f.general.id): Promise<ToolContext> {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: author
      ? { type: "person", userId: author }
      : { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "list my issues",
  });
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, message, [agentId], "mention"));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId,
    threadRootId: message.id,
    triggerMessageId: message.id,
  };
}

/** Walter owns `@dev`, which answers only him, and connects his own Linear: it goes on for his agents alone. */
async function walterWithLinear() {
  f = await setup();
  const walter = await addMember(f.db, f.org.id, "member", "walter");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: walter.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const [ops] = await f.db
    .insert(schema.agents)
    .values({ orgId: f.org.id, name: "Ops", handle: "ops", model: "claude-sonnet-5-5", ownerUserId: bia.id })
    .returning();
  if (!ops) throw new Error("no agent");
  const mine = await createApiKeyConnection(depsOf(f), walter.id, f.org.id, {
    connector: "linear",
    apiKey: "lin_api_FAKE_walter_1234",
    personal: true,
  });
  const linear = fakeLinear();
  const source = createConnectorToolSource({ ...depsOf(f), connect: linear.connect });
  return { walter, bia, ops, mine, linear, source };
}

const names = async (source: ReturnType<typeof createConnectorToolSource>, ctx: ToolContext) =>
  (await source.tools(ctx)).map((t) => t.name).sort();

test("a personal one-click sign-in has its person's own account id at the hosted adapter", () => {
  const org = "0b9f6a52-8d7e-4f8e-9a3c-2f1d5c6b7a80";
  expect(composioUserId(org)).toBe(`org_${org}`);
  expect(composioUserId(org, "walter_1")).toBe(`org_${org}_u_walter_1`);
  expect(composioUserId(org, "walter_1")).not.toBe(composioUserId(org, "bia_2"));
  // Its executions still count for the workspace.
  expect(orgOfComposioUser(composioUserId(org, "walter_1"))).toBe(org);
});

describe("who may add, see and change a personal connection", () => {
  test("any member adds one; it goes on for their own agents only; the team's stays for who manages connectors", async () => {
    const { walter, ops, mine } = await walterWithLinear();
    expect(mine.ownerUserId).toBe(walter.id);
    const grants = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id));
    expect(grants.map((g) => g.agentId)).toEqual([f.agent.id]);
    expect(grants.map((g) => g.agentId)).not.toContain(ops.id);
    await expect(
      createApiKeyConnection(depsOf(f), walter.id, f.org.id, { connector: "linear", apiKey: "lin_api_FAKE_team_12" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // GitHub stays the team's: its git proxy and repository lists read the workspace's one connection.
    await expect(
      createApiKeyConnection(depsOf(f), walter.id, f.org.id, {
        connector: "github",
        apiKey: "ghp_FAKE_walter_123456",
        personal: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The team may have its own Linear beside his: another tool prefix, nothing of his replaced.
    const team = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "linear",
      apiKey: "lin_api_FAKE_team_1234",
    });
    expect(team.ownerUserId).toBeNull();
    expect(team.toolPrefix).not.toBe(mine.toolPrefix);
    const live = (await f.db.select().from(schema.connectorConnections)).filter((c) => !c.revokedAt);
    expect(live.map((c) => c.id).sort()).toEqual([mine.id, team.id].sort());
  });

  test("another member reads nothing of it; who manages connectors sees that it exists and may remove it, never read it", async () => {
    const { walter, bia, mine } = await walterWithLinear();
    expect((await listConnections(f.db, bia.id, f.org.id, { others: true })).map((c) => c.id)).not.toContain(mine.id);
    expect((await listConnections(f.db, walter.id, f.org.id)).map((c) => c.id)).toEqual([mine.id]);
    // The owner manages connectors: with `others` the row comes, as a person's row with no address or account.
    const listed = await listConnections(f.db, f.owner.id, f.org.id, { others: true });
    const row = listed.find((c) => c.id === mine.id);
    if (!row) throw new Error("not listed");
    expect(connectionViewFor(row, f.owner.id)).toMatchObject({
      ownerUserId: walter.id,
      serverUrl: "",
      accountLabel: null,
    });
    expect((await listConnections(f.db, f.owner.id, f.org.id)).map((c) => c.id)).not.toContain(mine.id);
    await expect(connectionFor(f.db, bia.id, f.org.id, mine.id, "read")).rejects.toBeInstanceOf(NotFoundError);
    await expect(connectionFor(f.db, f.owner.id, f.org.id, mine.id, "read")).rejects.toBeInstanceOf(NotFoundError);
    await expect(renameConnection(f.db, f.owner.id, f.org.id, mine.id, "Mine now")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(revokeConnection(f.db, bia.id, f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await revokeConnection(f.db, f.owner.id, f.org.id, mine.id);
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).toEqual(
      [],
    );
  });

  test("another workspace finds nothing of it", async () => {
    const { mine } = await walterWithLinear();
    const [other] = await f.db.insert(schema.organizations).values({ name: "Acme", slug: "acme-2" }).returning();
    if (!other) throw new Error("no org");
    await f.db.insert(schema.organizationMembers).values({ orgId: other.id, userId: f.owner.id, role: "owner" });
    await expect(connectionFor(f.db, f.owner.id, other.id, mine.id, "remove")).rejects.toBeInstanceOf(NotFoundError);
    expect(await listConnections(f.db, f.owner.id, other.id, { others: true })).toEqual([]);
  });

  test("only its person renames it; moving it to the team needs them to manage connectors", async () => {
    const { walter, mine } = await walterWithLinear();
    expect((await renameConnection(f.db, walter.id, f.org.id, mine.id, "My Linear")).label).toBe("My Linear");
    await expect(moveConnectionToTeam(f.db, walter.id, f.org.id, mine.id)).rejects.toThrow("manage connectors");
    expect(mayConnection({ ownerUserId: walter.id }, walter.id, null, "move")).toBe(false);
  });
});

describe("a personal connection serves runs as a person's mailbox does", () => {
  test("its person's run gets its tools; a run nobody is behind gets nothing personal", async () => {
    const { walter, source } = await walterWithLinear();
    expect(await names(source, await runOf(f.agent.id, walter.id))).toEqual([
      "linear_create_issue",
      "linear_list_issues",
    ]);
    expect(await names(source, await runOf(f.agent.id, null))).toEqual([]);
  });

  test("someone the agent doesn't answer gets nothing; one it answers needs the owner's approval to act", async () => {
    const { walter, bia, source } = await walterWithLinear();
    expect(await names(source, await runOf(f.agent.id, bia.id))).toEqual([]);
    // Walter opens `@dev` to everyone: Bia may use his Linear through it, and its actions ask Walter alone.
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    const ctx = await runOf(f.agent.id, bia.id);
    const tools = await source.tools(ctx);
    const write = tools.find((t) => t.name === "linear_create_issue");
    const read = tools.find((t) => t.name === "linear_list_issues");
    expect(write).toMatchObject({ sensitive: true, asksOwner: true, ownerUserId: walter.id });
    expect(read?.sensitive).toBe(false);
    expect(read?.readsOutside).toBe(true);
    const asked = await write?.approvers?.({}, ctx, bia.id);
    expect(asked).toMatchObject({ ok: true, approvers: { userIds: [walter.id], required: true, requestedBy: bia.id } });
    // Even an agent that never asks asks him.
    if (write) expect(unaskedAtNever("never", write, { kind: "person", personId: bia.id } as never)).toBe(false);

    const gateway = createToolGateway({ sources: [source] });
    const result = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "linear_create_issue",
      input: { title: "Ship it", why: "Bia asked for this issue so the sign-in bug is tracked on the board." },
    });
    expect(result).toMatchObject({ type: "approval" });
    if (result.type === "approval") expect(result.approval.approvers).toMatchObject({ userIds: [walter.id] });

    // His own run acts as his: no card for a plain write.
    const own = (await source.tools(await runOf(f.agent.id, walter.id))).find((t) => t.name === "linear_create_issue");
    expect(own?.sensitive).toBe(false);
    expect(own?.asksOwner).toBeUndefined();
  });

  test('"all tools" on an agent never reaches someone\'s personal connection', async () => {
    const { walter, bia, ops, source } = await walterWithLinear();
    await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: ops.id, connectionId: null, scope: "*" });
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, ops.id));
    expect(await names(source, await runOf(ops.id, walter.id))).toEqual([]);
    expect(await names(source, await runOf(ops.id, bia.id))).toEqual([]);
  });

  test("the right hand uses it only for its owner, in their own DM", async () => {
    const { walter, bia, mine, source } = await walterWithLinear();
    await ensureRightHand(f.db, f.org.id);
    const [lodi] = await f.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!lodi) throw new Error("no right hand");
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: lodi.id, connectionId: mine.id, scope: "connector:*" });
    const dm = await openPersonAgentDm(f.db, f.org.id, walter.id, lodi.id);
    expect(await names(source, await runOf(lodi.id, walter.id, dm.id))).toEqual([
      "linear_create_issue",
      "linear_list_issues",
    ]);
    expect(await names(source, await runOf(lodi.id, walter.id, f.general.id))).toEqual([]);
    const biaDm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    expect(await names(source, await runOf(lodi.id, bia.id, biaDm.id))).toEqual([]);
  });

  test("a person who leaves takes their connections with them; the team's keep serving runs", async () => {
    const { walter, mine, source } = await walterWithLinear();
    const team = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "sentry",
      apiKey: "sntrys_FAKE_team_1234",
    });
    await removeMember(f.db, f.owner.id, f.org.id, walter.id);
    const [row] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, mine.id));
    expect(row?.revokedAt).not.toBeNull();
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).toEqual(
      [],
    );
    const still = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, team.id));
    expect(still.length).toBeGreaterThan(0);
    expect(await names(source, await runOf(f.agent.id, f.owner.id))).toEqual([]);
  });
});

describe("an agent's page", () => {
  test("who may change the agent sees another's personal connection while it is on, with no tools, and may only take it off", async () => {
    const { walter, mine } = await walterWithLinear();
    const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { others: true });
    expect(tree.connectors.find((c) => c.connectionId === mine.id)).toMatchObject({
      ownerUserId: walter.id,
      scopes: [],
    });
    // An app that doesn't know the word never gets it.
    const plain = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(plain.connectors.map((c) => c.connectionId)).not.toContain(mine.id);
    const input = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
    // A save that doesn't name it keeps it; only `false` takes it off.
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, input);
    const kept = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id));
    expect(kept.length).toBe(1);
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { ...input, connectors: { [mine.id]: false } });
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).toEqual(
      [],
    );
    // Nobody but Walter gives it back.
    await expect(
      setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { ...input, connectors: { [mine.id]: true } }),
    ).rejects.toThrow("Only its person");
    await setAgentAccess(f.db, walter.id, f.org.id, f.agent.id, { ...input, connectors: { [mine.id]: true } });
    expect(
      (await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).length,
    ).toBe(1);
  });
});
