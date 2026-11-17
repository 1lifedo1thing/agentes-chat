import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { PersonLimitError } from "@agenteschat/engine";
import { readShapes } from "@agenteschat/live/canvas";
import { ProviderError } from "@agenteschat/providers";
import { Hono } from "hono";
import * as Y from "yjs";
import { domainErrorResponse, isExpectedError } from "../src/http/errors";
import { IMAGE_REQUESTS_PER_PERSON } from "../src/routes/app/images";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

type Api = (path: string, init?: Parameters<Browser>[1]) => Promise<Response>;

/** The owner of Acme (a Claude key only), its API under the workspace, and a canvas in its Drive. */
async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const as =
    (b: Browser): Api =>
    (path, init) =>
      b(`/api/app/organizations/${org.orgId}${path}`, init);
  const api = as(owner);
  const res = await api("/live-files", { json: { kind: "canvas", title: "Moodboard" } });
  expect(res.status).toBe(201);
  const canvas = (await res.json()) as { id: string };
  return { owner, org, api, as, canvas };
}

/** A Gemini key for the workspace (checked by the fake provider like any key). */
async function addGemini(api: Api, apiKey = "AQ.gemini-test-key-1234") {
  const res = await api("/credentials", { json: { provider: "gemini", label: "pictures", apiKey } });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as { id: string };
}

/** The canvas's shapes as `GET …/live` gives its document. */
async function shapesOf(api: Api, id: string) {
  const res = await api(`/artifacts/${id}/live`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { state: string };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(body.state, "base64")));
  const shapes = readShapes(doc, { text: false });
  doc.destroy();
  return shapes;
}

describe("the API's description", () => {
  test("lists the image routes", async () => {
    const res = await t.app.request("/api/openapi.json");
    const paths = Object.keys(((await res.json()) as { paths: Record<string, unknown> }).paths);
    const org = "/app/organizations/{orgId}";
    expect(paths).toEqual(
      expect.arrayContaining([
        `${org}/images/models`,
        `${org}/artifacts/{artifactId}/images`,
        `${org}/artifacts/{artifactId}/images/{requestId}/retry`,
      ]),
    );
  });
});

describe("image models", () => {
  test("none without a key for an image provider; with one, its models, priced only for who sees usage", async () => {
    const { org, api, as, owner } = await seeded();
    expect(await (await api("/images/models")).json()).toEqual({ models: [] });
    await addGemini(api);
    const { models } = (await (await api("/images/models")).json()) as {
      models: { id: string; provider: string; aspects: string[]; pricePerImage?: number; refs: boolean }[];
    };
    expect(models[0]).toMatchObject({ id: "gemini-nano-banana-2.1", provider: "gemini", refs: true });
    expect(models[0]?.aspects).toContain("16:9");
    expect(models[0]?.pricePerImage).toBeCloseTo(0.0336, 6);
    expect(models.every((m) => m.provider === "gemini")).toBe(true);

    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const theirs = (await (await as(ana)("/images/models")).json()) as { models: { pricePerImage?: number }[] };
    expect(theirs.models.length).toBe(models.length);
    expect(theirs.models.every((m) => m.pricePerImage === undefined)).toBe(true);

    const stranger = browser(t);
    await signUp(stranger, "stranger@example.com");
    expect((await as(stranger)("/images/models")).status).toBe(403);
  });
});

