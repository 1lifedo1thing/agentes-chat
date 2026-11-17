import { type LiveRoom, useLivePeers } from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import { moveShapes, resizeShape, rotatedBounds, type ShapeView, shapeBounds, union } from "@agenteschat/live/canvas";
import { Canvas, DashPathEffect, Fill, Group, Path, RoundedRect, Shader, Skia } from "@shopify/react-native-skia";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import {
  GestureDetector,
  useLongPressGesture,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motion, useReducedMotion, useTheme } from "@/ui";
import { LivePointer } from "../shared/LivePointer";
import { usePeerLook } from "../shared/peers";
import { useFilePictures } from "../slides/pictures";
import {
  arrowLineW,
  boxOnScreen,
  type Cam,
  centerOn,
  clampZoom,
  dotAlpha,
  dotOffset,
  dotSpacing,
  FIT_PAD,
  type Frame,
  fitCam,
  followCam,
  inside,
  laidOutBox,
  onAnyBox,
  onHandle,
  type PeerView,
  type Pt,
  panBy,
  peerViewOf,
  stretchBox,
  toWorld,
  viewBox,
  viewCenter,
  type WBox,
  zoomAt,
} from "./camera";
import { colorFloats, DOTS_SHADER } from "./dots";
import { arrowDraws, keepsRatio, movingIds, peerPicks, peerPointers, shapeAt, shapesIn, stretchable } from "./logic";
import { ArrowLabel, FrameName, type Motion, ShapeItem } from "./ShapeItems";

/**
 * A canvas's plane on the phone (ADR 0194 §2, §9): an endless world under a camera (`camera.ts`), panned with a finger
 * (it glides on when let go), zoomed with two from 10% to 400% around them. The dots and the frames are drawn on the UI
 * thread (Skia) for every frame; the shapes are views laid out at the zoom they were last settled at and moved and
 * scaled with the camera, laid out again sharp when the fingers lift, and only those around what the screen shows.
 * Arrows, the selection's outline and everyone else's are drawn over them, at the screen's own line width.
 *
 * A tap picks what is under the finger (again on the picked one: open it, its words or its file); a drag on the picked
 * shape moves it (a frame with what is in it), its round corner stretches it (a picture keeping its shape); a long
 * press asks for its menu (or the plane's). Moving and stretching follow the finger on the UI thread and are written to
 * the file once, when it lifts. Everyone else's pointer glides over the plane with their name.
 */
export interface PlaneHandle {
  /** The world point in the middle of what the person sees. */
  center(): Pt;
  /** The world box the screen shows. */
  view(): WBox | null;
  /** Brings a world box into view (fitted when it doesn't fit), gliding there. */
  reveal(box: WBox): void;
  /** Everything on the canvas in view. */
  fitAll(): void;
  /** 100%, around the middle. */
  actualSize(): void;
}

export interface CanvasPlaneProps {
  room: LiveRoom;
  fileId: string;
  shapes: readonly ShapeView[];
  byId: ReadonlyMap<string, ShapeView>;
  readOnly: boolean;
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  /** A tap on the one shape already picked: open its words, its file, its page. */
  onOpen: (shape: ShapeView) => void;
  /** A tap on a picture that failed to be made: try again. */
  onRetry: (shape: ShapeView) => void;
  /** A long press on a shape (picked first) or on the plane (`id` null), with where it was, in the world. */
  onHold: (id: string | null, at: Pt) => void;
  /** Someone followed: their view, which this one goes to whenever it changes. */
  follow: PeerView | null;
  /** The person moved the view themselves (following someone stops). */
  onMoved: () => void;
  ref?: Ref<PlaneHandle>;
}

/** Compiled once; null if the device refuses it (the plane is then plain). */
let dotsEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;
function dots() {
  if (dotsEffect === undefined) {
    try {
      dotsEffect = Skia.RuntimeEffect.Make(DOTS_SHADER);
    } catch {
      dotsEffect = null;
    }
  }
  return dotsEffect;
}

/** A glide of the camera (a fit, a reveal, following someone). */
const GLIDE = { duration: motion.panel, easing: motion.easeInOut };
/** After the view settles, this long before the person's presence says where they look. */
const VIEW_AFTER_MS = 150;
const NO_BOX: WBox = { x: 0, y: 0, w: 0, h: 0 };

