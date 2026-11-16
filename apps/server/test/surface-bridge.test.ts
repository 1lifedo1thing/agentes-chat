import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";
import { asc, schema } from "@agenteschat/db";
import { SURFACE_PREFIX, setSurface, surfaceFromConfig } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { type OperatorDeps, operatorFetch, serveOperatorApi } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

const OPERATOR = "operator-test-token-".padEnd(48, "x");
const BRIDGE = "bridge-test-token-".padEnd(48, "y");
const SURFACE_ENV = {
  SURFACE_BRIDGE_TOKEN: BRIDGE,
  SURFACE_NAME: "Telegram",
  SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
};

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer({ env: { ...SURFACE_ENV, OPERATOR_API_TOKEN: OPERATOR } });
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
