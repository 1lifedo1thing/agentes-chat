import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const css = topLevel(
  await builtCss(
    "src/components/browser/browser.css",
    "src/components/desktop/desktop.css",
    "src/components/computer/computer.css",
  ),
);
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];
const px = (v: string | undefined) => Number.parseFloat(v ?? "NaN");

test("the live picture in the card is concentric with it: the card's radius less the stage's padding", () => {
  const inner = px(value(".brw-ac", "border-radius")) - px(value(".brw-ac__stage", "padding"));
  expect(px(value(".brw-ac__page", "border-radius"))).toBe(inner);
  expect(px(value(".dsk-screen", "border-radius"))).toBe(inner);
  // The computer window's page and screen stand on its stage with no card round them: their own radius stays.
  expect(px(value(".cmp-body .brw-ac__page", "border-radius"))).toBe(10);
  expect(px(value(".cmp-body .dsk-screen", "border-radius"))).toBe(10);
});

test("a hairline over the live picture's edge follows its rounded corners, over what the picture draws", () => {
  for (const selector of [
    ".brw-ac__page::after",
    ".dsk-screen::after",
    // In the conversation's frame the picture runs to the frame's inner corners: the stage carries them.
    ".brw-mf > .brw-mf__top + .brw-ac__body > .brw-ac__stage::after",
  ]) {
    expect({ selector, content: value(selector, "content") }).toEqual({ selector, content: '""' });
    expect({ selector, radius: value(selector, "border-radius") }).toEqual({ selector, radius: "inherit" });
    expect({ selector, line: value(selector, "box-shadow") }).toEqual({
      selector,
      line: "inset 0 0 0 1px var(--line)",
    });
    expect({ selector, events: value(selector, "pointer-events") }).toEqual({ selector, events: "none" });
    // Over a held still (z-index 1), under the agent's pointer (2).
    expect({ selector, z: value(selector, "z-index") }).toEqual({ selector, z: "1" });
  }
  expect(value(".brw-mf > .brw-mf__top + .brw-ac__body > .brw-ac__stage", "border-radius")).toBe("inherit");
});

test("no hairline where the picture has square corners: edge to edge, or letterboxed at a device's size", () => {
  for (const selector of [
    ".brw-mf .brw-ac__page::after",
    ".brw-mf .dsk-screen::after",
    ".brw-ac__page.is-emulated::after",
    ".cmp-dialog.is-screen-only .dsk-screen::after",
  ]) {
    expect({ selector, content: value(selector, "content") }).toEqual({ selector, content: "none" });
  }
});
