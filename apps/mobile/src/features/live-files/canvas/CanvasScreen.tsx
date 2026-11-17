import {
  type ArtifactDetail,
  isLiveFileKind,
  type LiveRoom,
  nextFrame,
  useArtifact,
  useLiveDocVersion,
  useLivePeers,
  useRetryImages,
} from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import {
  addShape,
  arrangeShapes,
  deleteShapes,
  frameAt,
  NOTE_COLORS,
  type NoteColor,
  readShapes,
  type ShapeView,
  shapeBounds,
  shapeIndex,
  union,
  updateShape,
} from "@agenteschat/live/canvas";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  EmptyState,
  type HeaderMenuItem,
  Icon,
  type IconName,
  PressScale,
  SCREEN_X,
  Text,
  usePulse,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openFile } from "../../files/open";
import { useErrorToast } from "../../shared/hooks";
import { pickOne, showActionSheet } from "../../shared/PickerSheet";
import { errorHaptic } from "../../shared/parts";
import { liveClosed, liveRoute } from "../logic";
import { setFollowing, useFollowing } from "../shared/follow";
import { LiveBar, LiveUnavailable } from "../shared/LiveBar";
import { NOTE_TINTS } from "../shared/LiveCover";
import { usePeerLook } from "../shared/peers";
import { type LiveDoc, useLiveDoc } from "../shared/useLiveDoc";
import { HereIsland } from "../slides/Island";
import { usePhotoPick } from "../slides/photos";
import { textRoute } from "../slides/routes";
import { CanvasPlane, type PlaneHandle } from "./CanvasPlane";
import type { PeerView, Pt } from "./camera";
import { type AddKind, chosenPictures, holdsWords, newSize, pictureSize, placeNear, retryable } from "./logic";
import { revealed, toReveal } from "./reveal";
import { generateRoute } from "./routes";

/**
 * A canvas on the phone (ADR 0194 §9, 0195), pushed with the file's bar (`LiveBar`): the plane with everything on it
 * (`CanvasPlane`), and under it the tools to add a note, a text, photos from the library, or to generate pictures
 * (the agent's look: an AI makes them) on a screen of their own, from the chosen pictures. A long press asks for a
 * shape's menu (its words, its color, variations, front and back, delete) or the plane's. Following someone (from the
 * faces' list) moves the view with theirs.
 */
export function CanvasScreen({ id }: { id: string }) {
  const live = useLiveDoc(id, { kind: "canvas" });
  const query = useArtifact(live.orgId, id);
  const detail = query.data;
  const title = detail?.title ?? "";
  const closed = liveClosed(live);

  // A link that named the wrong screen (or a file that isn't a canvas) gives way to the right one.
  const docKind = live.room && live.loaded ? live.room.kind : null;
  const kind = detail?.kind ?? docKind;
  useEffect(() => {
    if (!kind || kind === "canvas") return;
    if (isLiveFileKind(kind)) router.replace(liveRoute(kind, id));
    else router.replace({ pathname: "/file/[id]", params: { id } });
  }, [kind, id]);

  if (closed)
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={undefined} />
        <LiveUnavailable reason={closed} />
      </>
    );
  if (!live.room || !live.loaded || docKind !== "canvas")
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={detail} />
        <CanvasBones />
      </>
    );
  return <LiveCanvas live={live} room={live.room} fileId={id} title={title} detail={detail} />;
}

