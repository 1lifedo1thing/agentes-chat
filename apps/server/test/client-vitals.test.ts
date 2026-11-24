import { afterAll, beforeAll, expect, test } from "bun:test";
import { clientVitals, createClientVitals } from "../src/client-vitals";
import { browser, createTestServer, ORIGIN, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeAll(async () => {
  t = await createTestServer();
});
afterAll(async () => {
  await t.close();
});

test("a minute's reports sum up per platform: how many, the median, the 95th percentile and the worst", () => {
  const vitals = createClientVitals();
  expect(vitals.take()).toBeNull();
  for (let i = 1; i <= 20; i++) vitals.add({ platform: "ios", coldStartMs: i * 100, getsPerReturn: i % 4 });
  vitals.add({ platform: "android", jsLagMaxMs: 950 });
  expect(vitals.take()).toEqual({
    ios: {
      reports: 20,
      coldStartMs: { n: 20, p50: 1100, p95: 2000, max: 2000 },
      getsPerReturn: { n: 20, p50: 2, p95: 3, max: 3 },
    },
    android: { reports: 1, jsLagMaxMs: { n: 1, p50: 950, p95: 950, max: 950 } },
  });
  // Taken: the next minute starts empty.
  expect(vitals.take()).toBeNull();
});

test("the desktop app sums up per system, its web view's memory beside the rest, never one system with another", () => {
  const vitals = createClientVitals();
  vitals.add({ platform: "windows", coldStartMs: 6200, webviewBytes: 410_000_000 });
  vitals.add({ platform: "windows", coldStartMs: 5800, webviewBytes: 390_000_000 });
  vitals.add({ platform: "macos", coldStartMs: 2100, webviewBytes: 180_000_000, heapBytes: 60_000_000 });
  expect(vitals.take()).toEqual({
    windows: {
      reports: 2,
      coldStartMs: { n: 2, p50: 6200, p95: 6200, max: 6200 },
      webviewBytes: { n: 2, p50: 410_000_000, p95: 410_000_000, max: 410_000_000 },
    },
    macos: {
      reports: 1,
      coldStartMs: { n: 1, p50: 2100, p95: 2100, max: 2100 },
      heapBytes: { n: 1, p50: 60_000_000, p95: 60_000_000, max: 60_000_000 },
      webviewBytes: { n: 1, p50: 180_000_000, p95: 180_000_000, max: 180_000_000 },
    },
  });
});

test("an app sends its numbers with its session; nobody signed in, or a malformed report, is refused", async () => {
  const b = browser(t);
  await signUp(b, "vitals@example.com");
  clientVitals.take();
  const send = (json: unknown) => b("/api/app/client-vitals", { json });
  expect((await send({ platform: "android", coldStartMs: 1800, firstRowsMs: 2400, reconnects: 1 })).status).toBe(204);
  expect((await send({ platform: "linux", webviewBytes: 250_000_000 })).status).toBe(204);
  expect((await send({ platform: "fridge" })).status).toBe(400);
  expect((await send({ platform: "ios", coldStartMs: -5 })).status).toBe(400);
  expect((await send({ platform: "windows", webviewBytes: 1.5 })).status).toBe(400);
  const anonymous = await t.app.request("/api/app/client-vitals", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ platform: "ios" }),
  });
  expect(anonymous.status).toBe(401);
  expect(clientVitals.take()).toEqual({
    android: {
      reports: 1,
      coldStartMs: { n: 1, p50: 1800, p95: 1800, max: 1800 },
      firstRowsMs: { n: 1, p50: 2400, p95: 2400, max: 2400 },
      reconnects: { n: 1, p50: 1, p95: 1, max: 1 },
    },
    linux: { reports: 1, webviewBytes: { n: 1, p50: 250_000_000, p95: 250_000_000, max: 250_000_000 } },
  });
});
