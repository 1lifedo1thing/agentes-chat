import {
  type GenerateImagesInput,
  type ImageAspect,
  useApi,
  useGenerateImages,
  useImageModels,
  useLivePeers,
  useLiveSelector,
  useRetryImages,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { LOCAL } from "@agenteschat/live";
import type { Peer } from "@agenteschat/live/awareness";
import {
  type ArrowEnd,
  addShape,
  arrangeShapes,
  type Box,
  canvasBackground,
  defaultSize,
  deleteShapes,
  frameAt,
  moveShapes,
  type Point,
  rectsIntersect,
  resizeShape,
  type ShapeView,
  setCanvasBackground,
  setParent,
  shapeBounds,
  snapLines,
  union,
  updateShape,
} from "@agenteschat/live/canvas";
import { DetailsDialog, EmptyState, isApple } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useMaybeArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { ImageZoom } from "@/components/artifacts/ImageZoom";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { type MenuEntry, openContextMenu } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import type { LiveEditorProps } from "../editor";
import {
  type Camera,
  centerOn,
  dotSpacing,
  FIT_PADDING,
  fitCamera,
  followCamera,
  HOME,
  lerpCamera,
  panCamera,
  peerViewOf,
  type Size,
  sameCamera,
  stepCameraZoom,
  toWorld,
  visibleWorld,
  zoomCameraAt,
} from "./camera";
import { Dock, ShapeBar, type ShapeBarAction, type Tool, ZoomIsland } from "./chrome";
import {
  assetsToCopy,
  type CanvasClip,
  CLIP_TYPE,
  clipBounds,
  clipPayload,
  copyShapes,
  pasteClip,
  readClip,
  withAssets,
} from "./clipboard";
import { CanvasContext, type CanvasEnv } from "./context";
import {
  arrowLine,
  boundsOf,
  boxFrom,
  HANDLES,
  type Handle,
  type HitPart,
  hitShape,
  marqueeHits,
  resizeBox,
  rotationAt,
  scaleGroup,
  snapTargets,
  topLevelOf,
} from "./edit-math";
import { GenerateBar, type GenerateDraft } from "./generate";
import { ImageInspector } from "./inspector";
import { type Draft, Overlay } from "./overlay";
import { SOFT } from "./palette";
import { selectionOf } from "./selection";
import { ArrowShape, ShapeBody } from "./shapes";
import { useCanvasShapes } from "./store";
import "./canvas.css";

/**
 * The canvas ("Quadro", ADR 0191 §2, ADR 0192): an endless plane people and agents fill together with pictures,
 * notes, text, frames, shapes, arrows between them, Drive files and agents' pages, and pictures generated in place.
 *
 * Shapes are DOM in a world layer the camera moves (pan and zoom by trackpad, wheel, pinch, keys and the zoom island);
 * what must keep its size at any zoom (selection, handles, frames' names, guides, everyone's pointers) is drawn over it
 * in screen pixels (`Overlay`). Every change goes through `@agenteschat/live`'s canvas edits with the `LOCAL` origin,
 * so ⌘Z takes back this person's own changes only; drags write as they go (everyone watches them move), one step of
 * undo each. Presence says where the pointer is, what is chosen and what this person sees (to be followed).
 */
export function Canvas(props: LiveEditorProps) {
  const state = useSyncExternalStore(props.room.subscribe, props.room.getState, props.room.getState);
  if (!state.loaded) return <CanvasSkeleton />;
  return <CanvasEditor {...props} />;
}

/** While the canvas loads: its dotted plane and the dock's place, never a spinner alone. */
export function CanvasSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="cnv cnv--skeleton" role="status" aria-label={t("live.canvas.loading")}>
      <div className="cnv__plane" data-bg="dots" style={{ "--dot": "24px" } as CSSProperties} />
      <span className="cnv-dock cnv-dock--skeleton ac-skeleton" aria-hidden="true" />
    </div>
  );
}

/** A press that moves less than this (screen pixels) is a click. */
const CLICK_SLOP = 4;
/** Snapping reaches this far (screen pixels). */
const SNAP_PX = 6;
/** The arrows nudge this far (world units); with Shift, ten times as far. */
const NUDGE = 1;
/** Pictures over this don't upload (ADR 0191 §8). */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** A picture lands no bigger than this on its longest side (as `addShape` places one). */
const IMAGE_MAX_SIDE = 640;
/** A paste of shapes from this same canvas lands this far from the copied ones each time. */
const PASTE_STEP = 24;
/** With more shapes than this, only those near the screen are drawn. */
const CULL_FROM = 300;
/** A plane not laid out yet (a test, a hidden tab) works as if it were this size. */
const FALLBACK_STAGE: Size = { w: 1200, h: 800 };

/** What was copied last in this tab: the context menu's Paste reads it when the system's clipboard can't be read. */
let memoryClip: CanvasClip | null = null;

type Gesture =
  | { kind: "pan"; last: Point }
  | {
      kind: "press";
      startScreen: Point;
      startWorld: Point;
      hit: { id: string; part: HitPart } | null;
      shift: boolean;
      alt: boolean;
      /** It was chosen before this press (a click then narrows the selection to it, or Shift takes it out). */
      wasSelected: boolean;
    }
  | { kind: "move"; ids: string[]; startWorld: Point; applied: Point; bounds: Box | null; targets: Box[] }
  | { kind: "marquee"; startWorld: Point; base: string[] }
  | { kind: "resize"; id: string; handle: Handle; box: Box; rot: number; startWorld: Point; ratio: boolean }
  | { kind: "group"; handle: Handle; bounds: Box; boxes: Map<string, Box>; startWorld: Point }
  | { kind: "rotate"; id: string; center: Point }
  | { kind: "draw"; tool: "note" | "text" | "shape" | "frame"; startWorld: Point; startScreen: Point }
  | { kind: "arrow"; from: ArrowEnd; fromShape: string | null; startWorld: Point; startScreen: Point }
  | { kind: "end"; arrow: string; end: "from" | "to" }
  | { kind: "pinch"; startDist: number; startMid: Point; cam: Camera };

const isEditable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");

const isControl = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("button, a[href], input, textarea, select, [role='menuitem']");

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** A picture file's natural size, read in the browser (a square when it can't be read). */
async function naturalSize(file: File): Promise<{ w: number; h: number }> {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const size = { w: bitmap.width, h: bitmap.height };
      bitmap.close();
      if (size.w > 0 && size.h > 0) return size;
    }
  } catch {
    // Some types (an animated GIF in some browsers) only read through an <img>.
  }
  return new Promise((resolve) => {
    if (typeof URL.createObjectURL !== "function") return resolve({ w: 512, h: 512 });
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (size: { w: number; h: number }) => {
      URL.revokeObjectURL(url);
      resolve(size);
    };
    const timer = setTimeout(() => done({ w: 512, h: 512 }), 3000);
    img.onload = () => {
      clearTimeout(timer);
      done(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : { w: 512, h: 512 });
    };
    img.onerror = () => {
      clearTimeout(timer);
      done({ w: 512, h: 512 });
    };
    img.src = url;
  });
}

/** A picture as PNG (what the clipboard takes everywhere). */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("png"))), "image/png"),
  );
}