function LiveCanvas({
  live,
  room,
  fileId,
  title,
  detail,
}: {
  live: LiveDoc;
  room: LiveRoom;
  fileId: string;
  title: string;
  detail: ArtifactDetail | undefined;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const toast = useToast();
  const failed = useErrorToast();
  const insets = useSafeAreaInsets();
  const doc = room.doc;
  const readOnly = live.mode !== "edit";
  const plane = useRef<PlaneHandle>(null);

  const version = useLiveDocVersion(room, nextFrame);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after every change (`version`).
  const shapes = useMemo(() => readShapes(doc), [doc, version]);
  const byId = useMemo(() => shapeIndex(shapes), [shapes]);

  // ── The selection ──────────────────────────────────────────────────────────────────────────────────────────────
  const [chosen, setChosen] = useState<string[]>([]);
  // What someone else deleted leaves the selection.
  const selected = useMemo(() => chosen.filter((id) => byId.has(id)), [chosen, byId]);
  const selKey = selected.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per change of the chosen ids (`selKey`).
  useEffect(() => {
    room.setLocal({
      mode: selected.length > 0 && !readOnly ? "editing" : "viewing",
      sel: selected.length > 0 ? { canvas: selected } : undefined,
    });
  }, [room, selKey, readOnly]);
  useEffect(
    () => () => {
      if (!room.destroyed) room.setLocal({ cursor: undefined, sel: undefined, view: undefined, mode: "viewing" });
    },
    [room],
  );

  // ── Following someone ──────────────────────────────────────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const look = usePeerLook();
  const followId = useFollowing(fileId);
  const followed = followId === null ? null : (peers.find((p) => p.clientId === followId && !p.self) ?? null);
  const gone = followId !== null && followed === null && live.status === "live";
  useEffect(() => {
    if (gone) setFollowing(fileId, null);
  }, [gone, fileId]);
  const theirView = (followed?.state.view as PeerView | undefined) ?? null;
  const stopFollowing = useCallback(() => {
    if (followId !== null) setFollowing(fileId, null);
  }, [followId, fileId]);

  // ── Pictures asked for on "Gerar": shown once their placeholders are here ─────────────────────────────────────
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) return;
    const ids = toReveal(fileId);
    if (!ids) return;
    const boxes = ids.flatMap((id) => {
      const s = byId.get(id);
      return s ? [shapeBounds(s, byId)] : [];
    });
    const box = union(boxes);
    if (!box) return;
    revealed(fileId);
    plane.current?.reveal(box);
  }, [focused, byId, fileId]);

  // ── Adding ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const attempt = useCallback(
    (run: () => void) => {
      try {
        run();
      } catch {
        errorHaptic();
        toast({ title: t("live.canvas.errors.other"), icon: "x" });
      }
    },
    [toast, t],
  );
  const middle = (): Pt => plane.current?.center() ?? { x: 0, y: 0 };
  const addWords = (type: AddKind, at: Pt = middle()) => {
    try {
      const frame = frameAt(doc, at.x, at.y);
      const size = newSize(type);
      let made: string;
      if (frame) made = addShape(doc, { type, parent: frame, w: size.w, h: size.h }, LOCAL);
      else {
        const [box] = placeNear(doc, at, [size]);
        made = addShape(doc, { type, ...(box ?? { x: at.x - size.w / 2, y: at.y - size.h / 2, ...size }) }, LOCAL);
      }
      setChosen([made]);
      const shape = shapeIndex(readShapes(doc, { text: false })).get(made);
      if (shape) plane.current?.reveal(shape);
      router.push(textRoute(fileId, { shape: made }));
    } catch {
      errorHaptic();
      toast({ title: t("live.canvas.errors.tooMany"), icon: "x" });
    }
  };
  const photos = usePhotoPick(room.orgId, fileId);
  const addPhotos = async () => {
    const assets = await photos.pick(10);
    if (assets.length === 0) return;
    const at = middle();
    attempt(() => {
      const sizes = assets.map((a) => pictureSize(a.width, a.height));
      const boxes = placeNear(doc, at, sizes);
      const made = assets.map((a, i) => {
        const box = boxes[i] ?? { x: at.x, y: at.y, ...(sizes[i] ?? { w: 320, h: 320 }) };
        return addShape(
          doc,
          { type: "image", asset: a.id, nw: a.width ?? box.w, nh: a.height ?? box.h, ...box },
          LOCAL,
        );
      });
      setChosen(made);
      const all = union(boxes);
      if (all) plane.current?.reveal(all);
    });
  };
  const generate = (refs: readonly string[] = chosenPictures(selected, byId)) =>
    router.push(generateRoute(fileId, { refs, at: middle() }));

  // ── A shape's menu, the plane's menu ──────────────────────────────────────────────────────────────────────────
  const retry = useRetryImages(room.orgId, fileId);
  const retryShape = (shape: ShapeView) => {
    if (!retryable(shape) || !shape.request) return;
    retry.mutate(shape.request, { onError: failed });
  };
  const open = (shape: ShapeView) => {
    if (holdsWords(shape)) {
      if (!readOnly) router.push(textRoute(fileId, { shape: shape.id }));
      return;
    }
    if ((shape.type === "html" || shape.type === "file") && shape.artifact) openFile({ id: shape.artifact });
  };
  const pickColor = async (ids: readonly string[], current: NoteColor | undefined) => {
    const picked = await pickOne({
      title: t("live.canvas.bar.color"),
      value: current ?? null,
      options: NOTE_COLORS.map((color) => ({
        key: color,
        label: t(`live.canvas.colors.${color}`),
        leading: { kind: "node" as const, node: <NoteSwatch color={color} /> },
      })),
    });
    if (!picked) return;
    attempt(() => {
      for (const id of ids)
        if (byId.get(id)?.type === "note") updateShape(doc, id, { color: picked as NoteColor }, LOCAL);
    });
  };
  const hold = (id: string | null, at: Pt) => {
    if (!id) {
      const actions: { label: string; icon: IconName; onPress: () => void }[] = [
        ...(readOnly
          ? []
          : [
              { label: t("live.canvas.actions.addNote"), icon: "note" as const, onPress: () => addWords("note", at) },
              {
                label: t("live.canvas.actions.addText"),
                icon: "textTool" as const,
                onPress: () => addWords("text", at),
              },
            ]),
        { label: t("live.canvas.zoom.fitAll"), icon: "expand", onPress: () => plane.current?.fitAll() },
      ];
      showActionSheet(t("live.canvas.label"), actions);
      return;
    }
    const shape = byId.get(id);
    if (!shape) return;
    // A shape among the chosen ones: the menu acts on all of them; another one: on it alone, or adds it to them.
    const among = selected.includes(id);
    const targets = among ? selected : [id];
    if (!among) setChosen([id]);
    const pictures = chosenPictures(targets, byId);
    const notes = targets.filter((x) => byId.get(x)?.type === "note");
    const actions: { label: string; icon: IconName; destructive?: boolean; onPress: () => void }[] = [];
    if (!among && selected.length > 0 && !readOnly)
      actions.push({
        label: t("mobile.live.canvas.addToSelection"),
        icon: "plus",
        onPress: () => setChosen([...selected, id]),
      });
    if (targets.length === 1 && holdsWords(shape) && !readOnly)
      actions.push({ label: t("live.canvas.actions.editText"), icon: "pen", onPress: () => open(shape) });
    if (targets.length === 1 && (shape.type === "html" || shape.type === "file"))
      actions.push({ label: t("live.canvas.actions.openFile"), icon: "file", onPress: () => open(shape) });
    if (retryable(shape) && !readOnly)
      actions.push({ label: t("live.images.retry"), icon: "replay", onPress: () => retryShape(shape) });
    if (!readOnly) {
      if (notes.length > 0)
        actions.push({
          label: t("live.canvas.bar.color"),
          icon: "sparkle",
          onPress: () => void pickColor(notes, notes.length === 1 ? byId.get(notes[0] ?? "")?.color : undefined),
        });
      if (pictures.length > 0)
        actions.push({
          label: t("live.canvas.inspector.variations"),
          icon: "sparkle",
          onPress: () => generate(pictures),
        });
      actions.push(
        {
          label: t("live.canvas.arrange.front"),
          icon: "up",
          onPress: () => attempt(() => arrangeShapes(doc, targets, "front", LOCAL)),
        },
        {
          label: t("live.canvas.arrange.back"),
          icon: "down",
          onPress: () => attempt(() => arrangeShapes(doc, targets, "back", LOCAL)),
        },
        {
          label: t("live.canvas.actions.delete"),
          icon: "trash",
          destructive: true,
          onPress: () =>
            attempt(() => {
              deleteShapes(doc, targets, LOCAL);
              setChosen([]);
            }),
        },
      );
    }
    if (actions.length > 0) showActionSheet(shapeTitle(t, shape, targets.length), actions);
  };

  const menu: HeaderMenuItem[] = [
    {
      icon: "expand",
      sf: "arrow.up.left.and.arrow.down.right",
      label: t("live.canvas.zoom.fitAll"),
      onPress: () => plane.current?.fitAll(),
    },
    {
      icon: "search",
      sf: "1.magnifyingglass",
      label: t("live.canvas.zoom.actual"),
      onPress: () => plane.current?.actualSize(),
    },
  ];

  const pictures = chosenPictures(selected, byId);
  return (
    <>
      <LiveBar live={live} fileId={fileId} title={title} detail={detail} menu={menu} />
      <View style={styles.fill}>
        <CanvasPlane
          ref={plane}
          room={room}
          fileId={fileId}
          shapes={shapes}
          byId={byId}
          readOnly={readOnly}
          selected={selected}
          onSelect={setChosen}
          onOpen={open}
          onRetry={retryShape}
          onHold={hold}
          follow={theirView}
          onMoved={stopFollowing}
        />
        {shapes.length === 0 ? (
          <View style={styles.empty} pointerEvents="none">
            <EmptyState
              size="panel"
              icon="canvas"
              title={t("live.canvas.empty.title")}
              subtitle={readOnly ? t("live.canvas.empty.readOnly") : t("mobile.live.canvas.emptyText")}
            />
          </View>
        ) : null}
        {followed ? (
          <HereIsland
            who={followed.user}
            words={t("mobile.live.here.followingName", { name: look(followed.user).name })}
            action={t("mobile.live.here.stop")}
            onAction={stopFollowing}
          />
        ) : null}
      </View>
      {readOnly ? null : (
        <View
          style={[styles.tools, { paddingBottom: insets.bottom + 4, borderTopColor: c.line2, backgroundColor: c.bg }]}
        >
          <Tool icon="note" label={t("mobile.live.canvas.tools.note")} onPress={() => addWords("note")} />
          <Tool icon="textTool" label={t("mobile.live.canvas.tools.text")} onPress={() => addWords("text")} />
          <Tool
            icon="photos"
            label={photos.busy > 0 ? t("mobile.live.slides.tools.sending") : t("mobile.live.canvas.tools.photo")}
            disabled={photos.busy > 0}
            onPress={() => void addPhotos()}
          />
          <Tool
            icon="sparkle"
            agent
            label={t("mobile.live.canvas.tools.generate")}
            hint={pictures.length > 0 ? t("mobile.live.canvas.generateFrom", { count: pictures.length }) : undefined}
            onPress={() => generate()}
          />
        </View>
      )}
    </>
  );
}

