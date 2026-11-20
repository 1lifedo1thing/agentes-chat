import { type CodeDiffScope, type CodeSession, useCodeDiff } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Select, TabPanel, Tabs } from "@agenteschat/ui";
import { type CSSProperties, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DiffView } from "@/components/artifacts/views";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { CodeGutter, useStoredSize } from "./CodeGutter";
import { CodeScreen } from "./CodeScreen";
import { CodeHorizon } from "./CodeSky";
import { TerminalPane } from "./TerminalPane";

export type CodeTab = "diff" | "screen";
const TAB_KEY = "code:tab";
const TERMINAL_KEY = "code:terminal";

function readTab(): CodeTab {
  try {
    return localStorage.getItem(TAB_KEY) === "screen" ? "screen" : "diff";
  } catch {
    return "diff";
  }
}

/** The panel's tab, kept on this device: what the person looked at last, or the screen the agent turned it to. */
export function useCodeTab() {
  const [tab, setTabState] = useState<CodeTab>(readTab);
  const setTab = useCallback((next: CodeTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {}
  }, []);
  return [tab, setTab] as const;
}

function readTerminal() {
  try {
    return localStorage.getItem(TERMINAL_KEY) === "open";
  } catch {
    return false;
  }
}

/**
 * The session's side panel (ADR 0208): the change (Diff) or the agent's computer or a phone (Screen), and under
 * either, when opened, a shell in the worktree (Terminal) whose height drags. The agents' sky rises behind the diff
 * from its foot, with the session's agent standing on it, and fills the screen's stage.
 */
export function CodePanel({
  session,
  tab,
  onTab,
}: {
  session: CodeSession;
  tab: CodeTab;
  onTab: (tab: CodeTab) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(session.agentId) ?? null;
  const [terminal, setTerminalState] = useState(readTerminal);
  // The shell lives on while the drawer is closed: once opened, it stays mounted, only hidden.
  const [shellOpened, setShellOpened] = useState(terminal);
  const height = useStoredSize("code:terminalHeight", 120, 900, 280);
  const setTerminal = (open: boolean) => {
    setTerminalState(open);
    if (open) setShellOpened(true);
    try {
      localStorage.setItem(TERMINAL_KEY, open ? "open" : "closed");
    } catch {}
  };
  const stat = session.stat.at ? `+${session.stat.added} −${session.stat.removed}` : null;
  return (
    <section className="code-pane code-pane--side" style={{ "--code-term": `${height.size}px` } as CSSProperties}>
      <Tabs
        value={tab}
        onValueChange={onTab}
        label={t("codeSessions.panel.label")}
        items={[
          {
            value: "diff",
            label: (
              <>
                {t("codeSessions.panel.diff")}
                {stat && <span className="code-ptab__n tabular">{stat}</span>}
              </>
            ),
          },
          { value: "screen", label: t("codeSessions.panel.screen") },
        ]}
      >
        <TabPanel value="diff">
          <DiffPane session={session} />
          {agent && (
            <div className="code-hz" aria-hidden="true">
              <CodeHorizon />
            </div>
          )}
          {agent && (
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
        </TabPanel>
        <TabPanel value="screen">{agent && <CodeScreen agent={agent} />}</TabPanel>
      </Tabs>
      <Button
        size="sm"
        variant="ghost"
        icon="codeBlock"
        className="code-ptoggle"
        aria-pressed={terminal}
        onClick={() => setTerminal(!terminal)}
      >
        {t("codeSessions.panel.terminal")}
      </Button>
      {terminal && <CodeGutter axis="y" label={t("codeSessions.panel.terminalHeight")} size={height} />}
      {shellOpened && (
        <div className="code-drawer" hidden={!terminal}>
          {session.worktree.state === "ready" ? (
            <TerminalPane
              orgId={org.id}
              agentId={session.agentId}
              machineId={session.machineId}
              sessionId={session.id}
            />
          ) : (
            <p className="code-empty">{t("codeSessions.panel.notReady")}</p>
          )}
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
        <Select
          size="sm"
          className="code-select"
          aria-label={t("codeSessions.diff.scope")}
          value={scope}
          onValueChange={setScope}
          options={[
            { value: "base", label: t("codeSessions.diff.base", { base: session.baseBranch ?? "main" }) },
            { value: "uncommitted", label: t("codeSessions.diff.uncommitted") },
          ]}
        />
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
