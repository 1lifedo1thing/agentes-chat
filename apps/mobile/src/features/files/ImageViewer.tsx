import { useArtifact } from "@agenteschat/client";
import { keepWhole } from "@agenteschat/client/lib/format";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler";
import PagerView from "react-native-pager-view";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Icon, type IconName, PressScale, SCREEN_X, Text, ToastHost, useTheme } from "@/ui";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { savedAt, useFileActions, useSavedWhen } from "./actions";
import { decodeFileList, fileInfo, pageStep } from "./logic";
import { useRemoteFile } from "./source";
import { tellViewerPlace } from "./viewer-place";
import { ZoomPicture } from "./ZoomPicture";
import { pullCloses, pullDirection, pulledPlacement, pullProgress, type Size } from "./zoom";

/**
 * A message's pictures, full screen, as the phone's own photos: black, the name, "2 de 4" and who sent it on top;
 * pinch to zoom, double tap to zoom in at that spot or back out (`ZoomPicture`: the system's own zoom on iOS); swipe
 * between the pictures on the system's pager, a little black between them as they slide, or ‹ › on the sides; pull
 * down (or up) to close, the picture following the finger, smaller as it goes, as the black fades, and let go far or
 * fast enough it carries on away as the viewer closes, else it springs back; and Compartilhar, Salvar em Fotos, Ver
 * no Drive at the bottom. A tap hides and shows the bars; zooming in hides them.
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
    // Gestures and toasts get their own root in the modal (the app's sit under it).
    <GestureHandlerRootView style={styles.screen}>
      <ToastHost>
        <Viewer rawFiles={rawFiles} at={at} from={from} />
      </ToastHost>
    </GestureHandlerRootView>
  );
}

const WHITE = "#fff";
const DIM = "rgba(255,255,255,0.6)";
const PLATE = "rgba(255,255,255,0.14)";
/** ‹ and ›'s plate: they sit on the picture itself, and a white chevron on a light plate vanishes on a light picture. */
const SCRIM = "rgba(0,0,0,0.45)";
/** The round buttons over the picture. */
const ROUND = 44;
/** The black between two pictures as they slide. */
const GAP = 20;
/** A pull let go short of closing: back fast, with the slightest bounce (it was thrown). */
const BACK_SPRING = { stiffness: 700, damping: 50, mass: 1 };
/** A pull that closes: the picture carries on the way it was going, at the speed it left the finger. */
const AWAY_SPRING = { stiffness: 180, damping: 26, mass: 1, overshootClamping: true };

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
  const { reducedMotion } = useTheme();
  const { width, height } = useWindowDimensions();
  const screen = useMemo(() => ({ width, height }), [width, height]);
  const pager = useRef<PagerView>(null);
  const files = decodeFileList(rawFiles);
  const first = Math.min(Math.max(Number(at) || 0, 0), Math.max(files.length - 1, 0));
  const [index, setIndex] = useState(first);
  const [zoomed, setZoomed] = useState(false);
  const [paging, setPaging] = useState(false);
  const [chrome, setChrome] = useState(true);
  // The pull to close, in finger travel (the picture follows it loosely), and how far a closing picture carried on.
  const pullX = useSharedValue(0);
  const pullY = useSharedValue(0);
  const away = useSharedValue(0);
  // Closing once: a closing picture takes no other pull, and the viewer is one step back, never two.
  const leaving = useSharedValue(false);
  const drag = useDerivedValue(() => pullY.value + away.value);
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

  // Zoomed in, the pager holds still (the fingers move the picture), the side buttons step aside and the bars go.
  const onZoom = useCallback((now: boolean) => {
    setZoomed(now);
    if (now) setChrome(false);
  }, []);
  const onTap = useCallback(() => setChrome((v) => !v), []);

  const prev = pageStep(index, -1, files.length);
  const next = pageStep(index, 1, files.length);
  // The side buttons: the pager slides there, as a swipe would.
  const turn = (to: number | null) => {
    if (to === null) return;
    if (reducedMotion) pager.current?.setPageWithoutAnimation(to);
    else pager.current?.setPage(to);
  };

  const backdrop = useAnimatedStyle(() => ({ opacity: 1 - pullProgress(drag.value, height) }));

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
      <PagerView
        ref={pager}
        // As wide as the screen and the gap: each page holds its picture at the screen's width, the gap's black on
        // either side, seen only as they slide.
        style={[styles.pager, { width: width + GAP, marginLeft: -GAP / 2 }]}
        initialPage={first}
        scrollEnabled={!zoomed}
        overdrag
        offscreenPageLimit={1}
        onPageSelected={(e) => {
          setIndex(Math.round(e.nativeEvent.position));
          setZoomed(false);
        }}
        onPageScrollStateChanged={(e) => setPaging(e.nativeEvent.pageScrollState !== "idle")}
      >
        {files.map((f, i) => (
          <View key={`${f.id}@${f.version ?? ""}`} style={styles.page} collapsable={false}>
            {/* The one in sight and one each side: they load as they come near. */}
            {Math.abs(i - index) <= 1 ? (
              <Page
                id={f.id}
                {...(f.version !== undefined ? { version: f.version } : {})}
                screen={screen}
                active={i === index}
                paging={paging}
                pullX={pullX}
                pullY={pullY}
                away={away}
                leaving={leaving}
                onTap={onTap}
                onZoom={onZoom}
                onClose={close}
              />
            ) : null}
          </View>
        ))}
      </PagerView>

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

