import { type CodeGitStep, type CodeSession, useApi, useCloseCodeSession, useCodeGit } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking } from "react-native";
import type { HeaderAction, HeaderMenuItem } from "@/ui";
import { router } from "@/ui/navigation";
import { useErrorToast, useOrgId } from "../shared/hooks";
import { showActionSheet } from "../shared/PickerSheet";
import { CODING_HREF, sessionChatHref, sessionPeopleHref } from "./logic";
import { freeForStep, STEP, stepAsk, stepsOf } from "./steps";

/**
 * Asking a session's agent for a git step: the step's words posted as the person's message in the session's
 * conversation (ADR 0208), then, from anywhere but the conversation, back to it to watch. `sending` while it posts.
 */
export function useStepAsk(session: CodeSession | null, { inChat }: { inChat: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const failed = useErrorToast();
  const [sending, setSending] = useState(false);
  const ask = async (step: CodeGitStep): Promise<boolean> => {
    if (!session || sending) return false;
    setSending(true);
    try {
      await api.chat.post(orgId, session.channelId, { body: stepAsk(t, session, step), threadId: session.rootId });
      if (!inChat) router.dismissTo(sessionChatHref(session) as never);
      return true;
    } catch (error) {
      failed(error);
      return false;
    } finally {
      setSending(false);
    }
  };
  return { ask, sending };
}

/**
 * A session's "…" (ADR 0208), in its conversation's bar and on its code screen: what the web's header holds, as the
 * system's menu from the bar's button (the app's sheet on Android). The git steps while the agent is free (the next
 * one first), then who is in it, its pull request, and closing it (red). Null until the session is known.
 */
export function useSessionMenu(session: CodeSession | null, { inChat }: { inChat: boolean }): HeaderAction | null {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const failed = useErrorToast();
  const close = useCloseCodeSession(orgId);
  const free = freeForStep(session);
  const git = useCodeGit(orgId, session?.id ?? "", free);
  const { ask } = useStepAsk(session, { inChat });
  if (!session) return null;
  const next = git.data?.next ?? null;
  const menu: HeaderMenuItem[] = [
    ...(free
      ? stepsOf(session)
          .sort((a, b) => (a === next ? -1 : b === next ? 1 : 0))
          .map((step) => ({
            label: t(`codeSessions.git.step.${step}`),
            icon: STEP[step].icon,
            sf: STEP[step].sf,
            onPress: () => void ask(step),
          }))
      : []),
    {
      label: t("codeSessions.who.label"),
      icon: "members",
      sf: "person.2",
      onPress: () => router.push(sessionPeopleHref(session.id) as never),
    },
    ...(session.pr?.url
      ? [
          {
            label: t("codeSessions.view.openPr", { number: session.pr.number }),
            icon: "out" as const,
            sf: "arrow.up.right.square" as const,
            onPress: () => void Linking.openURL(session.pr?.url ?? ""),
          },
        ]
      : []),
    {
      label: t("codeSessions.view.close"),
      icon: "archive",
      sf: "archivebox",
      destructive: true,
      onPress: () =>
        close.mutate(session.id, {
          onSuccess: () => router.dismissTo(CODING_HREF as never),
          onError: failed,
        }),
    },
  ];
  // iOS opens the system's menu from the button; Android lists the same choices in the app's sheet.
  const onPress = () =>
    void showActionSheet(
      t("codeSessions.view.more"),
      menu.map((m) => ({ label: m.label, icon: m.icon, destructive: m.destructive, onPress: m.onPress })),
    );
  return { icon: "more", sf: "ellipsis", label: t("codeSessions.view.more"), onPress, menu };
}
