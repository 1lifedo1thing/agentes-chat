import { Image } from "expo-image";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { ActivityIndicator, Platform, type ScrollViewInstance, StyleSheet, View } from "react-native";
import {
  GestureDetector,
  type PanGesture,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Icon } from "@/ui";
import { clamp, fitted, maxZoom, panRoom, type Size, zoomInAt, zoomInRect } from "./zoom";

export interface ZoomPictureProps {
  source: { uri: string; headers?: Record<string, string> | undefined };
  /** Which picture and version: its cache entry, and what a recycled view shows. */
  cacheKey: string;
  screen: Size;
  /** The viewer's pull to close: first in line for a touch, and only offered at 1×. */
  pull: PanGesture;
  /** Off while the pages slide: a touch then is the pager's. */
  enabled: boolean;
  /** A single tap (after a double tap's wait): the viewer shows or hides its bars. */
  onTap: () => void;
  /** Zoomed in, or back at 1×. */
  onZoom: (zoomed: boolean) => void;
}

/**
 * One picture in the viewer, whole on the screen, that zooms. On iOS the system zooms it (a scroll view's own pinch,
 * with its momentum, its edges and its bounce past the limits) and a double tap zooms in at the tapped spot through
 * the same scroll view, so it feels as the phone's photos do. Android has no zooming view, so there the pinch is ours:
 * around the fingers, the picture never leaves the screen's edges, a zoomed picture flung with one finger glides to a
 * stop, and a double tap springs in at the spot or back out. Up to twice the picture's own pixels (`maxZoom`).
 */
export function ZoomPicture({ source, cacheKey, screen, pull, enabled, onTap, onZoom }: ZoomPictureProps) {
  const [pixels, setPixels] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const picture = fitted(pixels ? pixels.width / pixels.height : null, screen);
  const max = maxZoom(pixels?.width, screen.width);
  const image = (
    <Image
      source={{ uri: source.uri, ...(source.headers ? { headers: source.headers } : {}), cacheKey }}
      recyclingKey={cacheKey}
      contentFit="contain"
      transition={160}
      onLoad={(e) => {
        if (e.source.width > 0 && e.source.height > 0) setPixels({ width: e.source.width, height: e.source.height });
      }}
      onError={() => setFailed(true)}
      style={StyleSheet.absoluteFill}
      accessible={false}
    />
  );
  const zoom = { picture, screen, max, pull, enabled, onTap, onZoom, children: image };
  return (
    <View style={screen}>
      {Platform.OS === "ios" ? <SystemZoom {...zoom} /> : <OwnZoom {...zoom} />}
      {pixels ? null : (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          {failed ? <Icon name="image" size={30} color={DIM} /> : <ActivityIndicator color="#fff" />}
        </View>
      )}
    </View>
  );
}

const DIM = "rgba(255,255,255,0.6)";
/** A double tap's zoom, in or out: settles without overshooting. */
const ZOOM_SPRING = { dampingRatio: 1, duration: 360 };

interface ZoomProps {
  /** The picture's box at 1×, centered on the screen. */
  picture: Size;
  screen: Size;
  max: number;
  pull: PanGesture;
  enabled: boolean;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
  children: ReactNode;
}

/** iOS: the scroll view zooms, pans and bounces; ours are only the taps and the pull before them. */
function SystemZoom({ picture, screen, max, pull, enabled, onTap, onZoom, children }: ZoomProps) {
  const scroll = useRef<ScrollViewInstance>(null);
  const zoomed = useSharedValue(false);
  // At 1× it doesn't bounce, so a vertical drag is the pull to close; zoomed, it does, as any scroll view.
  const [bounces, setBounces] = useState(false);
  const zoomChanged = useCallback(
    (now: boolean) => {
      setBounces(now);
      onZoom(now);
    },
    [onZoom],
  );
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const now = (e.zoomScale ?? 1) > 1.01;
      if (now === zoomed.value) return;
      zoomed.value = now;
      scheduleOnRN(zoomChanged, now);
    },
  });
  const zoomTo = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    scroll.current?.scrollResponderZoomTo({ ...rect, animated: true });
  }, []);
  const tap = useTapGesture({
    enabled,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(onTap);
    },
  });
  const doubleTap = useTapGesture({
    enabled,
    numberOfTaps: 2,
    onDeactivate: (e) => {
      "worklet";
      // Zoomed: back to the whole picture. Else in at the spot, far enough to fill the screen.
      const rect = zoomed.value
        ? { x: 0, y: 0, width: picture.width, height: picture.height }
        : zoomInRect(picture, screen, { x: e.x, y: e.y }, max);
      scheduleOnRN(zoomTo, rect);
    },
  });
  const gesture = useExclusiveGestures(pull, doubleTap, tap);
  return (
    <GestureDetector gesture={gesture}>
      <Animated.ScrollView
        ref={scroll}
        style={screen}
        maximumZoomScale={max}
        minimumZoomScale={1}
        pinchGestureEnabled
        bouncesZoom
        bounces={bounces}
        centerContent
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
      >
        <View style={picture}>{children}</View>
      </Animated.ScrollView>
    </GestureDetector>
  );
}

