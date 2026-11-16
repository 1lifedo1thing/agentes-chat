import { useArtifact } from "@agenteschat/client";
import { keepWhole } from "@agenteschat/client/lib/format";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import {
  type CommonZoomState,
  fitContainer,
  Gallery,
  type GalleryRefType,
  type VerticalPullOptions,
} from "react-native-zoom-toolkit";
import { Icon, type IconName, PressScale, SCREEN_X, Text, ToastHost } from "@/ui";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { savedAt, useFileActions, useSavedWhen } from "./actions";
import { decodeFileList, fileInfo, pageStep } from "./logic";
import { useRemoteFile } from "./source";
import { tellViewerPlace } from "./viewer-place";
import { DISMISS_DISTANCE, DISMISS_VELOCITY, MAX_ZOOM } from "./zoom";

/**
 * A message's pictures, full screen, as the phone's own photos: black, the name, "2 de 4" and who sent it on top;
 * pinch to zoom around the fingers, double tap to zoom in at that spot or back out, drag a zoomed picture with its
 * momentum and an elastic edge (react-native-zoom-toolkit's Gallery); swipe or ‹ › on the sides between the pictures;
 * pull down (or up) to close, the picture following the finger as the black fades; and Compartilhar, Salvar em
 * Fotos, Ver no Drive at the bottom. A tap hides and shows the bars.
 */
export function ImageViewer({
  files: rawFiles,
  at,
  from,
}: {
  files: string | string[] | undefined;
  at: string | undefined;
  /** The stack it opened from, told where the person stops. */
  from?: string | undefined;
}) {
  return (
    // Toasts show inside the modal (the app's host sits under it).
    <ToastHost>
      <Viewer rawFiles={rawFiles} at={at} from={from} />
    </ToastHost>
  );
}

const WHITE = "#fff";
const DIM = "rgba(255,255,255,0.6)";
const PLATE = "rgba(255,255,255,0.14)";
/** ‹ and ›'s plate: they sit on the picture itself, and a white chevron on a light plate vanishes on a light picture. */
const SCRIM = "rgba(0,0,0,0.45)";
/** The round buttons over the picture. */
const ROUND = 44;

function Viewer({
  rawFiles,
  at,
  from,
}: {
  rawFiles: string | string[] | undefined;
  at: string | undefined;
  from: string | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const savedWhen = useSavedWhen();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const gallery = useRef<GalleryRefType>(null);
  const files = decodeFileList(rawFiles);
  const first = Math.min(Math.max(Number(at) || 0, 0), Math.max(files.length - 1, 0));
  const [index, setIndex] = useState(first);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const drag = useSharedValue(0);
  const scale = useSharedValue(1);
  // Closing once: the gallery tells a released pull again on every frame while the picture settles, and each close
  // was another step back (the conversation went too).
  const closing = useSharedValue(false);
  const current = files[index];
  const detail = useArtifact(orgId, current?.id ?? null, current?.version).data;
  const actions = useFileActions(detail);
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    goBack();
  }, []);
  useEffect(() => {
    if (from) tellViewerPlace(from, index);
  }, [from, index]);

  // The gallery's state, on the UI thread: zoomed in, the side buttons step aside as the swipe does.
  const onUpdate = useCallback(
    (state: CommonZoomState<number>) => {
      "worklet";
      scale.value = state.scale;
    },
    [scale],
  );
  useAnimatedReaction(
    () => scale.value > 1.01,
    (now, before) => {
      if (now !== before) scheduleOnRN(setZoomed, now);
    },
  );
  // Pulled down or up at its own size: the picture follows the finger (the gallery moves it) and the black fades;
  // let go far or fast enough, the viewer closes, else everything settles back.
  const onVerticalPull = useCallback(
    (pull: VerticalPullOptions) => {
      "worklet";
      if (closing.value) return;
      if (!pull.released) {
        drag.value = pull.translateY;
        return;
      }
      if (Math.abs(pull.translateY) > DISMISS_DISTANCE || Math.abs(pull.velocityY) > DISMISS_VELOCITY) {
        closing.value = true;
        scheduleOnRN(close);
        return;
      }
      drag.value = withTiming(0, { duration: 200 });
    },
    [drag, close, closing],
  );
  const onTap = useCallback(() => setChrome((v) => !v), []);

  const prev = pageStep(index, -1, files.length);
  const next = pageStep(index, 1, files.length);
  // The side buttons: the gallery slides there, as a swipe would.
  const turn = (to: number | null) => {
    if (to === null) return;
    gallery.current?.setIndex(to);
  };

  const backdrop = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(Math.abs(drag.value) / (height * 0.6), 0.85),
  }));

  const info = detail ? fileInfo(detail) : null;
  const author = detail ? dir.nameOf(detail.createdBy) : "";
  const place = files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : "";
  const sub = detail
    ? [place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")
    : keepWhole(place);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden={!chrome} animated />
      <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
      <Gallery
        ref={gallery}
        data={files}
        keyExtractor={(f) => `${f.id}@${f.version ?? ""}`}
        initialIndex={first}
        // The one in sight and one each side: they load as they come near.
        windowSize={3}
        maxScale={MAX_ZOOM}
        onIndexChange={setIndex}
        onTap={onTap}
        onUpdate={onUpdate}
        onVerticalPull={onVerticalPull}
        renderItem={(f) => (
          <Picture
            id={f.id}
            {...(f.version !== undefined ? { version: f.version } : {})}
            width={width}
            height={height}
          />
        )}
      />

      <Chrome visible={chrome} drag={drag} style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Round icon="x" label={t("mobile.common.close")} onPress={close} />
        <View style={styles.spacer} />
        <Round icon="more" label={t("mobile.files.more")} onPress={() => actions.more(true)} disabled={!detail} />
        {/* The name and its line on a row of their own under the buttons, the screen's width: never cut beside them. */}
        <View style={styles.title}>
          <Text variant="subhead" style={[styles.bold, { color: WHITE }]} numberOfLines={3}>
            {info?.name ?? ""}
          </Text>
          <Text variant="footnote" style={{ color: DIM }}>
            {sub}
          </Text>
        </View>
      </Chrome>

      {/* Gone while zoomed, as the swipe is: the fingers move the picture then. */}
      {files.length > 1 ? (
        <Chrome visible={chrome && !zoomed} drag={drag} style={[styles.sides, { top: height / 2 - ROUND / 2 }]}>
          {prev !== null ? (
            <View style={[styles.side, { left: insets.left + 12 }]}>
              <Round icon="left" label={t("mobile.files.previous")} plate={SCRIM} onPress={() => turn(prev)} />
            </View>
          ) : null}
          {next !== null ? (
            <View style={[styles.side, { right: insets.right + 12 }]}>
              <Round icon="right" label={t("mobile.files.next")} plate={SCRIM} onPress={() => turn(next)} />
            </View>
          ) : null}
        </Chrome>
      ) : null}

      <Chrome visible={chrome} drag={drag} style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
        <View style={styles.actions}>
          {detail?.inDrive !== false ? (
            <Action icon="person" label={t("share.button")} disabled={!detail} onPress={actions.shareSheet} />
          ) : null}
          <Action
            icon="share"
            label={t("mobile.files.send")}
            busy={actions.busy === "share"}
            disabled={!detail}
            onPress={actions.share}
          />
          <Action
            icon="photos"
            label={t("mobile.files.savePhotos")}
            busy={actions.busy === "photos"}
            disabled={!detail}
            onPress={actions.savePhotos}
          />
          <Action icon="drive" label={t("mobile.files.drive")} disabled={!detail} onPress={actions.drive} />
        </View>
      </Chrome>
    </View>
  );
}

