import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("the dock grows at the conversation's end (who is working, the reply bar): the conversation keeps ending above it", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain("followingEnd.current = atEnd && !readHold;");
  // One place does it: two frames on, only a list the grown dock left short (still scrolling down) goes on to the end.
  expect(chat).toMatch(
    /if \(followingEnd\.current && state && state\.distanceFromEnd > END_SLACK\)\s*void listRef\.current\?\.scrollToEnd\(\{ animated: true \}\);/,
  );
  // The second scroll that ran over the list's own shift is gone.
  expect(chat).not.toContain("boxHeightRef");
});

test("above the conversation's end, the dock's height and the keyboard move nothing", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  // The library's default moved the words being read each time an agent started or finished (the dock's height).
  expect(chat).toContain('keyboardLiftBehavior="whenAtEnd"');
});

test("a pushed screen's large title is the system's on iOS, over a scroll view that is the screen's first child", () => {
  const pushed = src("features/shared/PushedLargeTitle.tsx");
  expect(pushed).toContain('Platform.OS === "ios" ? <SystemLargeTitle {...props} /> : <DrawnLargeTitle {...props} />');
  expect(pushed).toContain('contentInsetAdjustmentBehavior="automatic"');
  const header = src("features/shared/parts.tsx");
  expect(header).toContain("headerLargeTitleEnabled: true,");
  expect(header).toContain("headerLargeTitleShadowVisible: false,");
});