/** What a shape's menu is titled: what it is ("Nota", "Imagem"), or how many things it acts on. */
function shapeTitle(t: (key: string, o?: Record<string, unknown>) => string, shape: ShapeView, count: number): string {
  if (count > 1) return t("live.canvas.count.items", { count });
  switch (shape.type) {
    case "image":
    case "pending":
      return t("live.canvas.kinds.image");
    case "frame":
      return shape.name || t("live.canvas.kinds.frame");
    case "html":
      return t("live.canvas.kinds.html");
    case "note":
      return t("live.canvas.tools.note");
    case "text":
      return t("live.canvas.tools.text");
    case "shape":
      return t("live.canvas.tools.shape");
    case "arrow":
      return t("live.canvas.tools.arrow");
    default:
      return t("live.canvas.label");
  }
}

/** A note color's swatch in the color menu. */
function NoteSwatch({ color }: { color: NoteColor }) {
  const { colors: c, scheme } = useTheme();
  const tint = NOTE_TINTS[color];
  return (
    <View
      style={[styles.swatch, { backgroundColor: scheme === "dark" ? tint.dark : tint.light, borderColor: c.line2 }]}
    />
  );
}

/**
 * A tool under the plane: its icon over its word. "Gerar" wears the agent's look (an AI makes the pictures): the
 * app's cut corner and its mark in the agent's color.
 */
