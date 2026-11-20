import {
  type CodeGitStep,
  type CodeSession,
  keys,
  useApi,
  useChannelMembers,
  useCloseCodeSession,
  useCodeGit,
  useCodeSession,
  useRetryCodeSession,
  useThreadInfo,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { planMeterText, usageShown } from "@agenteschat/client/lib/plan-usage";
import {
  AvatarStack,
  Button,
  Icon,
  Menu,
  MenuItem,
  MenuNote,
  Popover,
  planLevel,
  planLine,
  SplitButton,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { ModelPickerButton } from "@/components/ai/ModelPicker";
import { ScreenPanelContext } from "@/components/browser/screen-panel";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { ChannelPage, ChannelSkeleton } from "@/pages/ChannelPage";
import { CodeGutter, useStoredSize } from "./CodeGutter";
import { SessionState } from "./CodeList";
import { CodePanel, useCodeTab } from "./CodePanel";

/**
 * One code session (ADR 0208): the conversation with its agent under the session's header (name, state and branch,
 * the git button), the chat's own thread screen (tool rows, steering, stop, approvals), and the side panel. The
 * gutter between them drags (double click puts it back). The screen is the panel's: the conversation's browser cards
 * are a line that opens it, and it turns to the screen as the agent starts using it.
 */
export function CodeSessionView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const session = useCodeSession(org.id, sessionId);
  const talk = useStoredSize("code:talkWidth", 360, 1100, 620);
  const [tab, setTab] = useCodeTab();
  const screen = useMemo(() => ({ show: () => setTab("screen") }), [setTab]);
  if (session.isPending) return <ChannelSkeleton thread panel />;
  if (!session.data)
    return (
      <div className="code-session code-session--missing">
        <p className="code-empty">{session.error ? errorText(t, session.error) : t("codeSessions.view.gone")}</p>
      </div>
    );
  const s = session.data;
  return (
    <div className="code-session" style={{ "--code-talk": `${talk.size}px` } as CSSProperties}>
      <div className="code-panes">
        <section className="code-pane code-pane--talk">
          <CodeHeader session={s} />
          {s.worktree.state === "failed" && <FailedBar session={s} />}
          <ScreenPanelContext.Provider value={screen}>
            <CodeConversation session={s} />
          </ScreenPanelContext.Provider>
        </section>
        <CodeGutter label={t("codeSessions.view.resize")} size={talk} />
        <CodePanel session={s} tab={tab} onTab={setTab} />
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
        composerNote: <AgentStatus session={session} />,
        panel: true,
        openThread: false,
        task: true,
      }}
    />
  );
}

/**
 * Under the session's composer, as a coding CLI's status line: what its agent thinks with (changed in place, with the
 * DM's own picker) and how much of its plan's limits it has used.
 */
function AgentStatus({ session }: { session: CodeSession }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(session.agentId);
  if (!agent) return null;
  const plan = usageShown(agent.brain, 0).plan;
  const meter = plan ? planLine(plan.usage, planMeterText(t, i18n.language)) : null;
  return (
    <span className="code-status">
      <ModelPickerButton
        agent={agent}
        size="field"
        after={
          meter?.line ? (
            <span
              className="code-status__limit"
              data-level={planLevel(meter.top?.used ?? 0, meter.state === "limited")}
              title={[meter.title, meter.alert].filter(Boolean).join(" · ")}
            >
              {meter.line}
            </span>
          ) : null
        }
      />
    </span>
  );
}

/**
 * Who is in the session, as faces beside the git button (its agent first, then who opened it): a list where whoever
 * opened it, or an admin, takes someone out, and anyone else leaves. Bringing someone in is an @ in the conversation.
 */
