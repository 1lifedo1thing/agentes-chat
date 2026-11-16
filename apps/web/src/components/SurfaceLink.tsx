import {
  keys,
  type SurfaceLink,
  useConfirmSurfaceLink,
  useRemoveSurfaceLink,
  useSurfaceLinks,
} from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { surfaceRowOf } from "@agenteschat/client/lib/surface-links";
import { Alert, Button, Dialog, DialogBody, DialogFooter, Icon, PixelSpinner, QrCode, useNow } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { Step } from "@/components/devices/Step";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useImageLoads } from "@/hooks/useImageLoads";
import { useOpenParam } from "@/lib/open-param";
import { codeEndsAt, surfaceMarkUrl } from "@/lib/surface";
import { useToast } from "@/lib/toast";

/** A new code this long before the one on screen runs out, so a scan never meets an expired one. */
const RENEW_BEFORE_MS = 20_000;
/** While the dialog is open the links are asked this often too, in case the live event is missed. */
const WAIT_POLL_MS = 3000;
/** Refusals a fresh code gets past: the link ran out, was canceled, or its sender belongs to someone else. */
const NEW_CODE_FIXES = new Set(["surface.link_gone", "surface.code_gone", "surface.taken"]);

/** The surface's mark: the web's connector mark of that name when there is one, else a plain chat icon. */
export function SurfaceMark({ name }: { name: string }) {
  const url = surfaceMarkUrl(name);
  const loads = useImageLoads(url);
  return loads && url ? (
    <ConnectorIcon def={{ iconUrl: url, brandColor: null }} label={name} />
  ) : (
    <Icon name="message" size={16} />
  );
}

/** The workspace's built-in assistant by name, as it is called in this workspace. */
function useAssistantName() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return rightHandOf(useDirectory(org.id).agents)?.name ?? t("rightHand.labelCapitalized");
}

/**
 * Settings › Notifications › Where they arrive (ADR 0187): the outside chat surface, only for an account the server
 * lets link it. None: Link. A sender waiting on the person's confirm: the line opens the dialog at that step. Linked:
 * the sender as the surface shows it, with Unlink.
 */
