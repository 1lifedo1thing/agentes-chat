import { type CodeSession, useCodeSessions } from "@agenteschat/client";
import { cx, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** The quiet mark of a session that waits on me (the requests' own mark). */
export const WaitMark = () => (
  <span className="rq-wait" aria-hidden="true">
    <span />
  </span>
);

/** One session's state in words, in its color: what the list, the header and the home say. */
export function SessionState({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const work = session.work;
  if (work === "waiting")
    return (
      <span className="code-st code-st--wait">
        <WaitMark />
        <span>{t("codeSessions.state.waiting")}</span>
      </span>
    );
  if (work === "working" || work === "preparing")
    return (
      <span className="code-st code-st--work">
        <Icon name="spinner" size={14} className="code-spin" />
        <span>{t(work === "working" ? "codeSessions.state.working" : "codeSessions.state.preparing")}</span>
      </span>
    );
  if (work === "failed")
    return (
      <span className="code-st code-st--fail">
        <Icon name="alert" size={14} />
        <span>{t("codeSessions.state.failed")}</span>
      </span>
    );
  return (
    <span className="code-st code-st--ok">
      <Icon name="check" size={14} />
      <span>{session.pr ? t("codeSessions.state.pr", { number: session.pr.number }) : t("codeSessions.state.idle")}</span>
    </span>
  );
}

/** The change's size against the base, as git counts it ("+52 −10"); nothing until it was read once. */
export function StatCount({ session }: { session: CodeSession }) {
  if (!session.stat.at || session.stat.added + session.stat.removed === 0) return null;
  return (
    <span className="code-n tabular">
      <span className="code-add">+{session.stat.added}</span> <span className="code-del">−{session.stat.removed}</span>
    </span>
  );
}

/**
 * The page's list (ADR 0208): the sessions I take part in, grouped by repository, each with its agent, name, state in
 * words and the change's size. Who waits on me reads in the waiting color; the open one is marked.
 */
export function CodeList({ activeId }: { activeId: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const list = useCodeSessions(org.id);
  const groups = useMemo(() => {
    const by = new Map<string, CodeSession[]>();
    for (const s of list.data ?? []) by.set(s.repo, [...(by.get(s.repo) ?? []), s]);
    return [...by.entries()];
  }, [list.data]);
  return (
    <aside className="code-list" aria-label={t("codeSessions.list.label")}>
      <div className="code-list__h">
        <span className="code-list__t">{t("codeSessions.title")}</span>
        <Link
          to="/org/$orgId/code"
          params={{ orgId: org.id }}
          className="ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon code-list__new"
          aria-label={t("codeSessions.list.new")}
          title={t("codeSessions.list.new")}
        >
          <Icon name="plus" size={16} />
        </Link>
      </div>
      <div className="code-list__scroll">
        <Link
          to="/org/$orgId/code"
          params={{ orgId: org.id }}
          className={cx("code-row code-row--new", activeId === null && "is-on")}
        >
          <span className="code-row__face code-row__plus">
            <Icon name="plus" size={14} />
          </span>
          <span className="code-row__main">
            <span className="code-row__title">{t("codeSessions.list.newRow")}</span>
          </span>
        </Link>
        {groups.map(([repo, sessions]) => (
          <div key={repo} className="code-group">
            <div className="code-group__h">
              {repo}
              {sessions[0]?.local && <span className="code-group__where"> · {t("codeSessions.list.local")}</span>}
            </div>
            {sessions.map((s) => {
              const agent = dir.agentById.get(s.agentId);
              return (
                <Link
                  key={s.id}
                  to="/org/$orgId/code/$sessionId"
                  params={{ orgId: org.id, sessionId: s.id }}
                  className={cx("code-row", s.id === activeId && "is-on", s.work === "waiting" && "is-waiting")}
                >
                  <span className="code-row__face">
                    <AgentAvatar
                      agentId={s.agentId}
                      name={agent?.name ?? ""}
                      size="xs"
                      state={s.work === "working" ? "writing" : undefined}
                    />
                  </span>
                  <span className="code-row__main">
                    <span className="code-row__title">{s.title}</span>
                    <SessionState session={s} />
                  </span>
                  <StatCount session={s} />
                </Link>
              );
            })}
          </div>
        ))}
        {list.data && list.data.length === 0 && <p className="code-list__empty">{t("codeSessions.list.empty")}</p>}
      </div>
    </aside>
  );
}