describe("asking for pictures on a canvas", () => {
  test("placeholders at once (202), the pictures after the job, billed to the person", async () => {
    const { api, canvas, owner } = await seeded();
    await addGemini(api);
    const res = await api(`/artifacts/${canvas.id}/images`, {
      json: { prompt: "a lighthouse at dusk", count: 2, aspect: "16:9", at: { x: 0, y: 0 } },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      requestId: string;
      status: string;
      shapeIds: string[];
      frameId: string;
      costNanoUsd?: number;
    };
    expect(body).toMatchObject({ status: "queued", model: "gemini-nano-banana-2.1", aspect: "16:9", error: null });
    expect(body.shapeIds).toHaveLength(2);
    expect(body.costNanoUsd).toBeUndefined();
    const before = await shapesOf(api, canvas.id);
    expect(before.filter((s) => s.type === "pending").map((s) => s.status)).toEqual(["queued", "queued"]);
    expect(before.find((s) => s.id === body.frameId)?.name).toBe("a lighthouse at dusk");

    await t.drain();
    const after = await shapesOf(api, canvas.id);
    const images = after.filter((s) => s.type === "image");
    expect(images.map((s) => s.id).sort()).toEqual([...body.shapeIds].sort());
    // Each picture is served to whoever reads the canvas.
    const asset = await api(`/artifacts/${canvas.id}/assets/${images[0]?.asset}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("image/png");
    const me = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
    const [usage] = await t.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "image"));
    expect(usage).toMatchObject({ agentId: null, personId: me, costNanoUsd: 2 * 33_600_000 });
  });

  test("refusals in the person's words: no image model, not a canvas, a file out of reach, a bad body", async () => {
    const { api, canvas } = await seeded();
    const none = await api(`/artifacts/${canvas.id}/images`, { json: { prompt: "a fox" } });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("images.no_model");
    await addGemini(api);
    const sheet = (await (await api("/live-files", { json: { kind: "spreadsheet", title: "Costs" } })).json()) as {
      id: string;
    };
    const notCanvas = await api(`/artifacts/${sheet.id}/images`, { json: { prompt: "a fox" } });
    expect(((await notCanvas.json()) as { error: { code: string } }).error.code).toBe("images.not_canvas");
    const missing = await api(`/artifacts/${crypto.randomUUID()}/images`, { json: { prompt: "a fox" } });
    expect(missing.status).toBe(404);
    const unknownModel = await api(`/artifacts/${canvas.id}/images`, {
      json: { prompt: "a fox", model: "gpt-image-2" },
    });
    expect(((await unknownModel.json()) as { error: { code: string } }).error.code).toBe("images.model_unavailable");
    for (const json of [{ prompt: "" }, { prompt: "a fox", count: 5 }, { prompt: "a fox", aspect: "5:4" }]) {
      expect((await api(`/artifacts/${canvas.id}/images`, { json })).status).toBe(400);
    }
    expect(await shapesOf(api, canvas.id)).toEqual([]);
  });

  test(`at most ${IMAGE_REQUESTS_PER_PERSON.limit} requests an hour per person`, async () => {
    const { api, canvas, owner } = await seeded();
    await addGemini(api);
    const me = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
    for (let i = 0; i < IMAGE_REQUESTS_PER_PERSON.limit; i++)
      await t.adapters.rateLimiter.consume(`images:${me}`, IMAGE_REQUESTS_PER_PERSON);
    const res = await api(`/artifacts/${canvas.id}/images`, { json: { prompt: "a fox" } });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("images.rate");
  });
});

describe("Try again", () => {
  test("a request that failed for lack of a key makes its pictures once a key is back", async () => {
    const { api, canvas } = await seeded();
    const key = await addGemini(api);
    const asked = (await (await api(`/artifacts/${canvas.id}/images`, { json: { prompt: "a fox" } })).json()) as {
      requestId: string;
      shapeIds: string[];
    };
    expect((await api(`/credentials/${key.id}`, { method: "DELETE" })).status).toBeLessThan(300);
    await t.drain();
    const failed = (await shapesOf(api, canvas.id)).find((s) => s.id === asked.shapeIds[0]);
    expect(failed).toMatchObject({ type: "pending", status: "failed", error: "no_key" });

    await addGemini(api, "AQ.gemini-second-key-5678");
    const retry = await api(`/artifacts/${canvas.id}/images/${asked.requestId}/retry`, { json: {} });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ requestId: asked.requestId, status: "queued", error: null });
    await t.drain();
    const made = (await shapesOf(api, canvas.id)).find((s) => s.id === asked.shapeIds[0]);
    expect(made?.type).toBe("image");
    const unknown = await api(`/artifacts/${canvas.id}/images/${crypto.randomUUID()}/retry`, { json: {} });
    expect(unknown.status).toBe(404);
  });
});

describe("errors of a call made for a person", () => {
  /** What the app answers when a route throws `error`. */
  async function answer(error: Error) {
    const app = new Hono();
    app.get("/", () => {
      throw error;
    });
    app.onError((e, c) => domainErrorResponse(e, c) ?? c.json({ error: { code: "internal_error" } }, 500));
    const res = await app.request("/");
    return { status: res.status, body: (await res.json()) as { error: { code: string; params?: unknown } } };
  }

  test("a person at their monthly limit is a 402, a provider's failure a 503 naming who and why", async () => {
    expect(await answer(new PersonLimitError("ada", 10, 10))).toMatchObject({
      status: 402,
      body: { error: { code: "person_limit" } },
    });
    const down = new ProviderError("rate limited by provider", true, 429);
    down.provider = "Gemini";
    expect(await answer(down)).toMatchObject({
      status: 503,
      body: { error: { code: "provider_error", params: { provider: "Gemini", cause: "rate_limit" } } },
    });
    expect(isExpectedError(down)).toBe(true);
  });
});
