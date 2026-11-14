import { afterEach, expect, test } from "bun:test";
import { createMemoryBlobStore } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  allowPrivateOutbound,
  type CustomDeps,
  checkRequestHeaders,
  connectCustomServer,
  connectionHeaders,
  connectOverHttp,
  connectorGrantValidator,
  createConnectorToolSource,
  createRoutine,
  createToolGateway,
  listAudit,
  listCustomServers,
  type McpConnect,
  mcpPreset,
  postPersonMessage,
  type RequestHeader,
  saveCustomTools,
  setAgentScopes,
  storeCustomConnection,
  type ValidationError,
} from "../src";
import { addMember, type Fixture, SECRET, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

/** ADR 0186: request headers a person types for a server by address. */

let f: Fixture | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  allowPrivateOutbound(false);
  const current = f;
  f = undefined;
  await current?.close();
});

const SERVER = "https://tickets.example.com/mcp";
/** Values no answer, row or log line may ever hold. */
const VALUE = "fake-gate-pass";
const TEAM = "fake-team-pass";

const depsOf = (fx: Fixture, extra: Partial<CustomDeps> = {}): CustomDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: async () => ["93.184.216.34"],
  ...extra,
});

const headersOf = (init?: RequestInit) => Object.fromEntries(new Headers(init?.headers).entries());

/** A server that answers whatever it is asked: the headers each probe and each MCP session came with. */
function recorder() {
  const probes: Record<string, string>[] = [];
  const sessions: Record<string, string>[] = [];
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    probes.push(headersOf(init));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const connect: McpConnect = async (_connection, headers) => {
    sessions.push(headers);
    return {
      listTools: async () => [],
      callTool: async () => ({ content: "{}", isError: false }),
      close: async () => {},
    };
  };
  return { probes, sessions, http, connect };
}

async function connected(fx: Fixture, deps: CustomDeps, input: Parameters<typeof connectCustomServer>[3]) {
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, input);
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  return started;
}

const h = (name: string, value = "v"): RequestHeader => ({ name, value });

function refusal(headers: RequestHeader[], withKey = false) {
  try {
    checkRequestHeaders(headers, withKey);
    return null;
  } catch (error) {
    const { code, params } = error as ValidationError;
    return { code, params, said: JSON.stringify([(error as Error).message, params]) };
  }
}

