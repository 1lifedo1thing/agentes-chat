import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("in bubbles, the cards under someone else's words are bubbles of that message", () => {
  const row = src("features/chat/MessageRow.tsx");
  expect(row).toContain("const bubblePart = bubbled ? { fill: otherFill, edge: bubbleEdge } : null;");
  expect(row).toContain("<RowParts top={partTop} part={bubblePart} head={bubbleHead}>");
  expect(row).toContain("<BubblePartContext.Provider value={part}>");
  // Three points under the bubble, as a run of bubbles; cards of a message with no words start where it does.
  expect(row).toContain("const BUBBLE_JOIN = 3;");
  expect(row).toContain("const partTop = bubbled && (body || media) ? BUBBLE_JOIN - rhythm.part : cardTop;");
  // Every card on the shared surface takes the bubble's fill and no shadow there.
  const parts = src("features/shared/parts.tsx");
  expect(parts).toMatch(/part\s*\?\s*\{ backgroundColor: part\.fill, \.\.\.part\.edge \}/);
  // The ones outlined elsewhere (its tools, what it changed, a check, a poll, the work it handed) take the one frame
  // of a message's card: the bubble's fill and no outline there (`useMessageCardFrame`, below).
  expect(src("features/chat/Receipts.tsx")).toContain("const frame = [styles.card, card.style];");
  // The work it handed is a quiet line under the bubble, its mark where the bubble's words start.
  expect(src("features/chat/WorkLine.tsx")).toContain("quietInBubble: { paddingLeft: 14 },");
  expect(src("features/shared/bubble-part.ts")).toContain(
    "export const BUBBLE_PART_CORNERS = corners(RADIUS.sm, RADIUS.xl, RADIUS.xl, RADIUS.sm);",
  );
});

test("one frame for every card in a message: the bubble's fill with no outline in bubbles, the bubble's sides", () => {
  const look = src("features/chat/look.ts");
  expect(look).toContain("style: [{ backgroundColor: part.fill, borderWidth: 0 }, cardCorners, part.edge],");
  expect(look).toContain("style: [{ backgroundColor: colors.raised, borderColor: colors.line2 }, cardCorners],");
  const framed = [
    "features/chat/Receipts.tsx",
    "features/chat/ToolCalls.tsx",
    "features/chat/TeamChecks.tsx",
    "features/chat/ReachLines.tsx",
    "features/chat/FeedbackOffer.tsx",
    "features/chat/WorkLine.tsx",
    "features/right-hand/TeamWeekCard.tsx",
    "features/blocks/PollCard.tsx",
    "features/blocks/ChoicesCard.tsx",
    "features/blocks/LiveBlock.tsx",
  ];
  for (const file of framed) {
    const text = src(file);
    expect([file, text.includes(" = useMessageCardFrame();")]).toEqual([file, true]);
    // Never a surface of its own beside the frame's: that is what left two kinds of card in one conversation.
    expect([
      file,
      /backgroundColor: c(olors)?\.raised, borderColor: c(olors)?\.line2 \}, cardCorners/.test(text),
    ]).toEqual([file, false]);
  }
  // A bubble has no sky across its top, in a poll, a choice or a block as in a request.
  for (const file of ["features/blocks/PollCard.tsx", "features/blocks/LiveBlock.tsx"])
    expect([file, src(file).includes("{card.bubble ? null : (")]).toEqual([file, true]);
  expect(src("features/blocks/ChoicesCard.tsx")).toContain("const sky = card.bubble ? null : (");
  // The sides: a bubble's own 14, so a card's content starts where the words over it do.
  expect(src("ui/rhythm.ts")).toContain("export const MESSAGE_CARD_X = 14;");
  expect(src("ui/RowAction.tsx")).toContain(
    "export const ROW_CARD_INSET = { paddingLeft: MESSAGE_CARD_X, paddingRight: MESSAGE_CARD_X - FACE_PAD } as const;",
  );
  for (const file of [
    "features/chat/Receipts.tsx",
    "features/chat/asks.tsx",
    "features/chat/WorkLine.tsx",
    "features/chat/issue-work.tsx",
    "features/missions/cards.tsx",
    "features/files/MessageFiles.tsx",
  ])
    expect([file, src(file).includes("paddingHorizontal: MESSAGE_CARD_X")]).toEqual([file, true]);
  // A tool block's head and rows on the same 14 (the lines' 4 and a row's own 10).
  expect(src("features/chat/ToolCalls.tsx")).toContain("const ROW_PAD = 10;");
});

test("a message that is only a request is a bubble of its own: its name at the top, its time at the end", () => {
  const row = src("features/chat/MessageRow.tsx");
  expect(row).toContain("[approvalId, question, secret].filter(Boolean).length === 1;");
  expect(row).toContain("const bubbleHead = askAlone ? { who: who(true), time: when.time(m.createdAt) } : null;");
  expect(row).toContain("{nameLine && !askAlone ? who(false) : null}");
  const asks = src("features/chat/asks.tsx");
  expect(asks).toContain("{bubbleHead ? <View style={styles.bubbleHead}>{bubbleHead.who}</View> : null}");
  expect(asks).toContain("{bubbleHead.time}");
  // A bubble has no sky across its top, and the preview fades into the bubble's own fill.
  expect(asks).toContain(
    '{part ? null : <Sky color={sky} depth={0.55} fade={0.15} surface="raised" style={styles.sky} />}',
  );
  expect(asks).toContain("colors={[withOpacity(fill, 0), fill]}");
});
