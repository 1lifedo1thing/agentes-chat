import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";
import { and, asc, eq, schema } from "@agenteschat/db";
import { SURFACE_PREFIX, setSurface, sha256, surfaceFromConfig } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { type OperatorDeps, operatorFetch, serveOperatorApi } from "../src/operator/app";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

const OPERATOR = "operator-test-token-".padEnd(48, "x");
const BRIDGE = "bridge-test-token-".padEnd(48, "y");
const SURFACE_ENV = {
  SURFACE_BRIDGE_TOKEN: BRIDGE,
  SURFACE_NAME: "Telegram",
  SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
};

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer({
    env: { ...SURFACE_ENV, OPERATOR_API_TOKEN: OPERATOR, ALLOW_SIGNUP: "true", GROQ_API_KEY: "groq-key-1234" },
    // A fake speech provider: the words of any recording.
    speechFetch: (async () => Response.json({ text: "Ada, oi" })) as unknown as typeof fetch,
  });
});
afterAll(() => t.close());
beforeEach(() => setSurface(surfaceFromConfig(t.config)));
afterEach(() => setSurface(null));

/** The listener's routing for this config (default: both tokens, as the test server has them). */
function listener(config = t.config) {
  const deps: OperatorDeps = { db: t.db, config, version: "test", log: createLogger("error"), surface: t.services };
  return operatorFetch(deps);
}

