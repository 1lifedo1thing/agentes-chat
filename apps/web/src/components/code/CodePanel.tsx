import { type CodeDiffScope, type CodeSession, useCodeDiff } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, cx, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DiffView } from "@/components/artifacts/views";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { CodeScreen } from "./CodeScreen";
import { CodeHorizon } from "./CodeSky";
import { TerminalPane } from "./TerminalPane";

export type CodeTab = "diff" | "screen" | "terminal";
const TAB_KEY = "code:tab";

function readTab(): CodeTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "screen" || v === "terminal" ? v : "diff";
  } catch {
    return "diff";
  }
}

/**
 * The session's side panel (ADR 0208): the change (Diff), the agent's computer or a phone (Screen), a shell in the
 * worktree (Terminal). The agents' sky rises from its foot behind what it shows, with the session's agent standing on
 * it and what it does now.
 */
export function CodePanel({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(session.agentId) ?? null;
  const [tab, setTabState] = useState<CodeTab>(readTab);
  // The shell lives on while another tab shows: once opened, the terminal stays mounted, only hidden.
  const [shellOpened, setShellOpened] = useState(tab === "terminal");
  const setTab = (next: CodeTab) => {
    setTabState(next);
    if (next === "terminal") setShellOpened(true);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {}
  };
  const tabs: { id: CodeTab; icon: "code" | "computer" | "codeBlock"; label: string; extra?: string }[] = [
    {
      id: "diff",
      icon: "code",
      label: t("codeSessions.panel.diff"),
      ...(session.stat.at ? { extra: `+${session.stat.added} −${session.stat.removed}` } : {}),
    },
    { id: "screen", icon: "computer", label: t("codeSessions.panel.screen") },
    { id: "terminal", icon: "codeBlock", label: t("codeSessions.panel.terminal") },
  ];
  return (
    <section className="code-pane code-pane--side">
      <div className="code-hz" aria-hidden="true">
        <CodeHorizon />
      </div>
      <div className="code-ptabs" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            className={cx("code-ptab", tab === x.id && "is-on")}
            onClick={() => setTab(x.id)}
          >
            <Icon name={x.icon} size={15} />
            <span>{x.label}</span>
            {x.extra && <span className="code-ptab__n tabular">{x.extra}</span>}
          </button>
        ))}
      </div>
      <div className="code-pbody">
        {tab === "diff" && <DiffPane session={session} />}
        {tab === "screen" && agent && <CodeScreen agent={agent} />}
        {shellOpened && session.worktree.state === "ready" && (
          <div className="code-pbody__keep" hidden={tab !== "terminal"}>
            <TerminalPane orgId={org.id} agentId={session.agentId} sessionId={session.id} />
          </div>
        )}
        {tab === "terminal" && session.worktree.state !== "ready" && (
          <p className="code-empty">{t("codeSessions.panel.notReady")}</p>
        )}
      </div>
      {tab !== "terminal" && agent && (
        <div className="code-hz__row">
          <AgentAvatar
            agentId={agent.id}
            name={agent.name}
            size="lg"
            framed={false}
            state={session.work === "working" ? "writing" : undefined}
          />
          <span className="code-hz__w">
            <b>{agent.name}</b> {t(`codeSessions.panel.agent_${session.work}`)}
          </span>
        </div>
      )}
    </section>
  );
}

/** The change, read with git in the worktree: since the base (committed or not), or only what isn't committed. */
function DiffPane({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [scope, setScope] = useState<CodeDiffScope>("base");
  const ready = session.worktree.state === "ready";
  const diff = useCodeDiff(org.id, session.id, scope, ready);
  if (!ready) return <p className="code-empty">{t("codeSessions.panel.notReady")}</p>;
  return (
    <div className="code-diff">
      <div className="code-fhead">
        <label className="code-scope">
          <select value={scope} onChange={(e) => setScope(e.target.value as CodeDiffScope)}>
            <option value="base">{t("codeSessions.diff.base", { base: session.baseBranch ?? "main" })}</option>
            <option value="uncommitted">{t("codeSessions.diff.uncommitted")}</option>
          </select>
          <Icon name="chevronDown" size={12} />
        </label>
        {diff.data && (
          <span className="code-fhead__n tabular">
            {t("codeSessions.diff.files", { count: diff.data.files.length })}{" "}
            <span className="code-add">+{diff.data.added}</span> <span className="code-del">−{diff.data.removed}</span>
          </span>
        )}
        <span className="code-fhead__r">
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            iconOnly
            aria-label={t("codeSessions.diff.refresh")}
            title={t("codeSessions.diff.refresh")}
            loading={diff.isFetching}
            onClick={() => void diff.refetch()}
          />
        </span>
      </div>
      <div className="code-dscroll">
        {diff.isPending ? (
          <p className="code-empty">{t("codeSessions.diff.reading")}</p>
        ) : diff.error ? (
          <p className="code-empty">{errorText(t, diff.error)}</p>
        ) : diff.data && diff.data.files.length === 0 ? (
          <p className="code-empty">{t("codeSessions.diff.none")}</p>
        ) : diff.data?.truncated ? (
          <ul className="code-files">
            <li className="code-empty">{t("codeSessions.diff.tooLarge")}</li>
            {diff.data.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>{" "}
                <span className="tabular">
                  <span className="code-add">+{f.added}</span> <span className="code-del">−{f.removed}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : diff.data ? (
          <DiffView files={diff.data.files.map((f) => ({ path: f.path, patch: f.patch }))} />
        ) : null}
      </div>
    </div>
  );
}
