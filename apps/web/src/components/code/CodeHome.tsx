import { type CodeSession, useCodeSessions, useCodeStart, useCreateCodeSession } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, cx, Icon } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { CodeHomeSky } from "./CodeSky";
import { WaitMark } from "./CodeList";

const LAST_PICK = "code:lastPick";

function readLastPick(orgId: string): { agentId?: string; repo?: string } {
  try {
    return JSON.parse(localStorage.getItem(`${LAST_PICK}:${orgId}`) ?? "{}") as { agentId?: string; repo?: string };
  } catch {
    return {};
  }
}

function saveLastPick(orgId: string, pick: { agentId: string; repo: string }) {
  try {
    localStorage.setItem(`${LAST_PICK}:${orgId}`, JSON.stringify(pick));
  } catch {}
}

/** What an agent on the horizon is doing now, from the sessions I take part in. */
function agentState(sessions: CodeSession[], agentId: string): "waiting" | "working" | "free" {
  const own = sessions.filter((s) => s.agentId === agentId);
  if (own.some((s) => s.work === "waiting")) return "waiting";
  if (own.some((s) => s.work === "working" || s.work === "preparing")) return "working";
  return "free";
}

/**
 * The Code page's home (ADR 0208): the field in the middle of the agents' sky, and the agents that program standing on
 * its horizon, each saying what it does now. Writing and Enter opens a session with the picked agent in the picked
 * repository (the last ones used come back); the computer is the agent's own, so there is nothing else to choose.
 */
export function CodeHome() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const start = useCodeStart(org.id);
  const sessions = useCodeSessions(org.id).data ?? [];
  const create = useCreateCodeSession(org.id);
  const agents = start.data?.agents ?? [];
  const [agentId, setAgentId] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  // The last pick, else the first agent and its first repository.
  useEffect(() => {
    if (agentId || agents.length === 0) return;
    const last = readLastPick(org.id);
    const agent = agents.find((a) => a.agentId === last.agentId) ?? agents[0];
    if (!agent) return;
    setAgentId(agent.agentId);
    setRepo(last.repo && (agent.any || agent.repos.includes(last.repo)) ? last.repo : (agent.repos[0] ?? ""));
  }, [agents, agentId, org.id]);
  const picked = agents.find((a) => a.agentId === agentId) ?? null;
  const counts = useMemo(
    () => ({
      working: sessions.filter((s) => s.work === "working" || s.work === "preparing").length,
      waiting: sessions.filter((s) => s.work === "waiting").length,
    }),
    [sessions],
  );
  const pickAgent = (id: string) => {
    setAgentId(id);
    const agent = agents.find((a) => a.agentId === id);
    if (agent && !agent.any && !agent.repos.includes(repo)) setRepo(agent.repos[0] ?? "");
  };
  const ready = Boolean(picked && repo.trim() && text.trim()) && !create.isPending;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || !picked) return;
    const input = { agentId: picked.agentId, repo: repo.trim(), text: text.trim() };
    create.mutate(input, {
      onSuccess: (session) => {
        saveLastPick(org.id, { agentId: input.agentId, repo: input.repo });
        setText("");
        void navigate({ to: "/org/$orgId/code/$sessionId", params: { orgId: org.id, sessionId: session.id } });
      },
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const repoName = repo.trim() || t("codeSessions.home.aRepo");
  return (
    <div className="code-home">
      <div className="code-stage" aria-hidden="true">
        <CodeHomeSky />
      </div>
      <form className="code-mid" onSubmit={submit}>
        <h2 className="code-mid__t">{t("codeSessions.home.title", { repo: repoName })}</h2>
        <span className="code-mid__s">
          {[
            counts.working ? t("codeSessions.home.working", { count: counts.working }) : null,
            counts.waiting ? t("codeSessions.home.waiting", { count: counts.waiting }) : null,
          ]
            .filter(Boolean)
            .join(" · ") || t("codeSessions.home.quiet")}
        </span>
        {agents.length === 0 && start.isSuccess ? (
          <p className="code-mid__none">{t("codeSessions.home.noAgents")}</p>
        ) : (
          <div className="ac-composer code-start">
            <textarea
              className="code-start__text"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder={t("codeSessions.home.placeholder")}
              aria-label={t("codeSessions.home.label")}
            />
            <div className="code-start__opts">
              <label className="code-pick">
                {picked && (
                  <AgentAvatar
                    agentId={picked.agentId}
                    name={dir.agentById.get(picked.agentId)?.name ?? ""}
                    size="xs"
                  />
                )}
                <select
                  value={agentId ?? ""}
                  onChange={(e) => pickAgent(e.target.value)}
                  aria-label={t("codeSessions.home.agent")}
                >
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {dir.agentById.get(a.agentId)?.name ?? a.agentId}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={14} />
              </label>
              <label className="code-pick">
                <Icon name="repo" size={16} />
                {picked && !picked.any ? (
                  <select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label={t("codeSessions.home.repo")}>
                    {picked.repos.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="owner/name"
                    list="code-repos"
                    aria-label={t("codeSessions.home.repo")}
                  />
                )}
                {picked?.any && (
                  <datalist id="code-repos">
                    {picked.repos.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                )}
                {picked && !picked.any && <Icon name="chevronDown" size={14} />}
              </label>
              <span className="code-start__hint">{t("codeSessions.home.hint")}</span>
              <Button type="submit" size="sm" variant="primary" disabled={!ready} loading={create.isPending}>
                {t("codeSessions.home.start")}
              </Button>
            </div>
          </div>
        )}
        {create.error && (
          <p className="code-mid__error" role="alert">
            {errorText(t, create.error)}
          </p>
        )}
      </form>
      <div className="code-team">
        {agents.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? "";
          const state = agentState(sessions, a.agentId);
          return (
            <button
              key={a.agentId}
              type="button"
              className={cx("code-actor", a.agentId === agentId && "is-picked")}
              onClick={() => pickAgent(a.agentId)}
            >
              <AgentAvatar
                agentId={a.agentId}
                name={name}
                size="lg"
                framed={false}
                state={state === "working" ? "writing" : undefined}
              />
              <span className="code-actor__n">{name}</span>
              <span className={cx("code-actor__s", state === "waiting" && "code-st--wait")}>
                {state === "waiting" && <WaitMark />}
                <span>{t(`codeSessions.home.agent_${state}`)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
