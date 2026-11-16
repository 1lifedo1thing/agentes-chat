import type { AiAccounts as AiAccountsView, Credential } from "@agenteschat/client";
import {
  keys,
  useAiAccounts,
  useAiStatus,
  useApi,
  useCredentials,
  useMachines,
  usePlatformKey,
  useSettings,
  useUpdateSettings,
} from "@agenteschat/client";
import {
  accountTitle,
  agentsToGive,
  endsOnClaude,
  identityUnknown,
  keyRemovalText,
  offersSignInAgain,
  onSeveralComputers,
  ownSignIns,
  ownSignInTitle,
  signInOf,
} from "@agenteschat/client/lib/ai-accounts";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText, keyRefusal } from "@agenteschat/client/lib/errors";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentAi, aiStateOf, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { settingsSectionNameKey, settingsSectionTextKey } from "@agenteschat/client/lib/personal-view";
import { planOf } from "@agenteschat/client/lib/plans";
import { keyCopiesLine, keyName, keyNamedAfterProvider, keySource, shownKeys } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, GroupedList, GroupedRow, InfoHint, Locked, ProviderLogo, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { personalAiParts } from "../settings/logic";
import { chooseAction } from "../settings/parts";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { PromptForm, SheetTitle } from "../shared/PromptForm";
import { errorHaptic, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { PlanMeter } from "../usage/parts";
import { openKeyForAll } from "./KeyForAllScreen";
import { openConnectAi } from "./NoAiCard";
import { alertKeyRefused, Note, PasteField, PlanHoldNote, usePlanHold } from "./parts";

/*
 * Contas de IA, as the web's Settings › Contas de IA (ADR 0059, ADR 0061): "Seus planos", first the sign-ins of the
 * computers the person connected ("Conta deste computador", the agents there think with them), then their own
 * accounts on every computer, each with its plan's meter and the agents it thinks for, renamed (in a sheet), signed
 * in again (a new key for a coding plan) on its plan's page of Connect an AI, given to one more agent where it thinks
 * for all of them, or disconnected here; then the workspace's API keys (admins), the default one, a key swapped (in a
 * sheet) or deleted. Connecting a new one is the same picker as everywhere ("Conectar uma IA").
 */

type Account = AiAccountsView["accounts"][number];

/**
 * An account's actions (the web's row buttons): the system's action sheet on iOS, the app's sheet on Android, which
 * holds them all (Android's dialog kept three, and "Usar para …" for a fourth agent was lost).
 */
const choose = chooseAction;

/** An account's name, as the server keeps it. */
const NAME_LIMIT = { max: 40 };
/** No provider's key is shorter: a key cut short never goes. */
const KEY_MIN = 8;

export function AiAccountsScreen() {
  return (
    <SheetHostProvider>
      <AiAccounts />
    </SheetHostProvider>
  );
}

function AiAccounts() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  /** A computer's name in this workspace's words (a personal one's: its person's agents', ADR 0159). */
  const computerOf = (name: string) => computerNameOf(t, org?.name ?? "", name, isPersonal(org));
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const ai = useAiAccounts(orgId);
  const machines = useMachines(orgId);
  const dir = useDirectory();
  const meId = useMeId();
  const status = useAiStatus(orgId);
  const sheet = useSheet();
  const hold = usePlanHold(orgId, org);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  const rows = ai.data?.accounts ?? [];
  const own = ownSignIns(ai.data);
  const several = onSeveralComputers(rows);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
  const failed = () => {
    errorHaptic();
    toast({ title: t("agentPage.work.failed"), icon: "x" });
  };

  // Renaming in the app's own sheet, on every system (the system's text prompt is iOS's alone).
  const rename = (a: Account) =>
    sheet.open(
      <PromptForm
        title={t("aiAccounts.page.renameTitle", { label: a.label })}
        intro={t("aiAccounts.done.name")}
        placeholder={t("aiAccounts.page.nameLabel")}
        submitLabel={t("common.save")}
        initial={a.label}
        limit={NAME_LIMIT}
        onSubmit={async (text) => {
          // A name is one line, however it was typed or pasted.
          const name = text.replace(/\s+/g, " ").trim();
          if (!name || name === a.label) return sheet.close();
          try {
            await api.machines.renameAccount(orgId, a.machineId, a.id, name);
            successHaptic();
            toast({ title: t("aiAccounts.page.renamed", { label: name }), icon: "check" });
            refetch();
            sheet.close();
          } catch {
            failed();
          }
        }}
      />,
    );
  // Signing in again (a coding plan's new key) on its plan's page of Connect an AI, a screen with room for the keyboard:
  // that exact login, for one of the person's agents that thinks with it, else on its own.
  const signInAgain = (a: Account) => {
    const agentId = a.usedByIds?.find((id) => {
      const agent = dir.agentById.get(id);
      return agent !== undefined && (agent.ownerUserId === meId || isRightHand(agent));
    });
    openConnectAi({
      plan: planOfAccount(a),
      again: a.id,
      ...(a.email ? { email: a.email } : {}),
      ...(agentId ? { agentId } : {}),
    });
  };
  const names = (list: string[]) => joinNames(list, t);
  const machineOf = (a: Account) => machines.data?.find((m) => m.id === a.machineId);
  // One more of the person's agents thinks with an account made for all of them there: no sign-in.
  const give = (a: Account, agent: { id: string; name: string }) =>
    api.agents.setBrain(orgId, agent.id, { brain: a.kind, account: a.id }).then(() => {
      successHaptic();
      toast({ title: t("aiAccounts.done.savedAgent", { agent: agent.name, label: a.label }), icon: "check" });
      refetch();
      for (const key of [keys.agents(orgId), keys.aiStatus(orgId), keys.agentBrain(orgId, agent.id)])
        void qc.invalidateQueries({ queryKey: key });
    }, failed);
  const remove = (a: Account) =>
    Alert.alert(
      t("aiAccounts.page.disconnectTitle", { label: a.label }),
      [
        a.usedBy.length > 0
          ? t("aiAccounts.page.disconnectAgents", {
              count: a.usedBy.length,
              agents: names(a.usedBy),
              computer: computerOf(a.computer),
            })
          : t("aiAccounts.page.disconnectNone", { computer: computerOf(a.computer) }),
        ...(endsOnClaude(a, machineOf(a)) ? [t("aiAccounts.page.revokeOnClaude")] : []),
      ].join(" "),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("aiAccounts.page.disconnect"),
          style: "destructive",
          onPress: () =>
            api.machines.removeAccount(orgId, a.machineId, a.id).then(() => {
              successHaptic();
              toast({ title: t("aiAccounts.page.disconnected", { label: a.label }), icon: "check" });
              refetch();
              void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            }, failed),
        },
      ],
    );
  const actions = (a: Account) => {
    const plan = planOf(a.provider);
    const out = offersSignInAgain(a);
    const toGive = meId
      ? agentsToGive({
          account: a,
          agents: dir.agents,
          machine: machineOf(a),
          viewerId: meId,
          onKey: (id) => agentAi(dir.agentById.get(id), aiStateOf(status.data, id)) === "key",
        })
      : [];
    choose(
      a.label,
      [
        ...toGive.map((g) => ({
          label: t("aiAccounts.page.useFor", agentGrammar(g.name)),
          onPress: () => void give(a, g),
        })),
        ...(plan && a.status === "active"
          ? [{ label: t("aiAccounts.page.useAll"), onPress: () => openKeyForAll(a.machineId, a.id) }]
          : []),
        { label: t("aiAccounts.page.rename"), onPress: () => rename(a) },
        ...(out || plan
          ? [
              {
                label: plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain"),
                onPress: () => signInAgain(a),
              },
            ]
          : []),
        { label: t("aiAccounts.page.disconnect"), destructive: true, onPress: () => remove(a) },
      ],
      t("common.cancel"),
    );
  };

  // Under a hold its note says what comes first: an invitation to connect a plan would contradict it.
  const none = !hold && ai.isSuccess && rows.length === 0 && own.length === 0;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t(isPersonal(org) ? "settings.section.keysPersonal" : "mobile.ai.row")}
        solid={false}
        grouped
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.sectionHead}>
          <InfoHint
            name={t("common.about", { label: t("aiAccounts.page.title") })}
            text={t("aiAccounts.page.hint")}
            variant="title"
          >
            <Text variant="title" tone="ink">
              {t("aiAccounts.page.title")}
            </Text>
          </InfoHint>
        </View>
        {hold ? <PlanHoldNote org={org} /> : null}
        {ai.isLoading ? <ActivityIndicator color={c.muted} /> : null}
        {ai.isError && !ai.data ? <LoadFailed onRetry={() => void ai.refetch()} /> : null}
        {none ? (
          <FirstUse place="ai" size="panel" acts label={t("aiAccounts.page.connect")} onPress={() => openConnectAi()} />
        ) : null}
        {/* Settings' own groups on the grouped gray: the mark in the 32 pt column, the hairline from the text on. */}
        {own.length > 0 ? (
          <GroupedList>
            {own.map((o) => (
              <GroupedRow
                key={o.key}
                leading={<ProviderLogo id={o.kind} size="sm" />}
                label={ownSignInTitle(t, o)}
                sub={t("aiAccounts.page.ownOn", { computer: o.computer })}
                below={
                  o.usage ? (
                    <View style={styles.below}>
                      <PlanMeter usage={o.usage} compact />
                    </View>
                  ) : undefined
                }
              />
            ))}
          </GroupedList>
        ) : null}
        {rows.length > 0 ? (
          <GroupedList>
            {rows.map((a) => {
              const plan = planOf(a.provider);
              const out = signInOf(a) === "signed_out";
              const unknown = signInOf(a) === "unknown";
              const facts = [
                a.email ??
                  (a.keyHint
                    ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
                    : identityUnknown(a, machineOf(a))
                      ? t("aiAccounts.page.identityUnknown")
                      : null),
                several ? t("aiAccounts.page.on", { computer: computerOf(a.computer) }) : null,
                a.usedBy.length > 0
                  ? t("aiAccounts.page.usedBy", { count: a.usedBy.length, agents: names(a.usedBy) })
                  : t("aiAccounts.page.noAgent"),
              ].filter(Boolean);
              return (
                <GroupedRow
                  key={a.id}
                  leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" off={out} />}
                  label={accountTitle(a)}
                  sub={facts.join(" · ")}
                  more
                  onPress={() => actions(a)}
                  below={
                    out || unknown || a.usage || (plan && !plan.usage) ? (
                      <View style={styles.below}>
                        {out ? (
                          <Note icon="x">
                            {plan ? t("aiAccounts.page.keyRefused") : t("aiAccounts.page.signedOut")}
                          </Note>
                        ) : null}
                        {unknown ? <Note icon="info">{t("aiAccounts.page.statusUnknown")}</Note> : null}
                        {a.usage ? (
                          <PlanMeter usage={a.usage} compact />
                        ) : plan && !plan.usage ? (
                          <Text variant="small" tone="muted">
                            {t("aiAccounts.usage.notShared", { maker: plan.maker })}
                          </Text>
                        ) : null}
                      </View>
                    ) : undefined
                  }
                />
              );
            })}
          </GroupedList>
        ) : null}
        {none || hold ? null : (
          <View style={styles.start}>
            <Button
              size="sm"
              variant={rows.length || own.length ? "secondary" : "primary"}
              icon="plus"
              label={t("aiAccounts.page.connect")}
              onPress={() => openConnectAi()}
            />
          </View>
        )}
        {can(org, "manage_credentials") ? <KeysSection locale={i18n.language} /> : null}
        <PersonalParts />
      </ScrollView>
    </View>
  );
}

