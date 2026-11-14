import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AppNotification } from "../src/index";
import { applyNotificationEvent, dropNotification, keys } from "../src/index";
import { canClearAll, type NotificationPages } from "../src/lib/notifications";

const item = { id: "n1", kind: "mention", doneAt: "2026-10-16T04:00:00.000Z" } as AppNotification;
const pages = (): NotificationPages => ({
  pages: [{ items: [item], counts: { all: 0, mentions: 0, waiting: 0, unread: 0, reactions: 0 }, nextCursor: null }],
  pageParams: [null],
});
const doneIds = (qc: QueryClient) =>
  qc.getQueryData<NotificationPages>(keys.notificationList("o1", "done"))?.pages[0]?.items.map((n) => n.id);

test("the removed event leaves Concluídas alone; a drop the page asks for (answered, passed) leaves it too", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.notificationList("o1", "done"), pages());
  applyNotificationEvent(qc, "o1", { type: "notification.removed", id: "n1" });
  expect(doneIds(qc)).toEqual(["n1"]);
  dropNotification(qc, "o1", "n1");
  expect(doneIds(qc)).toEqual([]);
});

test("Concluir todas has something to move only beyond what waits on the person", () => {
  const counts = { all: 3, mentions: 1, waiting: 1, unread: 2, reactions: 0 };
  const loaded = [{ waiting: true }, { waiting: false }];
  expect(canClearAll("all", counts, loaded)).toBe(true);
  expect(canClearAll("all", { ...counts, all: 1 }, loaded)).toBe(false);
  // The one mention is the question waiting on the person: nothing to move.
  expect(canClearAll("mentions", counts, [{ waiting: true }])).toBe(false);
  expect(canClearAll("unread", counts, loaded)).toBe(true);
  expect(canClearAll("reactions", counts, [])).toBe(false);
  expect(canClearAll("waiting", counts, loaded)).toBe(false);
  expect(canClearAll("done", counts, loaded)).toBe(false);
  expect(canClearAll("all", undefined, [])).toBe(false);
});