test("what is accepted: each refusal has its own code and names the header, never its value", () => {
  // Names stay as typed, values lose the spaces around them, the order is kept.
  expect(checkRequestHeaders([h(" X-API-Key ", ` ${VALUE}\t1 `), h("x_team.1", "a b")], false)).toEqual({
    "X-API-Key": `${VALUE}\t1`,
    "x_team.1": "a b",
  });
  expect(Object.keys(checkRequestHeaders([h("B"), h("A")], false))).toEqual(["B", "A"]);

  for (const name of ["", "X Key", "X:Key", "Ação", "x".repeat(65)]) {
    expect(refusal([h("Ok"), h(name)])).toMatchObject({
      code: "connector.header_name",
      params: { header: name.slice(0, 64), index: 1 },
    });
  }
  expect(refusal([h("x".repeat(64))])).toBeNull();

  for (const value of [
    "",
    "   ",
    `${VALUE}\r\nX-Other: 1`,
    `${VALUE}\nx`,
    `${VALUE}\0`,
    `${VALUE} é`,
    "x".repeat(2001),
  ]) {
    const refused = refusal([h("X-API-Key", value)]);
    expect(refused).toMatchObject({ code: "connector.header_value", params: { header: "X-API-Key", index: 0 } });
    expect(refused?.said).not.toContain(VALUE);
  }
  expect(refusal([h("X-API-Key", "x".repeat(2000))])).toBeNull();

  const reserved = [
    "host",
    "content-length",
    "content-type",
    "accept",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-connection",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ];
  for (const name of reserved) {
    for (const typed of [name, name.toUpperCase()]) {
      expect(refusal([h(typed)])).toMatchObject({ code: "connector.header_reserved", params: { header: typed } });
    }
  }

  expect(refusal([h("X-Team"), h("Other"), h("x-team")])).toMatchObject({
    code: "connector.header_twice",
    params: { header: "x-team", index: 2 },
  });

  const many = Array.from({ length: 11 }, (_, i) => h(`X-${i}`));
  expect(refusal(many)).toMatchObject({ code: "connector.headers_too_many", params: { max: 10 } });
  expect(refusal(many.slice(0, 10))).toBeNull();

  // `Authorization` is a person's to type (another scheme) only while no key is sent as it.
  expect(checkRequestHeaders([h("Authorization", `Token ${VALUE}`)], false)).toEqual({
    Authorization: `Token ${VALUE}`,
  });
  expect(refusal([h("authorization", `Token ${VALUE}`)], true)).toMatchObject({
    code: "connector.header_and_key",
    params: { header: "authorization", index: 0 },
  });
});

/** One request as the server got it: its address, its JSON-RPC method (the HTTP one without a body) and headers. */
interface Sent {
  url: string;
  rpc: string;
  headers: Record<string, string>;
  body: string;
}

/** An MCP server over `fetch`, as far as a listing and a call go, that names an icon of its own: every request it got. */
function mcpOverFetch(icon: string) {
  const sent: Sent[] = [];
  const serve = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    const message = body
      ? (JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> })
      : null;
    sent.push({ url: String(input), rpc: message?.method ?? init.method ?? "GET", headers: headersOf(init), body });
    // No stream to listen on, no icon to give, and nothing to say to a notification.
    if (!message) return new Response(null, { status: 405 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "inbox", version: "1", icons: [{ src: icon, mimeType: "image/png" }] },
      },
      "tools/list": {
        tools: [
          {
            name: "list_inboxes",
            description: "List the team's inboxes",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      },
      "tools/call": { content: [{ type: "text", text: '{"id":"0193ffff-0000-4000-8000-000000000001"}' }] },
    };
    return Response.json({ jsonrpc: "2.0", id: message.id, result: results[message.method] ?? {} });
  }) as unknown as typeof fetch;
  return { sent, serve };
}

test("they go with every request to the server (the first question, tool sync, a tool call, a trigger's call), never with its icon", async () => {
  const fx = await setup();
  f = fx;
  const serverUrl = mcpPreset("millionsend")?.serverUrl ?? "";
  const icon = `${new URL(serverUrl).origin}/icon.png`;
  const mcp = mcpOverFetch(icon);
  // The real transport, with the network swapped for the fake: what is asserted is what would leave the process.
  allowPrivateOutbound();
  globalThis.fetch = mcp.serve;
  const deps = depsOf(fx, { connect: connectOverHttp, blobs: createMemoryBlobStore() });
  const { server } = await connected(fx, deps, {
    serverUrl,
    headers: [h("X-API-Key", VALUE), h("X-Team", TEAM)],
  });
  expect(server).toMatchObject({ authType: "api_key", headerNames: ["X-API-Key", "X-Team"] });
  expect(server.tools.map((t) => t.name)).toEqual(["list_inboxes"]);

  await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
    label: server.label,
    tools: [{ name: "list_inboxes", access: "read", label: "List inboxes" }],
  });
  await setAgentScopes(
    fx.db,
    fx.owner.id,
    fx.org.id,
    fx.agent.id,
    [{ connectionId: server.id, scope: `custom:${server.id}:read` }],
    connectorGrantValidator,
  );
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const ctx = {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
  const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
  const [tool] = await gateway.list(ctx);
  expect((await gateway.invoke(ctx, { toolUseId: "t1", name: tool?.name ?? "", input: {} })).type).toBe("result");

  const routine = await createRoutine(
    { ...routineDeps(fx), hooks: { publicUrl: "https://agentes.test", secret: SECRET }, connectors: deps },
    fx.owner.id,
    fx.org.id,
    {
      name: "Incoming orders",
      agentId: fx.agent.id,
      prompt: "Answer the new order.",
      target: { type: "channel", channelId: fx.general.id },
      trigger: { type: "connector", connectionId: server.id, event: "millionsend.email.received" },
    },
  );
  expect(routine.trigger).toMatchObject({ type: "connector", status: "active" });

  const calls = mcp.sent.filter((s) => s.rpc === "tools/call").map((s) => JSON.parse(s.body).params.name);
  expect(calls).toEqual(["list_inboxes", "create_webhook"]);
  const typed = (s: Sent) => [s.headers["x-api-key"], s.headers["x-team"]];
  const toServer = mcp.sent.filter((s) => s.url === serverUrl);
  expect(toServer.map((s) => s.rpc)).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
  expect(toServer.filter((s) => typed(s).join() !== [VALUE, TEAM].join())).toEqual([]);
  // The icon is on the server's own origin, and still not the MCP endpoint.
  const elsewhere = mcp.sent.filter((s) => s.url !== serverUrl);
  expect(new Set(elsewhere.map((s) => s.url))).toEqual(new Set([icon]));
  expect(elsewhere.filter((s) => typed(s).some(Boolean))).toEqual([]);
}, 30_000);

