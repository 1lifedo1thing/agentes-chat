import {
  type SurfaceLink,
  type SurfaceLinkCode,
  useAgents,
  useConfirmSurfaceLink,
  useMintSurfaceCode,
  useRemoveSurfaceLink,
  useSurfaceLinks,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { type SurfaceRow, surfaceRowOf } from "@agenteschat/client/lib/surface-links";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, StyleSheet, View } from "react-native";
import { useAppActive } from "@/lib/useAppActive";
import { useOrg } from "@/providers/org";
import { Button, GroupedList, GroupedRow, haptics, Sheet, Text, useToast } from "@/ui";
import { confirmAction } from "../settings/parts";
import { useColors, useNow } from "../shared/hooks";
import { MONO } from "../shared/parts";
import {
  assistantName,
  codeDeadline,
  codeIsStale,
  codeLeftText,
  LINK_POLL_MS,
  linkStep,
  senderName,
  surfaceRowText,
} from "./surface";

/**
 * The outside chat surface's row in Notificações (ADR 0187), only where this account may link it: none opens the
 * sheet, pending opens it at the confirm, active shows the sender with Unlink.
 */
export function SurfaceLinkRow() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const links = useSurfaceLinks();
  const agents = useAgents(orgId);
  const remove = useRemoveSurfaceLink();
  const [open, setOpen] = useState(false);
  const row = surfaceRowOf(links.data);
  if (row.kind === "hidden") return null;
  const text = surfaceRowText(t, row, assistantName(agents.data));
  const unlink = (link: SurfaceLink) =>
    confirmAction({
      title: t("mobile.surface.unlinkTitle", { surface: row.surface }),
      text: t("mobile.surface.unlinkText", { sender: senderName(link, row.surface) }),
      action: t("mobile.surface.unlink"),
      cancel: t("mobile.common.cancel"),
      onConfirm: () =>
        remove.mutate(link.id, {
          onSuccess: () => haptics.success(),
          onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
        }),
    });
  return (
    <>
      <GroupedList>
        <GroupedRow
          media
          icon="chat"
          label={row.surface}
          labelLines={0}
          {...(text.sub ? { sub: text.sub, subLines: 0 } : {})}
          {...(text.below ? { belowText: text.below } : {})}
          {...(text.value ? { value: text.value } : {})}
          disabled={remove.isPending}
          {...(row.kind === "active"
            ? { remove: { label: t("mobile.surface.unlink"), onPress: () => unlink(row.link) } }
            : { chevron: true, onPress: () => setOpen(true) })}
        />
      </GroupedList>
      <SurfaceLinkSheet open={open} onClose={() => setOpen(false)} row={row} />
    </>
  );
}

/**
 * Linking, two steps in one sheet: "Open <surface>" with the code under it (renewed before it runs out), waiting for
 * the surface to bring it back; then the sender to confirm, with the consent line right over Confirm. The live event
 * moves it on, and so do a read every few seconds while it waits and one when the app comes back to the front.
 */
function SurfaceLinkSheet({
  open,
  onClose,
  row,
}: {
  open: boolean;
  onClose: () => void;
  row: Exclude<SurfaceRow, { kind: "hidden" }>;
}) {
  const [linked, setLinked] = useState<SurfaceLink | null>(null);
  // Cleared once the sheet is gone, so the linked step stays on screen while it slides away.
  return (
    <Sheet open={open} onClose={onClose} onGone={() => setLinked(null)} solid>
      <LinkSteps row={row} linked={linked} onLinked={setLinked} onClose={onClose} />
    </Sheet>
  );
}

