import { useChannelCategories, useMuteChannel } from "@agenteschat/client";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl } from "react-native";
import { useOrg } from "@/providers/org";
import { SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { useCategoryMenus } from "../categories/menus";
import { mayCreate } from "../new/logic";
import { useOpenDm } from "../new/useOpenDm";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useWorkingNow } from "../shared/queries";
import { SheetHostProvider } from "../shared/SheetHost";
import { useHidesQuietGeneral } from "./ChatsScreen";
import { HomeRow } from "./HomeRow";
import { type ConversationRow, type ListKind, pinOf, rightHandPin, rowsOfKind, withoutQuietGeneral } from "./logic";
import { usePins } from "./pins";
import { useAgentRowStates } from "./useHomeNow";
import { useConversationRows, useRowFacts } from "./useRows";
import { useWaitingItems } from "./useWaitingItems";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Every conversation of one kind, pushed from a section's "Ver todos" on Conversas (agents, channels,
 * people), by latest activity, in the home's own rows: one tap deeper a row behaves as it does there (a swipe to pin it
 * or silence a channel, the long press's menu), under the same large title, and the same rows of its shape stand in
 * while it loads. An agent's row says it waits on you, or what it is doing. A personal workspace (ADR 0159) titles its
 * channels as group conversations and, as on the home, leaves a quiet #general out while its person is alone in it.
 */
export function ConversationListScreen(props: { kind: ListKind; categoryId?: string }) {
  return (
    <SheetHostProvider>
      <ConversationList {...props} />
    </SheetHostProvider>
  );
}

function ConversationList({ kind, categoryId }: { kind: ListKind; categoryId?: string }) {
  const { t } = useTranslation();
  const list = useConversationRows();
  const factsOf = useRowFacts();
  const dir = useDirectory();
  const orgId = useOrgId();
  const categories = useChannelCategories(orgId);
  // One channel category's "Ver todos": its channels, titled with its name.
  const category = categoryId ? categories.data?.find((x) => x.id === categoryId) : undefined;
  const inCategory = (r: ConversationRow) => r.kind === "channel" && r.categoryId === categoryId;
  const hideGeneral = useHidesQuietGeneral();
  // The right hand has its own row on Conversas, never one in Agentes (ADR 0137).
  const all = withoutQuietGeneral(rightHandPin(list.rows, rightHandOf(dir.agents)).rows, hideGeneral);
  const rows = categoryId ? rowsOfKind(all, "channels").filter(inCategory) : rowsOfKind(all, kind);
  const work = useWorkingNow();
  const waiting = useWaitingItems();
  const agentStates = useAgentRowStates(list.rows, work, waiting.items);
  const pull = usePullRefresh(list.refetch);
  const { org } = useOrg();
  const personal = isPersonal(org);
  // The home's own handlers for its rows: the long press's menu, the swipe's pin and a channel's silence.
  const menus = useCategoryMenus();
  const pins = usePins();
  const { mutate: muteChannel } = useMuteChannel(orgId);
  const muteRow = useCallback(
    (r: ConversationRow) => {
      if (r.kind === "channel") muteChannel({ channelId: r.channelId, muted: !r.muted });
    },
    [muteChannel],
  );
  const openDm = useOpenDm();
  const startDm = useCallback((agentId: string) => void openDm({ agentId }), [openDm]);
  const title = categoryId
    ? (category?.name ?? "")
    : kind === "channels" && personal
      ? t("shell.channelsPersonal")
      : t(`mobile.chats.section.${kind}`);
  const firstStep =
    categoryId || kind === "channels"
      ? {
          place: "channels" as const,
          acts: mayCreate(org, "channel"),
          label: t(personal ? "shell.sidebarMenu.newChannelPersonal" : "mobile.empty.channels.action"),
          onPress: () => router.push("/new-channel"),
        }
      : kind === "people"
        ? {
            place: "people" as const,
            acts: mayCreate(org, "invite"),
            label: t("members.inviteTitle"),
            onPress: () => router.push("/invite-people"),
          }
        : {
            place: "chats" as const,
            acts: true,
            label: t("mobile.empty.chats.action"),
            icon: "chat" as const,
            onPress: () => router.push("/new-chat"),
          };
  const holdLabel = t("sidebarPins.pin");
  // The pin mark, as on the home, only for what the person pinned (not day one's default).
  const pinnedByMe = (r: ConversationRow) => {
    const pin = pinOf(r);
    return pins.chosen && pin !== null && pins.isPinned(pin.kind, pin.id);
  };
  return (
    <PushedLargeTitle
      title={title}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {list.loading ? (
        <SkeletonList rows={6} />
      ) : list.failed && rows.length === 0 ? (
        <LoadFailed onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <FirstUse {...firstStep} />
      ) : (
        rows.map((r, i) => (
          <HomeRow
            key={r.key}
            row={r}
            facts={factsOf(r, agentStates.get(r.key))}
            divider={i > 0}
            live={i < LIVE_ROWS}
            pinned={pinnedByMe(r)}
            pinLabel={menus.rowActionsOf(r).find((a) => a.key === "pin")?.label ?? null}
            onHold={menus.openRowMenu}
            holdLabel={holdLabel}
            holdActions={menus.rowActionsOf}
            {...(r.kind === "dm" && !r.channelId ? { onStart: startDm } : {})}
            onMute={muteRow}
          />
        ))
      )}
    </PushedLargeTitle>
  );
}
