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

describe("an empty conversation scrolls clear of the bar and the keyboard", () => {
  test("an agent's first day and a channel's hello leave the clear bar's room at their top", () => {
    for (const file of ["features/chat/FirstDay.tsx", "features/chat/ChannelHello.tsx"]) {
      const greeting = src(file);
      expect(greeting).toContain("paddingTop: topInset + 8, paddingBottom: bottomInset + 16");
      expect(greeting).toContain("scrollIndicatorInsets={{ top: topInset, bottom: bottomInset }}");
    }
    const chat = src("features/chat/ChatScreen.tsx");
    expect(chat.match(/topInset=\{headerHeight\}/g)).toHaveLength(2);
  });

  test("a DM's intro answers taps with the keyboard up, lets it go on a drag and reaches its last rows above it", () => {
    const chat = src("features/chat/ChatScreen.tsx");
    expect(chat).toMatch(
      /const introScroll = \{[\s\S]*keyboardShouldPersistTaps: "handled"[\s\S]*keyboardDismissMode: "interactive"[\s\S]*automaticallyAdjustKeyboardInsets: true/,
    );
    expect(chat.match(/<ScrollView \{\.\.\.introScroll\}>/g)).toHaveLength(2);
  });
});