export function CanvasPlane({
  room,
  fileId,
  shapes,
  byId,
  readOnly,
  selected,
  onSelect,
  onOpen,
  onRetry,
  onHold,
  follow,
  onMoved,
  ref,
}: CanvasPlaneProps) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const reduced = useReducedMotion();
  const doc = room.doc;
  const picture = useFilePictures(room.orgId, fileId);
  const look = usePeerLook();

  // ── The camera ─────────────────────────────────────────────────────────────────────────────────────────────────
  const cx = useSharedValue(0);
  const cy = useSharedValue(0);
  const cs = useSharedValue(1);
  const frame = useSharedValue<Frame>({ width: 0, height: 0 });
  const [size, setSize] = useState<Frame | null>(null);
  // The zoom the shapes were last laid out at (a pinch scales them, the lift lays them out again).
  const [k, setK] = useState(1);
  // The world box shapes are laid out for: what the screen shows and a screen around it.
  const [region, setRegion] = useState<WBox>({ x: -2000, y: -2000, w: 4000, h: 4000 });
  const regionSv = useSharedValue<WBox>(region);
  const cam = useCallback((): Cam => ({ x: cx.value, y: cy.value, s: cs.value }), [cx, cy, cs]);

  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishView = useCallback(() => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      const f = frame.value;
      if (f.width > 0 && !room.destroyed) room.setLocal({ view: peerViewOf(cam(), f) });
    }, VIEW_AFTER_MS);
  }, [room, frame, cam]);
  useEffect(
    () => () => {
      if (viewTimer.current) clearTimeout(viewTimer.current);
    },
    [],
  );

  /** The view laid out again at its zoom, around where it is. */
  const settle = useCallback(
    (s: number) => {
      setK(s);
      const f = frame.value;
      if (f.width > 0) {
        const next = laidOutBox(cam(), f);
        regionSv.value = next;
        setRegion(next);
      }
      publishView();
    },
    [frame, cam, regionSv, publishView],
  );

  /** The camera to `to`, gliding (still with reduced motion), laid out again where it lands. */
  const goTo = useCallback(
    (to: Cam) => {
      cancelAnimation(cx);
      cancelAnimation(cy);
      cancelAnimation(cs);
      if (reduced) {
        cx.value = to.x;
        cy.value = to.y;
        cs.value = to.s;
        settle(to.s);
        return;
      }
      cx.value = withTiming(to.x, GLIDE);
      cy.value = withTiming(to.y, GLIDE);
      cs.value = withTiming(to.s, GLIDE, (done) => {
        if (done) scheduleOnRN(settle, to.s);
      });
    },
    [cx, cy, cs, reduced, settle],
  );

  // The first view: everything on the canvas, at most at its real size; an empty canvas around its origin.
  const placed = useRef(false);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const f = { width, height };
    frame.value = f;
    setSize(f);
    if (!placed.current && width > 0) {
      placed.current = true;
      const all = union(shapes.map((s) => shapeBounds(s, byId)));
      const to = all ? fitCam(all, f, FIT_PAD, 1) : centerOn({ x: 0, y: 0 }, f, 1);
      cx.value = to.x;
      cy.value = to.y;
      cs.value = to.s;
      settle(to.s);
    } else settle(cs.value);
  };

  useImperativeHandle(
    ref,
    () => ({
      center: () => viewCenter(cam(), frame.value),
      view: () => (frame.value.width > 0 ? viewBox(cam(), frame.value) : null),
      reveal: (box) => {
        const f = frame.value;
        if (f.width <= 0) return;
        if (inside(box, viewBox(cam(), f))) return;
        goTo(fitCam(box, f, FIT_PAD, Math.max(1, cs.value)));
      },
      fitAll: () => {
        const f = frame.value;
        const all = union(shapes.map((s) => shapeBounds(s, byId)));
        if (f.width > 0) goTo(all ? fitCam(all, f, FIT_PAD, 1) : centerOn({ x: 0, y: 0 }, f, 1));
      },
      actualSize: () => {
        const f = frame.value;
        if (f.width > 0) goTo(centerOn(viewCenter(cam(), f), f, 1));
      },
    }),
    [cam, frame, cs, goTo, shapes, byId],
  );

  // Following someone: the view goes where theirs is, whenever it changes.
  const followKey = follow ? `${follow.x}:${follow.y}:${follow.w}:${follow.h}:${follow.zoom}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per change of their view (`followKey`).
  useEffect(() => {
    if (!follow || !size) return;
    goTo(followCam(follow, size));
  }, [followKey, size]);

  // Laid out again whenever the view leaves the box laid out for it (a long pan).
  useAnimatedReaction(
    () => ({ x: cx.value, y: cy.value, s: cs.value, f: frame.value }),
    (now) => {
      if (now.f.width <= 0) return;
      const at = { x: now.x, y: now.y, s: now.s };
      if (inside(viewBox(at, now.f), regionSv.value)) return;
      const next = laidOutBox(at, now.f);
      regionSv.value = next;
      scheduleOnRN(setRegion, next);
    },
  );

  // ── The selection, on the UI thread ────────────────────────────────────────────────────────────────────────────
  const selBoxes = useSharedValue<WBox[]>([]);
  const selUnion = useSharedValue<WBox | null>(null);
  const canStretch = useSharedValue(false);
  const ratio = useSharedValue(false);
  // The one chosen shape's own box: what its corner stretches.
  const oneBox = useSharedValue<WBox>(NO_BOX);
  const one = selected.length === 1 ? byId.get(selected[0] ?? "") : undefined;
  useEffect(() => {
    const boxes = selected.flatMap((id) => {
      const s = byId.get(id);
      return s ? [s.type === "arrow" ? shapeBounds(s, byId) : rotatedBounds(s, s.rot ?? 0)] : [];
    });
    selBoxes.value = boxes;
    selUnion.value = union(boxes);
    canStretch.value = !readOnly && stretchable(one);
    ratio.value = !!one && keepsRatio(one);
    oneBox.value = one ? { x: one.x, y: one.y, w: one.w, h: one.h } : NO_BOX;
  }, [selected, byId, one, readOnly, selBoxes, selUnion, canStretch, ratio, oneBox]);

  // ── Moving and stretching ──────────────────────────────────────────────────────────────────────────────────────
  const moving = useSharedValue<Record<string, true>>({});
  const drag = useSharedValue<Pt>({ x: 0, y: 0 });
  const stretchId = useSharedValue("");
  const stretch = useSharedValue<WBox>(NO_BOX);
  const motionRefs = useMemo<Motion>(() => ({ moving, drag, stretchId, stretch }), [moving, drag, stretchId, stretch]);
  // What is lifted (moved or stretched), for the plane's own drawing of frames.
  const [lifted, setLifted] = useState<ReadonlySet<string>>(new Set());
  const [stretching, setStretching] = useState<string | null>(null);
  const reset = useRef(false);
  const settleMotion = useCallback(() => {
    moving.value = {};
    drag.value = { x: 0, y: 0 };
    stretchId.value = "";
    setLifted(new Set());
    setStretching(null);
  }, [moving, drag, stretchId]);
  // The file changed with the move: the shapes are drawn where they went, and the finger's offset goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: after each new drawing of the shapes.
  useLayoutEffect(() => {
    if (!reset.current) return;
    reset.current = false;
    settleMotion();
  }, [shapes]);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleSoon = useCallback(() => {
    reset.current = true;
    if (later.current) clearTimeout(later.current);
    // Nothing changed in the file (or the change was refused): nothing will draw again, so it settles anyway.
    later.current = setTimeout(() => {
      if (!reset.current) return;
      reset.current = false;
      settleMotion();
    }, 120);
  }, [settleMotion]);

  const startMove = useCallback(() => {
    const all = movingIds(selected, shapes);
    const rec: Record<string, true> = {};
    for (const id of all) rec[id] = true;
    moving.value = rec;
    setLifted(all);
  }, [selected, shapes, moving]);
  const startStretch = useCallback(() => {
    const id = selected[0];
    const s = id ? byId.get(id) : undefined;
    if (!s) return;
    // Its box to stretch from was set as the finger landed (`oneBox`), and follows the finger since.
    stretchId.value = s.id;
    setLifted(new Set([s.id]));
    setStretching(s.id);
  }, [selected, byId, stretchId]);
  const endMove = useCallback(
    (dx: number, dy: number) => {
      const s = cs.value;
      if (Math.hypot(dx, dy) * s < 0.5) {
        settleMotion();
        return;
      }
      try {
        moveShapes(doc, selected, dx, dy, LOCAL);
        const box = selUnion.value;
        if (box) {
          const at = { x: Math.round(box.x + box.w / 2 + dx), y: Math.round(box.y + box.h / 2 + dy) };
          room.setLocal({ cursor: { ...at, space: "canvas" } });
        }
      } catch {
        // Refused (the shape went meanwhile): it settles where it was.
      }
      settleSoon();
    },
    [doc, selected, cs, selUnion, room, settleMotion, settleSoon],
  );
  const endStretch = useCallback(
    (box: WBox) => {
      const id = stretchId.value;
      if (!id) return;
      try {
        resizeShape(doc, id, box, LOCAL);
      } catch {
        // Refused: it settles back.
      }
      settleSoon();
    },
    [doc, stretchId, settleSoon],
  );

  // ── What is laid out ───────────────────────────────────────────────────────────────────────────────────────────
  const keep = useMemo(() => new Set<string>([...selected, ...lifted]), [selected, lifted]);
  const visible = useMemo(() => shapesIn(shapes, byId, region, keep), [shapes, byId, region, keep]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const frames = visible.filter((s) => s.type === "frame");
  const items = visible.filter((s) => s.type !== "frame" && s.type !== "arrow");
  const arrows = useMemo(() => arrowDraws(visible, byId), [visible, byId]);
  const arrowsSv = useSharedValue(arrows);
  useEffect(() => {
    arrowsSv.value = arrows;
  }, [arrows, arrowsSv]);
  const labels = visible.flatMap((s) => {
    if (s.type !== "arrow" || !s.label) return [];
    const a = arrows.find((d) => d.id === s.id);
    if (!a) return [];
    const l = arrowLineW(a.from, a.to);
    return [{ id: s.id, label: s.label, at: { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 } }];
  });

  // ── Gestures ───────────────────────────────────────────────────────────────────────────────────────────────────
  const moved = useCallback(() => onMoved(), [onMoved]);
  const tapped = useCallback(
    (x: number, y: number) => {
      const at = toWorld({ x, y }, cam());
      const id = shapeAt(visibleRef.current, byId, at, cs.value);
      const shape = id ? byId.get(id) : undefined;
      room.setLocal({ cursor: { x: Math.round(at.x), y: Math.round(at.y), space: "canvas" } });
      if (!shape) {
        onSelect([]);
        return;
      }
      if (shape.type === "pending" && shape.status === "failed" && !readOnly) {
        onRetry(shape);
        return;
      }
      if (selected.length === 1 && selected[0] === shape.id) {
        onOpen(shape);
        return;
      }
      onSelect([shape.id]);
    },
    [cam, byId, cs, room, onSelect, onRetry, onOpen, selected, readOnly],
  );
  const held = useCallback(
    (x: number, y: number) => {
      const at = toWorld({ x, y }, cam());
      onHold(shapeAt(visibleRef.current, byId, at, cs.value), at);
    },
    [cam, byId, cs, onHold],
  );

  const mode = useSharedValue<"pan" | "move" | "stretch">("pan");
  const from = useSharedValue<WBox>(NO_BOX);
  const pan = usePanGesture({
    maxPointers: 2,
    minDistance: 6,
    onBegin: (e) => {
      "worklet";
      cancelAnimation(cx);
      cancelAnimation(cy);
      const now = { x: cx.value, y: cy.value, s: cs.value };
      const p = { x: e.x, y: e.y };
      if (e.numberOfPointers <= 1 && canStretch.value && onHandle(p, selUnion.value, now)) {
        mode.value = "stretch";
        from.value = oneBox.value;
        stretch.value = oneBox.value;
      } else if (!readOnly && e.numberOfPointers <= 1 && onAnyBox(p, selBoxes.value, now)) mode.value = "move";
      else mode.value = "pan";
    },
    onActivate: () => {
      "worklet";
      if (mode.value === "move") scheduleOnRN(startMove);
      else if (mode.value === "stretch") scheduleOnRN(startStretch);
      else scheduleOnRN(moved);
    },
    onUpdate: (e) => {
      "worklet";
      const s = cs.value;
      if (mode.value === "move") {
        drag.value = { x: drag.value.x + e.changeX / s, y: drag.value.y + e.changeY / s };
        return;
      }
      if (mode.value === "stretch") {
        stretch.value = stretchBox(from.value, e.translationX / s, e.translationY / s, ratio.value, s);
        return;
      }
      const to = panBy({ x: cx.value, y: cy.value, s }, e.changeX, e.changeY);
      cx.value = to.x;
      cy.value = to.y;
    },
    onDeactivate: (e) => {
      "worklet";
      if (mode.value === "move") {
        scheduleOnRN(endMove, drag.value.x, drag.value.y);
        return;
      }
      if (mode.value === "stretch") {
        scheduleOnRN(endStretch, stretch.value);
        return;
      }
      // Let go: the plane glides on and slows down.
      const s = cs.value;
      cx.value = withDecay({ velocity: -e.velocityX / s });
      cy.value = withDecay({ velocity: -e.velocityY / s }, (done) => {
        if (done) scheduleOnRN(publishView);
      });
    },
  });
  const pinchFrom = useSharedValue(1);
  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      cancelAnimation(cx);
      cancelAnimation(cy);
      cancelAnimation(cs);
      pinchFrom.value = cs.value;
    },
    onActivate: () => {
      "worklet";
      scheduleOnRN(moved);
    },
    onUpdate: (e) => {
      "worklet";
      const to = zoomAt({ x: cx.value, y: cy.value, s: cs.value }, clampZoom(pinchFrom.value * e.scale), {
        x: e.focalX,
        y: e.focalY,
      });
      cx.value = to.x;
      cy.value = to.y;
      cs.value = to.s;
    },
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(settle, cs.value);
    },
  });
  const tap = useTapGesture({
    maxDuration: 400,
    maxDistance: 10,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      scheduleOnRN(tapped, e.x, e.y);
    },
  });
  const hold = useLongPressGesture({
    minDuration: 450,
    maxDistance: 10,
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(held, e.x, e.y);
    },
  });
  const gestures = useSimultaneousGestures(pinch, pan, tap, hold);

  // ── Drawing on the UI thread ───────────────────────────────────────────────────────────────────────────────────
  const effect = dots();
  const dotColor = useMemo(() => colorFloats(c.line2), [c.line2]);
  const uniforms = useDerivedValue(() => {
    const now = { x: cx.value, y: cy.value, s: cs.value };
    const spacing = dotSpacing(now.s);
    const off = dotOffset(now, spacing);
    return {
      off: [off.x, off.y],
      spacing,
      r: 0.75,
      color: [dotColor[0], dotColor[1], dotColor[2], dotColor[3] * dotAlpha(now.s)],
    };
  });
  const world = useDerivedValue(() => [
    { translateX: -cx.value * cs.value },
    { translateY: -cy.value * cs.value },
    { scale: cs.value },
  ]);
  const dragged = useDerivedValue(() => [{ translateX: drag.value.x }, { translateY: drag.value.y }]);
  const hair = useDerivedValue(() => 1 / cs.value);
  const line15 = useDerivedValue(() => 1.5 / cs.value);
  const line2 = useDerivedValue(() => 2 / cs.value);
  const arrowPaths = useDerivedValue(() => {
    const solid = Skia.PathBuilder.Make();
    const dashed = Skia.PathBuilder.Make();
    const heads = Skia.PathBuilder.Make();
    const mv = moving.value;
    const d = drag.value;
    const sid = stretchId.value;
    const st = stretch.value;
    const head = 12 / cs.value;
    for (const a of arrowsSv.value) {
      const endOf = (e: (typeof a)["from"]) => {
        if (e.shape && e.shape === sid) return { x: st.x, y: st.y, w: st.w, h: st.h, box: e.box };
        const shifts = e.shape ? !!mv[e.shape] : !!mv[a.id];
        return shifts ? { x: e.x + d.x, y: e.y + d.y, w: e.w, h: e.h, box: e.box } : e;
      };
      const l = arrowLineW(endOf(a.from), endOf(a.to));
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
      if (len < 1e-6) continue;
      const ux = (l.x2 - l.x1) / len;
      const uy = (l.y2 - l.y1) / len;
      const path = a.dashed ? dashed : solid;
      path.moveTo(l.x1, l.y1);
      path.lineTo(l.x2 - ux * head * 0.8, l.y2 - uy * head * 0.8);
      const bx = l.x2 - ux * head;
      const by = l.y2 - uy * head;
      heads.moveTo(l.x2, l.y2);
      heads.lineTo(bx - uy * head * 0.55, by + ux * head * 0.55);
      heads.lineTo(bx + uy * head * 0.55, by - ux * head * 0.55);
      heads.close();
    }
    return { solid: solid.build(), dashed: dashed.build(), heads: heads.build() };
  });
  const solidArrows = useDerivedValue(() => arrowPaths.value.solid);
  const dashedArrows = useDerivedValue(() => arrowPaths.value.dashed);
  const arrowHeads = useDerivedValue(() => arrowPaths.value.heads);
  const selOutline = useDerivedValue(() => {
    const p = Skia.PathBuilder.Make();
    const u = selUnion.value;
    if (!u) return p.build();
    let b = u;
    if (stretchId.value) b = stretch.value;
    else if (Object.keys(moving.value).length > 0) b = { x: u.x + drag.value.x, y: u.y + drag.value.y, w: u.w, h: u.h };
    const pad = 3 / cs.value;
    p.addRect(Skia.XYWHRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad));
    return p.build();
  });
  const handleStyle = useAnimatedStyle(() => {
    const u = selUnion.value;
    if (!u || !canStretch.value) return { opacity: 0, transform: [{ translateX: -100 }, { translateY: -100 }] };
    const b = stretchId.value
      ? stretch.value
      : Object.keys(moving.value).length > 0
        ? { x: u.x + drag.value.x, y: u.y + drag.value.y, w: u.w, h: u.h }
        : u;
    const r = boxOnScreen(b, { x: cx.value, y: cy.value, s: cs.value });
    const pad = 3;
    return {
      opacity: 1,
      transform: [{ translateX: r.x + r.w + pad - HANDLE / 2 }, { translateY: r.y + r.h + pad - HANDLE / 2 }],
    };
  });
  const layer = useAnimatedStyle(() => ({
    transform: [{ translateX: -cx.value * cs.value }, { translateY: -cy.value * cs.value }, { scale: cs.value / k }],
  }));
  const pointerView = useDerivedValue(() => ({ s: cs.value, x: cx.value, y: cy.value, width: 1, height: 1 }));

  // ── Everyone else ──────────────────────────────────────────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const picks = peerPicks(peers, byId);
  const pointers = peerPointers(peers);

  const frameColor = (f: ShapeView) => f.fill ?? c.sunken;
  const staticFrames = frames.filter((f) => !lifted.has(f.id));
  const liftedFrames = frames.filter((f) => lifted.has(f.id) && f.id !== stretching);
  const stretchedFrame = stretching ? frames.find((f) => f.id === stretching) : undefined;

  return (
    <GestureDetector gesture={gestures}>
      <View
        style={[styles.fill, { backgroundColor: c.bg }]}
        onLayout={onLayout}
        collapsable={false}
        accessible
        accessibilityRole="image"
        accessibilityLabel={t("live.canvas.count.items", { count: shapes.length })}
      >
        {size ? (
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            {effect ? (
              <Fill>
                <Shader source={effect} uniforms={uniforms} />
              </Fill>
            ) : null}
            <Group transform={world}>
              {staticFrames.map((f) => (
                <FrameRect key={f.id} frame={f} fill={frameColor(f)} edge={c.line2} hair={hair} />
              ))}
              <Group transform={dragged}>
                {liftedFrames.map((f) => (
                  <FrameRect key={f.id} frame={f} fill={frameColor(f)} edge={c.line2} hair={hair} />
                ))}
              </Group>
              {stretchedFrame ? (
                <StretchedFrame box={stretch} fill={frameColor(stretchedFrame)} edge={c.line2} hair={hair} />
              ) : null}
            </Group>
          </Canvas>
        ) : null}

        <Animated.View style={[styles.world, layer]} pointerEvents="none">
          {frames.map((f) => (
            <FrameName key={`name:${f.id}`} shape={f} k={k} motion={motionRefs} />
          ))}
          {items.map((s) => (
            <ShapeItem key={s.id} shape={s} k={k} motion={motionRefs} picture={picture} readOnly={readOnly} />
          ))}
          {labels.map((l) => (
            <ArrowLabel key={`label:${l.id}`} label={l.label} at={l.at} k={k} />
          ))}
        </Animated.View>

        {size ? (
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Group transform={world}>
              <Path path={solidArrows} style="stroke" strokeWidth={line2} strokeCap="round" color={c.ink} />
              <Path path={dashedArrows} style="stroke" strokeWidth={line2} color={c.ink}>
                <DashPathEffect intervals={DASHES} />
              </Path>
              <Path path={arrowHeads} color={c.ink} />
              {picks.flatMap(({ peer, ids }) => {
                const tint = look(peer.user).tint;
                return ids.map((id) => {
                  const s = byId.get(id);
                  if (!s) return null;
                  const b = s.type === "arrow" ? shapeBounds(s, byId) : rotatedBounds(s, s.rot ?? 0);
                  return (
                    <RoundedRect
                      key={`${peer.clientId}:${id}`}
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      r={2}
                      style="stroke"
                      strokeWidth={line2}
                      color={tint}
                    />
                  );
                });
              })}
              {selected.length > 0 ? (
                <Path path={selOutline} style="stroke" strokeWidth={line15} color={c.ink} />
              ) : null}
            </Group>
          </Canvas>
        ) : null}

        {readOnly ? null : (
          <Animated.View
            pointerEvents="none"
            style={[styles.handle, { backgroundColor: "#ffffff", borderColor: c.ink }, handleStyle]}
          />
        )}

        {pointers.map(({ peer, at }) => {
          const who = look(peer.user);
          return (
            <LivePointer
              key={`pointer:${peer.clientId}`}
              user={peer.user}
              name={who.name}
              tint={who.tint}
              at={at}
              view={pointerView}
            />
          );
        })}
      </View>
    </GestureDetector>
  );
}

/** The selection's corner handle, in points. */
const HANDLE = 12;
/** A dashed arrow's dashes, in world units. */
const DASHES = [10, 8];

/** A frame on the plane: a rounded box a little sunken, its edge a hairline at any zoom. */
function FrameRect({
  frame,
  fill,
  edge,
  hair,
}: {
  frame: ShapeView;
  fill: string;
  edge: string;
  hair: Readonly<SharedValue<number>>;
}) {
  return (
    <Group>
      <RoundedRect x={frame.x} y={frame.y} width={frame.w} height={frame.h} r={12} color={fill} opacity={0.6} />
      <RoundedRect
        x={frame.x}
        y={frame.y}
        width={frame.w}
        height={frame.h}
        r={12}
        style="stroke"
        strokeWidth={hair}
        color={edge}
      />
    </Group>
  );
}

/** The frame being stretched, following the finger's box on the UI thread. */
function StretchedFrame({
  box,
  fill,
  edge,
  hair,
}: {
  box: Readonly<SharedValue<WBox>>;
  fill: string;
  edge: string;
  hair: Readonly<SharedValue<number>>;
}) {
  const x = useDerivedValue(() => box.value.x);
  const y = useDerivedValue(() => box.value.y);
  const w = useDerivedValue(() => box.value.w);
  const h = useDerivedValue(() => box.value.h);
  return (
    <Group>
      <RoundedRect x={x} y={y} width={w} height={h} r={12} color={fill} opacity={0.6} />
      <RoundedRect x={x} y={y} width={w} height={h} r={12} style="stroke" strokeWidth={hair} color={edge} />
    </Group>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  world: { position: "absolute", left: 0, top: 0, width: 0, height: 0, transformOrigin: "left top" },
  handle: { position: "absolute", left: 0, top: 0, width: HANDLE, height: HANDLE, borderRadius: 3, borderWidth: 1.5 },
});
