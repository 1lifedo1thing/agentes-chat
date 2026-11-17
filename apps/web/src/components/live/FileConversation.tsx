import type { Agent, Artifact, LiveKind } from "@agenteschat/client";
import { keys, useFileUnread, useThreadMessages } from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { badgeCount } from "@agenteschat/client/lib/unread";
import { Button, CountBadge, CountChip } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useDirectory } from "@/hooks/useDirectory";
import { nearerEsc } from "@/hooks/useEscClose";
import { useSideColumn } from "@/hooks/useMembersColumn";
import { STORAGE_KEYS } from "@/lib/storage";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { ThreadPage } from "@/pages/ThreadPage";
import { useChannelEvents } from "@/realtime/context";
import "@/components/threads/threads.css";
import "@/pages/issues.css";

/*
 * A live file's own conversation (ADR 0197), the task's (ADR 0145) beside a file: "Conversa 4" in the page's header
 * opens it, the app's thread panel shows it, and the file's page keeps its width for it so it never covers the file.
 */

/** From this width the conversation is a column beside the file; under it, it opens over the page like a task's. */
export const LIVE_TALK_DOCKED = "(min-width: 1100px)";
const LIVE_TALK_OVER = "(max-width: 1099px)";

/**
 * Whether the conversation is open, the person's last choice (kept per person and workspace); a file with a
 * conversation opens it by itself the first time. Under `LIVE_TALK_DOCKED` it opens over the page, until closed.
 */
export function useFileTalkColumn(artifact: Pick<Artifact, "conversation"> | null | undefined) {
  const has = (artifact?.conversation?.count ?? 0) > 0;
  return useSideColumn(STORAGE_KEYS.liveTalk, LIVE_TALK_OVER, LIVE_TALK_DOCKED, has);
}

/**
 * "Conversa 4" in the file's header (the task's `TaskConversationButton`): opens or closes the conversation. A reply I
 * haven't read there lights it like an unread channel; a mention of me adds its red number.
 */
export function FileConversationButton({
  artifact,
  open,
  onToggle,
}: {
  artifact: Artifact;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { unread, mentions } = useFileUnread(org.id, artifact.id);
  const count = artifact.conversation?.count ?? 0;
  return (
    <Button
      size="sm"
      variant={open ? "default" : "ghost"}
      icon="message"
      aria-pressed={open}
      aria-label={count > 0 ? t("live.conversation.toggle", { count }) : t("live.conversation.button")}
      className="task-talk__toggle"
      data-unread={unread > 0 || undefined}
      onClick={onToggle}
    >
      {t("live.conversation.button")}
      {count > 0 && <CountChip size="sm">{count}</CountChip>}
      {mentions > 0 && (
        <CountBadge
          className="task-talk__mentions"
          role="img"
          aria-label={t("shell.unreadMentions", { count: mentions })}
        >
          {badgeCount(mentions)}
        </CountBadge>
      )}
    </Button>
  );
}

/** What in the conversation changes "Conversa N": a message, an agent starting or ending its turn. */
const TALK_EVENTS: ReadonlySet<string> = new Set(["message.created", "agent.thinking", "agent.run", "run.finished"]);
/** A burst of them (an agent's steps) reads the file once. */
const TALK_REFRESH_MS = 1000;

/**
 * While the file's page is open, "Conversa N" stays true with the conversation closed (ADR 0197 §6): its channel's
 * events read the file's summary (`Artifact.conversation`) again, once per burst.
 */
export function useFileTalkLive(artifactId: string, channelId: string | null | undefined) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useChannelEvents(channelId ?? "", Boolean(channelId), (event) => {
    if (!TALK_EVENTS.has(event.type) || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void qc.invalidateQueries({ queryKey: keys.artifact(org.id, artifactId), exact: true });
    }, TALK_REFRESH_MS);
  });
}

/**
 * The conversation itself: the thread panel at its root (`useFileConversation` makes it on first use; the skeleton
 * until then). Docked, it hangs from the work area at the page's right (the page keeps that width:
 * `.lf-page[data-talk]`), never over the file, and Esc closes it only from inside it, so the editor keeps its own Esc.
 * Not docked, it is the task's panel over the page.
 */
export function FileConversationPanel({
  kind,
  rootId,
  docked,
  focusMessageId,
  onClose,
}: {
  kind: LiveKind;
  rootId: string | null;
  docked: boolean;
  focusMessageId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const label = t(`live.conversation.title.${kind}` as "live.conversation.title.file");
  const body = rootId ? (
    <ThreadPage threadId={rootId} focusMessageId={focusMessageId} onClose={onClose} escInside={docked} />
  ) : (
    <ChannelSkeleton thread panel />
  );
  if (!docked) {
    return (
      <SidePanel label={label} onClose={onClose}>
        {body}
      </SidePanel>
    );
  }
  // First, before the composer's own keys, as a panel's Esc is (`useEscClose`), but only from inside it.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || nearerEsc(e.nativeEvent)) return;
    e.preventDefault();
    onClose();
  };
  // Hung from the work area (the page's own box runs an entrance that would hold a fixed panel inside it).
  return createPortal(
    <aside className="thread-panel lf-talk" aria-label={label} onKeyDownCapture={onKey}>
      {body}
    </aside>,
    document.querySelector(".shell__work") ?? document.body,
  );
}

/**
 * The file's agent (ADR 0197), whom "Pedir ao Atlas" calls: the one that made it, else the last agent that spoke in
 * its conversation, else the workspace's right hand; only one this person may ask. Null: none.
 */
export function useFileAgent(artifact: Pick<Artifact, "createdBy" | "conversation"> | null | undefined): Agent | null {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const talk = artifact?.conversation ?? null;
  const messages = useThreadMessages(org.id, talk?.channelId, talk?.rootId ?? "");
  const askable = (id: string | null | undefined) => {
    const agent = id ? dir.agentById.get(id) : undefined;
    return agent && !agent.former && mayAsk(org, agent) ? agent : null;
  };
  if (!artifact) return null;
  if (artifact.createdBy.type === "agent") {
    const maker = askable(artifact.createdBy.id);
    if (maker) return maker;
  }
  const spoke = [...(messages.data ?? [])].reverse().find((m) => m.author.type === "agent" && askable(m.author.id));
  if (spoke) return askable(spoke.author.id);
  const wrote = [...(talk?.participants ?? [])].reverse().find((p) => p.type === "agent" && askable(p.id));
  if (wrote) return askable(wrote.id);
  return askable(rightHandOf(dir.agents)?.id) ?? dir.agents.find((a) => askable(a.id)) ?? null;
}
