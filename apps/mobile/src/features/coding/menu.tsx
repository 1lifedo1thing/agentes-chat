import { type CodeGitStep, type CodeSession, useApi, useCloseCodeSession, useCodeGit } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { Linking } from "react-native";
import type { HeaderAction, HeaderMenuItem, IconName } from "@/ui";
import { router } from "@/ui/navigation";
import { useErrorToast, useOrgId } from "../shared/hooks";
import { showActionSheet } from "../shared/PickerSheet";
import { CODING_HREF, sessionChatHref, sessionPeopleHref } from "./logic";

/** Each git step's mark in the menu, as the web's menu draws it. */
const STEP: Record<CodeGitStep, { icon: IconName; sf: HeaderMenuItem["sf"] }> = {
  commit: { icon: "check", sf: "checkmark.circle" },
  push: { icon: "up", sf: "arrow.up.circle" },
  pr: { icon: "pullRequest", sf: "arrow.triangle.pull" },
  merge: { icon: "gitPull", sf: "arrow.triangle.merge" },
};
/** The steps a project only on the computer has: Commit, then Merge into its base branch there. */
const LOCAL_STEPS: CodeGitStep[] = ["commit", "merge"];
const STEPS: CodeGitStep[] = ["commit", "push", "pr", "merge"];

/**
 * A session's "…" (ADR 0208), in its conversation's bar and on its code screen: what the web's header holds, as the
 * system's menu from the bar's button (the app's sheet on Android). The git step it can take now first (asked of the
 * agent in words in the conversation; from the code screen, back to it to watch), then who is in it, its pull request,
 * and closing it (red). Null until the session is known.
 */
export function useSessionMenu(session: CodeSession | null, { inChat }: { inChat: boolean }): HeaderAction | null {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const failed = useErrorToast();
  const close = useCloseCodeSession(orgId);
  const git = useCodeGit(orgId, session?.id ?? "", session?.worktree.state === "ready");
  if (!session) return null;
  const working = session.work === "working";
  const next = git.data?.next ?? null;
  const steps = session.local ? LOCAL_STEPS : STEPS;
  const ask = (step: CodeGitStep) => {
    const body =
      session.local && step === "merge"
        ? t("codeSessions.git.ask.mergeLocal", { base: session.baseBranch ?? "main" })
        : t(`codeSessions.git.ask.${step}`);
    api.chat
      .post(orgId, session.channelId, { body, threadId: session.rootId })
      .then(() => {
        if (!inChat) router.dismissTo(sessionChatHref(session) as never);
      })
      .catch(failed);
  };
  const menu: HeaderMenuItem[] = [
    // The git steps while the agent is free: the next one first, as the web's button.
    ...(working
      ? []
      : [...steps]
          .sort((a, b) => (a === next ? -1 : b === next ? 1 : 0))
          .map((step) => ({
            label: t(`codeSessions.git.step.${step}`),
            icon: STEP[step].icon,
            sf: STEP[step].sf,
            onPress: () => ask(step),
          }))),
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
