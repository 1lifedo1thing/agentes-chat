import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openingDockHeight, rememberDockHeight } from "../../src/features/chat/dock-height";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const chat = src("features/chat/ChatScreen.tsx");

test("a conversation opens with the dock's room known before the list places its end", () => {
  // The height laid out last, or a one-line composer over the home indicator before any.
  expect(openingDockHeight(89)).toBe(89);
  rememberDockHeight(0);
  expect(openingDockHeight(89)).toBe(89);
  rememberDockHeight(121);
  expect(openingDockHeight(89)).toBe(121);
  expect(chat).toContain(
    "const boxHeight = useSharedValue(openingDockHeight(Math.max(insets.bottom, 10) + DOCK_LINE));",
  );
  expect(chat).toMatch(/boxHeight\.set\(height\);\s*rememberDockHeight\(height\);/);
  // The list's end starts there too, and the list is told as it mounts (the keyboard list's own report is a round trip
  // from the UI thread that landed after the list said it was placed: Legend List #586).
  expect(src("features/chat/list-end.ts")).toContain("const end = useSharedValue(box.get());");
  expect(chat).toMatch(/listRef\.current = list;\s*list\?\.reportContentInset\(\{ bottom: listEnd\.get\(\) \}\);/);
  expect(chat).toContain("ref={attachList}");
});

test("opening at its latest message, the list shows only once it sits at its end", () => {
  // Three times over two frames, then the fade (v0's and Expensify's lists; Legend List #600).
  expect(chat).toMatch(
    /if \(!opensAtEnd\.current\) \{\s*show\(\);\s*return;\s*\}[\s\S]{0,400}void listRef\.current\?\.scrollToEnd\(\{ animated: false \}\);\s*requestAnimationFrame\(\(\) => \{\s*void listRef\.current\?\.scrollToEnd\(\{ animated: false \}\);\s*requestAnimationFrame\(\(\) => \{\s*void listRef\.current\?\.scrollToEnd\(\{ animated: false \}\);\s*show\(\);/,
  );
  // Once: the fallback timer and the list's own word don't place it twice.
  expect(chat).toMatch(/if \(revealing\.current\) return;\s*revealing\.current = true;/);
  expect(chat).toContain("opensAtEnd.current = openFrom === null && !focusId;");
});

test("a message sent slides up into view in one motion and is there at once, whole", () => {
  // Going to the end glides the list's own follow of its end for a moment, instead of a jump and a second scroll.
  expect(chat).toContain("const GLIDE = { animated: true } as const;");
  expect(chat).toMatch(/setAtEnd\(true\);[\s\S]{0,240}setGlide\(\(n\) => n \+ 1\);/);
  expect(chat).toContain("maintainScrollAtEnd={readHold || anchored ? false : glide > 0 ? GLIDE : true}");
  // Meanwhile the keyboard list's instant shift for the growing dock is held, and a cover keeps its own hold.
  expect(chat).toMatch(
    /if \(glide === 0\) return;\s*if \(!covered\.current\) freeze\.value = true;\s*const timer = setTimeout\(\(\) => \{\s*setGlide\(0\);\s*if \(!covered\.current\) freeze\.value = false;\s*\}, GLIDE_MS\);/,
  );
  // My own words never fade in; someone else's still rise in.
  expect(chat).toContain("entering={fresh && m.author.id !== meId ? ENTER : undefined}");
});

test("in a DM with an agent, a message I send rises to the top of the room and the reply writes under it", () => {
  // Its row's key held as it is sent (an agent answers it: not a GIF or a sticker alone).
  expect(chat).toMatch(
    /if \(isMediaAlone\(local\)\) return;\s*\/\/[^\n]*\n\s*if \(dmAgentId\) \{\s*anchorRise\.current = "waiting";\s*setAnchorKey\(messageKey\(local\)\);/,
  );
  // The room under it is the list's (`anchoredEndSpace`), the message under the bar, a long one by its last lines.
  expect(chat).toContain("anchorOffset: (hasPin ? 0 : headerHeight) + BAND_GAP,");
  expect(chat).toContain("anchorMaxSize: ANCHOR_MAX,");
  expect(chat).toContain("anchoredEndSpace={anchoredEndSpace}");
  // It rises once the list measured it and what follows (or a moment later anyway), with the keyboard list's own scroll,
  // the keyboard left as it is.
  expect(chat).toMatch(/if \(info\.anchorKey === anchorKeyRef\.current\) rise\(\);/);
  expect(chat).toContain("void scrollMessageToEnd({ animated: true, closeKeyboard: false })");
  expect(chat).toContain("const timer = setTimeout(rise, ANCHOR_WAIT_MS);");
  // Going to the end leaves the rise to it, and the reply is never chased: no follow while a message is held.
  expect(chat).toMatch(/if \(anchorRise\.current === "waiting"\) return;\s*setGlide/);
  expect(chat).toContain("maintainScrollAtEnd={readHold || anchored ? false : glide > 0 ? GLIDE : true}");
  // At its end is where it is (the round button and what is new below read that), and a long reply isn't taken to its
  // first line: it already reads from there.
  expect(chat).toContain('return state.listen(anchored ? "isAtEnd" : "isFollowingEnd", setAtEnd);');
  expect(chat).toMatch(/if \(anchorKeyRef\.current\) \{\s*toReadRef\.current = null;\s*return;\s*\}/);
});
