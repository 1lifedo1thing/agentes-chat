import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownOptionsOf } from "../main-stack";

/** The second sweep of the settings, Você, people, devices and connectors screens: keyboard, scroll, bars, navigation. */
const src = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");

describe("the settings and Você page frames", () => {
  test("a form page lets a drag take the keyboard away, and its docked action rides over the keyboard", () => {
    const page = src("features/settings/parts.tsx");
    expect(page).toContain('keyboardDismissMode="interactive"');
    // The docked action sits over the keyboard (over the system's ‹ › bar too) and a focused field stays clear of it.
    expect(page).toContain("<KeyboardStickyView");
    expect(page).toContain("offset={{ opened: insets.bottom - toolbarRoom }}");
    expect(page).toContain("const bar = toolbarRoom + docked;");
    expect(page).toContain("bottomOffset={bar + FIELD_CLEARANCE}");
    // The home indicator's room is the docked bar's, never added twice under the content.
    expect(page).toContain("paddingBottom: bottom ? 24 : 24 + insets.bottom");
    expect(src("features/me/parts.tsx")).toContain('keyboardDismissMode="interactive"');
  });

  test("a list read from the server is read again on a pull, on both frames", () => {
    const page = src("features/settings/parts.tsx");
    expect(page).toContain("onRefresh?: () => Promise<unknown>;");
    expect(page).toContain("<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />");
    // A large-title list with a search makes room for the keyboard.
    expect(page).toContain("keyboard={keyboard}");
    const me = src("features/me/parts.tsx");
    expect(me).toContain("usePullRefresh(onRefresh ?? NOTHING_TO_READ)");
  });
});

describe("no field takes the keyboard as its screen opens", () => {
  test("renaming a computer, a new category, suggesting someone, an invitation's note, a server's address", () => {
    for (const file of [
      "features/settings/MachineScreen.tsx",
      "features/categories/CategoryScreens.tsx",
      "features/members/SuggestPerson.tsx",
      "features/members/InvitePickers.tsx",
      "features/server/ServerAddress.tsx",
      "features/me/WorkspacesPages.tsx",
    ])
      expect({ file, autoFocus: src(file).includes("autoFocus") }).toEqual({ file, autoFocus: false });
  });
});

describe("Workspaces' ways in", () => {
  test("the team's server, while signed in, is a pushed screen with the system's back over its sky", () => {
    expect(ownOptionsOf("me/team-server")).toBe("cover,");
    const pages = src("features/me/WorkspacesPages.tsx");
    const server = pages.slice(pages.indexOf("export function TeamServerPage"));
    expect(server).toContain("<PushedHeader plate />");
    expect(server).not.toContain("onBack=");
  });

  test("Add workspace's sheet closes with ×, never a back arrow that only closes it", () => {
    const pages = src("features/me/WorkspacesPages.tsx");
    expect(pages).toContain('<SheetHeader title={t("mobile.me.addWorkspace")} />');
    expect(pages).not.toContain('icon="back"');
  });
});

describe("requests to join", () => {
  const route = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "app", "(app)", path), "utf8");

  test("a pushed screen with the system's bar, so each card's choices push over it", () => {
    // Out of the sheets: a choice pushed from a sheet would land under it, or close it with the card's draft.
    expect(route("_layout.tsx")).not.toContain('name="join-requests"');
    expect(route("(main)/join-requests.tsx")).toContain("<JoinRequestsScreen focus={request} />");
    expect(ownOptionsOf("join-requests")).toBeNull();
    const screen = src("features/members/JoinRequestsScreen.tsx");
    expect(screen).toContain("<SettingsPage");
    expect(screen).not.toContain("SheetScreen");
    expect(screen).toContain("onRefresh={() => Promise.allSettled([list.refetch(), roles.refetch()])}");
    // An empty list needs no Close of its own: the system's back is there.
    expect(screen).not.toContain("onClose");
  });

  test("denying's reason opens on the tap that asks for it, and its way out is Cancel, never a drawn Back", () => {
    const screen = src("features/members/JoinRequestsScreen.tsx");
    expect(screen).not.toContain('t("mobile.common.back")');
    expect(screen).toContain('label={t("mobile.common.cancel")}');
  });
});
