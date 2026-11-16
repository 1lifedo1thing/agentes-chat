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

describe("a channel's members", () => {
  const members = () => src("features/chat/ChannelMembers.tsx");
  const screen = (name: string) => {
    const file = members();
    const at = file.indexOf(`export function ${name}(`);
    const next = file.indexOf("\nexport function ", at + 1);
    return file.slice(at, next < 0 ? undefined : next);
  };

  test("the list is a pushed list under the large title, read again on a pull, the search first under the title", () => {
    const list = screen("ChannelMembersScreen");
    expect(list).toMatch(/<PushedLargeTitle\s+title=\{t\("shell\.members"\)\}\s+grouped\s+keyboard\s+refreshControl=/);
    expect(list).toContain("const pull = usePullRefresh(roster.refetch);");
    expect(list.indexOf("<SearchField")).toBeLessThan(list.indexOf('t("channelMembers.caption")'));
    expect(list).toContain("<Locked when={removal.pending}");
  });

  test("one agent's screen doesn't say its name again under the bar that says it", () => {
    const agent = screen("ChannelAgentScreen");
    expect(agent).toContain("<SettingsPage title={name}");
    expect(agent).not.toContain("label={name}");
    expect(agent).toContain('label={t("profile.viewProfile")}');
  });

  test("adding people says when who is in already didn't load, instead of offering everyone again", () => {
    const add = screen("AddChannelMembersScreen");
    expect(add).toMatch(/roster\.isError \? \([\s\S]{0,140}<LoadFailed onRetry=\{\(\) => void roster\.refetch\(\)\} \/>/);
  });
});

describe("the conversation's sheets read as one family", () => {
  test("Retornos and a message's agents are the sheets' grouped rows, as Fixadas", () => {
    const returns = src("features/chat/Returns.tsx");
    const sheet = returns.slice(returns.indexOf("export function ReturnsSheet("));
    expect(sheet).not.toMatch(/<Card>|<Row\b/);
    expect(sheet).toContain("<GroupedList>");
    // Canceling is the row's own ×, a spinner in its place while it goes.
    expect(sheet).toMatch(/r\.canCancel && !leaving\s*\?\s*\{\s*remove: \{/);
    const receipts = src("features/chat/AgentReceipts.tsx");
    const agents = receipts.slice(receipts.indexOf("function ReceiptsSheet("));
    expect(agents).not.toMatch(/<Card>|<Row\b|<SectionHeader/);
    expect(agents.match(/<GroupedList>/g)).toHaveLength(2);
  });

  test("a chart or code opened whole with nothing left to show says so as an empty state, with the sheet's bar", () => {
    for (const [file, key] of [
      ["features/chat/ChartCard.tsx", "mobile.chart.gone"],
      ["features/chat/CodeCard.tsx", "mobile.code.gone"],
    ] as const) {
      const card = src(file);
      expect(card).toMatch(
        new RegExp(
          `<SheetBar onClose=\\{\\(\\) => router\\.back\\(\\)\\} />\\s*<View style=\\{styles\\.gone\\}>\\s*<EmptyState size="panel" icon="\\w+" title=\\{t\\("${key.replace(/\./g, "\\.")}"\\)\\} />`,
        ),
      );
    }
  });
});

describe("the kit's presses and rulers", () => {
  test("a voice message's speed chip presses as the play button beside it does", () => {
    const player = src("features/voice/VoiceMessage.tsx");
    expect(player).toMatch(/<PressScale\s+to=\{0\.92\}\s+onPress=\{cycle\}/);
    expect(player).not.toMatch(/<Pressable\s+onPress=\{cycle\}/);
  });

  test("the GIF categories run to the sheet's edges by the sheet's own side, not a number of their own", () => {
    const media = src("features/chat/MediaPickerSheet.tsx");
    expect(media).toContain("chips: { marginHorizontal: -SHEET_X }");
  });
});
