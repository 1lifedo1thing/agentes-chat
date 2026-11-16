import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The agents, team, cargos, AI, right hand and usage screens against the phone's checklist: no keyboard that opens by
 * itself, fields the keyboard never hides or traps, real navigation, one bar per screen. Read as text: the tests can't
 * render React Native.
 */
const src = (path: string) => readFileSync(new URL(`../../src/features/${path}`, import.meta.url), "utf8");

describe("the keyboard waits for a tap", () => {
  test("a new setor's and a cargo's name fields don't take the focus as their screens open", () => {
    expect(src("team/NewSectorScreen.tsx")).not.toContain("autoFocus");
    expect(src("roles/LookScreen.tsx")).not.toContain("autoFocus");
  });

  test("Edit agent walks its fields: Next from the name, the @ and the role; the bar over the keyboard closes it", () => {
    const edit = src("agents/AgentEditScreen.tsx");
    expect(edit).toMatch(/<SettingsPage[\s\S]*?\btoolbar\b[\s\S]*?>/);
    expect(edit).toMatch(/autoCorrect=\{false\}\s+\{\.\.\.NEXT_FIELD\}/);
    expect(edit).toContain("next={!rightHand}");
    expect(edit).toMatch(/<RoleInput[\s\S]*?\bnext\b[\s\S]*?\/>/);
    expect(src("agents/HandleInput.tsx")).toContain('{...(next ? NEXT_FIELD : { returnKeyType: "done" as const })}');
    expect(src("agents/RoleInput.tsx")).toContain("{...(next ? NEXT_FIELD : {})}");
  });

  test("the right hand's budget is every agent's budget field, and its number pad closes from the bar over it", () => {
    const screen = src("right-hand/SettingsScreen.tsx");
    expect(screen).toContain('<SettingsPage title={agent.name} subtitle={t("rightHand.label")} toolbar>');
    expect(screen).toContain("<BudgetField");
    expect(screen).toContain("const { amount, invalid } = readBudget(budget);");
    expect(screen).not.toContain("<TextInput");
    // Its guidance is a row of a group, as every long field of the settings pages.
    const approvals = src("right-hand/Approvals.tsx");
    expect(approvals).toMatch(/<GroupedList>\s+<TextArea[\s\S]*?style=\{styles\.bare\}\s+\/>\s+<\/GroupedList>/);
  });

  test("Uso's budget field goes away with a drag down the page", () => {
    expect(src("usage/UsageScreen.tsx")).toContain('keyboardDismissMode="interactive"');
  });
});
