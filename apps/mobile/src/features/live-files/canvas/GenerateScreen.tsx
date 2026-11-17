import {
  type ImageAspect,
  type ImageModelOption,
  MAX_IMAGES_PER_REQUEST,
  useGenerateImages,
  useImageModels,
} from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { readShapeById } from "@agenteschat/live/canvas";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type * as Y from "yjs";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  Icon,
  PressScale,
  ProviderLogo,
  SCREEN_X,
  Segmented,
  Text,
  useTheme,
} from "@/ui";
import { goBack } from "@/ui/navigation";
import { openConnectAi } from "../../ai/NoAiCard";
import { LoadFailed } from "../../shared/FirstUse";
import { useErrorToast, useOrgId } from "../../shared/hooks";
import { pickOne } from "../../shared/PickerSheet";
import { PushedHeader } from "../../shared/parts";
import { TextArea } from "../../shared/TextArea";
import { useLiveDoc } from "../shared/useLiveDoc";
import { useFilePictures } from "../slides/pictures";
import type { Pt } from "./camera";
import { aspectChoices, countChoices, pickModel } from "./generate";
import { revealLater } from "./reveal";

/**
 * "Gerar imagem" on the phone (ADR 0195), a pushed screen over the canvas: what the pictures should show, the model
 * (the workspace's default first, each with its maker's mark), their shape, how many (one to four) and the canvas's
 * chosen pictures to start from (when the model takes them). "Gerar" puts the placeholders on the canvas and goes back
 * to it, which brings them into view; they turn into the pictures as they come. With no key for any image model, it
 * says which keys work and leads to connecting one.
 */
export function GenerateScreen({ id, refs, at }: { id: string; refs: readonly string[]; at: Pt | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const models = useImageModels(orgId);
  const live = useLiveDoc(id, { kind: "canvas" });
  return (
    <>
      <PushedHeader title={t("live.images.title")} />
      {models.isError ? (
        <View style={styles.middle}>
          <LoadFailed onRetry={() => void models.refetch()} />
        </View>
      ) : !models.data ? (
        <View style={styles.middle} accessible accessibilityLabel={t("live.images.loadingModels")}>
          <ActivityIndicator />
        </View>
      ) : models.data.length === 0 ? (
        <NoKey />
      ) : (
        <GenerateForm
          fileId={id}
          orgId={orgId}
          models={models.data}
          refs={refs}
          at={at}
          doc={live.room?.doc ?? null}
          offline={live.status === "offline"}
        />
      )}
    </>
  );
}

/** No key for any image model: which ones work, and the way to connect one (for whoever may add keys). */
function NoKey() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <View style={styles.middle}>
      <EmptyState
        size="page"
        icon="sparkle"
        title={t("live.images.noKey")}
        action={
          can(org, "manage_credentials") ? (
            <Button
              variant="secondary"
              label={t("live.images.connect")}
              onPress={() => openConnectAi({ intent: "api_key" })}
            />
          ) : undefined
        }
      />
    </View>
  );
}

