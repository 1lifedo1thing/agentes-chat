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
import { Button, cx, Icon } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { ChannelPage, ChannelSkeleton } from "@/pages/ChannelPage";
import { CodePanel } from "./CodePanel";
import { SessionState } from "./CodeList";

const TALK_KEY = "code:talkWidth";
const TALK_MIN = 360;
const TALK_MAX = 1100;
const TALK_DEFAULT = 620;

function readTalk() {
  try {
    const v = Number(localStorage.getItem(TALK_KEY));
    return Number.isFinite(v) && v >= TALK_MIN && v <= TALK_MAX ? v : TALK_DEFAULT;
  } catch {
    return TALK_DEFAULT;
  }
}

/**
 * One code session (ADR 0208): its header (name, branch and state, the git button), the conversation with its agent
 * in the middle (the chat's own thread screen: tool rows, steering, stop, approvals), and the side panel. The gutter
 * between them drags (double click puts it back).
 */
export function CodeSessionView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const session = useCodeSession(org.id, sessionId);
  const [talk, setTalk] = useState(readTalk);
  if (session.isPending) return <ChannelSkeleton thread panel />;
  if (!session.data)
    return (
      <div className="code-session code-session--missing">
        <p className="code-empty">{session.error ? errorText(t, session.error) : t("codeSessions.view.gone")}</p>
      </div>
    );
  const s = session.data;
  return (
    <div className="code-session" style={{ "--code-talk": `${talk}px` } as CSSProperties}>
      <CodeHeader session={s} />
      {s.worktree.state === "failed" && <FailedBar session={s} />}
      <div className="code-panes">
        <section className="code-pane code-pane--talk">
          <CodeConversation session={s} />
        </section>
        <Gutter width={talk} onWidth={setTalk} />
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
  );
}

/** The drag between the conversation and the panel: its width per person, kept on this device. */
function Gutter({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(TALK_MIN, Math.min(TALK_MAX, w)));
  const save = (w: number) => {
    try {
      localStorage.setItem(TALK_KEY, String(w));
    } catch {}
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onWidth(clamp(start.current.w + e.clientX - start.current.x));
  };
  const up = () => {
    if (start.current) save(width);
    start.current = null;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable separator between two panes, as the live file's grip
    <div
      className="code-gutter"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={TALK_MIN}
      aria-valuemax={TALK_MAX}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        onWidth(TALK_DEFAULT);
        save(TALK_DEFAULT);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const next = clamp(width + (e.key === "ArrowLeft" ? -24 : 24));
          onWidth(next);
          save(next);
        }
      }}
    />
  );
}

/** The session's header: its name, branch and state, and the git button. */
function CodeHeader({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const close = useCloseCodeSession(org.id);
  const [menu, setMenu] = useState(false);
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
        <div className="code-more">
          <Button
            size="sm"
            variant="ghost"
            icon="more"
            iconOnly
            aria-label={t("codeSessions.view.more")}
            title={t("codeSessions.view.more")}
            onClick={() => setMenu((open) => !open)}
          />
          {menu && (
            <div className="ac-menu code-moremenu" role="menu">
              {session.pr?.url && (
                <a className="ac-menu__item" role="menuitem" href={session.pr.url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={16} />
                  <span className="ac-menu__label">{t("codeSessions.view.openPr", { number: session.pr.number })}</span>
                </a>
              )}
              <button
                type="button"
                role="menuitem"
                className="ac-menu__item ac-menu__item--danger"
                onClick={() => {
                  setMenu(false);
                  close.mutate(session.id, {
                    onSuccess: () => void navigate({ to: "/org/$orgId/code", params: { orgId: org.id } }),
                    onError: (error) => toast.show(errorText(t, error), "error"),
                  });
                }}
              >
                <Icon name="archive" size={16} />
                <span className="ac-menu__label">
                  <span>{t("codeSessions.view.close")}</span>
                  <span className="ac-menu__desc">{t("codeSessions.view.closeHint")}</span>
                </span>
              </button>
            </div>
          )}
        </div>
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
  const [menu, setMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const next = git.data?.next ?? null;
  useEffect(() => {
    if (!menu) return;
    const shut = () => setMenu(false);
    window.addEventListener("click", shut);
    return () => window.removeEventListener("click", shut);
  }, [menu]);
  const ask = async (step: CodeGitStep) => {
    setSending(true);
    try {
      await api.chat.post(org.id, session.channelId, {
        body: t(`codeSessions.git.ask.${step}`),
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
    return t("codeSessions.git.hint.merge");
  };
  return (
    <span className="code-git">
      <Button
        size="sm"
        variant="primary"
        disabled={!next || working || sending}
        loading={sending}
        onClick={() => next && void ask(next)}
      >
        {next ? t(`codeSessions.git.step.${next}`) : t("codeSessions.git.upToDate")}
      </Button>
      <Button
        size="sm"
        variant="primary"
        icon="chevronDown"
        iconOnly
        className="code-git__more"
        aria-label={t("codeSessions.git.more")}
        aria-expanded={menu}
        onClick={(e) => {
          e.stopPropagation();
          setMenu((open) => !open);
        }}
      />
      {menu && (
        <div className="ac-menu code-gitmenu" role="menu">
          {STEPS.map((step) => (
            <button
              key={step}
              type="button"
              role="menuitem"
              className={cx("ac-menu__item", step === next && "is-next")}
              disabled={working || sending}
              onClick={() => void ask(step)}
            >
              <Icon
                name={step === "commit" ? "check" : step === "push" ? "upload" : step === "pr" ? "pullRequest" : "merge"}
                size={16}
              />
              <span className="ac-menu__label">
                <span>{t(`codeSessions.git.step.${step}`)}</span>
                {hint(step) && <span className="ac-menu__desc">{hint(step)}</span>}
              </span>
            </button>
          ))}
          <p className="code-gitmenu__note">{t("codeSessions.git.note")}</p>
        </div>
      )}
    </span>
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
        <b>{t("codeSessions.view.failed")}</b> {session.worktree.error}
      </span>
      <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>
        {t("codeSessions.view.retry")}
      </Button>
    </div>
  );
}
