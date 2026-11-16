import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type SurfaceLink, type SurfaceLinks } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { surfaceRowOf } from "@agenteschat/client/lib/surface-links";
import {
  assistantName,
  CODE_TTL_MS,
  codeDeadline,
  codeIsStale,
  codeLeftText,
  linkStep,
  RENEW_BEFORE_MS,
  senderName,
  surfaceRowText,
  surfaceTagText,
} from "../../src/features/me/surface";
import { translator } from "./fixtures";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const SURFACE = "Example Chat";
const LONG_DISPLAY = "+1 555 0100 0101 0102 0103 0104 0105 0106 0107 0108 0109 0110 0111";
const LONG_PROFILE = "Ana 🌿 من فريق المبيعات Theo example.com 🚀 a very long profile name";
const LONG_SURFACE = "Example Chat for Teams and Families Everywhere Around the World Plus";

const link = (over: Partial<SurfaceLink> = {}): SurfaceLink => ({
  id: "l1",
  status: "pending",
  display: "+1 555 0100",
  profileName: "Ana",
  orgId: "o1",
  orgName: "Acme",
  createdAt: new Date(NOW - 60_000).toISOString(),
  confirmedAt: null,
  expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
  ...over,
});
const links = (list: SurfaceLink[], over: Partial<SurfaceLinks> = {}): SurfaceLinks => ({
  surface: { name: SURFACE },
  allowed: true,
  links: list,
  ...over,
});

describe("the row in Notificações", () => {
  test("hidden unless this account may link", () => {
    expect(surfaceRowOf(links([], { allowed: false }), NOW).kind).toBe("hidden");
    expect(surfaceRowOf(links([], { surface: null, allowed: false }), NOW).kind).toBe("hidden");
    expect(surfaceRowOf(undefined, NOW).kind).toBe("hidden");
  });

  test("none offers Link with the assistant's line, pending waits, active shows the sender with On", async () => {
    const t = await translator("en");
    const none = surfaceRowOf(links([]), NOW);
    if (none.kind === "hidden") throw new Error("hidden");
    expect(surfaceRowText(t, none, "Lodi")).toEqual({ sub: "Lodi can message you there", value: "Link" });
    expect(surfaceRowText(t, none, null)).toEqual({ value: "Link" });

    const pending = surfaceRowOf(links([link()]), NOW);
    if (pending.kind === "hidden") throw new Error("hidden");
    expect(pending.kind).toBe("pending");
    expect(surfaceRowText(t, pending, "Lodi")).toEqual({ sub: "Waiting for you to confirm" });

    const active = surfaceRowOf(links([link({ status: "active", expiresAt: null })]), NOW);
    if (active.kind === "hidden") throw new Error("hidden");
    expect(surfaceRowText(t, active, "Lodi")).toEqual({ sub: "+1 555 0100", below: "Ana", value: "On" });
  });

  test("worst case: the whole display and profile name, never cut, and only one line when the other is missing", async () => {
    const t = await translator("en");
    const row = surfaceRowOf(
      links([link({ status: "active", display: LONG_DISPLAY, profileName: LONG_PROFILE, expiresAt: null })], {
        surface: { name: LONG_SURFACE },
      }),
      NOW,
    );
    if (row.kind !== "active") throw new Error(row.kind);
    expect(row.surface).toBe(LONG_SURFACE);
    expect(surfaceRowText(t, row, "Lodi")).toEqual({ sub: LONG_DISPLAY, below: LONG_PROFILE, value: "On" });
    expect(surfaceRowText(t, { ...row, link: { ...row.link, display: null } }, "Lodi")).toEqual({
      sub: LONG_PROFILE,
      value: "On",
    });
  });

  test("the row wraps every line and unlinks through the system's confirm", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("labelLines={0}");
    expect(src).toContain("subLines: 0");
    expect(src).toContain("confirmAction({");
    const page = readFileSync(join(import.meta.dir, "../../src/features/me/PreferencePages.tsx"), "utf8");
    expect(page).toContain("<SurfaceLinkRow />");
  });

  test("unlink's words name the sender", async () => {
    const t = await translator("en");
    expect(t("mobile.surface.unlinkTitle", { surface: SURFACE })).toBe("Unlink Example Chat?");
    expect(t("mobile.surface.unlinkText", { sender: senderName(link(), SURFACE) })).toBe(
      "Messages from +1 555 0100 stop reaching your workspaces.",
    );
    expect(senderName(link({ display: null }), SURFACE)).toBe("Ana");
    expect(senderName(link({ display: null, profileName: null }), SURFACE)).toBe(SURFACE);
  });
});