/** One picture, fitted whole in the screen once its size is known (the gallery zooms and moves it). */
function Picture({ id, version, width, height }: { id: string; version?: number; width: number; height: number }) {
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, id, version);
  const [ratio, setRatio] = useState<number | null>(null);
  const size = ratio ? fitContainer(ratio, { width, height }) : { width, height };
  if (!link.data)
    return (
      <View style={[styles.center, { width, height }]}>
        {link.isError ? <Icon name="image" size={30} color={DIM} /> : <ActivityIndicator color={WHITE} />}
      </View>
    );
  return (
    <View style={size}>
      <Image
        source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${id}@${version ?? "latest"}` }}
        recyclingKey={`${id}@${version ?? "latest"}`}
        contentFit="contain"
        transition={160}
        onLoad={(e) => {
          if (e.source.width > 0 && e.source.height > 0) setRatio(e.source.width / e.source.height);
        }}
        style={StyleSheet.absoluteFill}
        accessible={false}
      />
      {ratio ? null : (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator color={WHITE} />
        </View>
      )}
    </View>
  );
}

/** The bars: fade with a tap, and while the picture is dragged away. */
function Chrome({
  visible,
  drag,
  style,
  children,
}: {
  visible: boolean;
  drag: SharedValue<number>;
  style: object[];
  children: ReactNode;
}) {
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.value = withTiming(visible ? 1 : 0, { duration: 180 });
  }, [visible, shown]);
  const anim = useAnimatedStyle(() => ({
    opacity: shown.value * (1 - Math.min(Math.abs(drag.value) / 80, 1)),
  }));
  return (
    <Animated.View pointerEvents={visible ? "box-none" : "none"} style={[...style, anim]}>
      {children}
    </Animated.View>
  );
}

function Round({
  icon,
  label,
  onPress,
  disabled = false,
  plate = PLATE,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  plate?: string;
}) {
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[styles.round, { backgroundColor: plate }]}
      contentStyle={styles.center}
    >
      <Icon name={icon} size={20} color={WHITE} />
    </PressScale>
  );
}

function Action({
  icon,
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressScale
      to={0.92}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      style={styles.action}
      contentStyle={styles.actionIn}
    >
      <View style={[styles.circle, { backgroundColor: PLATE }]}>
        {busy ? <ActivityIndicator color={WHITE} /> : <Icon name={icon} size={20} color={WHITE} />}
      </View>
      <Text variant="caption" style={[styles.bold, { color: WHITE }]} numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  black: { backgroundColor: "#000" },
  top: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  spacer: { flex: 1 },
  title: { flexBasis: "100%", gap: 2 },
  bold: { fontWeight: "600" },
  round: { width: ROUND, height: ROUND, borderRadius: ROUND / 2 },
  center: { alignItems: "center", justifyContent: "center" },
  sides: { position: "absolute", left: 0, right: 0, height: ROUND },
  side: { position: "absolute", top: 0 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 6 },
  actions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: SCREEN_X, paddingTop: 10 },
  action: { minWidth: 88 },
  actionIn: { alignItems: "center", gap: 6 },
  circle: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
});