/** Android: pinch around the fingers, a zoomed picture dragged and flung inside the screen's edges, double tap. */
function OwnZoom({ picture, screen, max, pull, enabled, onTap, onZoom, children }: ZoomProps) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Where the pinch started (its focal point from the screen's center), so each frame is worked out from there.
  const start = useSharedValue({ scale: 1, x: 0, y: 0, fx: 0, fy: 0 });
  const pinching = useSharedValue(false);
  const [zoomed, setZoomed] = useState(false);
  const zoomChanged = useCallback(
    (now: boolean) => {
      setZoomed(now);
      onZoom(now);
    },
    [onZoom],
  );
  useAnimatedReaction(
    () => scale.value > 1.01,
    (now, before) => {
      if (before !== null && now !== before) scheduleOnRN(zoomChanged, now);
    },
  );
  const stop = () => {
    "worklet";
    cancelAnimation(scale);
    cancelAnimation(x);
    cancelAnimation(y);
  };

  const pinch = usePinchGesture({
    enabled,
    onActivate: (e) => {
      "worklet";
      stop();
      pinching.value = true;
      start.value = {
        scale: scale.value,
        x: x.value,
        y: y.value,
        fx: e.focalX - screen.width / 2,
        fy: e.focalY - screen.height / 2,
      };
    },
    onUpdate: (e) => {
      "worklet";
      const from = start.value;
      const next = clamp(from.scale * e.scale, 1, max);
      const grown = next / from.scale;
      // The spot that was under the fingers stays under them, wherever they go; the picture stays over the screen.
      const room = panRoom(picture, next, screen);
      scale.value = next;
      x.value = clamp(e.focalX - screen.width / 2 - grown * (from.fx - from.x), -room.x, room.x);
      y.value = clamp(e.focalY - screen.height / 2 - grown * (from.fy - from.y), -room.y, room.y);
    },
    onFinalize: () => {
      "worklet";
      pinching.value = false;
    },
  });
  // One finger on a zoomed picture moves it (from where it is, so a pinch can turn into a drag), and a fling glides.
  const pan = usePanGesture({
    enabled: enabled && zoomed,
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      stop();
    },
    onUpdate: (e) => {
      "worklet";
      if (pinching.value) return;
      const room = panRoom(picture, scale.value, screen);
      x.value = clamp(x.value + e.changeX, -room.x, room.x);
      y.value = clamp(y.value + e.changeY, -room.y, room.y);
    },
    onDeactivate: (e) => {
      "worklet";
      if (pinching.value) return;
      const room = panRoom(picture, scale.value, screen);
      x.value = withDecay({ velocity: e.velocityX, clamp: [-room.x, room.x] });
      y.value = withDecay({ velocity: e.velocityY, clamp: [-room.y, room.y] });
    },
  });
  const tap = useTapGesture({
    enabled,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(onTap);
    },
  });
  const doubleTap = useTapGesture({
    enabled,
    numberOfTaps: 2,
    onDeactivate: (e) => {
      "worklet";
      stop();
      const to =
        scale.value > 1.01
          ? { scale: 1, x: 0, y: 0 }
          : zoomInAt(picture, screen, { x: e.x - screen.width / 2, y: e.y - screen.height / 2 }, max);
      scale.value = withSpring(to.scale, ZOOM_SPRING);
      x.value = withSpring(to.x, ZOOM_SPRING);
      y.value = withSpring(to.y, ZOOM_SPRING);
    },
  });
  const pinchAndPan = useSimultaneousGestures(pinch, pan);
  const gesture = useExclusiveGestures(pull, pinchAndPan, doubleTap, tap);
  const moved = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <View style={[screen, styles.center]} collapsable={false}>
        <Animated.View style={[picture, moved]}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
});