function GenerateForm({
  fileId,
  orgId,
  models,
  refs,
  at,
  doc,
  offline,
}: {
  fileId: string;
  orgId: string;
  models: readonly ImageModelOption[];
  refs: readonly string[];
  at: Pt | null;
  doc: Y.Doc | null;
  offline: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const insets = useSafeAreaInsets();
  const failed = useErrorToast();
  const generate = useGenerateImages(orgId, fileId);
  const picture = useFilePictures(orgId, fileId);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const model = pickModel(models, modelId);
  const aspects = aspectChoices(model);
  const [aspectWanted, setAspect] = useState<ImageAspect>("1:1");
  const aspect = aspects.includes(aspectWanted) ? aspectWanted : (aspects[0] ?? "1:1");
  const counts = countChoices(model, MAX_IMAGES_PER_REQUEST);
  const [countWanted, setCount] = useState(1);
  const count = Math.min(countWanted, counts.length);
  // The chosen pictures to start from, as the canvas has them now (one deleted meanwhile is left out).
  const [kept, setKept] = useState<readonly string[]>(refs);
  const references = useMemo(
    () =>
      kept.flatMap((id) => {
        const s = doc ? readShapeById(doc, id, { text: false }) : null;
        return s?.type === "image" && s.asset ? [{ id, asset: s.asset }] : [];
      }),
    [kept, doc],
  );
  const usesRefs = model?.refs !== false && references.length > 0;
  const price =
    model?.pricePerImage !== undefined
      ? new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD", maximumFractionDigits: 3 }).format(
          model.pricePerImage * count,
        )
      : null;
  const ready = prompt.trim().length > 0 && !!model && !offline && !generate.isPending;

  const chooseModel = async () => {
    const picked = await pickOne({
      title: t("live.images.model"),
      value: model?.id ?? null,
      options: models.map((m) => ({
        key: m.id,
        label: m.label,
        leading: { kind: "node" as const, node: <ProviderLogo id={m.provider} size="sm" /> },
      })),
    });
    if (picked) setModelId(picked);
  };

  const send = async () => {
    if (!ready || !model) return;
    try {
      const made = await generate.mutateAsync({
        prompt: prompt.trim(),
        count,
        aspect,
        model: model.id,
        ...(usesRefs ? { references: references.map((r) => r.id) } : {}),
        ...(at ? { at } : {}),
      });
      revealLater(fileId, made.shapeIds.length > 0 ? made.shapeIds : made.frameId ? [made.frameId] : []);
      haptics.success();
      goBack();
    } catch (error) {
      failed(error);
    }
  };

  return (
    <KeyboardAwareScrollView
      style={[styles.fill, { backgroundColor: c.grouped }]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      bottomOffset={24}
      contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
    >
      <TextArea
        value={prompt}
        onChangeText={setPrompt}
        autoFocus
        minHeight={120}
        placeholder={t("live.images.prompt")}
        accessibilityLabel={t("live.images.promptLabel")}
      />

      {references.length > 0 ? (
        <View style={styles.block}>
          <GroupedHeader>{t("live.images.references")}</GroupedHeader>
          <View style={styles.refs}>
            {references.map((r) => (
              <View key={r.id} style={[styles.ref, { backgroundColor: c.sunken }]}>
                <Image
                  source={picture(r.asset)}
                  contentFit="cover"
                  style={[StyleSheet.absoluteFill, styles.refPicture]}
                  accessible={false}
                />
                <PressScale
                  onPress={() => setKept((list) => list.filter((x) => x !== r.id))}
                  accessibilityRole="button"
                  accessibilityLabel={t("live.images.removeReference")}
                  hitSlop={8}
                  style={[styles.remove, { backgroundColor: c.raised, boxShadow: shadows.e1 }]}
                >
                  <Icon name="x" size={12} color={c.ink} />
                </PressScale>
              </View>
            ))}
          </View>
          {model?.refs === false ? (
            <Text variant="footnote" tone="faint" style={styles.note}>
              {t("live.images.noRefs")}
            </Text>
          ) : null}
        </View>
      ) : null}

      <GroupedList>
        <GroupedRow
          label={t("live.images.model")}
          value={model?.label ?? ""}
          valueLeading={model ? <ProviderLogo id={model.provider} size="xs" /> : undefined}
          menu
          onPress={() => void chooseModel()}
        />
      </GroupedList>

      <View style={styles.block}>
        <GroupedHeader>{t("live.images.aspect")}</GroupedHeader>
        <Segmented
          wide
          items={aspects.map((a) => ({
            key: a,
            label: a,
            accessibilityLabel: t("mobile.live.generate.aspect", { a }),
          }))}
          value={aspect}
          onChange={(key) => setAspect(key as ImageAspect)}
        />
      </View>

      {counts.length > 1 ? (
        <View style={styles.block}>
          <GroupedHeader>{t("live.images.count")}</GroupedHeader>
          <Segmented
            wide
            items={counts.map((n) => ({ key: String(n), label: String(n) }))}
            value={String(count)}
            onChange={(key) => setCount(Number(key))}
          />
        </View>
      ) : null}

      {offline ? (
        <Text variant="footnote" tone="faint" style={styles.note}>
          {t("live.images.offline")}
        </Text>
      ) : null}

      <View style={styles.go}>
        <PressScale
          onPress={() => void send()}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityLabel={t("live.images.generate")}
          accessibilityState={{ disabled: !ready, busy: generate.isPending }}
          style={[styles.agent, { backgroundColor: c.raised, boxShadow: shadows.e1 }, !ready && styles.off]}
        >
          {generate.isPending ? (
            <ActivityIndicator size="small" color={c.ink} />
          ) : (
            <Icon name="sparkle" size={18} color={c.agent} />
          )}
          <Text variant="body" style={styles.bold}>
            {t("live.images.generate")}
          </Text>
        </PressScale>
        {price ? (
          <Text variant="footnote" tone="faint" style={styles.price}>
            {t("live.images.price", { price })}
          </Text>
        ) : null}
      </View>
    </KeyboardAwareScrollView>
  );
}

const REF = 64;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SCREEN_X },
  in: { paddingHorizontal: SCREEN_X, paddingTop: 16, gap: 24 },
  block: { gap: 8 },
  refs: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  ref: { width: REF, height: REF, borderRadius: 10 },
  refPicture: { borderRadius: 10 },
  remove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  note: { paddingHorizontal: 4 },
  go: { gap: 8 },
  // The agent's look: an AI makes these pictures (the app's cut corner at the bottom left).
  agent: {
    minHeight: 48,
    borderRadius: 15,
    borderBottomLeftRadius: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  bold: { fontWeight: "600" },
  price: { textAlign: "center" },
  off: { opacity: 0.5 },
});