function LinkSteps({
  row,
  linked,
  onLinked,
  onClose,
}: {
  row: Exclude<SurfaceRow, { kind: "hidden" }>;
  linked: SurfaceLink | null;
  onLinked: (link: SurfaceLink) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const links = useSurfaceLinks();
  const step = linkStep(row, Boolean(linked));
  const linkOrg = row.kind === "pending" ? (row.link.orgId ?? orgId) : orgId;
  const assistant = assistantName(useAgents(linkOrg).data);
  // The failure of the last action, said in whichever step follows it (a refused confirm lands back on the code).
  const [error, setError] = useState<string | null>(null);
  const active = useAppActive();
  const waiting = step === "code";
  const { refetch } = links;
  useEffect(() => {
    if (!waiting || !active) return;
    void refetch();
    const timer = setInterval(() => void refetch(), LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, active, refetch]);

  if (step === "linked" && linked)
    return (
      <View style={styles.col}>
        <Text variant="title">{t("mobile.surface.linkedTitle", { surface: row.surface })}</Text>
        <Text variant="body" tone="muted">
          {assistant
            ? t("mobile.surface.linkedText", { assistant, sender: senderName(linked, row.surface) })
            : senderName(linked, row.surface)}
        </Text>
        <Button variant="primary" wide label={t("mobile.common.done")} onPress={onClose} />
      </View>
    );
  if (step === "confirm" && row.kind === "pending")
    return (
      <ConfirmStep
        surface={row.surface}
        link={row.link}
        assistant={assistant}
        error={error}
        setError={setError}
        onLinked={onLinked}
      />
    );
  return <CodeStep surface={row.surface} assistant={assistant} error={error} setError={setError} />;
}

function CodeStep({
  surface,
  assistant,
  error,
  setError,
}: {
  surface: string;
  assistant: string | null;
  error: string | null;
  setError: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId } = useOrg();
  const mint = useMintSurfaceCode();
  const [code, setCode] = useState<{ made: SurfaceLinkCode; deadline: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // A repaint every second for the countdown; the time itself is read just below.
  const now = useNow(1000);
  const stale = codeIsStale(code?.deadline ?? null, now);
  const { mutate, isPending } = mint;
  const make = () => {
    setFailed(false);
    mutate(orgId, {
      onSuccess: (made) => setCode({ made, deadline: codeDeadline(made, Date.now()) }),
      onError: (e) => {
        setFailed(true);
        setError(errorText(t, e));
      },
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new code only when the shown one is gone or ending
  useEffect(() => {
    if (stale && !isPending && !failed) make();
  }, [stale, isPending, failed]);

  const title = assistant
    ? t("mobile.surface.talkTitle", { assistant, surface })
    : t("mobile.surface.title", { surface });
  return (
    <View style={styles.col}>
      <Text variant="title">{title}</Text>
      <Text variant="body" tone="muted">
        {t("mobile.surface.codeText")}
      </Text>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {code && !failed ? (
        <>
          <Button
            variant="primary"
            wide
            wrap
            label={t("mobile.surface.open", { surface })}
            onPress={() => {
              setError(null);
              void Linking.openURL(code.made.openUrl).catch(() =>
                setError(t("mobile.surface.openFailed", { surface })),
              );
            }}
          />
          <View style={styles.code}>
            <Text variant="small" tone="muted">
              {t("mobile.surface.orType")}
            </Text>
            <Text selectable style={[styles.mono, { color: c.ink }]}>
              {code.made.code}
            </Text>
            <Text variant="small" tone="faint">
              {codeLeftText(t, code.deadline, now)}
            </Text>
          </View>
        </>
      ) : failed ? (
        <Button
          variant="secondary"
          wide
          label={t("mobile.common.retry")}
          loading={isPending}
          onPress={() => {
            setError(null);
            make();
          }}
        />
      ) : (
        <View style={styles.making}>
          <ActivityIndicator color={c.muted} />
          <Text variant="small" tone="muted">
            {t("openOnPhone.making")}
          </Text>
        </View>
      )}
    </View>
  );
}

function ConfirmStep({
  surface,
  link,
  assistant,
  error,
  setError,
  onLinked,
}: {
  surface: string;
  link: SurfaceLink;
  assistant: string | null;
  error: string | null;
  setError: (error: string | null) => void;
  onLinked: (link: SurfaceLink) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const confirm = useConfirmSurfaceLink();
  const remove = useRemoveSurfaceLink();
  const yes = () => {
    setError(null);
    confirm.mutate(link.id, {
      onSuccess: (done) => {
        haptics.success();
        onLinked(done);
      },
      onError: (e) => {
        haptics.warning();
        setError(errorText(t, e));
      },
    });
  };
  // The sender's pending link ends, and the sheet goes back to a fresh code.
  const notMe = () => {
    setError(null);
    remove.mutate(link.id, { onError: (e) => setError(errorText(t, e)) });
  };
  return (
    <View style={styles.col}>
      <Text variant="title">{t("mobile.surface.confirmTitle", { surface })}</Text>
      <View style={[styles.sender, { backgroundColor: c.sunken }]}>
        <Text variant="small" tone="muted">
          {t("mobile.surface.sentBy")}
        </Text>
        {link.display ? (
          <Text variant="body" selectable style={styles.strong}>
            {link.display}
          </Text>
        ) : null}
        {link.profileName ? (
          <Text variant="body" tone="ink2" selectable>
            {link.profileName}
          </Text>
        ) : null}
      </View>
      <Text variant="body" tone="muted">
        {t("mobile.surface.onlyYou")}
      </Text>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {assistant ? (
        <Text variant="small" tone="muted">
          {t("surface.link.consent", { assistant, surface })}
        </Text>
      ) : (
        <ActivityIndicator color={c.muted} />
      )}
      <Button
        variant="primary"
        wide
        label={t("mobile.surface.confirm")}
        loading={confirm.isPending}
        disabled={!assistant || remove.isPending}
        onPress={yes}
      />
      <Button
        variant="ghost"
        wide
        label={t("mobile.surface.notMe")}
        loading={remove.isPending}
        disabled={confirm.isPending}
        onPress={notMe}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  col: { gap: 16 },
  code: { alignItems: "center", gap: 4 },
  mono: { fontFamily: MONO, fontSize: 22, letterSpacing: 2 },
  making: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48 },
  sender: { borderRadius: 14, padding: 16, gap: 4 },
  strong: { fontWeight: "600" },
});
