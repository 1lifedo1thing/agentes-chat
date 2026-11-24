import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  claimLink,
  confirmLink,
  decideOnSurfacePage,
  emailPinReset,
  insertMessage,
  listSurfaceDeliveries,
  lodiFor,
  mintLinkCode,
  mintPageLink,
  openPersonAgentDm,
  openSurfacePage,
  PAGE_FIRST_OPEN_MS,
  PAGE_OPEN_MS,
  type PageKind,
  PIN_LOCK_MS,
  pruneSurfaceRows,
  queueSurfaceDelivery,
  removeLink,
  resetSurfacePin,
  setSurface,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const { surfaceDeliveries, surfaceLinks, surfacePageLinks, approvals, agentRuns, outbox, organizationMembers } = schema;

let f: Fixture;
beforeEach(async () => {
  f = await setup({ rightHand: true });
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: null,
  });
});
afterEach(async () => {
  setSurface(null);
  await f.close();
});

const T0 = new Date();
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const minutes = (n: number) => n * 60_000;

async function linked() {
  const { code } = await mintLinkCode(f.db, f.owner.id, f.org.id);
  const { link } = await claimLink(
    { db: f.db },
    { externalId: "sender-77", display: "+1 555 0100", profileName: null, code },
  );
  await confirmLink({ db: f.db }, f.owner.id, link.id);
  await f.db.delete(surfaceDeliveries);
  return link.id;
}

async function dm() {
  const lodi = await lodiFor(f.db, f.org.id);
  if (!lodi) throw new Error("no right hand");
  return { lodi, channel: await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id) };
}

/** What a surface turn's delete asks: the person alone decides it (`approvers`), as the gateway writes it. */
async function approval() {
  const { lodi, channel } = await dm();
  const [row] = await f.db
    .insert(approvals)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: channel.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `tu_${crypto.randomUUID()}`,
      tool: "vault_delete",
      scope: "",
      params: { key: "OLD_KEY" },
      actionHash: crypto.randomUUID(),
      title: "Delete the key OLD_KEY",
      detail: '{"key":"OLD_KEY"}',
      approvers: { userIds: [f.owner.id], label: f.owner.name, requestedBy: f.owner.id, requesterDecides: true },
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

async function page(kind: PageKind = "confirm", targetId?: string) {
  const linkId = await linked();
  const target = targetId ?? (kind === "confirm" ? (await approval()).id : crypto.randomUUID());
  const url = await mintPageLink(f.db, { orgId: f.org.id, linkId, userId: f.owner.id, kind, targetId: target });
  await f.db.update(surfacePageLinks).set({ createdAt: T0 });
  const token = new URL(url).searchParams.get("token") ?? "";
  return { url, token, linkId, targetId: target };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code,
  );

describe("lifetimes: opened once within 10 minutes, then its kind's time in that browser", () => {
  test.each([
    ["confirm", 60],
    ["screen", 30],
    ["control", 15],
  ] as const)("%s: open for %i minutes after its first open", async (kind, open) => {
    expect(PAGE_OPEN_MS[kind]).toBe(minutes(open));
    const { token } = await page(kind);
    const first = await openSurfacePage({ db: f.db, now: at(PAGE_FIRST_OPEN_MS - 1000) }, token, null);
    expect(first.secret).toBeString();
    const opened = PAGE_FIRST_OPEN_MS - 1000;
    expect(first.view.expiresAt).toBe(new Date(T0.getTime() + opened + minutes(open)).toISOString());
    const reopen = (ms: number) => openSurfacePage({ db: f.db, now: at(opened + ms) }, token, first.secret);
    expect((await reopen(minutes(open) - 1000)).secret).toBeNull();
    expect(await codeOf(reopen(minutes(open) + 1000))).toBe("surface.page_gone");
  });

  test("not opened within 10 minutes: gone", async () => {
    const { token } = await page();
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(PAGE_FIRST_OPEN_MS + 1000) }, token, null))).toBe(
      "surface.page_gone",
    );
  });

  test("another browser can't open it once it was opened", async () => {
    const { token } = await page();
    const first = await openSurfacePage({ db: f.db, now: at(0) }, token, null);
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, token, null))).toBe("surface.page_elsewhere");
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, token, "someone-else"))).toBe(
      "surface.page_elsewhere",
    );
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, token, first.secret))).toBe("ok");
  });

  test("ends early when the surface link ends, or the person leaves the workspace", async () => {
    const one = await page();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, one.token, null)).secret;
    await removeLink({ db: f.db }, f.owner.id, one.linkId);
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, one.token, secret))).toBe("surface.page_gone");

    const two = await page();
    const again = (await openSurfacePage({ db: f.db, now: at(0) }, two.token, null)).secret;
    await f.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, f.org.id), eq(organizationMembers.userId, f.owner.id)));
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, two.token, again))).toBe("surface.page_gone");
  });

  test("pruned a day later", async () => {
    await page();
    await f.db.update(surfacePageLinks).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) });
    await pruneSurfaceRows(f.db);
    expect(await f.db.select().from(surfacePageLinks)).toEqual([]);
  });
});