test("a redirect on the server's own origin keeps them; one to another origin gets no request at all", async () => {
  // Where the address isn't pinned (`allowPrivateOutbound`), the transport itself stays on the origin. Pinned, it is
  // `outboundFetch`'s "ownRedirects follows a 307 or 308 on the same origin only" (net-guard.test.ts).
  allowPrivateOutbound();
  const sent: [string, string | null][] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push([url, new Headers(init?.headers).get("x-api-key")]);
    if (url === "https://tools.example.com/mcp")
      return new Response(null, { status: 308, headers: { location: "/mcp/" } });
    return new Response(null, { status: 307, headers: { location: "https://other.example.com/mcp" } });
  }) as unknown as typeof fetch;
  const opened = await connectOverHttp({ serverUrl: "https://tools.example.com/mcp" }, { "x-api-key": VALUE }).then(
    () => true,
    () => false,
  );
  expect(opened).toBe(false);
  expect(sent).toEqual([
    ["https://tools.example.com/mcp", VALUE],
    ["https://tools.example.com/mcp/", VALUE],
  ]);
});

test("a server that asks for a sign-in: refused, and only the question to the server itself carried them", async () => {
  const fx = await setup();
  f = fx;
  const metadata = "https://tickets.example.com/.well-known/oauth-protected-resource/mcp";
  const requests: [string, string | null][] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push([url, new Headers(init?.headers).get("x-api-key")]);
    if (url === SERVER) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
      });
    }
    if (url === metadata) {
      return Response.json({
        resource: SERVER,
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["tickets"],
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const start = () =>
    connectCustomServer(depsOf(fx, { http }), fx.owner.id, fx.org.id, {
      serverUrl: SERVER,
      headers: [h("X-API-Key", VALUE)],
    });
  await expect(start()).rejects.toMatchObject({ code: "connector.headers_with_sign_in" });
  // The metadata read on the server's own origin got none either: it is not the MCP endpoint.
  expect(requests).toEqual([
    [SERVER, VALUE],
    [metadata, null],
  ]);
  expect(await fx.db.select().from(schema.oauthStates)).toEqual([]);
  expect(await fx.db.select().from(schema.connectorConnections)).toEqual([]);
});

test("a token refresh carries none of them, and the new tokens keep them", async () => {
  const fx = await setup();
  f = fx;
  const [client] = await fx.db
    .insert(schema.oauthClients)
    .values({
      orgId: fx.org.id,
      issuer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "dcr-client-1",
      tokenAuthMethod: "none",
    })
    .returning();
  const posted: { url: string; headers: Record<string, string>; body: string }[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(input), headers: headersOf(init), body: String(init?.body) });
    return Response.json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  }) as unknown as typeof fetch;
  const deps = depsOf(fx, { http });
  const { connection } = await storeCustomConnection(deps, {
    orgId: fx.org.id,
    actorId: fx.owner.id,
    serverUrl: SERVER,
    label: "Tickets",
    authType: "oauth",
    secret: { accessToken: "at-1", refreshToken: "rt-1", headers: { "X-Team": TEAM } },
    tokenExpiresAt: new Date(Date.now() + 5_000),
    oauthClientId: client?.id,
    resource: SERVER,
  });
  expect(connection.headerNames).toEqual(["X-Team"]);
  expect(await connectionHeaders(deps, connection)).toEqual({ "x-team": TEAM, authorization: "Bearer at-2" });
  expect(posted.map((p) => p.url)).toEqual(["https://auth.example.com/token"]);
  expect(JSON.stringify(posted)).not.toContain(TEAM);
  expect(posted[0]?.headers["x-team"]).toBeUndefined();
  // Read again from its row: the refreshed secret still holds them.
  const [row] = await fx.db
    .select()
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.id, connection.id));
  if (!row) throw new Error("no connection");
  expect(await connectionHeaders(deps, row)).toEqual({ "x-team": TEAM, authorization: "Bearer at-2" });
  expect(posted).toHaveLength(1);
}, 30_000);

