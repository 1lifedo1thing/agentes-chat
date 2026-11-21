import { createContext, useContext, useSyncExternalStore } from "react";
import { isSafeId } from "../shared/logic";
import type { ConversationRow } from "./logic";

/**
 * Conversas in two panes (ADR 0212: the iPhone Duo's inner display, a large screen): the conversation open beside the
 * list, kept per workspace while the app runs (through redraws, remounts and the device opening and closing), and what
 * the window changing size class does with it. Pure but for the store and its hooks, so the tests run it.
 */

/** A conversation the split shows: a channel or a DM, or a thread of one. */
export interface ChatTarget {
  channelId: string;
  threadId: string | null;
}

export const sameChat = (a: ChatTarget | null, b: ChatTarget | null): boolean =>
  a === b || (a !== null && b !== null && a.channelId === b.channelId && a.threadId === b.threadId);

/** The conversation a row of Conversas opens; null for an agent with none yet (`channelId: ""`). */
export function chatOfRow(row: ConversationRow): ChatTarget | null {
  if (!row.channelId) return null;
  return { channelId: row.channelId, threadId: row.kind === "thread" || row.kind === "mission" ? row.threadId : null };
}

/** The first conversation of a list (Recentes: the most recent first); null when it has none. */
export function firstChatOf(rows: readonly ConversationRow[]): ChatTarget | null {
  for (const row of rows) {
    const chat = chatOfRow(row);
    if (chat) return chat;
  }
  return null;
}

/** What the split keeps of its choice: the conversation and its visit (`chooseChat`'s `again`). */
interface Chosen extends ChatTarget {
  visit: number;
}

const chosen = new Map<string, Chosen>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Opens a conversation in the workspace's split. `again`: a new visit even when it is the one open (it opens afresh,
 * at a place handed over: `reading-place.ts`).
 */
export function chooseChat(orgId: string, target: ChatTarget, again = false) {
  const was = chosen.get(orgId) ?? null;
  if (!again && sameChat(was, target)) return;
  chosen.set(orgId, { channelId: target.channelId, threadId: target.threadId, visit: (was?.visit ?? 0) + 1 });
  for (const listener of listeners) listener();
}

/** The conversation open in the workspace's split, if any. */
export function chosenChat(orgId: string): ChatTarget | null {
  const was = chosen.get(orgId);
  return was ? { channelId: was.channelId, threadId: was.threadId } : null;
}

/** The key its pane is drawn under: a new conversation, or a new visit of the same one, draws it afresh. */
export function chosenKey(orgId: string): string | null {
  const was = chosen.get(orgId);
  return was ? `${was.channelId}:${was.threadId ?? ""}:${was.visit}` : null;
}

/** The split's choice as it changes (its key, `chosenKey`). */
export function useChosenKey(orgId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => chosenKey(orgId),
    () => chosenKey(orgId),
  );
}

/** Whether this conversation is the one open beside the list: a row redraws only when its own answer changes. */
export function useIsChosen(orgId: string | null, target: ChatTarget | null): boolean {
  const read = () => orgId !== null && target !== null && sameChat(chosenChat(orgId), target);
  return useSyncExternalStore(subscribe, read, read);
}

/** How the list opens a conversation while the split shows: beside it, in its pane, rather than pushed. */
export interface ChatOpener {
  orgId: string;
  open: (target: ChatTarget) => void;
}

/** Given by the split around both panes; none elsewhere, where a conversation is pushed as always. */
export const ChatOpenerContext = createContext<ChatOpener | null>(null);

export const useChatOpener = () => useContext(ChatOpenerContext);

/**
 * The conversation pushed over the tabs when it is what shows: the main stack's `chat/[channelId]` route on top, as
 * expo-router's `useSegments` and `useGlobalSearchParams` give it. Null for anything else.
 */
export function pushedChatOf(
  segments: readonly string[],
  params: Readonly<Record<string, string | string[] | undefined>>,
): ChatTarget | null {
  const n = segments.length;
  if (n < 3 || segments[n - 1] !== "[channelId]" || segments[n - 2] !== "chat" || segments[n - 3] !== "(main)")
    return null;
  const { channelId, thread } = params;
  if (!isSafeId(channelId)) return null;
  return { channelId, threadId: isSafeId(thread) && thread !== channelId ? thread : null };
}

/**
 * A conversation's address (`chatHref`: `/chat/<id>`, with `thread=`) as the split opens it; null for any other place,
 * and for an agent's request for help (`handoff=`), whose card opens in control on the pushed screen.
 */
export function chatOfHref(href: string): ChatTarget | null {
  const [path = "", query = ""] = href.split("?");
  const channelId = /^\/chat\/([^/]+)$/.exec(path)?.[1];
  if (!isSafeId(channelId)) return null;
  const params = new Map(
    query
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const [name = "", value = ""] = pair.split("=");
        return [name, value] as const;
      }),
  );
  if (params.has("handoff")) return null;
  const thread = params.get("thread");
  return { channelId, threadId: isSafeId(thread) && thread !== channelId ? thread : null };
}

/** What the window changing size class does with the conversation (`handoffOf`). */
export type Handoff = { kind: "push"; chat: ChatTarget } | { kind: "split"; chat: ChatTarget } | null;

/**
 * So that closing and opening an iPhone Duo mid-task keeps the person in the conversation (ADR 0212):
 * - wide to compact, with the split on screen and a conversation open in it, that conversation is pushed, as a tap on
 *   its row does on a phone;
 * - compact to wide, with a conversation pushed over the tabs, it opens in the split, back on the tabs.
 * Anything else stays as it is (a screen pushed over the split, another tab, no change of size class).
 */
export function handoffOf(
  before: boolean,
  wide: boolean,
  state: { splitShown: boolean; chosen: ChatTarget | null; pushed: ChatTarget | null },
): Handoff {
  if (before && !wide) return state.splitShown && state.chosen ? { kind: "push", chat: state.chosen } : null;
  if (!before && wide) return state.pushed ? { kind: "split", chat: state.pushed } : null;
  return null;
}
