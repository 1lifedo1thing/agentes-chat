import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("the dock grows at the conversation's end (who is working, the reply bar): the conversation keeps ending above it", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain("followingEnd.current = atEnd && !readHold;");
  expect(chat).toMatch(
    /if \(grew && followingEnd\.current\)\s*requestAnimationFrame\(\(\) => void listRef\.current\?\.scrollToEnd\(\{ animated: true \}\)\);/,
  );
});

test("a pushed screen's large title is the system's on iOS, over a scroll view that is the screen's first child", () => {
  const pushed = src("features/shared/PushedLargeTitle.tsx");
  expect(pushed).toContain('Platform.OS === "ios" ? <SystemLargeTitle {...props} /> : <DrawnLargeTitle {...props} />');
  expect(pushed).toContain('contentInsetAdjustmentBehavior="automatic"');
  const header = src("features/shared/parts.tsx");
  expect(header).toContain("headerLargeTitleEnabled: true,");
  expect(header).toContain("headerLargeTitleShadowVisible: false,");
});