test("headers alone connect, a key goes on top of them, and no answer, row or audit line holds a value", async () => {
  const fx = await setup();
  f = fx;
  const r = recorder();
  const deps = depsOf(fx, { http: r.http, connect: r.connect });
  const alone = await connected(fx, deps, {
    serverUrl: SERVER,
    label: "Tickets",
    headers: [h("X-API-Key", ` ${VALUE} `)],
  });
  // It holds a secret a person typed, as a key does.
  expect(alone.server).toMatchObject({ authType: "api_key", headerNames: ["X-API-Key"] });
  expect(r.probes).toHaveLength(1);
  expect(r.probes[0]?.["x-api-key"]).toBe(VALUE);
  expect(r.sessions.at(-1)).toEqual({ "x-api-key": VALUE });

  // With a key the server isn't asked first, and the key's `Authorization` goes with them.
  const keyed = await connected(fx, deps, { serverUrl: SERVER, apiKey: "test-key", headers: [h("X-Team", TEAM)] });
  expect(keyed.server.headerNames).toEqual(["X-Team"]);
  expect(r.probes).toHaveLength(1);
  expect(r.sessions.at(-1)).toEqual({ "x-team": TEAM, authorization: "Bearer test-key" });
  await expect(
    connectCustomServer(deps, fx.owner.id, fx.org.id, {
      serverUrl: SERVER,
      apiKey: "test-key",
      headers: [h("Authorization", `Token ${VALUE}`)],
    }),
  ).rejects.toMatchObject({ code: "connector.header_and_key", params: { header: "Authorization", index: 0 } });

  // Another scheme: `Authorization` as typed, with no key.
  const scheme = await connected(fx, deps, { serverUrl: SERVER, headers: [h("Authorization", `Token ${VALUE}`)] });
  expect(r.sessions.at(-1)).toEqual({ authorization: `Token ${VALUE}` });

  // None typed: as before, a server that answers has nothing to keep.
  const open = await connected(fx, deps, { serverUrl: "https://open.example.com/mcp" });
  expect(open.server.headerNames).toEqual([]);
  expect(r.sessions.at(-1)).toEqual({});

  const reader = await addMember(fx.db, fx.org.id, "member", "reader");
  const listed = await listCustomServers(fx.db, fx.owner.id, fx.org.id);
  expect(listed.map((s) => s.headerNames)).toEqual([["X-API-Key"], ["X-Team"], ["Authorization"], []]);
  // Who can't manage connectors isn't told what a server is sent.
  const forReader = await listCustomServers(fx.db, reader.id, fx.org.id);
  expect(forReader.map((s) => s.headerNames)).toEqual([[], [], [], []]);

  const rows = await fx.db.select().from(schema.connectorConnections);
  const audit = (await listAudit(fx.db, fx.owner.id, fx.org.id)).rows;
  expect(audit.some((row) => row.action === "connector.custom_connected")).toBe(true);
  const said = JSON.stringify([alone, keyed, scheme, listed, forReader, rows, audit]);
  expect(said).toContain("X-API-Key");
  expect(said).not.toContain(VALUE);
  expect(said).not.toContain(TEAM);
});