/**
 * AI and apps in a personal workspace (ADR 0159 §3): Connectors and MCPs and Skills at the foot of the AI accounts,
 * those this person opens, each a row to its own screen as in Settings. Nothing in a team's workspace.
 */
function PersonalParts() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const parts = isPersonal(org) ? personalAiParts(org) : [];
  if (parts.length === 0) return null;
  return (
    <View style={styles.keysHead}>
      <GroupedList>
        {parts.map((s) => (
          <GroupedRow
            key={s.id}
            icon={s.icon}
            label={t(settingsSectionNameKey(org, s.id))}
            sub={t(settingsSectionTextKey(org, s.id))}
            subLines={2}
            chevron
            onPress={() => router.push(s.href as never)}
          />
        ))}
      </GroupedList>
    </View>
  );
}

/** The workspace's API keys (the web's "Chaves de provedor"): the default one, a key swapped or deleted. */
function KeysSection({ locale }: { locale: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const held = usePlanHold(orgId, org) !== null;
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const credentials = useCredentials(orgId);
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const all = (credentials.data ?? []).filter((k) => !k.revokedAt);
  const live = shownKeys(credentials.data ?? []);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
  const failed = (error: unknown) => {
    errorHaptic();
    const refusal = keyRefusal(t, error);
    if (refusal) alertKeyRefused(t, refusal);
    else toast({ title: errorText(t, error), icon: "x" });
  };
  const platform = usePlatformKey(orgId);
  const sheet = useSheet();

  // Replacing a key in the app's own sheet, on every system: the new key hidden as it is typed or pasted. A refused
  // key keeps the sheet open, with what it said.
  const rotate = (k: Credential) =>
    sheet.open(
      <KeyPrompt
        title={t("settings.rotateTitle", { label: k.label })}
        intro={t("settings.rotateHelp")}
        submitLabel={t("settings.saveKey")}
        onSubmit={(apiKey) =>
          api.agents.rotateCredential(orgId, k.id, { apiKey }).then((saved) => {
            successHaptic();
            toast({
              title:
                saved.check === "unchecked"
                  ? t("connectAi.key.savedUnchecked", { provider: keyName(k) })
                  : t("settings.rotated"),
              icon: "check",
            });
            refetch();
            sheet.close();
          }, failed)
        }
      />,
    );
  const remove = (k: Credential) =>
    Alert.alert(t("settings.removeTitle", { label: k.label }), keyRemovalText(t, k, all, platform.data === true), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.remove"),
        style: "destructive",
        onPress: () =>
          api.agents.removeCredential(orgId, k.id, true, true).then(() => {
            successHaptic();
            refetch();
            void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            void qc.invalidateQueries({ queryKey: keys.agentPages(orgId) });
          }, failed),
      },
    ]);
  const removeCopies = (k: Credential) =>
    Alert.alert(t("settings.removeCopiesTitle", { label: k.label }), t("settings.removeCopiesText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.removeCopies"),
        onPress: () =>
          api.agents.removeCredentialCopies(orgId, k.id).then(({ removed }) => {
            successHaptic();
            toast({ title: t("settings.copiesRemoved", { count: removed }), icon: "check" });
            refetch();
            void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            void qc.invalidateQueries({ queryKey: keys.agentPages(orgId) });
          }, failed),
      },
    ]);
  const actions = (k: Credential, isDefault: boolean) =>
    choose(
      k.label,
      [
        ...(isDefault
          ? []
          : [{ label: t("settings.makeDefault"), onPress: () => update.mutate({ defaultCredentialId: k.id }) }]),
        ...(held ? [] : [{ label: t("settings.rotate"), onPress: () => rotate(k) }]),
        ...(k.copies ? [{ label: t("settings.removeCopies"), onPress: () => removeCopies(k) }] : []),
        { label: t("settings.remove"), destructive: true, onPress: () => remove(k) },
      ],
      t("common.cancel"),
    );

  return (
    <>
      <View style={[styles.sectionHead, styles.keysHead]}>
        <Text variant="title" tone="ink">
          {t("settings.keysTitle")}
        </Text>
        <Text variant="small" tone="muted">
          {t("settings.keysSubtitle")}
        </Text>
      </View>
      {credentials.isLoading ? <ActivityIndicator color={c.muted} /> : null}
      {credentials.isSuccess && live.length === 0 ? (
        <Text variant="small" tone="muted">
          {t("settings.noKeys")}
        </Text>
      ) : null}
      {live.length > 0 ? (
        <GroupedList>
          {live.map((k) => {
            const isDefault = settings.data?.defaultCredentialId === k.id;
            return (
              <GroupedRow
                key={k.id}
                leading={<ProviderLogo id={k.provider} size="sm" />}
                label={k.label}
                sub={[
                  keyNamedAfterProvider(k) ? null : keySource(k),
                  t("settings.keyEndsIn", { hint: k.keyHint }),
                  t("settings.keyAdded", { when: relativeTime(t, locale, k.createdAt) }),
                  keyCopiesLine(t, k),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                value={isDefault ? t("settings.default") : undefined}
                more
                onPress={() => actions(k, isDefault)}
              />
            );
          })}
        </GroupedList>
      ) : null}
      {held ? (
        <PlanHoldNote org={org} keys />
      ) : (
        <View style={styles.start}>
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            label={t("settings.addKey")}
            onPress={() => openConnectAi({ intent: "api_key" })}
          />
        </View>
      )}
    </>
  );
}

/**
 * One key asked in a sheet, as `PromptForm` asks one text: the title, a line of help, the key (hidden, with Paste while
 * the field is empty) and one button that waits for the save. Anything shorter than a key never goes.
 */
function KeyPrompt({
  title,
  intro,
  submitLabel,
  onSubmit,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  onSubmit: (key: string) => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = key.trim().length >= KEY_MIN;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSubmit(key.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SheetTitle title={title} />
      <Text variant="body" tone="muted">
        {intro}
      </Text>
      <Locked when={busy}>
        <PasteField
          value={key}
          onChangeText={setKey}
          onPasted={setKey}
          label={title}
          secret
          onSubmit={() => void submit()}
        />
      </Locked>
      <Button
        variant="primary"
        wide
        label={submitLabel}
        loading={busy}
        disabled={!ready}
        onPress={() => void submit()}
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The settings screens' side margin: the groups on the same 16 pt edge as everywhere else.
  in: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  sectionHead: { gap: 4, paddingHorizontal: 2 },
  keysHead: { marginTop: 20 },
  below: { gap: 8, marginTop: 6 },
  start: { alignSelf: "flex-start" },
});
