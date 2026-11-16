import { formatBytes } from "@agenteschat/client/lib/files";
import {
  type ComputerCard,
  type ComputerOs,
  computerApp,
  computerOs,
  migrateCommand,
  migrateFile,
  migratePrompt,
} from "@agenteschat/client/lib/import/computer";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  JourneyScene,
  normalizeAppearance,
  Segmented,
  Spinner,
  SwapLabel,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { failedOffline } from "@/chat/offline";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ImportFailureNote } from "@/components/ImportFailure";
import type { ImportFlowState } from "@/components/ImportFlow";
import { IMPORT_ACCEPT } from "@/lib/import";
import { blockedItems, choosable, droppedFiles, importApplyErrorText, itemId, picksOf } from "@/lib/import-flow";
import { hasFiles } from "@/lib/obsidian";
import "./hosting.css";
import "./import-computer.css";

/** The agents the sheet names one by one before "and N more". */
const FACES = 3;

/**
 * Bringing a team from an app that keeps it on the person's computer (ADR 0055, addendum 2026-11-16), as a sheet
 * over the import: the request for a coding assistant (or the command itself), which reads the app there and writes
 * one file; the file dropped here; who is coming; then the arrival. The crossing on top follows along: the team
 * waits in the desert, walks while the person looks at what comes, and is here once it's made. The reading, the
 * plan and the apply are the flow's own, so closing the sheet at any point leaves the same import on the page.
 */
