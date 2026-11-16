import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("the keyboard comes up only for a tap", () => {
  test.each([
    "features/wiki/WikiWrite.tsx",
    "features/new/NewChannelForm.tsx",
    "features/new/NewScreen.tsx",
    "features/new/NewChatPicker.tsx",
    "features/new/ChatTargets.tsx",
  ])("%s focuses no field as it opens", (file) => {
    const code = src(file);
    expect(code).not.toContain("autoFocus");
    expect(code).not.toMatch(/\.focus\(\);?\s*\}, \[\]\)/);
  });

  test("a person or an agent picked in New opens the conversation with its keyboard down", () => {
    const create = src("features/new/NewScreen.tsx");
    expect(create).not.toContain("compose: true");
    expect(create).toContain("openDm({ agentId }, { replace: true })");
    expect(create).toContain("openDm({ userId: p.userId }, { replace: true })");
  });

  test("the wiki editor's tools ride on the keys, never a bar's height behind them", () => {
    const write = src("features/wiki/WikiWrite.tsx");
    // Measured where it is on the screen (under the bar), not from its parent's top.
    expect(write).toContain('<KeyboardAvoidingView behavior="padding" automaticOffset style={styles.fill}>');
    // The home indicator's room goes as the keyboard comes.
    expect(write).toContain("height: insets.bottom * (1 - keyboard.progress.get())");
    expect(write).not.toContain("<View style={{ height: insets.bottom }} />");
  });

  test("a sheet's content puts the keyboard away on a drag", () => {
    expect(src("ui/SheetScreen.tsx")).toContain('keyboardDismissMode="on-drag"');
  });
});

describe("New and Chat with…", () => {
  test("New's groups swap at once as the person types: no layout or fade per keystroke", () => {
    const create = src("features/new/NewScreen.tsx");
    expect(create).not.toContain("LinearTransition");
    expect(create).not.toContain("layout={layout}");
    expect(create).not.toContain("FadeOut");
  });

  test("Chat with… lists agents and people in New's own grouped rows", () => {
    const targets = src("features/new/ChatTargets.tsx");
    expect(targets).toContain("<GroupedRow");
    expect(targets).toContain("size={GROUPED_ROW.lead}");
    expect(targets).not.toContain("ActionList");
  });

  test("a search that found nobody offers to clear it", () => {
    for (const file of ["features/new/NewScreen.tsx", "features/new/ChatTargets.tsx"]) {
      expect({ file, clear: src(file).includes('label={t("filters.clearSearch")}') }).toEqual({ file, clear: true });
    }
    expect(src("features/new/NewChatPicker.tsx")).toContain('onClear={() => setQ("")}');
  });

  test("a channel that couldn't be made says why", () => {
    const form = src("features/new/NewChannelForm.tsx");
    expect(form).toContain(".catch(failed)");
    expect(form).not.toContain('t("mobile.app.failed")');
  });
});
