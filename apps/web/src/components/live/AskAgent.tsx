import type { Agent, Artifact, LiveSelection } from "@agenteschat/client";
import { useAgents, useAskAgentAbout, useChannelMembers } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { messagePath } from "@agenteschat/client/lib/message-links";
import {
  Button,
  Chip,
  ChosenValue,
  Icon,
  modKey,
  Popover,
  SearchSelect,
  type SelectOption,
  Textarea,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/** "Request sent" stays this long before the popover closes by itself. */
export const ASK_SENT_MS = 2000;

/** The agents to offer: the file's conversation's first (they know it), then the others the person may ask. */
function useAskable(artifact: Artifact) {
  const { org } = useOrg();
  const agents = useAgents(org.id);
  const members = useChannelMembers(org.id, artifact.channelId ?? "", Boolean(artifact.channelId));
  return useMemo(() => {
    const inHere = new Set((members.data ?? []).filter((m) => m.type === "agent").map((m) => m.id));
    // A DM with an agent: that agent.
    const dm = artifact.audience.kind === "dm" ? artifact.audience.with : null;
    if (dm?.type === "agent" && dm.id) inHere.add(dm.id);
    const list = (agents.data ?? []).filter((a: Agent) => !a.former && mayAsk(org, a));
    const here = list.filter((a) => inHere.has(a.id));
    const others = list.filter((a) => !inHere.has(a.id));
    return { here, others, loading: agents.isPending };
  }, [agents.data, agents.isPending, members.data, artifact.audience, org]);
}

/**
 * Ask an agent, from inside the file (ADR 0194 §6): whom (the file's conversation's agents first), what, and about
 * what (the selection the editor reports, else the whole file). The message goes where the file lives, carrying it;
 * the agent then opens it and everyone in it watches. After sending: "Request sent" with "See the conversation", then
 * it closes.
 */
export function AskAgentForm({
  artifact,
  selection,
  onDone,
}: {
  artifact: Artifact;
  selection: LiveSelection | null;
  /** Sent and shown, or Esc: the popover or dialog around it closes. */
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const { here, others, loading } = useAskable(artifact);
  const ask = useAskAgentAbout(org.id, artifact.id);
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ channelId: string; threadId: string | null; id: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const all = useMemo(() => [...here, ...others], [here, others]);
  const chosen = all.find((a) => a.id === agentId) ?? here[0] ?? all[0];
  // Grouped only when some are in the file's conversation: "Na conversa deste arquivo", then "Outros agentes".
  const grouped = here.length !== 0;
  const options = useMemo<SelectOption[]>(
    () =>
      all.map((a) => {
        const group = here.includes(a) ? t("live.shell.askAgent.here") : t("live.shell.askAgent.others");
        return {
          value: a.id,
          label: a.name,
          group: grouped ? group : undefined,
          leading: <AgentAvatar agentId={a.id} name={a.name} appearance={lookOf(a)} size="xs" />,
        };
      }),
    [all, here, grouped, t],
  );
  useEffect(() => {
    box.current?.focus();
  }, []);
  // "Request sent" closes by itself after a moment.
  useEffect(() => {
    if (!sent) return;
    const id = setTimeout(onDone, ASK_SENT_MS);
    return () => clearTimeout(id);
  }, [sent, onDone]);

  if (sent && chosen) {
    return (
      <div className="lf-ask lf-ask--sent" role="status">
        <p className="lf-ask__sent">
          <Icon name="check" size={16} />
          <b>{t("live.shell.askAgent.sent")}</b>
        </p>
        <p className="small muted">{t("live.shell.askAgent.sentBody", { name: chosen.name })}</p>
        <Button
          variant="link"
          onClick={() => {
            onDone();
            void navigate({ href: messagePath(org.id, sent) });
          }}
        >
          {t("live.shell.askAgent.see")}
        </Button>
      </div>
    );
  }

  if (!loading && all.length === 0) {
    return (
      <div className="lf-ask">
        <p className="small muted">{t("live.shell.askAgent.none")}</p>
      </div>
    );
  }

  const send = () => {
    const words = text.trim();
    if (!chosen || !words || ask.isPending) return;
    ask.mutate(
      { agentId: chosen.id, text: words, ...(selection ? { selection } : {}) },
      {
        onSuccess: (done) => setSent({ id: done.id, channelId: done.channelId, threadId: done.threadId }),
        onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
      },
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };
  const g = chosen ? agentGrammar(chosen.name) : null;
  return (
    <form
      className="lf-ask"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <SearchSelect
        className="lf-ask__agent"
        aria-label={t("live.shell.askAgent.agent")}
        value={chosen?.id}
        onValueChange={setAgentId}
        options={options}
        placeholder={t("live.shell.askAgent.pick")}
        labels={{
          search: t("live.shell.askAgent.search"),
          searchPlaceholder: t("live.shell.askAgent.searchPlaceholder"),
          noResults: t("live.shell.askAgent.noResults"),
          list: t("live.shell.askAgent.list"),
        }}
        renderValue={(o) =>
          o ? (
            <span>
              <ChosenValue option={o} />
            </span>
          ) : (
            t("live.shell.askAgent.pick")
          )
        }
      />
      <Textarea
        ref={box}
        className="lf-ask__text"
        aria-label={t("live.shell.askAgent.prompt")}
        placeholder={t("live.shell.askAgent.prompt")}
        rows={3}
        autoGrow
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <p className="lf-ask__about">
        <span className="small muted">{t("live.shell.askAgent.about")}</span>
        <Chip icon={KIND_ICON[artifact.kind]}>{selection?.label ?? t("live.shell.askAgent.wholeFile")}</Chip>
      </p>
      <div className="lf-ask__actions">
        <Button
          type="submit"
          variant="agent"
          size="sm"
          loading={ask.isPending}
          disabled={!chosen || !text.trim()}
          kbd={[modKey(), "↵"]}
        >
          {g ? t("live.shell.askAgent.send", { name: g.name, context: g.context }) : t("live.shell.askAgent.sendNone")}
        </Button>
      </div>
    </form>
  );
}

/** "Ask an agent" in the page's header: the agent's button, opening the form beside it (360 wide). */
export function AskAgentButton({ artifact, selection }: { artifact: Artifact; selection: LiveSelection | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      label={t("live.shell.askAgent.title")}
      side="bottom"
      align="end"
      className="lf-ask-pop"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="agent" size="sm" icon="agent">
          {t("live.shell.ask")}
        </Button>
      }
    >
      {open && <AskAgentForm artifact={artifact} selection={selection} onDone={() => setOpen(false)} />}
    </Popover>
  );
}
