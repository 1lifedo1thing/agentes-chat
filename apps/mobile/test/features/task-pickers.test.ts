import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audienceReady, closeTaskPick, openTaskPick, sameActor, taskPickNow } from "../../src/features/issues/pick";
import { pushedByDefault } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("a task's fields picked on their own screen", () => {
  test("the pick holds what is picked and how it goes back, until its screen closes", () => {
    const picked: (string | null)[] = [];
    openTaskPick({ what: "project", value: null, apply: (id) => picked.push(id) });
    const now = taskPickNow();
    expect(now?.what).toBe("project");
    if (now?.what === "project") now.apply("p1");
    expect(picked).toEqual(["p1"]);
    // Closing the one a screen showed ends it; a pick started meanwhile for the next screen stays.
    const next = { what: "projectFilter" as const, value: "", apply: () => {} };
    openTaskPick(next);
    closeTaskPick(now);
    expect(taskPickNow()).toBe(next);
    closeTaskPick(next);
    expect(taskPickNow()).toBeNull();
  });

  test("the same assignee, nobody included; a list of people that names nobody can't be saved", () => {
    expect(sameActor(null, null)).toBe(true);
    expect(sameActor({ type: "agent", id: "a" }, { type: "agent", id: "a" })).toBe(true);
    expect(sameActor({ type: "agent", id: "a" }, { type: "person", id: "a" })).toBe(false);
    expect(sameActor({ type: "agent", id: "a" }, null)).toBe(false);
    expect(audienceReady({ mode: "everyone" })).toBe(true);
    expect(audienceReady({ mode: "people", userIds: ["me"] })).toBe(true);
    expect(audienceReady({ mode: "people", userIds: [] })).toBe(false);
  });

  test("its screen is pushed with the stack's bar, and goes back with nothing to pick for", () => {
    expect(pushedByDefault("issues/pick")).toBe(true);
    const screen = src("issues/TaskPickScreen.tsx");
    expect(screen).toContain('if (!pick) goBack("/issues");');
    // It takes its pick as it opens, and ends that one only.
    expect(screen).toContain("const [pick] = useState(taskPickNow);");
    expect(screen).toContain("return () => closeTaskPick(pick);");
    // A single choice goes back on its tap, its check on the one in use.
    expect(screen).toContain("checked={sameActor(who, pick.value)}");
    expect(screen).toContain("checked={c.id === pick.value}");
  });

  test("Nova tarefa opens nothing inside the form: many choices push the picker, a short list is the app's menu", () => {
    const form = src("issues/NewIssueForm.tsx");
    for (const gone of ["setOpen(", 'open === "', "<Filters", "<WhoSeesRows"])
      expect([gone, form.includes(gone)]).toEqual([gone, false]);
    for (const what of ["who", "project", "sees"]) expect(form).toContain(`pickOn({ what: "${what}"`);
    expect(form.match(/chooseAction\(/g)).toHaveLength(2);
    // The rows say how they open: a chevron for a screen, the menu's mark for the app's menu.
    expect(form.match(/\bmenu\b\n/g)).toHaveLength(2);
  });

  test("a task's head and its bar's \"…\" push the same pickers; its priority and due date are the app's menu", () => {
    const screen = src("issues/IssueScreen.tsx");
    const pickers = screen.slice(screen.indexOf("function useIssuePickers("), screen.indexOf("function useIssueMenu("));
    for (const what of ["column", "who", "project"]) expect(pickers).toContain(`what: "${what}"`);
    expect(pickers).toContain('router.push("/issues/pick");');
    expect(pickers.match(/choose\(\n?\s*t\("/g)?.length).toBe(3);
    expect(pickers).not.toContain("sheet.");
    // The bar: Concluir and "…" as the system's bar buttons, "…" the system's menu on iOS and the app's on Android.
    const bar = screen.slice(screen.indexOf("function IssueBar("), screen.indexOf("function useFinish("));
    expect(bar).toContain('sf: finish.open ? "checkmark.circle" : "arrow.uturn.backward.circle",');
    expect(bar).toContain("menu: items,");
    expect(bar).toContain("chooseAction(");
    for (const gone of ["FinishWord", "IconButton", "ActivityIndicator", "<ActionList"])
      expect([gone, screen.includes(gone)]).toEqual([gone, false]);
  });
});