export function ImportFromComputer({
  flow,
  card,
  onClose,
  standalone,
  todos,
}: {
  flow: ImportFlowState;
  /** The app picked; null keeps the sheet closed. */
  card: ComputerCard | null;
  onClose: () => void;
  /** Applies here (Configurações); the onboarding applies when its step continues. */
  standalone: boolean;
  /** What to set up afterwards, as the preview lists it. */
  todos: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  // The app last picked stays on the sheet while it closes.
  const last = useRef<ComputerCard>("openbotrun");
  if (card) last.current = card;
  const shown = card ?? last.current;
  const app = computerApp(shown);
  const apply = useMutation({ mutationFn: () => flow.apply(), meta: { silent: true } });

  const planned = flow.planned;
  const stage = planned && flow.report ? "here" : planned ? "go" : "wait";
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" });

  let title = t("onboarding.import.computer.title", { app });
  let body: ReactNode;
  let foot: ReactNode = null;

  if (!planned) {
    body = <Ask flow={flow} card={shown} app={app} />;
  } else {
    const { bundle, items } = planned;
    const picks = picksOf(items, flow.pick, blockedItems(bundle, items, flow.pick));
    const picked = new Set(picks);
    const coming = (kind: string) => items.filter((i) => i.kind === kind && picked.has(itemId(i)));
    const agents = coming("agent").flatMap((i) => bundle.agents.find((a) => a.key === i.key) ?? []);
    const files = flow.copyFiles ? planned.files.filter((f) => !f.skip) : [];

    if (!flow.report) {
      const nothing = !items.some(choosable);
      title =
        agents.length > 0
          ? t("onboarding.import.computer.ready", { count: agents.length })
          : nothing
            ? t("onboarding.import.nothingNew")
            : t("onboarding.import.computer.readyOther");
      const rest = agents.slice(FACES);
      body = (
        <>
          {agents.length > 0 && (
            <ul className="imp-team">
              {agents.slice(0, FACES).map((a) => (
                <li key={a.key}>
                  <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />
                  <span className="imp-team__text">
                    <b>{a.name}</b>
                    {a.role && <span>{a.role}</span>}
                  </span>
                </li>
              ))}
              {rest.length > 0 && (
                <li>
                  <span className="imp-team__faces">
                    {rest.slice(0, FACES).map((a) => (
                      <AgentAvatar key={a.key} name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />
                    ))}
                  </span>
                  <span className="imp-team__text">
                    <b>
                      {rest.length <= FACES
                        ? names.format(rest.map((a) => a.name))
                        : t("onboarding.import.computer.others", { count: rest.length })}
                    </b>
                  </span>
                </li>
              )}
            </ul>
          )}
          <ul className="imp-todo">
            {coming("routine").length > 0 && (
              <li className="ac-iconline">
                <Icon name="routines" size={16} />
                <span className="imp-todo__text">
                  {t("onboarding.import.computer.routines", { count: coming("routine").length })}
                </span>
              </li>
            )}
            {coming("note").length > 0 && (
              <li className="ac-iconline">
                <Icon name="book" size={16} />
                <span className="imp-todo__text">
                  {t("onboarding.import.computer.notes", { count: coming("note").length })}
                </span>
              </li>
            )}
            {coming("skill").length > 0 && (
              <li className="ac-iconline">
                <Icon name="bulb" size={16} />
                <span className="imp-todo__text">
                  {t("onboarding.import.computer.skills", { count: coming("skill").length })}
                </span>
              </li>
            )}
            {coming("channel").length > 0 && (
              <li className="ac-iconline">
                <Icon name="channel" size={16} />
                <span className="imp-todo__text">
                  {t("onboarding.import.computer.channels", { count: coming("channel").length })}
                </span>
              </li>
            )}
            {files.length > 0 && (
              <li className="ac-iconline">
                <Icon name="drive" size={16} />
                <span className="imp-todo__text">
                  <span>{t("onboarding.import.computer.files", { count: files.length })}</span>
                  <span className="small muted">
                    {t("onboarding.import.computer.filesSize", {
                      size: formatBytes(
                        i18n.language,
                        files.reduce((sum, f) => sum + f.size, 0),
                      ),
                    })}
                  </span>
                </span>
              </li>
            )}
          </ul>
          {bundle.todo.length > 0 && (
            <>
              <p className="imp-sheet__sub">{t("onboarding.import.computer.after")}</p>
              {todos}
            </>
          )}
          {apply.isError && <Alert>{importApplyErrorText(t, apply.error, failedOffline)}</Alert>}
          {flow.progress && (
            <p className="imp-apply__progress" role="status">
              {t("onboarding.import.applying", flow.progress)}
            </p>
          )}
        </>
      );
      foot = (
        <DialogFooter>
          {nothing || !standalone ? (
            <Button variant="primary" size="lg" block onClick={onClose}>
              {nothing ? t("common.close") : t("common.continue")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              block
              disabled={picks.length === 0 || apply.isPending}
              loading={apply.isPending}
              onClick={() => apply.mutate()}
            >
              {agents.length > 0
                ? t("onboarding.import.computer.bring", { count: agents.length })
                : t("onboarding.import.go", { count: picks.length })}
            </Button>
          )}
          {!nothing && (
            <p className="imp-sheet__alt">
              <button type="button" className="ac-link" onClick={onClose} disabled={apply.isPending}>
                {t("onboarding.import.computer.choose")}
              </button>
            </p>
          )}
        </DialogFooter>
      );
    } else {
      const made = flow.report.filter((i) => i.action === "create" || i.action === "update");
      const here = made.filter((i) => i.kind === "agent").map((i) => i.label);
      const missed = flow.report.filter((i) => i.action === "skip").length;
      const copy = flow.copy;
      title = t("onboarding.import.computer.arrivedTitle");
      body = (
        <>
          <p className="imp-sheet__text">
            {here.length > 0
              ? t("onboarding.import.computer.arrived", { count: here.length, names: names.format(here) })
              : t("onboarding.import.computer.arrivedOther", { count: made.length })}
          </p>
          {copy?.running && (
            <div className="imp-copy" role="status">
              <div className="imp-copy__line">
                <span className="ac-iconline">
                  <Spinner />
                  <b>{t("onboarding.import.computer.copying")}</b>
                </span>
                <span className="imp-copy__count">
                  {t("onboarding.import.computer.copyCount", { done: copy.done, total: copy.total })}
                </span>
              </div>
              <div className="imp-copy__bar">
                <i style={{ width: `${copy.total > 0 ? Math.round((copy.done / copy.total) * 100) : 0}%` }} />
              </div>
              <span className="small muted">{t("onboarding.import.computer.keepOpen")}</span>
            </div>
          )}
          {copy && !copy.running && (copy.result?.copied ?? 0) > 0 && (
            <p className="imp-note ac-iconline">
              <Icon name="drive" size={16} />
              <span>{t("onboarding.import.files.done", { count: copy.result?.copied ?? 0 })}</span>
            </p>
          )}
          {missed > 0 && (
            <p className="imp-note ac-iconline">
              <Icon name="info" size={16} />
              <span>{t("onboarding.import.computer.missed", { count: missed })}</span>
            </p>
          )}
          {bundle.todo.length > 0 && (
            <>
              <p className="imp-sheet__sub">{t("onboarding.import.computer.after")}</p>
              {todos}
            </>
          )}
        </>
      );
      foot = (
        <DialogFooter>
          <Button variant="primary" size="lg" block onClick={onClose}>
            {t("onboarding.import.computer.see")}
          </Button>
        </DialogFooter>
      );
    }
  }

  return (
    <Dialog
      open={card !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="hosting-sheet imp-sheet"
    >
      <div className="hosting-sheet__hero">
        <JourneyScene journey={stage} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="hosting-sheet__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <p className="hosting-sheet__title" aria-hidden="true">
        {title}
      </p>
      <DialogBody className="hosting-sheet__body imp-sheet__body">{body}</DialogBody>
      {foot}
    </Dialog>
  );
}

/** The two steps: the request to paste (or the command), then the file dropped here. */
function Ask({ flow, card, app }: { flow: ImportFlowState; card: ComputerCard; app: string }) {
  const { t } = useTranslation();
  const [os, setOs] = useState<ComputerOs>(() =>
    computerOs(typeof navigator === "undefined" ? "" : navigator.platform),
  );
  const [byHand, setByHand] = useState(false);
  const [over, setOver] = useState(false);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = flow.busy !== null;
  const text = byHand
    ? migrateCommand(window.location.origin, card, os)
    : migratePrompt(window.location.origin, card, os);
  // The mark goes back to "Copiar" on its own, and at once when what there is to copy changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is what resets it
  useEffect(() => setCopied(null), [text]);
  useEffect(() => {
    if (copied !== "ok") return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <>
      <p className="imp-sheet__text">
        {t(byHand ? "onboarding.import.computer.leadCommand" : "onboarding.import.computer.lead", { app })}
      </p>
      <ol className="imp-do">
        <li>
          <span className="imp-do__n" aria-hidden="true">
            1
          </span>
          <div className="imp-do__body">
            <b>
              {byHand
                ? t(
                    os === "windows"
                      ? "onboarding.import.computer.pastePowerShell"
                      : "onboarding.import.computer.pasteTerminal",
                  )
                : t("onboarding.import.computer.pasteAssistant")}
            </b>
            <Textarea
              readOnly
              rows={byHand ? 2 : 4}
              value={text}
              aria-label={t(
                byHand ? "onboarding.import.computer.commandLabel" : "onboarding.import.computer.promptLabel",
              )}
              className="imp-other__prompt imp-do__text"
              data-command={byHand || undefined}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="imp-other__copy">
              <Button onClick={() => void copy()}>
                <SwapLabel
                  icon="copy"
                  altIcon="check"
                  label={t(byHand ? "common.copy" : "onboarding.import.computer.copy")}
                  alt={t("common.copied")}
                  showAlt={copied === "ok"}
                />
              </Button>
              <Segmented
                size="sm"
                label={t("onboarding.import.computer.os.label")}
                value={os}
                onValueChange={setOs}
                options={[
                  { value: "unix", label: t("onboarding.import.computer.os.unix") },
                  { value: "windows", label: t("onboarding.import.computer.os.windows") },
                ]}
              />
            </div>
            <span role="status" className="imp-do__hint">
              {copied === "failed"
                ? t("onboarding.import.request.copyFailed")
                : byHand
                  ? t("onboarding.import.computer.commandHelp")
                  : t("onboarding.import.computer.assistants")}
            </span>
            <button type="button" className="ac-link imp-do__alt" onClick={() => setByHand(!byHand)}>
              {t(byHand ? "onboarding.import.computer.usePrompt" : "onboarding.import.computer.useCommand")}
            </button>
          </div>
        </li>
        <li>
          <span className="imp-do__n" aria-hidden="true">
            2
          </span>
          <div className="imp-do__body">
            <b>{t("onboarding.import.computer.dropStep")}</b>
            {busy ? (
              <div className="imp-reading">
                <span className="imp-reading__text" role="status">
                  <Spinner />
                  {flow.busy === "planning" ? t("onboarding.import.planning") : t("onboarding.import.reading")}
                </span>
                <Button size="sm" variant="ghost" onClick={flow.cancel}>
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard way
              <div
                className="imp-drop"
                data-over={over || undefined}
                onDragOver={(e) => {
                  if (!hasFiles(e.dataTransfer)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setOver(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
                }}
                onDrop={(e) => {
                  if (!hasFiles(e.dataTransfer)) return;
                  e.preventDefault();
                  setOver(false);
                  void flow.read({ files: droppedFiles(e.dataTransfer) });
                }}
              >
                <button type="button" className="imp-drop__area" onClick={() => input.current?.click()}>
                  <Icon name="upload" />
                  <b>{over ? t("onboarding.import.dropping") : t("onboarding.import.computer.drop")}</b>
                  <span>{t("onboarding.import.computer.dropHelp", { file: migrateFile(card) })}</span>
                </button>
              </div>
            )}
            <input
              ref={input}
              type="file"
              hidden
              accept={IMPORT_ACCEPT}
              aria-label={t("onboarding.import.fileLabel")}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void flow.read({ files });
              }}
            />
          </div>
        </li>
      </ol>
      {flow.failure && <ImportFailureNote failure={flow.failure} retry={flow.retry} />}
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span>{t("onboarding.import.computer.safe", { app })}</span>
      </p>
    </>
  );
}
