import {
  type CodeGitStep,
  type CodeSession,
  useApi,
  useCloseCodeSession,
  useCodeGit,
  useCodeSession,
  useRetryCodeSession,
  useThreadInfo,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Icon, Menu, MenuItem, MenuNote, SplitButton } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { ToolsOpenContext } from "@/components/ToolCalls";
import { useToast } from "@/lib/toast";
import { ChannelPage, ChannelSkeleton } from "@/pages/ChannelPage";
import { CodeGutter, useStoredWidth } from "./CodeGutter";
import { CodePanel } from "./CodePanel";
import { SessionState } from "./CodeList";

/**
 * One code session (ADR 0208): its header (name, branch and state, the git button), the conversation with its agent
 * in the middle (the chat's own thread screen: tool rows, steering, stop, approvals), and the side panel. The gutter
 * between them drags (double click puts it back).
 */
export function CodeSessionView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const session = useCodeSession(org.id, sessionId);
  const talk = useStoredWidth("code:talkWidth", 360, 1100, 620);
  if (session.isPending) return <ChannelSkeleton thread panel />;
  if (!session.data)
    return (
      <div className="code-session code-session--missing">
        <p className="code-empty">{session.error ? errorText(t, session.error) : t("codeSessions.view.gone")}</p>
      </div>
    );
  const s = session.data;
  return (
    <div className="code-session" style={{ "--code-talk": `${talk.width}px` } as CSSProperties}>
      <CodeHeader session={s} />
      {s.worktree.state === "failed" && <FailedBar session={s} />}
      <div className="code-panes">
        <section className="code-pane code-pane--talk">
          <CodeConversation session={s} />
        </section>
        <CodeGutter label={t("codeSessions.view.resize")} size={talk} />
        <CodePanel session={s} />
      </div>
    </div>
  );
}

/** The conversation: the thread at the session's root, as the chat draws a task's conversation (no header of its own). */
function CodeConversation({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const info = useThreadInfo(org.id, session.rootId);
  const thread = info.data;
  if (!thread) return <ChannelSkeleton thread panel />;
  return (
    // The agent's work reads like a terminal there: every tool line in sight.
    <ToolsOpenContext.Provider value={true}>
      <ChannelPage
      channelId={thread.channelId}
      thread={thread}
      fallback={{
        id: thread.channelId,
        name: thread.channelName,
        topic: "",
        visibility: "private",
        isMember: true,
        createdAt: thread.createdAt,
      }}
      chrome={{
        // The page's header is the session's own, above the conversation.
        header: () => null,
        composerLabel: t("codeSessions.view.composer"),
        panel: true,
        openThread: false,
        task: true,
      }}
      />
    </ToolsOpenContext.Provider>
  );
}

/** The session's header: its name, branch and state, and the git button. */
function CodeHeader({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const close = useCloseCodeSession(org.id);
  return (
    <header className="code-head">
      <div className="code-head__l">
        <h1 className="code-head__t">{session.title}</h1>
        <span className="code-head__m">
          {session.branch && (
            <span className="code-br">
              <Icon name="gitPull" size={14} />
              <code>{session.branch}</code>
            </span>
          )}
          <span className="code-dot">·</span>
          <SessionState session={session} />
        </span>
      </div>
      <div className="code-head__r">
        {session.worktree.state === "ready" && <GitButton session={session} />}
        <Menu
          align="end"
          label={t("codeSessions.view.more")}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              icon="more"
              iconOnly
              aria-label={t("codeSessions.view.more")}
              title={t("codeSessions.view.more")}
            />
          }
        >
          {session.pr?.url && (
            <MenuItem icon="external" onSelect={() => window.open(session.pr?.url ?? "", "_blank", "noopener")}>
              {t("codeSessions.view.openPr", { number: session.pr.number })}
            </MenuItem>
          )}
          <MenuItem
            icon="archive"
            danger
            description={t("codeSessions.view.closeHint")}
            onSelect={() =>
              close.mutate(session.id, {
                onSuccess: () => void navigate({ to: "/org/$orgId/code", params: { orgId: org.id } }),
                onError: (error) => toast.show(errorText(t, error), "error"),
              })
            }
          >
            {t("codeSessions.view.close")}
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}

const STEPS: CodeGitStep[] = ["commit", "push", "pr", "merge"];

/**
 * The git button (ADR 0208): its label is the next step (Commit, Push, Open PR, Merge), read from the worktree; the
 * others are in its menu. Each asks the session's agent in words in the conversation, so it works with any git host
 * and flow: the agent commits, pushes or opens the PR, and merging still asks for approval as it always does.
 */
function GitButton({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const git = useCodeGit(org.id, session.id, true);
  const [sending, setSending] = useState(false);
  const next = git.data?.next ?? null;
  const ask = async (step: CodeGitStep) => {
    setSending(true);
    try {
      await api.chat.post(org.id, session.channelId, {
        body:
          session.local && step === "merge"
            ? t("codeSessions.git.ask.mergeLocal", { base: session.baseBranch ?? "main" })
            : t(`codeSessions.git.ask.${step}`),
        threadId: session.rootId,
      });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setSending(false);
    }
  };
  const working = session.work === "working";
  const hint = (step: CodeGitStep) => {
    const d = git.data;
    if (!d) return "";
    if (step === "commit") return t("codeSessions.git.hint.commit", { count: d.uncommitted });
    if (step === "push") return t("codeSessions.git.hint.push", { count: d.ahead });
    if (step === "pr") return d.pr ? t("codeSessions.git.hint.prOpen", { number: d.pr.number }) : t("codeSessions.git.hint.pr");
    return session.local
      ? t("codeSessions.git.hint.mergeLocal", { base: session.baseBranch ?? "main" })
      : t("codeSessions.git.hint.merge");
  };
  // A local project has no remote: Commit and Merge (into its base branch on the computer) only.
  const steps = session.local ? STEPS.filter((s) => s === "commit" || s === "merge") : STEPS;
  return (
    <SplitButton
      size="sm"
      className="code-git"
      disabled={!next || working || sending}
      loading={sending}
      onClick={() => next && void ask(next)}
      menu={
        <Menu
          align="end"
          label={t("codeSessions.git.more")}
          trigger={<Button size="sm" icon="chevronDown" iconOnly aria-label={t("codeSessions.git.more")} />}
        >
          {steps.map((step) => (
            <MenuItem
              key={step}
              icon={step === "commit" ? "check" : step === "push" ? "upload" : step === "pr" ? "pullRequest" : "merge"}
              description={hint(step) || undefined}
              disabled={working || sending}
              onSelect={() => void ask(step)}
            >
              {t(`codeSessions.git.step.${step}`)}
            </MenuItem>
          ))}
          <MenuNote>{t("codeSessions.git.note")}</MenuNote>
        </Menu>
      }
    >
      {next ? t(`codeSessions.git.step.${next}`) : t("codeSessions.git.upToDate")}
    </SplitButton>
  );
}

/** The worktree couldn't be made: why, and "Try again". */
function FailedBar({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const retry = useRetryCodeSession(org.id, session.id);
  return (
    <div className="code-failed" role="alert">
      <Icon name="alert" size={16} />
      <span className="code-failed__t">
        <b>{t("codeSessions.view.failed")}</b>{" "}
        {session.worktree.errorCode === "github_access" ? t("codeSessions.view.githubAccess") : session.worktree.error}
      </span>
      <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>
        {t("codeSessions.view.retry")}
      </Button>
    </div>
  );
}
