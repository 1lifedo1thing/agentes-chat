import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(`../../src/features/${path}`, import.meta.url).pathname).text();
/** A `StyleSheet.create` entry's declarations, as written. */
const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^}]*)\\}`))?.[1] ?? "";

describe("the live picture's edge on the phone", () => {
  test("the closed card's thumbnail, the open card's page, its view of the whole screen and the help peek share one hairline", async () => {
    const [card, handoff] = await Promise.all([read("browser/BrowserCard.tsx"), read("browser/HandoffCard.tsx")]);
    const HAIRLINE = "borderWidth: StyleSheet.hairlineWidth";
    expect(style(card, "thumb")).toContain(HAIRLINE);
    expect(card).toContain("{ backgroundColor: c.sunken, borderColor: c.line }");
    // On the box that rounds and clips the picture, at that box's radius.
    expect(style(card, "page")).toContain(HAIRLINE);
    expect(style(card, "page")).toContain("borderRadius: CARD - PAGE_INSET");
    expect(card).toMatch(/styles\.page,\s*\{ borderColor: c\.line \},/);
    // The whole screen's box is ScreenWatch's, rounded by the card.
    expect(style(card, "screen")).toContain("borderRadius: CARD - PAGE_INSET");
    expect(card).toContain("style={[styles.screen,");
    expect(style(handoff, "peek")).toContain(HAIRLINE);
    expect(style(handoff, "peek")).toContain("borderRadius: 12");
    expect(handoff).toContain("<View style={[styles.peek, { backgroundColor: c.sunken, borderColor: c.line }]}>");
  });

  test("the whole screen's box carries the same hairline, and the screen fits inside it", async () => {
    const watch = await read("computer/ScreenWatch.tsx");
    expect(watch).toContain("const EDGE = StyleSheet.hairlineWidth;");
    expect(style(watch, "box")).toContain("borderWidth: EDGE");
    // Over the thumbnail's backdrop, so the translucent line reads the same; the dark fill is the screen's alone.
    expect(watch).toMatch(/styles\.box,\s*\{ backgroundColor: c\.sunken, borderColor: c\.line \},/);
    expect(style(watch, "box")).not.toContain("backgroundColor");
    expect(style(watch, "frame")).toContain('backgroundColor: "#101010"');
    // The line is inside the box's layout: the room the screen scales to is what it leaves.
    expect(watch).toContain("const width = Math.max(1, e.nativeEvent.layout.width - 2 * EDGE);");
    expect(watch).toContain("const height = Math.max(1, e.nativeEvent.layout.height - 2 * EDGE);");
  });
});