async function call(
  fetch: ReturnType<typeof listener>,
  path: string,
  token: string | null,
): Promise<{ status: number; code: string | null; body: Record<string, unknown> }> {
  if (!fetch) throw new Error("no listener");
  const res = await fetch(
    new Request(`http://127.0.0.1${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  const error = body.error as { code?: string } | undefined;
  return { status: res.status, code: error?.code ?? null, body };
}

const ORGS = "/api/operator/v1/orgs";
const HEALTH = `${SURFACE_PREFIX}/health`;

test("no listener when neither token is set", () => {
  expect(listener(testConfig())).toBeNull();
  expect(serveOperatorApi({ db: t.db, config: testConfig(), version: "test", log: createLogger("error") })).toBeNull();
});

test("the bridge token alone: the bridge answers with it, and nothing under the operator prefix answers", async () => {
  const fetch = listener(testConfig(SURFACE_ENV));
  const ok = await call(fetch, HEALTH, BRIDGE);
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ ok: true, surface: "Telegram", version: "test" });
  expect((await call(fetch, HEALTH, null)).status).toBe(401);
  const wrong = await call(fetch, HEALTH, "w".repeat(48));
  expect([wrong.status, wrong.code]).toEqual([401, "unauthorized"]);
  for (const token of [BRIDGE, OPERATOR, null]) {
    const res = await call(fetch, ORGS, token);
    expect([res.status, res.code]).toEqual([404, "not_found"]);
  }
});

test("the operator token alone: the bridge prefix is a 404", async () => {
  const fetch = listener(testConfig({ OPERATOR_API_TOKEN: OPERATOR }));
  expect((await call(fetch, ORGS, OPERATOR)).status).toBe(200);
  for (const token of [BRIDGE, OPERATOR]) {
    const res = await call(fetch, HEALTH, token);
    expect([res.status, res.code]).toEqual([404, "not_found"]);
  }
});

test("both tokens: each opens only its own prefix", async () => {
  const fetch = listener();
  expect((await call(fetch, ORGS, OPERATOR)).status).toBe(200);
  expect((await call(fetch, HEALTH, BRIDGE)).status).toBe(200);
  const bridgeOnOperator = await call(fetch, ORGS, BRIDGE);
  expect([bridgeOnOperator.status, bridgeOnOperator.code]).toEqual([401, "unauthorized"]);
  const operatorOnBridge = await call(fetch, HEALTH, OPERATOR);
  expect([operatorOnBridge.status, operatorOnBridge.code]).toEqual([401, "unauthorized"]);
  expect((await call(fetch, `${SURFACE_PREFIX}/nothing-here`, BRIDGE)).status).toBe(404);
  expect((await call(fetch, `${SURFACE_PREFIX}/nothing-here`, null)).status).toBe(401);
});

test("one surface_calls row per bridge call, with its answer and never a raw sender id", async () => {
  await t.db.delete(schema.surfaceCalls);
  const fetch = listener();
  await call(fetch, HEALTH, BRIDGE);
  await call(fetch, HEALTH, "w".repeat(48));
  await call(fetch, `${SURFACE_PREFIX}/nothing-here`, BRIDGE);
  await call(fetch, ORGS, OPERATOR);
  const rows = await t.db.select().from(schema.surfaceCalls).orderBy(asc(schema.surfaceCalls.id));
  expect(rows.map((r) => [r.method, r.route, r.status, r.code])).toEqual([
    ["GET", `${SURFACE_PREFIX}/health`, 200, null],
    ["GET", `${SURFACE_PREFIX}/health`, 401, "unauthorized"],
    ["GET", `${SURFACE_PREFIX}/*`, 404, "not_found"],
  ]);
  expect(rows.every((r) => r.externalHash === null && r.linkId === null && r.userId === null)).toBe(true);
});

test("the OpenAPI document is the committed contract (ADR 0187)", async () => {
  const doc = await call(listener(), `${SURFACE_PREFIX}/openapi.json`, BRIDGE);
  expect(doc.status).toBe(200);
  const file = Bun.file(`${import.meta.dir}/surface-openapi.json`);
  // After a deliberate change: UPDATE_SURFACE_OPENAPI=1 bun test apps/server/test/surface-bridge.test.ts, then bun run format.
  if (process.env.UPDATE_SURFACE_OPENAPI === "1") await Bun.write(file, `${JSON.stringify(doc.body, null, 2)}\n`);
  expect(doc.body).toEqual(await file.json());
});

// Inbound: a linked sender's messages through `POST /messages`.

let ana: Browser | null = null;
let anaOrg = "";
const SENDER = "sender-2002";

/** Ana, her workspace, and this sender linked to her account there (once per file). */
async function linked() {
  if (ana) return ana;
  const b = browser(t);
  await signUp(b, "ana@example.com");
  const res = await b("/api/app/organizations", { json: { name: "Acme", context: "Acme builds rockets." } });
  anaOrg = ((await res.json()) as { organization: { id: string } }).organization.id;
  const { code } = (await (await b(`/api/app/organizations/${anaOrg}/surface-link/code`, { json: {} })).json()) as {
    code: string;
  };
  const fetch = listener();
  if (!fetch) throw new Error("no listener");
  const claimed = await fetch(
    new Request(`http://127.0.0.1${SURFACE_PREFIX}/links/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BRIDGE}` },
      body: JSON.stringify({ externalId: SENDER, display: "+1 555 0100", profileName: "Ana", code }),
    }),
  );
  const { linkId } = (await claimed.json()) as { linkId: string };
  const confirmed = await b(`/api/app/me/surface-links/${linkId}/confirm`, { json: {} });
  if (confirmed.status !== 200) throw new Error(`confirm failed: ${confirmed.status}`);
  ana = b;
  return b;
}

async function send(
  fields: Record<string, string | File | File[]>,
  token = BRIDGE,
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of [value].flat()) form.append(key, v);
  }
  const fetch = listener();
  if (!fetch) throw new Error("no listener");
  const res = await fetch(
    new Request(`http://127.0.0.1${SURFACE_PREFIX}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...headers },
      body: form,
    }),
  );
  const body = (await res.json()) as Record<string, unknown> & { error?: { code: string } };
  return { status: res.status, code: body.error?.code ?? null, body };
}

async function stored(id: unknown) {
  const [m] = await t.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, anaOrg), eq(schema.messages.id, String(id))));
  if (!m) throw new Error("no message");
  return m;
}

test("a text message posts as the linked person in their DM, recorded with whom it touched", async () => {
  await linked();
  await t.db.delete(schema.surfaceCalls);
  const res = await send({ externalId: SENDER, inboundId: "in-text-1", text: "Bom dia" });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ status: "posted", voiceAsFile: false, orgId: anaOrg, orgName: "Acme" });
  const m = await stored(res.body.messageId);
  expect(m.body).toBe("Bom dia");
  expect(m.meta.via).toMatchObject({ kind: "surface", surface: "telegram" });
  const again = await send({ externalId: SENDER, inboundId: "in-text-1", text: "Bom dia" });
  expect(again.body).toMatchObject({ status: "duplicate", messageId: res.body.messageId });
  const [row] = await t.db.select().from(schema.surfaceCalls).orderBy(asc(schema.surfaceCalls.id)).limit(1);
  expect(row).toMatchObject({ route: `${SURFACE_PREFIX}/messages`, status: 201, orgId: anaOrg });
  expect(row?.externalHash).toBe(sha256(SENDER).slice(0, 16));
  expect(row?.linkId).not.toBeNull();
});

test("files and a forwarded mark go through; a voice note is queued for its words", async () => {
  await linked();
  const files = [new File(["hello"], "notes.txt", { type: "text/plain" }), new File([new Uint8Array(8)], "a.png")];
  const withFiles = await send({ externalId: SENDER, inboundId: "in-files-1", files, forwarded: "true" });
  expect(withFiles.status).toBe(201);
  const m = await stored(withFiles.body.messageId);
  expect((m.meta.artifacts as { title: string }[]).map((a) => a.title)).toEqual(["notes.txt", "a.png"]);
  expect(m.meta.readOutside).toBe(true);

  const voice = new File([new Uint8Array(4000)], "voice.ogg", { type: "audio/ogg" });
  const queued = await send({ externalId: SENDER, inboundId: "in-voice-1", voice, voiceDurationMs: "2500" });
  expect([queued.status, queued.body.status, queued.body.messageId]).toEqual([201, "queued", null]);
  await t.drain();
  const [clip] = await t.db.select().from(schema.voiceClips);
  const spoken = await stored(clip?.messageId);
  expect(spoken.body).toBe("Ada, oi");
  expect(spoken.meta.via).toMatchObject({ kind: "surface" });

  const big = new File([new Uint8Array(20 * 1024)], "voice.ogg", { type: "audio/ogg" });
  const asFile = await send({ externalId: SENDER, inboundId: "in-voice-2", voice: big, voiceDurationMs: "1000" });
  expect([asFile.status, asFile.body.status, asFile.body.voiceAsFile]).toEqual([201, "posted", true]);
});

test("refused: bad shapes 400, unknown sender 404, wrong or operator token 401, a file over 50 MB 413", async () => {
  await linked();
  const note = new File([new Uint8Array(10)], "voice.ogg", { type: "audio/ogg" });
  const file = new File(["x"], "x.txt");
  const shapes: Record<string, string | File | File[]>[] = [
    { externalId: SENDER, inboundId: "bad-1" },
    { externalId: SENDER, inboundId: "bad-2", text: "hi", surprise: "yes" },
    { externalId: SENDER, inboundId: "bad-3", voice: note, voiceDurationMs: "1000", files: file },
    { externalId: SENDER, inboundId: "bad-4", voice: note },
    { externalId: SENDER, inboundId: "bad-5", files: Array.from({ length: 11 }, () => file) },
    { externalId: SENDER, inboundId: "bad-6", text: "hi", replyTo: "not-a-uuid" },
  ];
  for (const fields of shapes) {
    expect(await send(fields)).toMatchObject({ status: 400, code: "invalid_request" });
  }
  expect(await send({ externalId: "sender-nobody", inboundId: "x-1", text: "hi" })).toMatchObject({
    status: 404,
    code: "surface.unlinked",
  });
  expect((await send({ externalId: SENDER, inboundId: "x-2", text: "hi" }, OPERATOR)).status).toBe(401);
  expect((await send({ externalId: SENDER, inboundId: "x-3", text: "hi" }, "w".repeat(48))).status).toBe(401);
  const huge = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "huge.bin");
  expect(await send({ externalId: SENDER, inboundId: "x-4", files: huge })).toMatchObject({
    status: 413,
    code: "surface.too_large",
  });
});

test("a person posting in the app can't set the surface mark", async () => {
  const b = await linked();
  const posted = await send({ externalId: SENDER, inboundId: "in-app-1", text: "from the surface" });
  const dm = (await stored(posted.body.messageId)).channelId;
  const res = await b(`/api/app/organizations/${anaOrg}/channels/${dm}/messages`, {
    json: { body: "from the app", meta: { via: { kind: "surface", surface: "telegram" } } },
  });
  if (res.status === 201) {
    const m = await stored(((await res.json()) as { id: string }).id);
    expect(m.meta.via).toBeUndefined();
  } else {
    expect(res.status).toBe(400);
  }
});
