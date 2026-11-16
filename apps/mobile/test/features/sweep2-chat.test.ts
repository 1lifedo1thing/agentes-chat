import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("no screen or sheet of the conversation opens with the keyboard up", () => {
  test("a new mission's goal waits for the person's tap", () => {
    const screen = src("features/chat/NewMissionScreen.tsx");
    expect(screen).not.toContain("autoFocus");
    expect(screen).not.toMatch(/\.focus\(\)/);
  });

  test("the conversation's search opens on its recent searches and filters, the field waiting for a tap", () => {
    const search = src("features/search/ConversationSearch.tsx");
    expect(search).not.toContain("autoFocus");
    // Picking an operator still puts the caret back in the field: that is an answer to a tap in the sheet.
    expect(search).toContain("field.current?.focus();");
  });
});