describe("the sheet", () => {
  test("code, then confirm once a pending link arrives, then linked", () => {
    expect(linkStep(surfaceRowOf(links([]), NOW), false)).toBe("code");
    expect(linkStep(surfaceRowOf(links([link()]), NOW), false)).toBe("confirm");
    expect(linkStep(surfaceRowOf(links([link({ status: "active" })]), NOW), true)).toBe("linked");
    // A pending link past its 10 minutes goes back to a fresh code.
    const old = link({ expiresAt: new Date(NOW - 1).toISOString() });
    expect(linkStep(surfaceRowOf(links([old]), NOW), false)).toBe("code");
  });

  test("a fresh code before the shown one runs out, whatever the phone's clock says", () => {
    const code = { expiresAt: new Date(NOW + 9 * 60_000).toISOString() };
    expect(codeDeadline(code, NOW)).toBe(NOW + 9 * 60_000);
    // A phone 15 minutes fast reads the code as long gone: it counts the server's 10 minutes from the answer.
    expect(codeDeadline(code, NOW + 15 * 60_000)).toBe(NOW + 15 * 60_000 + CODE_TTL_MS);
    expect(codeIsStale(null, NOW)).toBe(true);
    expect(codeIsStale(NOW + RENEW_BEFORE_MS + 1, NOW)).toBe(false);
    expect(codeIsStale(NOW + RENEW_BEFORE_MS, NOW)).toBe(true);
  });

  test("the countdown under the code", async () => {
    const t = await translator("en");
    expect(codeLeftText(t, NOW + 9 * 60_000 + 41_000, NOW)).toBe("Valid for 9:41");
    expect(codeLeftText(t, NOW - 5000, NOW)).toBe("Valid for 0:00");
  });

  test("the code step opens the surface, shows the code and waits: live event, every 3 seconds, back in front", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("Linking.openURL(code.made.openUrl)");
    expect(src).toContain("setInterval(() => void refetch(), LINK_POLL_MS)");
    expect(src).toContain("useAppActive()");
    expect(src).toContain("{code.made.code}");
    expect(src).toMatch(/label=\{t\("mobile\.surface\.open", \{ surface \}\)\}/);
    expect(src).not.toMatch(/QrCode/);
  });

  test("the consent line sits directly above Confirm, in the recorded words", async () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    const consent = src.indexOf('t("surface.link.consent"');
    const confirm = src.indexOf('label={t("mobile.surface.confirm")}');
    expect(consent).toBeGreaterThan(0);
    expect(confirm).toBeGreaterThan(consent);
    expect(src.slice(consent, confirm)).not.toMatch(/<Text/);
    const en = await translator("en");
    expect(en("surface.link.consent", { assistant: "Lodi", surface: SURFACE })).toBe(
      "Lodi by agentes.chat may message you on Example Chat about your workspaces, and call you only when something is urgent and you allow it. Write stop to turn this off.",
    );
    const pt = await translator("pt-BR");
    expect(pt("surface.link.consent", { assistant: "Lodi", surface: SURFACE })).toContain("Escreva parar");
  });

  test("the assistant is the workspace's right hand", () => {
    expect(
      assistantName([
        { builtin: null, name: "Theo" },
        { builtin: "right_hand", name: "Lodi" },
      ]),
    ).toBe("Lodi");
    expect(assistantName(undefined)).toBeNull();
  });

  test("failures say the cause and a way out", async () => {
    const t = await translator("en");
    for (const code of ["surface.link_gone", "surface.taken", "surface.no_assistant", "surface.not_allowed"]) {
      const line = errorText(t, new ApiError(409, code, code));
      expect(line).not.toBe(t("mobile.app.failed"));
      expect(line.toLowerCase()).not.toContain("support");
    }
    expect(t("mobile.surface.openFailed", { surface: SURFACE })).toBe(
      "Couldn't open Example Chat on this phone. Send it the code below instead.",
    );
  });
});

describe("the mark on messages", () => {
  test("via the surface, and forwarded there, by the server's name for it", async () => {
    const t = await translator("en");
    const data = links([]);
    const via = { via: { kind: "surface", surface: "example chat", linkId: "l1" } };
    expect(surfaceTagText(t, via, "Ana", data)).toEqual({
      label: "via Example Chat",
      hint: "Sent by Ana on Example Chat",
    });
    expect(surfaceTagText(t, { via: { ...via.via, forwarded: true } }, "Ana", data)?.label).toBe(
      "forwarded via Example Chat",
    );
    // Before the links answer is read, the id stands in for the name.
    expect(surfaceTagText(t, via, "Ana", undefined)?.label).toBe("via example chat");
    expect(surfaceTagText(t, { via: { kind: "app", name: "Claude" } }, "Ana", data)).toBeNull();
    expect(surfaceTagText(t, null, "Ana", data)).toBeNull();
  });

  test("only a person's message carries it, with a generic chat icon", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/chat/MessageRow.tsx"), "utf8");
    expect(src).toMatch(/m\.author\.type === "person"\s*\?\s*surfaceTagText/);
    expect(src).toContain('<Tag icon="chat" label={surfaceTag.label} hint={surfaceTag.hint} />');
  });
});
