import { afterAll, beforeAll, expect, test } from "bun:test";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { watchProcessHealth } from "../src/process-health";
import { createTestServer, type TestServer } from "./harness";

const TOKEN = "operator-test-token-".padEnd(48, "x");
const MB = 1024 * 1024;

let t: TestServer;
beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
});
afterAll(async () => {
  await t.close();
});

test("a process writes its vitals for GET /vitals, and one heap snapshot once its heap passes the mark", async () => {
  let heapUsed = 100 * MB;
  const written: string[] = [];
  const health = watchProcessHealth(
    {
      db: t.db,
      log: createLogger("error"),
      role: "worker",
      version: "test",
      eventLoopLag: () => ({ p50Ms: 1, p99Ms: 12.5, maxMs: 40, at: new Date().toISOString() }),
      heapSnapshotMb: 200,
      heapSnapshotDir: "/data/heap",
      memoryUsage: () => ({ rss: 300 * MB, heapUsed, heapTotal: 400 * MB, external: 0, arrayBuffers: 0 }),
      writeSnapshot: (path) => {
        written.push(path);
        return path;
      },
    },
    60_000,
  );
  try {
    await health.tick();
    expect(written).toEqual([]);
    heapUsed = 250 * MB;
    await health.tick();
    await health.tick();
    expect(written).toHaveLength(1);
    expect(written[0]).toStartWith("/data/heap/heap-worker-");

    const app = createOperatorApp({ db: t.db, config: t.config, version: "test", log: createLogger("error") }, TOKEN);
    const res = await app.request("/api/operator/v1/vitals", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const vitals = (await res.json()) as {
      processes: Record<string, unknown>[];
      runClaims: Record<string, unknown>;
    };
    expect(vitals.processes.find((p) => p.id === health.id)).toMatchObject({
      role: "worker",
      rssBytes: 300 * MB,
      heapUsedBytes: 250 * MB,
      eventLoopP99Ms: 12.5,
      heapSnapshot: { file: written[0]?.slice("/data/heap/".length) },
    });
    expect(vitals.runClaims).toMatchObject({ windowSeconds: 300, queued: 0 });
  } finally {
    health.stop();
  }
});