export function SurfacePrefRow() {
  const { t } = useTranslation();
  const toast = useToast();
  const links = useSurfaceLinks();
  const remove = useRemoveSurfaceLink();
  const assistant = useAssistantName();
  const [open, setOpen] = useOpenParam("link");
  const [unlinking, setUnlinking] = useState<SurfaceLink | null>(null);
  const row = surfaceRowOf(links.data);
  if (row.kind === "hidden") return null;
  const { surface } = row;
  const sender = row.kind === "active" ? [row.link.display, row.link.profileName].filter(Boolean) : [];

  return (
    <>
      <PrefRow
        id="notice-surface"
        lead={<SurfaceMark name={surface} />}
        label={surface}
        hint={row.kind === "pending" ? undefined : t("surface.row.hint", { assistant, surface })}
        status={
          row.kind === "pending" ? (
            t("surface.row.pending")
          ) : sender.length > 0 ? (
            <span className="surface-sender__line">
              {sender.map((s, i) => (
                <span key={s}>
                  {i > 0 && " · "}
                  <bdi>{s}</bdi>
                </span>
              ))}
            </span>
          ) : undefined
        }
        onOpen={row.kind === "pending" ? () => setOpen(1) : undefined}
        control={
          row.kind === "active" ? (
            <Button size="sm" icon="block" onClick={() => setUnlinking(row.link)}>
              {t("surface.row.unlink")}
            </Button>
          ) : (
            <Button size="sm" icon="link" onClick={() => setOpen(1)}>
              {t("surface.row.link")}
            </Button>
          )
        }
      />
      <SurfaceLinkDialog open={open !== null} onClose={() => setOpen(null)} />
      <Dialog
        open={unlinking !== null}
        onOpenChange={(o) => !o && !remove.isPending && setUnlinking(null)}
        title={t("surface.row.unlinkTitle", { surface })}
        description={t("surface.row.unlinkText", { assistant })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setUnlinking(null)} disabled={remove.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              unlinking &&
              remove.mutate(unlinking.id, {
                onSuccess: () => {
                  toast.show(t("surface.row.unlinked", { surface }));
                  setUnlinking(null);
                },
                onError: (e) => toast.show(errorText(t, e), "error"),
              })
            }
          >
            {t("surface.row.unlink")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/**
 * Linking the surface, in three steps like the desktop hand-over: a code to send from it (a QR of the surface's own
 * link with the code typed in), the wait for it to arrive, then the person checks the sender that sent it and
 * confirms. The code answers in the workspace these settings are in.
 */
export function SurfaceLinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { org } = useOrg();
  const assistant = useAssistantName();
  const links = useSurfaceLinks();
  const confirm = useConfirmSurfaceLink();
  const remove = useRemoveSurfaceLink();
  const [sent, setSent] = useState(false);
  const [linked, setLinked] = useState<SurfaceLink | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    if (open) return;
    setSent(false);
    setLinked(null);
    setFailure(null);
  }, [open]);

  useQuery({
    queryKey: keys.surfaceLinks,
    queryFn: () => api.surfaces.list(),
    enabled: open,
    refetchInterval: WAIT_POLL_MS,
  });
  const row = surfaceRowOf(links.data);
  const surface = row.kind === "hidden" ? "" : row.surface;
  const pending = row.kind === "pending" ? row.link : null;
  const step = linked ? "done" : failure ? "failed" : pending ? "confirm" : sent ? "wait" : "code";

  const code = useQuery({
    queryKey: ["surfaceLinkCode", org.id],
    queryFn: async () => {
      const minted = await api.surfaces.mintCode(org.id);
      return { ...minted, endsAt: codeEndsAt(minted.expiresAt) };
    },
    enabled: open && (step === "code" || step === "wait"),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchInterval: (q) =>
      q.state.data && !q.state.error ? Math.max(1000, q.state.data.endsAt - RENEW_BEFORE_MS - Date.now()) : false,
    refetchOnWindowFocus: (q) =>
      q.state.data && !q.state.error && q.state.data.endsAt - RENEW_BEFORE_MS <= Date.now() ? "always" : false,
  });
  const now = useNow(open && code.isSuccess && 1000);
  const busy = confirm.isPending || remove.isPending;
  // A sender still waiting (one linked to someone else) would bring the confirm back: it is canceled first.
  const startAgain = () => {
    if (pending) remove.mutate(pending.id);
    setFailure(null);
    setSent(false);
    void code.refetch();
  };

  const title =
    step === "done"
      ? t("surface.link.doneTitle", { surface })
      : step === "confirm"
        ? t("surface.link.confirmTitle", { surface })
        : t("surface.link.title", { assistant, surface });
  const steps = (
    <ol className="dv-steps">
      <Step state={step === "code" ? "current" : "done"} live={false} title={t("surface.link.stepScan", { surface })} />
      <Step
        state={step === "code" ? "waiting" : step === "wait" ? "current" : "done"}
        title={t("surface.link.stepSend")}
        text={step === "wait" ? t("surface.link.stepSendText") : undefined}
      />
      <Step state={step === "confirm" ? "current" : "waiting"} live={false} title={t("surface.link.stepConfirm")} />
    </ol>
  );
  const openUrl = code.data && /^https:\/\//.test(code.data.openUrl) ? code.data.openUrl : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={440}
    >
      {step === "done" && linked ? (
        <>
          <DialogBody>
            <p className="surface-link__text">{t("surface.link.doneText", { assistant })}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>
              {t("surface.link.done")}
            </Button>
          </DialogFooter>
        </>
      ) : step === "failed" ? (
        <>
          <DialogBody>
            <Alert>{errorText(t, failure)}</Alert>
          </DialogBody>
          <DialogFooter>
            {NEW_CODE_FIXES.has(errorCode(failure) ?? "") ? (
              <Button variant="primary" onClick={startAgain}>
                {t("surface.link.newCode")}
              </Button>
            ) : (
              <Button onClick={onClose}>{t("common.close")}</Button>
            )}
          </DialogFooter>
        </>
      ) : step === "confirm" && pending ? (
        <>
          <DialogBody className="surface-link">
            <div className="surface-sender">
              <span className="small muted">{t("surface.link.sentBy")}</span>
              {pending.display && (
                <bdi className="surface-sender__display" dir="auto">
                  {pending.display}
                </bdi>
              )}
              {pending.profileName && (
                <bdi className="surface-sender__line" dir="auto">
                  {pending.profileName}
                </bdi>
              )}
              {pending.orgName && (
                <span className="small muted surface-sender__line">
                  {t("surface.link.workspace", { workspace: pending.orgName })}
                </span>
              )}
            </div>
            {steps}
            <p className="small muted surface-link__text">{t("surface.link.consent", { assistant, surface })}</p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              loading={remove.isPending}
              disabled={busy}
              onClick={() => remove.mutate(pending.id, { onSuccess: onClose, onError: setFailure })}
            >
              {t("surface.link.notMe")}
            </Button>
            <Button
              variant="primary"
              loading={confirm.isPending}
              disabled={busy}
              onClick={() => confirm.mutate(pending.id, { onSuccess: setLinked, onError: setFailure })}
            >
              {t("surface.link.confirm")}
            </Button>
          </DialogFooter>
        </>
      ) : code.isError ? (
        <DialogBody className="surface-link">
          <Alert>{errorText(t, code.error)}</Alert>
          <Button onClick={() => void code.refetch()}>{t("common.retry")}</Button>
        </DialogBody>
      ) : (
        <DialogBody className="surface-link">
          {step === "code" && (
            <div className="phone-code">
              <div className="phone-code__qr" data-loading={!openUrl || undefined}>
                {openUrl ? (
                  <QrCode text={openUrl} label={t("surface.link.qr", { surface })} />
                ) : (
                  <PixelSpinner size={24} label={t("surface.link.making")} />
                )}
              </div>
            </div>
          )}
          {code.data && (
            <p className="small muted surface-link__code">
              <span>{t("surface.link.code", { code: code.data.code })}</span>
              <span>{t("openOnPhone.validFor", { time: formatTimeLeft(Math.max(0, code.data.endsAt - now)) })}</span>
            </p>
          )}
          {steps}
          {openUrl && (
            <Button asChild block>
              <a href={openUrl} target="_blank" rel="noreferrer" onClick={() => setSent(true)}>
                <Icon name="external" size={16} />
                {t("surface.link.open", { surface })}
              </a>
            </Button>
          )}
          {step === "wait" && (
            <Button variant="ghost" onClick={() => setSent(false)}>
              {t("surface.link.showCode")}
            </Button>
          )}
        </DialogBody>
      )}
    </Dialog>
  );
}