/**
 * One page: its picture (`ZoomPicture`) and, on the one in sight at 1×, the pull to close. The pull tracks the finger
 * 1:1 (the picture follows it loosely, `pulledPlacement`) and can be caught again while it springs back; let go, a
 * fast release is decided by its direction and a slow one by its distance (`pullCloses`).
 */
function Page({
  id,
  version,
  screen,
  active,
  paging,
  pullX,
  pullY,
  away,
  leaving,
  onTap,
  onZoom,
  onClose,
}: {
  id: string;
  version?: number;
  screen: Size;
  active: boolean;
  paging: boolean;
  pullX: SharedValue<number>;
  pullY: SharedValue<number>;
  away: SharedValue<number>;
  leaving: SharedValue<boolean>;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, id, version);
  const [zoomed, setZoomed] = useState(false);
  const zoomChanged = useCallback(
    (now: boolean) => {
      setZoomed(now);
      if (active) onZoom(now);
    },
    [active, onZoom],
  );
  // Where a pull caught mid-spring started from, so the picture stays under the finger.
  const from = useSharedValue({ x: 0, y: 0 });
  const pull = usePanGesture({
    enabled: active && !zoomed && !paging,
    activeOffsetY: [-10, 10],
    failOffsetX: [-10, 10],
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      cancelAnimation(pullX);
      cancelAnimation(pullY);
      from.value = { x: pullX.value, y: pullY.value };
    },
    onUpdate: (e) => {
      "worklet";
      if (leaving.value) return;
      pullX.value = from.value.x + e.translationX;
      pullY.value = from.value.y + e.translationY;
    },
    onDeactivate: (e) => {
      "worklet";
      if (leaving.value) return;
      const travel = from.value.y + e.translationY;
      if (pullCloses(travel, e.velocityY)) {
        leaving.value = true;
        away.value = withSpring(pullDirection(travel, e.velocityY) * screen.height, {
          ...AWAY_SPRING,
          velocity: e.velocityY,
        });
        scheduleOnRN(onClose);
        return;
      }
      pullX.value = withSpring(0, BACK_SPRING);
      pullY.value = withSpring(0, BACK_SPRING);
    },
  });
  const placed = useAnimatedStyle(() => {
    if (!active) return { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    const at = pulledPlacement(pullX.value, pullY.value, screen);
    return { transform: [{ translateX: at.x }, { translateY: at.y + away.value }, { scale: at.scale }] };
  });
  const key = `${id}@${version ?? "latest"}`;
  return (
    <Animated.View style={[screen, placed]}>
      {link.data ? (
        <ZoomPicture
          source={link.data}
          cacheKey={key}
          screen={screen}
          pull={pull}
          enabled={!paging}
          onTap={onTap}
          onZoom={zoomChanged}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          {link.isError ? <Icon name="image" size={30} color={DIM} /> : <ActivityIndicator color={WHITE} />}
        </View>
      )}
    </Animated.View>
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
  drag: Readonly<SharedValue<number>>;
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
  pager: { flex: 1 },
  page: { alignItems: "center", justifyContent: "center" },
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