function SessionPeople({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const actors = useActors();
  const members = useChannelMembers(org.id, session.channelId);
  const [open, setOpen] = useState(false);
  // Whoever an @ brought in joins as the conversation moves: read again when it does, and when the list opens.
  const refetch = members.refetch;
  useEffect(() => {
    if (session.lastAt) void refetch();
  }, [session.lastAt, refetch]);
  const rank = (m: { type: string; id: string }) =>
    m.type === "agent" && m.id === session.agentId ? 0 : m.id === session.createdBy ? 1 : 2;
  const people = [...(members.data ?? [])]
    .filter((m) => m.type === "agent" || m.type === "person")
    .map((m) => ({ type: m.type as "agent" | "person", id: m.id }))
    .sort((a, b) => rank(a) - rank(b));
  const manages = session.createdBy === me.user.id || can(org, "manage_channels");
  const remove = useMutation({
    mutationFn: (m: { type: "agent" | "person"; id: string }) =>
      api.chat.removeMember(org.id, session.channelId, m.type === "agent" ? { agentId: m.id } : { userId: m.id }),
    onSuccess: (_, m) => {
      void qc.invalidateQueries({ queryKey: keys.channelMembers(org.id, session.channelId) });
      void qc.invalidateQueries({ queryKey: keys.roster(org.id, session.channelId) });
      // Out of it myself: the session isn't mine to see any more.
      if (m.type === "person" && m.id === me.user.id) {
        setOpen(false);
        void navigate({ to: "/org/$orgId/code", params: { orgId: org.id } });
      }
    },
    onError: (error) => toast.show(errorText(t, error), "error"),
  });
  if (people.length === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refetch();
      }}
      side="bottom"
      align="end"
      label={t("codeSessions.who.label")}
      className="code-whopop"
      trigger={
        <button type="button" className="code-who" aria-label={t("codeSessions.who.open", { count: people.length })}>
          <AvatarStack>{people.slice(0, 3).map((p) => actors.avatar(p, "sm"))}</AvatarStack>
          {people.length > 3 && <span className="code-who__n tabular">+{people.length - 3}</span>}
        </button>
      }
    >
      <p className="ac-popover__title">{t("codeSessions.who.label")}</p>
      {people.map((p) => {
        const core = rank(p) < 2;
        const self = p.type === "person" && p.id === me.user.id;
        const name = actors.name(p);
        return (
          <div key={`${p.type}:${p.id}`} className="ac-popover__row code-whopop__row">
            {actors.avatar(p, "sm")}
            <span className="code-whopop__name">{name}</span>
            {core ? (
              <span className="ac-popover__row-status">
                {rank(p) === 0 ? t("codeSessions.who.agent") : t("codeSessions.who.opener")}
              </span>
            ) : self ? (
              <Button
                size="sm"
                variant="ghost"
                className="code-whopop__act"
                loading={remove.isPending && remove.variables?.id === p.id}
                onClick={() => remove.mutate(p)}
              >
                {t("codeSessions.who.leave")}
              </Button>
            ) : (
              manages && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  iconOnly
                  className="code-whopop__act"
                  aria-label={t("codeSessions.who.remove", { name })}
                  title={t("codeSessions.who.remove", { name })}
                  loading={remove.isPending && remove.variables?.id === p.id}
                  onClick={() => remove.mutate(p)}
                />
              )
            )}
          </div>
        );
      })}
      <p className="code-whopop__note">{t("codeSessions.who.invite")}</p>
    </Popover>
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
          <SessionState session={session} />
          {session.branch && (
            <>
              <span className="code-dot">·</span>
              <span className="code-br" title={session.branch}>
                <Icon name="gitPull" size={14} />
                <code>{session.branch}</code>
              </span>
            </>
          )}
        </span>
      </div>
      <div className="code-head__r">
        <SessionPeople session={session} />
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
    if (step === "pr")
      return d.pr ? t("codeSessions.git.hint.prOpen", { number: d.pr.number }) : t("codeSessions.git.hint.pr");
    return session.local
      ? t("codeSessions.git.hint.mergeLocal", { base: session.baseBranch ?? "main" })
      : t("codeSessions.git.hint.merge");
  };
  // A local project has no remote: Commit and Merge (into its base branch on the computer) only.
  const steps = session.local ? STEPS.filter((s) => s === "commit" || s === "merge") : STEPS;
  // Only when there is a next step and the agent is free to take it: no button that waits greyed out.
  if (!next || working) return null;
  return (
    <SplitButton
      size="sm"
      className="code-git"
      disabled={sending}
      loading={sending}
      onClick={() => void ask(next)}
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
              disabled={sending}
              onSelect={() => void ask(step)}
            >
              {t(`codeSessions.git.step.${step}`)}
            </MenuItem>
          ))}
          <MenuNote>{t("codeSessions.git.note")}</MenuNote>
        </Menu>
      }
    >
      {t(`codeSessions.git.step.${next}`)}
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