describe("the PIN", () => {
  const deps = (ms: number) => ({ db: f.db, pubsub: f.pubsub, now: at(ms) });

  test("the first approval chooses it; refusing needs none", async () => {
    const { token, linkId, targetId } = await page();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    expect((await openSurfacePage({ db: f.db, now: at(0) }, token, secret)).view.pin.set).toBe(false);
    expect(await codeOf(decideOnSurfacePage(deps(1000), token, secret, { decision: "approve", pin: "12345" }))).toBe(
      "surface.pin_shape",
    );
    const view = await decideOnSurfacePage(deps(1000), token, secret, { decision: "approve", pin: "482913" });
    expect(view.approval?.status).toBe("approved");
    expect(view.pin.set).toBe(true);
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(row?.pinHash).not.toContain("482913");
    expect((await f.db.select().from(approvals).where(eq(approvals.id, targetId)))[0]?.decidedByUserId).toBe(
      f.owner.id,
    );

    const other = await approval();
    const next = await mintPageLink(f.db, {
      orgId: f.org.id,
      linkId,
      userId: f.owner.id,
      kind: "confirm",
      targetId: other.id,
    });
    const nextToken = new URL(next).searchParams.get("token") ?? "";
    const nextSecret = (await openSurfacePage({ db: f.db }, nextToken, null)).secret;
    const refused = await decideOnSurfacePage({ db: f.db, pubsub: f.pubsub }, nextToken, nextSecret, {
      decision: "refuse",
    });
    expect(refused.approval?.status).toBe("refused");
  });

  test("only the browser that opened the page decides, and not before it opened", async () => {
    const { token } = await page();
    expect(await codeOf(decideOnSurfacePage(deps(0), token, null, { decision: "refuse" }))).toBe("surface.page_gone");
    await openSurfacePage({ db: f.db, now: at(0) }, token, null);
    expect(await codeOf(decideOnSurfacePage(deps(1000), token, "guess", { decision: "refuse" }))).toBe(
      "surface.page_elsewhere",
    );
  });

  test("three wrong ones lock approving for 15 minutes", async () => {
    const { token, linkId } = await page();
    await f.db
      .update(surfaceLinks)
      .set({ pinHash: await Bun.password.hash("111111") })
      .where(eq(surfaceLinks.id, linkId));
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    const approve = (ms: number, pin: string) =>
      decideOnSurfacePage(deps(ms), token, secret, { decision: "approve", pin }).then(
        (v) => v.approval?.status,
        (e: { code: string; params?: Record<string, unknown> }) => [e.code, e.params],
      );
    expect(await approve(1000, "222222")).toEqual(["surface.pin_wrong", { left: 2 }]);
    expect(await approve(2000, "222222")).toEqual(["surface.pin_wrong", { left: 1 }]);
    const until = new Date(T0.getTime() + 3000 + PIN_LOCK_MS).toISOString();
    expect(await approve(3000, "222222")).toEqual(["surface.pin_locked", { until }]);
    expect(await approve(4000, "111111")).toEqual(["surface.pin_locked", { until }]);
    expect(await approve(3000 + PIN_LOCK_MS + 1000, "111111")).toBe("approved");
  });

  test("forgot it: an emailed link clears it once", async () => {
    const { token, linkId } = await page();
    await f.db.update(surfaceLinks).set({ pinHash: "x", pinFailures: 2 }).where(eq(surfaceLinks.id, linkId));
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    await emailPinReset({ db: f.db, now: at(1000), publicUrl: "https://app.example.com" }, token, secret);
    const [job] = await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"));
    const payload = job?.payload as { template?: { url?: string } } | undefined;
    const url = String(payload?.template?.url);
    expect(url).toStartWith("https://app.example.com/email-undo?kind=surface-pin&token=");
    const reset = new URL(url).searchParams.get("token") ?? "";
    expect(await resetSurfacePin(f.db, reset)).toEqual({ surface: "Example Chat" });
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect([row?.pinHash, row?.pinFailures]).toEqual([null, 0]);
    expect(await codeOf(resetSurfacePin(f.db, reset))).toBe("surface.pin_reset_gone");
  });
});

test("the same sender linked again keeps the PIN; another sender of the account starts without one", async () => {
  const first = await linked();
  await f.db.update(surfaceLinks).set({ pinHash: "kept" }).where(eq(surfaceLinks.id, first));
  await linked();
  expect((await f.db.select().from(surfaceLinks))[0]?.pinHash).toBe("kept");
  const { code } = await mintLinkCode(f.db, f.owner.id, f.org.id);
  const { link } = await claimLink(
    { db: f.db },
    { externalId: "sender-88", display: "+1 555 0101", profileName: null, code },
  );
  await confirmLink({ db: f.db }, f.owner.id, link.id);
  expect((await f.db.select().from(surfaceLinks))[0]?.pinHash).toBeNull();
});

test("an approval's card in a surface reply opens its own page, not the app", async () => {
  await linked();
  const { lodi, channel } = await dm();
  const ask = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "person", userId: f.owner.id },
    body: "apaga a chave antiga",
    meta: {
      via: { kind: "surface", surface: "example chat", linkId: (await f.db.select().from(surfaceLinks))[0]?.id },
    },
  });
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: channel.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "dm",
      hop: 1,
      status: "waiting_approval",
    })
    .returning();
  const asked = await approval();
  const card = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "agent", agentId: lodi.id, runId: run?.id ?? "", hop: 1 },
    body: "Approval request: Delete the key OLD_KEY",
    meta: { approvalId: asked.id },
  });
  expect(await queueSurfaceDelivery(f.db, f.org.id, card.id)).toBe(true);
  const [listed] = await listSurfaceDeliveries({ db: f.db }, 10);
  expect(listed?.card?.kind).toBe("approval");
  expect(listed?.card?.url).toMatch(/\/surface-page\?token=[\w-]{40,}$/);
  const [minted] = await f.db.select().from(surfacePageLinks);
  expect([minted?.kind, minted?.targetId]).toEqual(["confirm", asked.id]);
});