/** A file name from a prompt ("Uma raposa na neve" → "uma-raposa-na-neve.png"). */
function fileNameOf(words: string | undefined, fallback: string): string {
  const slug = (words ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || fallback}.png`;
}

/** The aspect among `aspects` nearest to a picture's proportions. */
function nearestAspect(w: number, h: number, aspects: readonly ImageAspect[]): ImageAspect | undefined {
  const ratio = w / h;
  let best: ImageAspect | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const a of aspects) {
    const [aw = 1, ah = 1] = a.split(":").map(Number);
    const d = Math.abs(Math.log(aw / ah / ratio));
    if (d < gap) {
      gap = d;
      best = a;
    }
  }
  return best;
}

function CanvasEditor({ room, orgId, readOnly, following, onStopFollowing, onSelection }: LiveEditorProps) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const reduced = usePrefersReducedMotion();
  const viewer = useMaybeArtifactViewer();
  const fileId = room.fileId;
  const doc = room.doc;
  const { store, snapshot } = useCanvasShapes(room);
  const { list, byId } = snapshot;
  const peers = useLivePeers(room);
  const bg = useLiveSelector(room, canvasBackground) ?? "dots";
  const connection = useSyncExternalStore(room.subscribe, room.getState, room.getState);
  const offline = connection.status === "offline";
  const models = useImageModels(orgId, { enabled: !readOnly });
  const canGenerate = !readOnly;
  const generate = useGenerateImages(orgId, fileId);
  const retry = useRetryImages(orgId, fileId);

  const rootRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Size>(FALLBACK_STAGE);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const [cam, setCamState] = useState<Camera>(HOME);
  const camRef = useRef(cam);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ id: string; kind: "frame" | "label" } | null>(null);
  const [interacting, setInteracting] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [uploads, setUploads] = useState<{ key: number; box: Box }[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genDraft, setGenDraft] = useState<GenerateDraft | null>(null);
  const [inspectorOff, setInspectorOff] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<ShapeView | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pointerWorld = useRef<Point | null>(null);
  const pendingWrite = useRef<(() => void) | null>(null);
  const writeFrame = useRef(0);
  const placed = useRef(false);
  const pasteCount = useRef(0);
  const reveal = useRef<string[] | null>(null);
  const uploadKey = useRef(0);
  const glide = useRef(0);
  /** Shapes that were placeholders: when they turn into pictures, those fade in. */
  const wasPending = useRef(new Set<string>());
  /** The double click that opened a text box: its caret goes there. */
  const editAt = useRef<{ id: string; x: number; y: number } | null>(null);

  const sel = useMemo(() => selected.filter((id) => byId.has(id)), [selected, byId]);
  const selShapes = useMemo(() => sel.map((id) => byId.get(id) as ShapeView), [sel, byId]);

  // ── Camera ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const followingRef = useRef(following);
  followingRef.current = following;
  const stopFollowing = useRef(onStopFollowing);
  stopFollowing.current = onStopFollowing;

  /** Moves the view; `user`: this person moved it (following someone ends). */
  const setCam = useCallback((next: Camera, opts: { user?: boolean } = {}) => {
    cancelAnimationFrame(glide.current);
    if (opts.user && followingRef.current) stopFollowing.current();
    camRef.current = next;
    setCamState(next);
  }, []);

  /** Glides the view to `target` (at once with reduced motion). */
  const glideTo = useCallback(
    (target: Camera, opts: { user?: boolean; ms?: number } = {}) => {
      cancelAnimationFrame(glide.current);
      if (opts.user && followingRef.current) stopFollowing.current();
      const from = camRef.current;
      if (reduced || sameCamera(from, target)) {
        camRef.current = target;
        setCamState(target);
        return;
      }
      const ms = opts.ms ?? 260;
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        const e = 1 - (1 - k) ** 3;
        const next = k >= 1 ? target : lerpCamera(from, target, e);
        camRef.current = next;
        setCamState(next);
        if (k < 1) glide.current = requestAnimationFrame(step);
      };
      glide.current = requestAnimationFrame(step);
    },
    [reduced],
  );

  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  // The plane's size; a resize keeps what is in its middle there.
  useEffect(() => {
    const el = planeRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!(w > 0 && h > 0)) return;
      const before = stageRef.current;
      if (before.w === w && before.h === h) return;
      if (placed.current) {
        const c = camRef.current;
        const next = { z: c.z, x: c.x + (w - before.w) / 2, y: c.y + (h - before.h) / 2 };
        camRef.current = next;
        setCamState(next);
      }
      stageRef.current = { w, h };
      setStage({ w, h });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The first view: everything on the canvas, at most at its real size; an empty canvas around its origin.
  useEffect(() => {
    if (placed.current) return;
    placed.current = true;
    const shapes = store.now().list;
    const bounds = union(shapes.map((s) => shapeBounds(s, store.now().byId)));
    const first = bounds
      ? fitCamera(bounds, stageRef.current, FIT_PADDING, 1)
      : centerOn({ x: 0, y: 0 }, stageRef.current, 1);
    camRef.current = first;
    setCamState(first);
  }, [store]);

  const fitAll = useCallback(() => {
    const bounds = union(store.now().list.map((s) => shapeBounds(s, store.now().byId)));
    if (bounds) glideTo(fitCamera(bounds, stageRef.current, FIT_PADDING, 1), { user: true });
  }, [store, glideTo]);

  const fitSelection = useCallback(() => {
    const bounds = boundsOf(sel, store.now().byId);
    if (bounds) glideTo(fitCamera(bounds, stageRef.current, FIT_PADDING, 2), { user: true });
  }, [sel, store, glideTo]);

  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      const c = camRef.current;
      const s = stageRef.current;
      glideTo(zoomCameraAt(c, stepCameraZoom(c.z, dir), { x: s.w / 2, y: s.h / 2 }), { user: true, ms: 160 });
    },
    [glideTo],
  );

  const zoomActual = useCallback(() => {
    const s = stageRef.current;
    glideTo(zoomCameraAt(camRef.current, 1, { x: s.w / 2, y: s.h / 2 }), { user: true, ms: 160 });
  }, [glideTo]);

  /** The middle of what this person sees, in world units (where new things go). */
  const viewCenter = useCallback((): Point => {
    const v = visibleWorld(camRef.current, stageRef.current);
    return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  }, []);

  // Wheel and trackpad: two fingers or the wheel move the plane, a pinch or ⌘/Ctrl with the wheel zooms at the pointer.
  useEffect(() => {
    const el = planeRef.current;
    if (!el) return;
    let last = 1;
    let gesturing = false;
    const at = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      // A page someone is using scrolls itself.
      if (e.target instanceof Element && e.target.closest(".cnv-page[data-live]")) return;
      e.preventDefault();
      const c = camRef.current;
      const pinch = e.ctrlKey || e.metaKey;
      if (gesturing && pinch) return;
      if (pinch) {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageRef.current.h : 1;
        const k = Math.exp(-e.deltaY * unit * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002));
        setCam(zoomCameraAt(c, c.z * k, at(e)), { user: true });
        return;
      }
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageRef.current.h : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      // Shift with a mouse wheel goes sideways.
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      setCam(panCamera(c, -dx, -dy), { user: true });
    };
    // Safari's trackpad pinch: its own events, `scale` counted from the gesture's start.
    const onGesture = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      gesturing = e.type !== "gestureend";
      if (e.type === "gesturestart") last = 1;
      if (e.type !== "gesturechange" || !g.scale || pointers.current.size > 1) return;
      const r = el.getBoundingClientRect();
      const p = { x: (g.clientX ?? r.left + r.width / 2) - r.left, y: (g.clientY ?? r.top + r.height / 2) - r.top };
      const c = camRef.current;
      setCam(zoomCameraAt(c, (c.z * g.scale) / last, p), { user: true });
      last = g.scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) el.addEventListener(type, onGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) el.removeEventListener(type, onGesture);
    };
  }, [setCam]);

  // ── Presence ────────────────────────────────────────────────────────────────────────────────────────────────────

  const cursorFrame = useRef(0);
  const sendCursor = useCallback(
    (p: Point | null) => {
      cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = requestAnimationFrame(() =>
        room.setLocal({ cursor: p ? { x: Math.round(p.x), y: Math.round(p.y), space: "canvas" } : undefined }),
      );
    },
    [room],
  );

  // A text box that closed forgets where its caret was opened.
  useEffect(() => {
    if (!editing) editAt.current = null;
  }, [editing]);

  // What is chosen goes out when the choice changes, not on every change to the canvas.
  const chosenKey = sel.join(",");
  useEffect(() => {
    const ids = chosenKey ? chosenKey.split(",") : [];
    room.setLocal({
      sel: ids.length ? { canvas: ids.slice(0, 200) } : undefined,
      mode: ids.length || editing ? "editing" : "viewing",
    });
  }, [room, chosenKey, editing]);

  useEffect(() => {
    const timer = setTimeout(() => room.setLocal({ view: peerViewOf(cam, stage) }), 120);
    return () => clearTimeout(timer);
  }, [room, cam, stage]);

  useEffect(
    () => () => {
      cancelAnimationFrame(cursorFrame.current);
      if (!room.destroyed) room.setLocal({ cursor: undefined, sel: undefined, view: undefined, mode: "viewing" });
    },
    [room],
  );

  // Following someone: their view (or, for an agent with none, what it works on, or its pointer).
  const followed: Peer | null = useMemo(() => {
    if (!following) return null;
    return peers.find((p) => !p.self && p.user.kind === following.user.kind && p.user.id === following.user.id) ?? null;
  }, [peers, following]);

  useEffect(() => {
    if (following && !followed) onStopFollowing();
  }, [following, followed, onStopFollowing]);

  const followView = followed?.state.view;
  const followSel = followed?.state.sel?.canvas?.join(",");
  const followCursor = followed?.state.cursor;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the followed peer's view, choice and pointer move it.
  useEffect(() => {
    if (!followed) return;
    const s = stageRef.current;
    let target: Camera | null = null;
    if (followView) target = followCamera(followView, s);
    else {
      const bounds = boundsOf(followed.state.sel?.canvas ?? [], store.now().byId);
      if (bounds) target = fitCamera(bounds, s, FIT_PADDING * 2, camRef.current.z);
      else if (followCursor?.space === "canvas") target = centerOn(followCursor, s, camRef.current.z);
    }
    if (target) glideTo(target, { ms: 220 });
  }, [
    followed?.clientId,
    followView?.x,
    followView?.y,
    followView?.w,
    followView?.h,
    followSel,
    followCursor?.x,
    followCursor?.y,
  ]);

  // ── Selection out ───────────────────────────────────────────────────────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: the words follow the chosen ids and their kinds.
  useEffect(() => {
    onSelection(selectionOf(t, selShapes));
  }, [chosenKey, selShapes.map((s) => s.type).join(","), t]);

  // Placeholders turned pictures fade in (once); new pictures from Generate come into view.
  useEffect(() => {
    for (const s of list) {
      if (s.type === "pending") wasPending.current.add(s.id);
      else if (s.type === "image" && wasPending.current.has(s.id)) {
        const id = s.id;
        setTimeout(() => wasPending.current.delete(id), 1500);
      }
    }
    const ids = reveal.current;
    if (!ids?.length || !ids.every((id) => byId.has(id))) return;
    reveal.current = null;
    const bounds = boundsOf(ids, byId);
    if (!bounds) return;
    const view = visibleWorld(camRef.current, stageRef.current);
    const inside =
      bounds.x >= view.x &&
      bounds.y >= view.y &&
      bounds.x + bounds.w <= view.x + view.w &&
      bounds.y + bounds.h <= view.y + view.h;
    if (!inside) glideTo(fitCamera(bounds, stageRef.current, FIT_PADDING * 2, camRef.current.z));
  }, [list, byId, glideTo]);

  // ── Edits ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Writes waiting for the next frame (a drag writes once a frame, whatever the pointer's rate). */
  const scheduleWrite = useCallback((write: () => void) => {
    pendingWrite.current = write;
    if (writeFrame.current) return;
    writeFrame.current = requestAnimationFrame(() => {
      writeFrame.current = 0;
      const w = pendingWrite.current;
      pendingWrite.current = null;
      w?.();
    });
  }, []);

  const flushWrite = useCallback(() => {
    cancelAnimationFrame(writeFrame.current);
    writeFrame.current = 0;
    const w = pendingWrite.current;
    pendingWrite.current = null;
    w?.();
  }, []);

  /** A refused edit (the canvas is full, a shape gone meanwhile) says so instead of failing quietly. */
  const safely = useCallback(
    <T,>(edit: () => T): T | undefined => {
      try {
        return edit();
      } catch (error) {
        const code = (error as { code?: string }).code;
        toast.show(
          code === "too_many"
            ? t("live.canvas.errors.tooMany")
            : code === "too_large"
              ? t("live.canvas.errors.tooLarge")
              : t("live.canvas.errors.other"),
          "error",
        );
        return undefined;
      }
    },
    [toast, t],
  );

  const endStep = useCallback(() => room.undo.stopCapturing(), [room]);

  const removeShapes = useCallback(
    (ids: readonly string[]) => {
      if (readOnly || !ids.length) return;
      safely(() => deleteShapes(doc, ids, LOCAL));
      endStep();
      setSelected([]);
    },
    [readOnly, doc, safely, endStep],
  );

  const duplicate = useCallback(
    (ids: readonly string[], offset = PASTE_STEP) => {
      if (readOnly) return [];
      const clip = copyShapes(doc, fileId, ids);
      if (!clip) return [];
      const made = safely(() => pasteClip(doc, clip, offset, offset, LOCAL)) ?? [];
      endStep();
      setSelected(made);
      return made;
    },
    [readOnly, doc, fileId, safely, endStep],
  );

  /** A new shape where the person pointed, inside the frame under it; chosen, and its text open for typing. */
  const create = useCallback(
    (type: "note" | "text" | "shape" | "frame", box: Box, text?: string) => {
      const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const parent = frameAt(doc, c.x, c.y);
      const id = safely(() =>
        addShape(
          doc,
          {
            type,
            ...box,
            ...(parent ? { parent } : {}),
            ...(type === "frame" ? { name: t("live.canvas.newFrame") } : {}),
            ...(text !== undefined ? { text } : {}),
          },
          LOCAL,
        ),
      );
      if (!id) return null;
      if (type === "frame") {
        // What lies whole inside a new frame goes into it.
        const now = store.now();
        const inside = now.list
          .filter((s) => s.id !== id && s.type !== "arrow" && (s.parent ?? null) === (parent ?? null))
          .filter((s) => {
            const b = shapeBounds(s, now.byId);
            return b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h;
          })
          .map((s) => s.id);
        if (inside.length) safely(() => setParent(doc, inside, id, LOCAL));
      }
      endStep();
      setSelected([id]);
      if (type !== "frame" && type !== "shape" && text === undefined) setEditing(id);
      if (type === "frame") setNaming({ id, kind: "frame" });
      return id;
    },
    [doc, safely, endStep, store, t],
  );

  /** A shape of its default size centered on a world point. */
  const createAt = useCallback(
    (type: "note" | "text" | "shape" | "frame", at: Point, text?: string) => {
      const size = type === "text" ? { w: 320, h: 40 } : defaultSize(type);
      return create(type, { x: at.x - size.w / 2, y: at.y - size.h / 2, w: size.w, h: size.h }, text);
    },
    [create],
  );

  /** Pictures from the computer (dropped, pasted, picked) uploaded into the file and placed around `at`. */
  const placeFiles = useCallback(
    async (files: File[], at: Point) => {
      if (readOnly) return;
      const pictures = files.filter((f) => IMAGE_TYPES.has(f.type));
      if (!pictures.length) {
        toast.show(t("live.canvas.errors.onlyImages"), "error");
        return;
      }
      const fitting = pictures.filter((f) => f.size <= MAX_ASSET_BYTES);
      if (fitting.length < pictures.length) toast.show(t("live.canvas.errors.imageTooBig"), "error");
      if (!fitting.length) return;
      const sizes = await Promise.all(fitting.map(naturalSize));
      const gap = 24;
      const boxes = sizes.map((s) => {
        const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(s.w, s.h));
        return { w: s.w * k, h: s.h * k };
      });
      const total = boxes.reduce((sum, b) => sum + b.w, 0) + gap * (boxes.length - 1);
      let x = at.x - total / 2;
      const placedBoxes = boxes.map((b) => {
        const box = { x, y: at.y - b.h / 2, w: b.w, h: b.h };
        x += b.w + gap;
        return box;
      });
      const keys = placedBoxes.map((box) => {
        const key = ++uploadKey.current;
        return { key, box };
      });
      setUploads((u) => [...u, ...keys]);
      const made: string[] = [];
      await Promise.all(
        fitting.map(async (file, i) => {
          const ghost = keys[i];
          const size = sizes[i];
          if (!ghost || !size) return;
          try {
            const asset = await api.live.uploadAsset(orgId, fileId, file);
            const c = { x: ghost.box.x + ghost.box.w / 2, y: ghost.box.y + ghost.box.h / 2 };
            const parent = frameAt(doc, c.x, c.y);
            const id = safely(() =>
              addShape(
                doc,
                {
                  type: "image",
                  asset: asset.id,
                  nw: asset.width ?? size.w,
                  nh: asset.height ?? size.h,
                  ...ghost.box,
                  ...(parent ? { parent } : {}),
                  alt: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200),
                },
                LOCAL,
              ),
            );
            if (id) made.push(id);
          } catch (error) {
            toast.show(errorText(t, error, i18n.language, { maxMb: 25 }), "error");
          } finally {
            setUploads((u) => u.filter((g) => g.key !== ghost.key));
          }
        }),
      );
      endStep();
      if (made.length) setSelected(made);
    },
    [readOnly, toast, t, i18n.language, api, orgId, fileId, doc, safely, endStep],
  );

  /** Where a paste lands: under the pointer when it is over the plane, else the middle of the view. */
  const pasteAt = useCallback((): Point | null => pointerWorld.current, []);

  /** Shapes copied before (here or on another canvas) put on this one. */
  const pasteShapes = useCallback(
    async (clip: CanvasClip) => {
      if (readOnly) return;
      let here = clip;
      const copies = assetsToCopy(clip, fileId);
      if (copies.length) {
        const map = new Map<string, string>();
        await Promise.all(
          copies.map(async (assetId) => {
            try {
              const asset = await api.live.copyAsset(orgId, fileId, { fileId: clip.file, assetId });
              map.set(assetId, asset.id);
            } catch {
              // A picture this person can't read there stays out.
            }
          }),
        );
        if (map.size < copies.length) toast.show(t("live.canvas.errors.someImagesLeft"), "error");
        here = withAssets(clip, fileId, map);
      }
      const bounds = clipBounds(here);
      if (!bounds) return;
      const at = pasteAt();
      let dx: number;
      let dy: number;
      if (at) {
        dx = at.x - (bounds.x + bounds.w / 2);
        dy = at.y - (bounds.y + bounds.h / 2);
      } else if (clip.file === fileId) {
        pasteCount.current += 1;
        dx = PASTE_STEP * pasteCount.current;
        dy = PASTE_STEP * pasteCount.current;
      } else {
        const c = viewCenter();
        dx = c.x - (bounds.x + bounds.w / 2);
        dy = c.y - (bounds.y + bounds.h / 2);
      }
      const made = safely(() => pasteClip(doc, here, dx, dy, LOCAL)) ?? [];
      endStep();
      setSelected(made);
    },
    [readOnly, fileId, api, orgId, toast, t, pasteAt, viewCenter, safely, doc, endStep],
  );

  /** Paste from the context menu: the system's clipboard when the browser lets it be read, else this tab's copy. */
  const pasteFromMenu = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes("text/html")) {
          const html = await (await item.getType("text/html")).text();
          const clip = readClip({ html });
          if (clip) return void (await pasteShapes(clip));
        }
        const picture = item.types.find((type) => IMAGE_TYPES.has(type));
        if (picture) {
          const blob = await item.getType(picture);
          const file = new File([blob], `${t("live.canvas.kinds.image")}.${picture.split("/")[1]}`, { type: picture });
          return void (await placeFiles([file], pasteAt() ?? viewCenter()));
        }
        if (item.types.includes("text/plain")) {
          const text = (await (await item.getType("text/plain")).text()).trim();
          if (text) return void createAt("text", pasteAt() ?? viewCenter(), text.slice(0, 20_000));
        }
      }
    } catch {
      // The browser keeps its clipboard to itself: what was copied here comes instead.
    }
    if (memoryClip) await pasteShapes(memoryClip);
  }, [pasteShapes, placeFiles, createAt, pasteAt, viewCenter, t]);

  const copySelection = useCallback(
    (data?: DataTransfer | null) => {
      const clip = copyShapes(doc, fileId, sel);
      if (!clip) return false;
      memoryClip = clip;
      pasteCount.current = 0;
      const { json, html, text } = clipPayload(clip);
      if (data) {
        data.setData(CLIP_TYPE, json);
        data.setData("text/html", html);
        data.setData("text/plain", text);
      } else {
        void navigator.clipboard
          ?.write?.([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([text], { type: "text/plain" }),
            }),
          ])
          .catch(() => {});
      }
      return true;
    },
    [doc, fileId, sel],
  );

  const assetUrl = useCallback((assetId: string) => api.live.assetUrl(orgId, fileId, assetId), [api, orgId, fileId]);

  const downloadImage = useCallback(
    (shape: ShapeView) => {
      if (!shape.asset) return;
      fileSaver.save(assetUrl(shape.asset), fileNameOf(shape.gen?.prompt ?? shape.alt, t("live.canvas.imageFile")));
    },
    [assetUrl, t],
  );

  const copyImage = useCallback(
    (shape: ShapeView) => {
      if (!shape.asset) return;
      const url = assetUrl(shape.asset);
      try {
        // The picture as a promise, so the browser still counts the press as what asked to copy.
        const png = fetch(url, { credentials: "same-origin" })
          .then((res) => res.blob())
          .then(asPng);
        void navigator.clipboard
          .write([new ClipboardItem({ "image/png": png })])
          .then(() => toast.show(t("live.canvas.imageCopied")))
          .catch(() => toast.show(t("live.canvas.errors.copyImage"), "error"));
      } catch {
        toast.show(t("live.canvas.errors.copyImage"), "error");
      }
    },
    [assetUrl, toast, t],
  );

  const runGenerate = useCallback(
    async (input: Omit<GenerateImagesInput, "at">, at?: Point) => {
      try {
        const res = await generate.mutateAsync({ ...input, at: at ?? viewCenter() });
        const ids = res.frameId ? [res.frameId] : res.shapeIds;
        reveal.current = ids;
        setSelected(ids);
        return true;
      } catch {
        // The query client says what went wrong.
        return false;
      }
    },
    [generate, viewCenter],
  );

  const variations = useCallback(
    (shape: ShapeView) => {
      const list = models.data ?? [];
      const model = list.find((m) => m.id === shape.gen?.model && m.refs) ?? list.find((m) => m.refs);
      if (!model || !shape.gen) return;
      const aspect = shape.nw && shape.nh ? nearestAspect(shape.nw, shape.nh, model.aspects) : undefined;
      void runGenerate(
        {
          prompt: shape.gen.prompt,
          count: Math.min(2, model.maxCount),
          model: model.id,
          references: [shape.id],
          ...(aspect ? { aspect } : {}),
        },
        { x: shape.x + shape.w * 1.5 + 40, y: shape.y + shape.h / 2 },
      );
    },
    [models.data, runGenerate],
  );

  const openGenerate = useCallback((d: GenerateDraft | null = null) => {
    setGenDraft(d);
    setGenerating(true);
  }, []);

  /** Stable for the hook's life, so the shapes' shared env stays one object while the canvas is open. */
  const retryImages = retry.mutate;
  const env = useMemo<CanvasEnv>(
    () => ({
      room,
      orgId,
      fileId,
      readOnly,
      assetUrl,
      retry: (requestId) => retryImages(requestId),
      interact: (id) => {
        setInteracting(id);
        setSelected([id]);
      },
      doneEditing: (id, box) => {
        const shape = store.now().byId.get(id);
        if (!shape || readOnly) return;
        const empty = !shape.text?.some((p) => p.runs.some((r) => r.text.trim()));
        if (shape.type === "text" && empty) {
          deleteShapes(doc, [id], LOCAL);
          setSelected((s) => s.filter((x) => x !== id));
        } else if (shape.type === "text" && box && box.h > 0 && Math.abs(box.h - shape.h) > 1) {
          updateShape(doc, id, { h: Math.max(24, box.h) }, LOCAL);
        }
        room.undo.stopCapturing();
      },
      stopEditing: (id) => {
        setEditing((now) => (now === id ? null : now));
        setSelected([id]);
        planeRef.current?.focus({ preventScroll: true });
      },
      caretFor: (id) => {
        const at = editAt.current;
        return at?.id === id ? { x: at.x, y: at.y } : "end";
      },
      openFile: (id) => viewer?.open(id),
    }),
    [room, orgId, fileId, readOnly, assetUrl, store, doc, viewer, retryImages],
  );

  // ── Pointer ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = planeRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const worldOf = (e: { clientX: number; clientY: number }) => toWorld(camRef.current, local(e));
  const hitAt = (p: Point) => {
    const now = store.now();
    return hitShape(now.list, now.byId, p, camRef.current.z);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const target = e.target as Element;
    // A shape's own buttons, the open text box, a page in use, the bars over the plane: theirs.
    if (editing && target.closest(`[data-shape="${editing}"]`)) return;
    if (interacting && target.closest(`[data-shape="${interacting}"]`)) return;
    if (target.closest(".cnv-bar, .cnv-over__name-input, .cnv-over__label-input") || isControl(target)) return;
    if (editing) setEditing(null);
    if (interacting) setInteracting(null);
    planeRef.current?.focus({ preventScroll: true });
    const screen = local(e);
    pointers.current.set(e.pointerId, screen);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    flushWrite();

    // Two fingers: pinch and pan.
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        gesture.current = {
          kind: "pinch",
          startDist: distance(a, b),
          startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          cam: camRef.current,
        };
        setDraft(null);
        setBusy(false);
      }
      return;
    }
    if (pointers.current.size > 2) return;

    const world = toWorld(camRef.current, screen);
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle") ?? null;
    const label = target.closest("[data-frame-label]")?.getAttribute("data-frame-label") ?? null;
    const hit = label ? { id: label, part: "frameEdge" as HitPart } : hitAt(world);

    if (e.button === 1 || tool === "hand" || space || (e.pointerType === "touch" && !hit && !handle)) {
      gesture.current = { kind: "pan", last: screen };
      setPanning(true);
      return;
    }
    if (readOnly && tool !== "select") return;

    if (handle && !readOnly) {
      const now = store.now();
      if (handle === "rotate" && sel.length === 1) {
        const s = now.byId.get(sel[0] as string);
        if (s) {
          gesture.current = { kind: "rotate", id: s.id, center: { x: s.x + s.w / 2, y: s.y + s.h / 2 } };
          setBusy(true);
          return;
        }
      }
      if ((handle === "from" || handle === "to") && sel.length === 1) {
        gesture.current = { kind: "end", arrow: sel[0] as string, end: handle };
        setBusy(true);
        return;
      }
      if ((HANDLES as readonly string[]).includes(handle)) {
        if (sel.length === 1) {
          const s = now.byId.get(sel[0] as string);
          if (s) {
            gesture.current = {
              kind: "resize",
              id: s.id,
              handle: handle as Handle,
              box: { x: s.x, y: s.y, w: s.w, h: s.h },
              rot: s.rot ?? 0,
              startWorld: world,
              ratio: s.type === "image" || s.type === "pending",
            };
            setBusy(true);
            return;
          }
        } else if (sel.length > 1) {
          const ids = topLevelOf(sel, now.list).filter((id) => now.byId.get(id)?.type !== "arrow");
          const bounds = boundsOf(ids, now.byId);
          if (bounds) {
            const boxes = new Map(
              ids.map((id) => {
                const s = now.byId.get(id) as ShapeView;
                return [id, { x: s.x, y: s.y, w: s.w, h: s.h }];
              }),
            );
            gesture.current = { kind: "group", handle: handle as Handle, bounds, boxes, startWorld: world };
            setBusy(true);
            return;
          }
        }
      }
    }

    if (tool === "note" || tool === "text" || tool === "shape" || tool === "frame") {
      gesture.current = { kind: "draw", tool, startWorld: world, startScreen: screen };
      return;
    }
    if (tool === "arrow") {
      const from = hit && store.now().byId.get(hit.id)?.type !== "arrow" ? hit.id : null;
      gesture.current = {
        kind: "arrow",
        from: from ? { shape: from } : { x: world.x, y: world.y },
        fromShape: from,
        startWorld: world,
        startScreen: screen,
      };
      return;
    }

    // The select tool.
    if (!hit) {
      gesture.current = { kind: "marquee", startWorld: world, base: e.shiftKey ? sel : [] };
      if (!e.shiftKey) setSelected([]);
      return;
    }
    const wasSelected = sel.includes(hit.id);
    const frameRoom = hit.part === "frameInside" && !wasSelected;
    if (!wasSelected && !frameRoom) setSelected(e.shiftKey ? [...sel, hit.id] : [hit.id]);
    gesture.current = {
      kind: "press",
      startScreen: screen,
      startWorld: world,
      hit,
      shift: e.shiftKey,
      alt: e.altKey,
      wasSelected,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const screen = local(e);
    const world = toWorld(camRef.current, screen);
    if (e.pointerType !== "touch") {
      pointerWorld.current = world;
      sendCursor(world);
    }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, screen);
    const g = gesture.current;
    if (!g) {
      if (tool === "select" && !readOnly && e.pointerType === "mouse") {
        const hit = hitAt(world);
        const id = hit && hit.part !== "frameInside" ? hit.id : null;
        if (id !== hover) setHover(id);
      }
      return;
    }
    switch (g.kind) {
      case "pinch": {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const z = zoomCameraAt(g.cam, g.cam.z * (distance(a, b) / g.startDist), g.startMid);
        setCam(panCamera(z, mid.x - g.startMid.x, mid.y - g.startMid.y), { user: true });
        return;
      }
      case "pan": {
        setCam(panCamera(camRef.current, screen.x - g.last.x, screen.y - g.last.y), { user: true });
        g.last = screen;
        return;
      }
      case "press": {
        if (distance(screen, g.startScreen) <= CLICK_SLOP) return;
        const now = store.now();
        const frameRoom = g.hit?.part === "frameInside" && !g.wasSelected;
        if (!g.hit || frameRoom || readOnly) {
          gesture.current = { kind: "marquee", startWorld: g.startWorld, base: g.shift ? sel : [] };
          if (!g.shift) setSelected([]);
          onPointerMove(e);
          return;
        }
        let ids = topLevelOf(sel.includes(g.hit.id) ? sel : [g.hit.id], now.list).filter(
          (id) => !now.byId.get(id)?.locked,
        );
        if (!ids.length) {
          gesture.current = null;
          return;
        }
        if (g.alt) {
          const clip = copyShapes(doc, fileId, ids);
          const made = clip ? (safely(() => pasteClip(doc, clip, 0, 0, LOCAL)) ?? []) : [];
          if (made.length) {
            ids = made;
            setSelected(made);
          }
        }
        const fresh = store.now();
        const moving = new Set(ids);
        gesture.current = {
          kind: "move",
          ids,
          startWorld: g.startWorld,
          applied: { x: 0, y: 0 },
          bounds: boundsOf(ids, fresh.byId),
          targets: snapTargets(fresh.list, fresh.byId, moving, visibleWorld(camRef.current, stageRef.current)),
        };
        setHover(null);
        setBusy(true);
        onPointerMove(e);
        return;
      }
      case "move": {
        let dx = world.x - g.startWorld.x;
        let dy = world.y - g.startWorld.y;
        let guides: Draft["guides"] = [];
        if (g.bounds && !(e.metaKey || e.ctrlKey)) {
          const moved = { x: g.bounds.x + dx, y: g.bounds.y + dy, w: g.bounds.w, h: g.bounds.h };
          const snap = snapLines(moved, g.targets, SNAP_PX / camRef.current.z);
          dx += snap.dx;
          dy += snap.dy;
          guides = snap.guides;
        }
        setDraft(guides.length ? { guides } : null);
        const ids = g.ids;
        scheduleWrite(() => {
          const ddx = dx - g.applied.x;
          const ddy = dy - g.applied.y;
          if (!ddx && !ddy) return;
          g.applied = { x: dx, y: dy };
          safely(() => moveShapes(doc, ids, ddx, ddy, LOCAL));
        });
        return;
      }
      case "marquee": {
        const rect = boxFrom(g.startWorld, world);
        setDraft({ marquee: rect });
        const now = store.now();
        const hits = marqueeHits(now.list, now.byId, rect);
        setSelected([...new Set([...g.base, ...hits])]);
        return;
      }
      case "resize": {
        const next = resizeBox(
          g.box,
          g.rot,
          g.handle,
          { x: world.x - g.startWorld.x, y: world.y - g.startWorld.y },
          { ratio: g.ratio !== e.shiftKey },
        );
        scheduleWrite(() => safely(() => resizeShape(doc, g.id, next, LOCAL)));
        return;
      }
      case "group": {
        const { boxes } = scaleGroup(
          g.bounds,
          g.handle,
          { x: world.x - g.startWorld.x, y: world.y - g.startWorld.y },
          [...g.boxes.values()],
          { ratio: !e.shiftKey },
        );
        const ids = [...g.boxes.keys()];
        scheduleWrite(() =>
          doc.transact(() => {
            ids.forEach((id, i) => {
              const box = boxes[i];
              if (box) safely(() => resizeShape(doc, id, box, LOCAL));
            });
          }, LOCAL),
        );
        return;
      }
      case "rotate": {
        const rot = rotationAt(g.center, world, e.shiftKey);
        scheduleWrite(() => safely(() => updateShape(doc, g.id, { rot }, LOCAL)));
        return;
      }
      case "draw": {
        if (distance(screen, g.startScreen) <= CLICK_SLOP) return;
        let box = boxFrom(g.startWorld, world);
        if (e.shiftKey || g.tool === "note") {
          const side = Math.max(box.w, box.h);
          box = {
            x: world.x < g.startWorld.x ? g.startWorld.x - side : g.startWorld.x,
            y: world.y < g.startWorld.y ? g.startWorld.y - side : g.startWorld.y,
            w: side,
            h: side,
          };
        }
        setDraft({ box });
        return;
      }
      case "arrow": {
        const hit = hitAt(world);
        const to = hit && hit.id !== g.fromShape && store.now().byId.get(hit.id)?.type !== "arrow" ? hit.id : null;
        setHover(to);
        const start = g.fromShape ? store.now().byId.get(g.fromShape) : undefined;
        const from = start ? { x: start.x + start.w / 2, y: start.y + start.h / 2 } : g.startWorld;
        setDraft({ line: { from, to: world } });
        return;
      }
      case "end": {
        const arrow = store.now().byId.get(g.arrow);
        if (!arrow) return;
        const other = g.end === "from" ? arrow.to : arrow.from;
        const otherShape = other && "shape" in other ? store.now().byId.get(other.shape) : undefined;
        const fixed = otherShape
          ? { x: otherShape.x + otherShape.w / 2, y: otherShape.y + otherShape.h / 2 }
          : other && !("shape" in other)
            ? other
            : world;
        const hit = hitAt(world);
        setHover(hit && hit.id !== g.arrow ? hit.id : null);
        setDraft({ line: g.end === "to" ? { from: fixed, to: world } : { from: world, to: fixed } });
        return;
      }
    }
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>, cancelled = false) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      else {
        // One finger of a pinch lifted: the other one moves the plane.
        const [left] = [...pointers.current.values()];
        gesture.current = left ? { kind: "pan", last: left } : null;
      }
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = null;
    setPanning(false);
    setBusy(false);
    setDraft(null);
    const world = worldOf(e);
    switch (g.kind) {
      case "press": {
        if (cancelled || !g.hit) return;
        const id = g.hit.id;
        if (g.hit.part === "frameInside" && !g.wasSelected) setSelected(g.shift ? [...sel, id] : [id]);
        else if (g.shift && g.wasSelected) setSelected(sel.filter((x) => x !== id));
        else if (!g.shift && g.wasSelected && sel.length > 1) setSelected([id]);
        return;
      }
      case "move": {
        flushWrite();
        // Each moved shape goes into the frame its middle landed on (or out of any).
        const now = store.now();
        const frames = g.ids.filter((id) => now.byId.get(id)?.type === "frame");
        doc.transact(() => {
          for (const id of g.ids) {
            const s = now.byId.get(id);
            if (!s || s.type === "arrow") continue;
            const under = frameAt(doc, s.x + s.w / 2, s.y + s.h / 2, [id, ...frames]);
            if ((under ?? undefined) !== s.parent) safely(() => setParent(doc, [id], under, LOCAL));
          }
        }, LOCAL);
        endStep();
        return;
      }
      case "resize":
      case "group":
      case "rotate":
        flushWrite();
        endStep();
        return;
      case "draw": {
        if (cancelled) return;
        const small = distance(local(e), g.startScreen) <= CLICK_SLOP;
        let box: Box;
        if (small) {
          const size = g.tool === "text" ? { w: 320, h: 40 } : defaultSize(g.tool);
          box = { x: g.startWorld.x - size.w / 2, y: g.startWorld.y - size.h / 2, w: size.w, h: size.h };
        } else {
          box = boxFrom(g.startWorld, world);
          if (e.shiftKey || g.tool === "note") {
            const side = Math.max(box.w, box.h);
            box = {
              x: world.x < g.startWorld.x ? g.startWorld.x - side : g.startWorld.x,
              y: world.y < g.startWorld.y ? g.startWorld.y - side : g.startWorld.y,
              w: side,
              h: side,
            };
          }
          box = { ...box, w: Math.max(box.w, 24), h: Math.max(box.h, g.tool === "text" ? 40 : 24) };
        }
        create(g.tool, box);
        setTool("select");
        return;
      }
      case "arrow": {
        setHover(null);
        if (cancelled || distance(local(e), g.startScreen) <= CLICK_SLOP) return;
        const hit = hitAt(world);
        const toShape = hit && hit.id !== g.fromShape && store.now().byId.get(hit.id)?.type !== "arrow" ? hit.id : null;
        const id = safely(() =>
          addShape(
            doc,
            { type: "arrow", from: g.from, to: toShape ? { shape: toShape } : { x: world.x, y: world.y } },
            LOCAL,
          ),
        );
        endStep();
        if (id) setSelected([id]);
        setTool("select");
        return;
      }
      case "end": {
        setHover(null);
        if (cancelled) return;
        const hit = hitAt(world);
        const target: ArrowEnd =
          hit && hit.id !== g.arrow && store.now().byId.get(hit.id)?.type !== "arrow"
            ? { shape: hit.id }
            : { x: world.x, y: world.y };
        safely(() => updateShape(doc, g.arrow, { [g.end]: target }, LOCAL));
        endStep();
        return;
      }
      default:
        return;
    }
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (isControl(target) || isEditable(target)) return;
    if (editing && target.closest(`[data-shape="${editing}"]`)) return;
    const label = target.closest("[data-frame-label]")?.getAttribute("data-frame-label");
    if (label) {
      if (!readOnly) setNaming({ id: label, kind: "frame" });
      return;
    }
    const world = worldOf(e);
    const hit = hitAt(world);
    const shape = hit ? store.now().byId.get(hit.id) : undefined;
    if (!shape || hit?.part === "frameInside") {
      if (!readOnly && tool === "select") createAt("text", world);
      return;
    }
    switch (shape.type) {
      case "image":
        setZoomed(shape);
        return;
      case "file":
        if (shape.artifact) viewer?.open(shape.artifact);
        return;
      case "html":
        env.interact(shape.id);
        return;
      default:
        break;
    }
    if (readOnly) return;
    if (shape.type === "note" || shape.type === "text" || shape.type === "shape") {
      editAt.current = { id: shape.id, x: e.clientX, y: e.clientY };
      setSelected([shape.id]);
      setEditing(shape.id);
    } else if (shape.type === "arrow") setNaming({ id: shape.id, kind: "label" });
    else if (shape.type === "frame") setNaming({ id: shape.id, kind: "frame" });
  };

  const onName = useCallback(
    (id: string, kind: "frame" | "label", value: string | null) => {
      setNaming(null);
      planeRef.current?.focus({ preventScroll: true });
      if (value === null || readOnly) return;
      const shape = store.now().byId.get(id);
      if (!shape) return;
      const next = value.trim();
      if (kind === "frame" && next && next !== shape.name) safely(() => updateShape(doc, id, { name: next }, LOCAL));
      if (kind === "label" && next !== (shape.label ?? "")) {
        safely(() => updateShape(doc, id, { label: next || null }, LOCAL));
      }
      endStep();
    },
    [readOnly, store, safely, doc, endStep],
  );

  // ── Keys and the clipboard ──────────────────────────────────────────────────────────────────────────────────────

  const arrange = useCallback(
    (how: "front" | "forward" | "backward" | "back") => {
      if (readOnly || !sel.length) return;
      safely(() => arrangeShapes(doc, sel, how, LOCAL));
      endStep();
    },
    [readOnly, sel, safely, doc, endStep],
  );

  const pickTool = useCallback((next: Tool) => {
    setTool(next);
    setEditing(null);
    if (next !== "select") setHover(null);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const typing = isEditable(e.target);
    if (e.key === "Escape") {
      if (typing && editing) {
        e.preventDefault();
        const id = editing;
        setEditing(null);
        setSelected([id]);
        planeRef.current?.focus({ preventScroll: true });
        return;
      }
      if (typing) return;
      if (interacting) {
        setInteracting(null);
        e.preventDefault();
        return;
      }
      if (tool !== "select") {
        setTool("select");
        e.preventDefault();
        return;
      }
      if (sel.length) {
        setSelected([]);
        e.preventDefault();
      }
      return;
    }
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey) {
      if (key === "z") {
        e.preventDefault();
        if (readOnly) return;
        if (e.shiftKey) room.undo.redo();
        else room.undo.undo();
        return;
      }
      if (key === "y" && !isApple()) {
        e.preventDefault();
        if (!readOnly) room.undo.redo();
        return;
      }
      if (key === "a") {
        e.preventDefault();
        setSelected(
          topLevelOf(
            store.now().list.map((s) => s.id),
            store.now().list,
          ),
        );
        return;
      }
      if (key === "d") {
        e.preventDefault();
        duplicate(sel);
        return;
      }
      return;
    }
    if (isControl(e.target) && (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow"))) return;
    if (e.key === " " && !e.repeat) {
      e.preventDefault();
      setSpace(true);
      return;
    }
    if (e.altKey) return;
    if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      fitAll();
      return;
    }
    if (e.shiftKey && e.code === "Digit2") {
      e.preventDefault();
      fitSelection();
      return;
    }
    if (e.shiftKey && e.code === "Digit0") {
      e.preventDefault();
      zoomActual();
      return;
    }
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      zoomStep(1);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomStep(-1);
      return;
    }
    if (e.code === "BracketRight" || e.code === "BracketLeft") {
      e.preventDefault();
      const up = e.code === "BracketRight";
      arrange(e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward");
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
      e.preventDefault();
      removeShapes(sel);
      return;
    }
    if (e.key === "Enter" && sel.length === 1 && !readOnly) {
      const s = byId.get(sel[0] as string);
      if (!s) return;
      e.preventDefault();
      if (s.type === "note" || s.type === "text" || s.type === "shape") setEditing(s.id);
      else if (s.type === "frame") setNaming({ id: s.id, kind: "frame" });
      else if (s.type === "arrow") setNaming({ id: s.id, kind: "label" });
      else if (s.type === "image") setZoomed(s);
      return;
    }
    if (e.key.startsWith("Arrow") && sel.length && !readOnly) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * NUDGE;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const ids = topLevelOf(sel, store.now().list).filter((id) => !store.now().byId.get(id)?.locked);
      safely(() => moveShapes(doc, ids, dx, dy, LOCAL));
      return;
    }
    if (e.shiftKey || mod) return;
    const toolKeys: Record<string, Tool> = { v: "select", h: "hand" };
    const editKeys: Record<string, Tool> = { n: "note", t: "text", r: "shape", a: "arrow", f: "frame" };
    if (toolKeys[key]) {
      e.preventDefault();
      pickTool(toolKeys[key]);
      return;
    }
    if (readOnly) return;
    if (editKeys[key]) {
      e.preventDefault();
      pickTool(editKeys[key]);
      return;
    }
    if (key === "i") {
      e.preventDefault();
      fileInput.current?.click();
      return;
    }
    if (key === "g" && canGenerate) {
      e.preventDefault();
      openGenerate();
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " ") setSpace(false);
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (isEditable(e.target) || !sel.length) return;
    if (copySelection(e.clipboardData)) e.preventDefault();
  };
  const onCut = (e: ClipboardEvent<HTMLDivElement>) => {
    if (isEditable(e.target) || !sel.length || readOnly) return;
    if (copySelection(e.clipboardData)) {
      e.preventDefault();
      removeShapes(sel);
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (isEditable(e.target) || readOnly) return;
    const data = e.clipboardData;
    const clip = readClip({ json: data.getData(CLIP_TYPE), html: data.getData("text/html") });
    if (clip) {
      e.preventDefault();
      void pasteShapes(clip);
      return;
    }
    const files = [...data.files].filter((f) => IMAGE_TYPES.has(f.type));
    if (files.length) {
      e.preventDefault();
      void placeFiles(files, pasteAt() ?? viewCenter());
      return;
    }
    const text = data.getData("text/plain").trim();
    if (text) {
      e.preventDefault();
      createAt("text", pasteAt() ?? viewCenter(), text.slice(0, 20_000));
    }
  };

  // The desktop app's Edit menu sends undo and redo as `beforeinput` to what has the focus.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onInput = (e: Event) => {
      const type = (e as InputEvent).inputType;
      if ((type !== "historyUndo" && type !== "historyRedo") || isEditable(e.target) || readOnly) return;
      e.preventDefault();
      if (type === "historyUndo") room.undo.undo();
      else room.undo.redo();
    };
    el.addEventListener("beforeinput", onInput);
    return () => el.removeEventListener("beforeinput", onInput);
  }, [room, readOnly]);

  // ── Drop ────────────────────────────────────────────────────────────────────────────────────────────────────────

  const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly || !carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropping) setDropping(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropping(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    if (readOnly || !carriesFiles(e)) return;
    e.preventDefault();
    void placeFiles([...e.dataTransfer.files], worldOf(e));
  };

  // ── Menus ───────────────────────────────────────────────────────────────────────────────────────────────────────

  const shapeBarAction = (action: ShapeBarAction) => {
    if (readOnly) return;
    const ids = sel;
    switch (action.kind) {
      case "color":
        doc.transact(() => {
          for (const id of ids)
            if (byId.get(id)?.type === "note") safely(() => updateShape(doc, id, { color: action.color }, LOCAL));
        }, LOCAL);
        break;
      case "fill":
        doc.transact(() => {
          for (const id of ids) {
            if (byId.get(id)?.type !== "shape") continue;
            const fill = action.color ? SOFT[action.color].light : null;
            safely(() => updateShape(doc, id, { fill }, LOCAL));
          }
        }, LOCAL);
        break;
      case "size":
        doc.transact(() => {
          for (const id of ids) {
            const s = byId.get(id);
            if (s?.type !== "text") continue;
            safely(() => updateShape(doc, id, { style: { ...s.style, size: action.size } }, LOCAL));
          }
        }, LOCAL);
        break;
      case "shapeKind":
        doc.transact(() => {
          for (const id of ids)
            if (byId.get(id)?.type === "shape") safely(() => updateShape(doc, id, { kind: action.shapeKind }, LOCAL));
        }, LOCAL);
        break;
      case "dashed":
        doc.transact(() => {
          for (const id of ids)
            if (byId.get(id)?.type === "arrow")
              safely(() => updateShape(doc, id, { dashed: action.dashed || null }, LOCAL));
        }, LOCAL);
        break;
      case "label":
        if (ids[0]) setNaming({ id: ids[0], kind: "label" });
        return;
      case "rename":
        if (ids[0]) setNaming({ id: ids[0], kind: "frame" });
        return;
      case "arrange":
        arrange(action.how);
        return;
      case "duplicate":
        duplicate(ids);
        return;
      case "lock":
        doc.transact(() => {
          for (const id of ids) safely(() => updateShape(doc, id, { locked: action.locked || null }, LOCAL));
        }, LOCAL);
        break;
      case "delete":
        removeShapes(ids);
        return;
    }
    endStep();
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    const target = e.target as Element;
    if (interacting && target.closest(`[data-shape="${interacting}"]`)) return;
    if (target.closest(".cnv-dock, .cnv-zoom, .cnv-gen, .cnv-insp, .cnv-bar")) return;
    e.preventDefault();
    const world = worldOf(e);
    const label = target.closest("[data-frame-label]")?.getAttribute("data-frame-label");
    const hit = label ? { id: label, part: "frameEdge" as HitPart } : hitAt(world);
    const id = hit && hit.part !== "frameInside" ? hit.id : null;
    let ids = sel;
    if (id && !sel.includes(id)) {
      ids = [id];
      setSelected(ids);
    }
    pointerWorld.current = world;
    const entries: MenuEntry[] = [];
    const item = (
      key: string,
      label: string,
      run: () => void,
      extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {},
    ) => entries.push({ kind: "item", id: key, label, run, ...extra });
    if (id) {
      const shape = byId.get(id);
      if (!readOnly)
        item("cut", t("live.canvas.actions.cut"), () => copySelection() && removeShapes(ids), { icon: "copy" });
      item("copy", t("live.canvas.actions.copy"), () => copySelection(), { icon: "copy" });
      if (!readOnly) {
        item("paste", t("live.canvas.actions.paste"), () => void pasteFromMenu());
        item("duplicate", t("live.canvas.actions.duplicate"), () => duplicate(ids));
        entries.push({ kind: "separator" });
        item("front", t("live.canvas.arrange.front"), () => arrange("front"));
        item("forward", t("live.canvas.arrange.forward"), () => arrange("forward"));
        item("backward", t("live.canvas.arrange.backward"), () => arrange("backward"));
        item("back", t("live.canvas.arrange.back"), () => arrange("back"));
      }
      if (shape?.type === "image" && ids.length === 1) {
        entries.push({ kind: "separator" });
        item("download", t("live.canvas.inspector.download"), () => downloadImage(shape), { icon: "download" });
        item("copyImage", t("live.canvas.inspector.copy"), () => copyImage(shape), { icon: "image" });
        item("open", t("live.canvas.inspector.open"), () => setZoomed(shape), { icon: "expand" });
        if (!readOnly && shape.gen && (models.data ?? []).some((m) => m.refs)) {
          item("variations", t("live.canvas.inspector.variations"), () => variations(shape), { icon: "sparkle" });
        }
        if (!readOnly && (models.data ?? []).some((m) => m.refs)) {
          item("editAi", t("live.canvas.inspector.edit"), () => openGenerate({ prompt: "", references: [shape.id] }), {
            icon: "edit",
          });
        }
      }
      if (!readOnly && shape && ids.length === 1) {
        if (shape.type === "note" || shape.type === "text" || shape.type === "shape") {
          item("editText", t("live.canvas.actions.editText"), () => setEditing(shape.id), { icon: "edit" });
        }
        if (shape.type === "frame")
          item("rename", t("live.canvas.bar.rename"), () => setNaming({ id: shape.id, kind: "frame" }), {
            icon: "edit",
          });
        if (shape.type === "arrow")
          item("label", t("live.canvas.bar.label"), () => setNaming({ id: shape.id, kind: "label" }), { icon: "edit" });
        if (shape.type === "file" && shape.artifact && viewer) {
          const fid = shape.artifact;
          item("openFile", t("live.canvas.actions.openFile"), () => viewer.open(fid), { icon: "eye" });
        }
      }
      if (!readOnly) {
        const locked = ids.every((x) => byId.get(x)?.locked);
        entries.push({ kind: "separator" });
        item(
          "lock",
          locked ? t("live.canvas.actions.unlock") : t("live.canvas.actions.lock"),
          () => shapeBarAction({ kind: "lock", locked: !locked }),
          { icon: "lock" },
        );
        item("delete", t("live.canvas.actions.delete"), () => removeShapes(ids), { icon: "trash", danger: true });
      }
    } else {
      if (!readOnly) {
        item("paste", t("live.canvas.actions.paste"), () => void pasteFromMenu());
        item("note", t("live.canvas.actions.addNote"), () => createAt("note", world), { icon: "sticky" });
        item("text", t("live.canvas.actions.addText"), () => createAt("text", world), { icon: "textTool" });
        entries.push({ kind: "separator" });
      }
      item("all", t("live.canvas.actions.selectAll"), () =>
        setSelected(
          topLevelOf(
            store.now().list.map((s) => s.id),
            store.now().list,
          ),
        ),
      );
      item("fit", t("live.canvas.zoom.fitAll"), fitAll, { disabled: !list.length });
      if (!readOnly) {
        entries.push({ kind: "separator" }, { kind: "header", label: t("live.canvas.background.label") });
        for (const b of ["dots", "grid", "plain"] as const) {
          item(
            `bg-${b}`,
            t(`live.canvas.background.${b}`),
            () => setCanvasBackground(doc, b, LOCAL),
            bg === b ? { icon: "check" } : {},
          );
        }
      }
    }
    openContextMenu(e.clientX, e.clientY, entries, e.target);
  };

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const view = visibleWorld(cam, stage);
  const margin = Math.max(view.w, view.h) * 0.5;
  const drawn =
    list.length > CULL_FROM
      ? list.filter((s) => s.type === "arrow" || rectsIntersect(shapeBounds(s, byId), view, margin))
      : list;

  const single = selShapes.length === 1 ? selShapes[0] : null;
  const inspected = single?.type === "image" && inspectorOff !== single.id ? single : null;
  const selectedImages = selShapes.filter((s) => s.type === "image");
  const imageShapes = useMemo(() => new Map(list.filter((s) => s.type === "image").map((s) => [s.id, s])), [list]);
  const empty = list.length === 0 && uploads.length === 0;
  const barShapes =
    !readOnly &&
    !busy &&
    !editing &&
    !naming &&
    selShapes.length > 0 &&
    !selShapes.some((s) => s.type === "image" || s.type === "pending" || s.type === "html" || s.type === "file")
      ? selShapes
      : [];
  const barBounds = barShapes.length ? boundsOf(sel, byId) : null;
  const barStyle: CSSProperties | null = barBounds
    ? (() => {
        const top = barBounds.y * cam.z + cam.y;
        const left = (barBounds.x + barBounds.w / 2) * cam.z + cam.x;
        const below = top < 72;
        return {
          left: Math.min(Math.max(left, 160), stage.w - 160),
          top: below ? (barBounds.y + barBounds.h) * cam.z + cam.y + 16 : top - 16,
          transform: below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        };
      })()
    : null;

  const spacing = dotSpacing(cam.z);
  const planeStyle = {
    "--dot": `${spacing}px`,
    "--dot-x": `${cam.x}px`,
    "--dot-y": `${cam.y}px`,
    "--dot-fade": cam.z < 0.4 ? String(Math.max(0, (cam.z - 0.1) / 0.3)) : "1",
  } as CSSProperties;

  return (
    <CanvasContext.Provider value={env}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the canvas's keys and clipboard, for whatever in it has focus */}
      <div
        ref={rootRef}
        className="cnv"
        data-readonly={readOnly || undefined}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCopy={onCopy}
        onCut={onCut}
        onPaste={onPaste}
      >
        <div className="cnv__main">
          <div
            ref={planeRef}
            className="cnv__plane"
            role="application"
            aria-label={t("live.canvas.label")}
            aria-roledescription={t("live.canvas.roledescription")}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the plane takes the keys (tools, delete, arrows, zoom)
            tabIndex={0}
            data-bg={bg}
            data-tool={tool}
            data-panning={panning || undefined}
            data-space={space || undefined}
            data-dropping={dropping || undefined}
            style={planeStyle}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => onPointerEnd(e)}
            onPointerCancel={(e) => onPointerEnd(e, true)}
            onPointerLeave={() => {
              pointerWorld.current = null;
              sendCursor(null);
              if (hover) setHover(null);
            }}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <div className="cnv__world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
              {drawn.map((s) =>
                s.type === "arrow" ? (
                  <ArrowOf
                    key={s.id}
                    arrow={s}
                    byId={byId}
                    editingLabel={naming?.kind === "label" && naming.id === s.id}
                  />
                ) : (
                  <ShapeBody
                    key={s.id}
                    shape={s}
                    editing={editing === s.id}
                    interacting={interacting === s.id}
                    fresh={s.type === "image" && wasPending.current.has(s.id)}
                  />
                ),
              )}
              {uploads.map((u) => (
                <div
                  key={u.key}
                  className="cnv-upload"
                  role="status"
                  aria-label={t("live.canvas.uploading")}
                  style={{ left: u.box.x, top: u.box.y, width: u.box.w, height: u.box.h }}
                />
              ))}
            </div>
            <Overlay
              cam={cam}
              stage={stage}
              shapes={list}
              byId={byId}
              selected={sel}
              hover={hover}
              draft={draft}
              peers={peers}
              readOnly={readOnly}
              naming={naming}
              onName={onName}
              busy={busy}
            />
            {empty && (
              <div className="cnv__empty">
                <EmptyState
                  size="panel"
                  title={t("live.canvas.empty.title")}
                  actions={
                    readOnly ? undefined : (
                      <>
                        <button
                          type="button"
                          className="ac-btn ac-btn--sm"
                          onClick={() => createAt("note", viewCenter())}
                        >
                          {t("live.canvas.empty.note")}
                        </button>
                        <button type="button" className="ac-btn ac-btn--sm" onClick={() => fileInput.current?.click()}>
                          {t("live.canvas.empty.upload")}
                        </button>
                        <button
                          type="button"
                          className="ac-btn ac-btn--agent ac-btn--sm"
                          onClick={() => openGenerate()}
                        >
                          {t("live.canvas.empty.generate")}
                        </button>
                      </>
                    )
                  }
                >
                  {readOnly ? t("live.canvas.empty.readOnly") : t("live.canvas.empty.text")}
                </EmptyState>
              </div>
            )}
            {dropping && (
              <div className="cnv__drop" aria-hidden="true">
                <span className="cnv__drop-words">{t("live.canvas.dropHere")}</span>
              </div>
            )}
          </div>
          {barShapes.length > 0 && barStyle && (
            <ShapeBar shapes={barShapes} style={barStyle} onAction={shapeBarAction} />
          )}
          <div className="cnv__bottom">
            {generating && !readOnly ? (
              <GenerateBar
                orgId={orgId}
                images={imageShapes}
                selectedImages={selectedImages}
                draft={genDraft}
                offline={offline}
                pending={generate.isPending}
                assetUrl={assetUrl}
                onGenerate={(input) => runGenerate(input)}
                onClose={() => {
                  setGenerating(false);
                  setGenDraft(null);
                  planeRef.current?.focus({ preventScroll: true });
                }}
              />
            ) : (
              <Dock
                tool={tool}
                readOnly={readOnly}
                canGenerate={canGenerate}
                onTool={pickTool}
                onImage={() => fileInput.current?.click()}
                onGenerate={() => openGenerate()}
              />
            )}
          </div>
          <ZoomIsland zoom={cam.z} onStep={zoomStep} onActual={zoomActual} onFit={fitAll} canFit={list.length > 0} />
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void placeFiles(files, viewCenter());
            }}
          />
        </div>
        {inspected && (
          <ImageInspector
            shape={inspected}
            readOnly={readOnly}
            canGenerate={canGenerate}
            assetUrl={assetUrl}
            onVariations={() => variations(inspected)}
            onEdit={() => openGenerate({ prompt: "", references: [inspected.id] })}
            onDownload={() => downloadImage(inspected)}
            onCopy={() => copyImage(inspected)}
            onOpen={() => setZoomed(inspected)}
            onClose={() => setInspectorOff(inspected.id)}
          />
        )}
        {zoomed?.asset && (
          <DetailsDialog
            open
            size="xl"
            fill
            className="artifact-sheet artifact-sheet--image"
            title={
              zoomed.gen?.prompt ? (
                <span className="cnv-zoomed__title">{zoomed.gen.prompt}</span>
              ) : (
                t("live.canvas.kinds.image")
              )
            }
            closeLabel={t("live.canvas.inspector.close")}
            onOpenChange={(open) => !open && setZoomed(null)}
          >
            <div className="file-view file-view--image">
              <ImageZoom
                src={assetUrl(zoomed.asset)}
                alt={zoomed.alt ?? zoomed.gen?.prompt ?? t("live.canvas.kinds.image")}
              />
            </div>
          </DetailsDialog>
        )}
      </div>
    </CanvasContext.Provider>
  );
}

/** An arrow with its line worked out from its ends now (a bound end follows its shape). */
function ArrowOf({
  arrow,
  byId,
  editingLabel,
}: {
  arrow: ShapeView;
  byId: ReadonlyMap<string, ShapeView>;
  editingLabel: boolean;
}) {
  const line = arrowLine(arrow, byId);
  if (!line) return null;
  return (
    <ArrowShape id={arrow.id} line={line} dashed={!!arrow.dashed} label={arrow.label} editingLabel={editingLabel} />
  );
}