test("Reconectar keeps the account's headers, replaces them with a list and removes them with an empty one", async () => {
  const fx = await setup();
  f = fx;
  const r = recorder();
  const deps = depsOf(fx, { http: r.http, connect: r.connect });
  const first = await connected(fx, deps, {
    serverUrl: SERVER,
    apiKey: "test-key",
    headers: [h("X-API-Key", VALUE), h("X-Team", TEAM)],
  });
  const again = (input: Omit<Parameters<typeof connectCustomServer>[3], "serverUrl" | "connectionId">) =>
    connected(fx, deps, { serverUrl: SERVER, connectionId: first.server.id, ...input });

  // Absent: they stay, whatever else changes (here the key).
  const kept = await again({ apiKey: "test-key-2" });
  expect(kept).toMatchObject({ outcome: "reconnected", server: { id: first.server.id } });
  expect(kept.server.headerNames).toEqual(["X-API-Key", "X-Team"]);
  expect(r.sessions.at(-1)).toEqual({ "x-api-key": VALUE, "x-team": TEAM, authorization: "Bearer test-key-2" });

  // No key typed: the server is asked with the ones it has, and they alone are the connection.
  const alone = await again({});
  expect(alone.server.headerNames).toEqual(["X-API-Key", "X-Team"]);
  expect(r.probes.at(-1)).toMatchObject({ "x-api-key": VALUE, "x-team": TEAM });
  expect(r.sessions.at(-1)).toEqual({ "x-api-key": VALUE, "x-team": TEAM });

  // A list replaces them all.
  const replaced = await again({ headers: [h("Authorization", `Token ${VALUE}`)] });
  expect(replaced.server.headerNames).toEqual(["Authorization"]);
  expect(r.sessions.at(-1)).toEqual({ authorization: `Token ${VALUE}` });
  // The one it kept is `Authorization`: a key now would be sent as that too.
  await expect(again({ apiKey: "test-key-3" })).rejects.toMatchObject({
    code: "connector.header_and_key",
    params: { header: "Authorization" },
  });

  // An empty list removes them: nothing is sent, and the row names none.
  const removed = await again({ headers: [] });
  expect(removed.server.headerNames).toEqual([]);
  expect(r.probes.at(-1)?.["x-api-key"]).toBeUndefined();
  expect(r.sessions.at(-1)).toEqual({});
  const rows = await fx.db.select().from(schema.connectorConnections);
  expect(rows.map((row) => [row.id, row.headerNames])).toEqual([[first.server.id, null]]);
});

test("refused where a key is: a service through Composio, and a sign-in-only server on the Cloud", async () => {
  const fx = await setup();
  f = fx;
  const r = recorder();
  const headers = [h("X-API-Key", VALUE)];
  const start = (deps: CustomDeps, serverUrl: string) =>
    connectCustomServer(deps, fx.owner.id, fx.org.id, { serverUrl, headers });
  const self = depsOf(fx, { http: r.http, connect: r.connect });
  await expect(start(self, "https://backend.composio.dev/api/v3.1/toolkits/googledrive")).rejects.toMatchObject({
    code: "connector.oauth_only",
  });
  const intercom = mcpPreset("intercom")?.serverUrl ?? "";
  await expect(start({ ...self, publicUrl: "https://agentes.chat" }, intercom)).rejects.toMatchObject({
    code: "connector.oauth_only",
  });
  expect(r.probes).toEqual([]);
  expect((await start(self, intercom)).status).toBe("connected");
});
