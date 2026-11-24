import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  claimLink,
  lodiFor,
  mintPageLink,
  openPersonAgentDm,
  setSurface,
  surfaceFromConfig,
} from "@agenteschat/engine";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

const BRIDGE = "bridge-test-token-".padEnd(48, "y");

let t: TestServer;
let ana: Browser;
let orgId: string;
let userId: string;
let linkId: string;

beforeAll(async () => {
  t = await createTestServer({
    env: {
      ALLOW_SIGNUP: "true",
      SURFACE_BRIDGE_TOKEN: BRIDGE,
      SURFACE_NAME: "Example Chat",
      SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
    },
  });
  setSurface(surfaceFromConfig(t.config));
  ana = browser(t);
  await signUp(ana, "ana@example.com");
  const res = await ana("/api/app/organizations", { json: { name: "Acme", context: "Acme builds rockets." } });
  orgId = ((await res.json()) as { organization: { id: string } }).organization.id;
  const minted = (await (await ana(`/api/app/organizations/${orgId}/surface-link/code`, { json: {} })).json()) as {
    code: string;
  };
  const { link } = await claimLink(
    { db: t.db },
    { externalId: "sender-1", display: "+1 555 0100", profileName: null, code: minted.code },
  );
  const confirmed = await ana(`/api/app/me/surface-links/${link.id}/confirm`, { json: {} });
  expect(confirmed.status).toBe(200);
  linkId = link.id;
  userId = link.userId;
});
afterAll(() => {
  setSurface(null);
  return t.close();
});

async function confirmPage() {
  const lodi = await lodiFor(t.db, orgId, userId);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, userId, lodi.id);
  const [approval] = await t.db
    .insert(schema.approvals)
    .values({
      orgId,
      agentId: lodi.id,
      channelId: dm.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `tu_${crypto.randomUUID()}`,
      tool: "vault_delete",
      scope: "",
      params: {},
      actionHash: crypto.randomUUID(),
      title: "Delete the key OLD_KEY",
      detail: "{}",
      approvers: { userIds: [userId], label: "Ana", requestedBy: userId, requesterDecides: true },
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  if (!approval) throw new Error("no approval");
  const url = await mintPageLink(t.db, { orgId, linkId, userId, kind: "confirm", targetId: approval.id });
  return { token: new URL(url).searchParams.get("token") ?? "", approvalId: approval.id };
}

const codeOf = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

test("the first browser to open the page keeps it; another browser can't", async () => {
  const { token } = await confirmPage();
  const phone = browser(t);
  const opened = await phone("/api/app/surface-page/open", { json: { token } });
  expect(opened.status).toBe(200);
  const cookie = opened.headers.getSetCookie().find((c) => c.startsWith("surface_page_")) ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Path=/api/app/surface-page");
  expect(cookie).toContain("SameSite=Strict");
  expect(((await opened.json()) as { approval: { title: string; canDecide: boolean } }).approval).toMatchObject({
    title: "Delete the key OLD_KEY",
    canDecide: true,
  });
  const other = browser(t);
  const elsewhere = await other("/api/app/surface-page/open", { json: { token } });
  expect([elsewhere.status, await codeOf(elsewhere)]).toEqual([403, "surface.page_elsewhere"]);
  expect((await phone("/api/app/surface-page/open", { json: { token } })).status).toBe(200);
});

test("approving takes the PIN; the first one chosen becomes it", async () => {
  const { token, approvalId } = await confirmPage();
  const phone = browser(t);
  await phone("/api/app/surface-page/open", { json: { token } });
  const bad = await phone("/api/app/surface-page/decide", { json: { token, decision: "approve" } });
  expect([bad.status, await codeOf(bad)]).toEqual([400, "surface.pin_shape"]);
  const ok = await phone("/api/app/surface-page/decide", { json: { token, decision: "approve", pin: "907312" } });
  expect(ok.status).toBe(200);
  const [row] = await t.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  expect(row?.status).toBe("approved");

  const next = await confirmPage();
  await phone("/api/app/surface-page/open", { json: { token: next.token } });
  const wrong = await phone("/api/app/surface-page/decide", {
    json: { token: next.token, decision: "approve", pin: "000000" },
  });
  expect([wrong.status, await codeOf(wrong)]).toEqual([403, "surface.pin_wrong"]);
});

test("forgot the PIN: an email, from the browser that opened the page only", async () => {
  const { token } = await confirmPage();
  const phone = browser(t);
  expect((await phone("/api/app/surface-page/forgot-pin", { json: { token } })).status).toBe(404);
  await phone("/api/app/surface-page/open", { json: { token } });
  expect((await phone("/api/app/surface-page/forgot-pin", { json: { token } })).status).toBe(204);
  const gone = await browser(t)("/api/app/surface-pin-reset", { json: { token: "x".repeat(40) } });
  expect([gone.status, await codeOf(gone)]).toEqual([404, "surface.pin_reset_gone"]);
});
