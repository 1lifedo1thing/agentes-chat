import { type ErrorBoundaryProps, useGlobalSearchParams, useIsFocused, useSegments } from "expo-router";
import { Component, type ReactNode, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text, TwoPane } from "@/ui";
import { landOn, router } from "@/ui/navigation";
import { Pane } from "@/ui/pane";
import { ChatScreen } from "../chat/ChatScreen";
import { handPlace, placeKey, readingPlace } from "../chat/reading-place";
import { stillHref } from "../links/landing";
import { chatHref } from "../links/logic";
import { useRememberPlace } from "../me/useStart";
import { useOrgId } from "../shared/hooks";
import { FocusLive } from "../shared/parts";
import { ScreenError } from "../shared/ScreenError";
import {
  type ChatOpener,
  ChatOpenerContext,
  type ChatTarget,
  chooseChat,
  chosenChat,
  handoffOf,
  pushedChatOf,
  useChatOpener,
  useChosenKey,
} from "./split";

/**
 * Conversas on a large screen (ADR 0212: the iPhone Duo's inner display): the list (the home, `list`) in the left pane
 * and the open conversation in the right one, with its own bar there (its pill in the middle, its computer and "…" at
 * the pane's top right, no back button: the list is beside it) and its composer at the pane's foot, clear of the tab
 * bar. A row opens its conversation here instead of pushing it and stays lit while it is open; another row swaps only
 * this pane. The choice is kept per workspace (`split.ts`), through redraws, remounts and the device closing and
 * opening; with none yet, the list's most recent conversation opens (`OpenFirstChat`).
 */
export function ChatsSplit({ list }: { list: ReactNode }) {
  const orgId = useOrgId();
  const key = useChosenKey(orgId);
  const chat = key ? chosenChat(orgId) : null;
  const opener = useMemo<ChatOpener>(() => ({ orgId, open: (target) => chooseChat(orgId, target) }), [orgId]);
  return (
    <ChatOpenerContext.Provider value={opener}>
      <TwoPane
        testID="chats-split"
        list={<Pane testID="chats-split-list">{list}</Pane>}
        detail={
          // Its safe area is its own: the tab bar floats over its foot, where the composer stands.
          <Pane ownInsets testID="chats-split-detail">
            {key && chat ? <ConversationPane key={key} chat={chat} /> : <NoChat />}
          </Pane>
        }
      />
    </ChatOpenerContext.Provider>
  );
}

/**
 * The open conversation in its pane: the conversation's own screen, its bar the pane's (`PushedHeader` in a pane), and
 * the place the app reopens at its next start (ADR 0108), as its pushed screen is.
 */
function ConversationPane({ chat }: { chat: ChatTarget }) {
  useRememberPlace(chatHref(chat.channelId, chat.threadId));
  return (
    <PaneBoundary>
      <FocusLive>
        <ChatScreen channelId={chat.channelId} threadId={chat.threadId} />
      </FocusLive>
    </PaneBoundary>
  );
}

/** No conversation to open yet (none in the workspace): a quiet line where it would be. */
function NoChat() {
  const { t } = useTranslation();
  return (
    <View style={styles.empty}>
      <Text variant="small" tone="faint" style={styles.emptyText}>
        {t("mobile.chats.splitEmpty")}
      </Text>
    </View>
  );
}

/**
 * A conversation that breaks while drawing says what happened in its pane, the list beside it still there; "Try
 * again" draws it again. Another conversation opened draws a fresh one (the pane is keyed by it).
 */
class PaneBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  private retry: ErrorBoundaryProps["retry"] = async () => this.setState({ error: null });

  override render() {
    return this.state.error ? <ScreenError error={this.state.error} retry={this.retry} /> : this.props.children;
  }
}

/**
 * With nothing open yet beside the list, its first conversation (the most recent) opens. Draws nothing; only in the
 * split.
 */
export function OpenFirstChat({ channelId, threadId }: { channelId: string | null; threadId: string | null }) {
  const opener = useChatOpener();
  const key = useChosenKey(opener?.orgId ?? "");
  useEffect(() => {
    if (opener && !key && channelId) opener.open({ channelId, threadId });
  }, [opener, key, channelId, threadId]);
  return null;
}

/**
 * Opening and closing the device mid-task keeps the person in the conversation (ADR 0212): the window changing size
 * class moves it between the split's pane and a pushed screen (`handoffOf`), with the message they were reading
 * (`reading-place.ts`); what they were typing is the composer's own, kept by conversation while the app runs. Draws
 * nothing; under Conversas, which stays mounted beneath the other tabs and the screens pushed over them.
 */
export function SplitHandoff({ wide }: { wide: boolean }) {
  const orgId = useOrgId();
  const focused = useIsFocused();
  const segments = useSegments();
  const params = useGlobalSearchParams();
  // Read as the size class changes; kept here as they render.
  const now = useRef({ orgId, focused, pushed: pushedChatOf(segments, params) });
  now.current = { orgId, focused, pushed: pushedChatOf(segments, params) };
  const was = useRef(wide);
  useEffect(() => {
    const before = was.current;
    was.current = wide;
    const { orgId: org, focused: splitShown, pushed } = now.current;
    const step = handoffOf(before, wide, { splitShown, chosen: chosenChat(org), pushed });
    if (!step) return;
    const place = placeKey(step.chat.channelId, step.chat.threadId);
    handPlace(place, readingPlace(place));
    if (step.kind === "push") {
      // In place, without the slide: the conversation was already on screen.
      router.push(stillHref(chatHref(step.chat.channelId, step.chat.threadId)) as never);
      return;
    }
    // Opened afresh in the pane (even if it was the one open there), at the place handed over; then back to the tabs.
    chooseChat(org, step.chat, true);
    landOn("/");
  }, [wide]);
  return null;
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center" },
});