function Tool({
  icon,
  label,
  onPress,
  agent = false,
  hint,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  agent?: boolean;
  hint?: string | undefined;
  disabled?: boolean;
}) {
  const { colors: c } = useTheme();
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled }}
      style={[styles.tool, agent && [styles.agent, { backgroundColor: c.plate }], disabled && styles.off]}
    >
      <Icon name={icon} size={22} color={agent ? c.agent : c.ink} />
      <Text variant="caption" tone="ink2" numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

/** The plane's shape while the canvas opens: its dots, quiet. */
function CanvasBones() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const pulse = usePulse();
  return (
    <Animated.View
      style={[styles.fill, styles.bones, { backgroundColor: c.bg }, pulse]}
      accessible
      accessibilityLabel={t("live.canvas.loading")}
      accessibilityState={{ busy: true }}
    >
      {Array.from({ length: 12 }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <View key={row} style={styles.boneRow}>
          {Array.from({ length: 8 }, (_, col) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
            <View key={col} style={[styles.dot, { backgroundColor: c.line2 }]} />
          ))}
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  empty: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SCREEN_X,
  },
  tools: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingHorizontal: 8,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tool: {
    minWidth: 72,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 8,
    borderRadius: 14,
  },
  // The agent's look: the app's cut corner at the bottom left.
  agent: { borderBottomLeftRadius: 4 },
  off: { opacity: 0.4 },
  swatch: { width: 24, height: 24, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  bones: { paddingTop: 24, gap: 24, alignItems: "center" },
  boneRow: { flexDirection: "row", gap: 40 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
});
