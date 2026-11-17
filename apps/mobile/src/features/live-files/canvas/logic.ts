import type { Peer } from "@agenteschat/live/awareness";
import {
  arrowPath,
  type Box,
  containsPoint,
  descendantsOf,
  type NoteColor,
  placeBoxes,
  resolveEnd,
  type ShapeType,
  type ShapeView,
  shapeBounds,
  union,
} from "@agenteschat/live/canvas";
import type * as Y from "yjs";
import type { ArrowEndW, WBox } from "./camera";

/**
 * A canvas on the phone (ADR 0194 §2, 0195): which shapes are laid out, what a finger lands on, what moves with what,
 * where something new goes, how arrows are drawn and what a picture being made says. Pure: the screen draws it and
 * the tests read it.
 */

/** The shapes laid out for a world box: those that reach into it, and those that must stay (selected, being moved). */
export function shapesIn(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  box: WBox,
  keep: ReadonlySet<string> = new Set(),
): ShapeView[] {
  return shapes.filter((s) => {
    if (keep.has(s.id)) return true;
    const b = shapeBounds(s, byId);
    return b.x <= box.x + box.w && box.x <= b.x + b.w && b.y <= box.y + box.h && box.y <= b.y + b.h;
  });
}

/** How tall a frame's name is over its top edge, in points on screen (tapping it picks the frame). */
export const FRAME_NAME_H = 24;
/** The least a finger needs: a shape smaller than this on screen answers to a box this big around its middle. */
export const MIN_TARGET = 32;

/** Distance from a point to a segment. */
export function segmentDistance(p: { x: number; y: number }, l: { x1: number; y1: number; x2: number; y2: number }) {
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len)) : 0;
  return Math.hypot(p.x - (l.x1 + t * dx), p.y - (l.y1 + t * dy));
}

/** A shape's box grown around its middle to at least `MIN_TARGET` points on screen at zoom `s`. */
function targetBox(box: Box, s: number): Box {
  const min = MIN_TARGET / Math.max(s, 1e-6);
  const w = Math.max(box.w, min);
  const h = Math.max(box.h, min);
  return { x: box.x - (w - box.w) / 2, y: box.y - (h - box.h) / 2, w, h };
}

/**
 * What a finger at world point `p` lands on at zoom `s`: the topmost shape there (a line within a finger's reach of an
 * arrow, a small shape by a finger-sized box around it), else a frame by its name over its top edge or its inside; null
 * on the bare plane. `shapes` in drawing order (frames first).
 */
export function shapeAt(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  p: { x: number; y: number },
  s: number,
  reach = 12,
): string | null {
  const r = reach / Math.max(s, 1e-6);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (!shape || shape.type === "frame") continue;
    if (shape.type === "arrow") {
      const line = arrowLine(shape, byId);
      if (line && segmentDistance(p, line) <= r) return shape.id;
      continue;
    }
    if (containsPoint(targetBox(shape, s), p, shape.rot ?? 0)) return shape.id;
  }
  const label = FRAME_NAME_H / Math.max(s, 1e-6);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const frame = shapes[i];
    if (frame?.type !== "frame") continue;
    const onName = p.x >= frame.x && p.x <= frame.x + frame.w && p.y >= frame.y - label && p.y < frame.y;
    if (onName || containsPoint(frame, p)) return frame.id;
  }
  return null;
}

/** The box around the chosen shapes (world), or null. */
export function selectionBox(ids: readonly string[], byId: ReadonlyMap<string, ShapeView>): WBox | null {
  const boxes = ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [shapeBounds(s, byId)] : [];
  });
  return union(boxes);
}

/** What moves when the chosen shapes move: them, and everything in a chosen frame. */
export function movingIds(ids: readonly string[], shapes: readonly ShapeView[]): Set<string> {
  const set = new Set(ids);
  for (const id of descendantsOf(ids, shapes)) set.add(id);
  return set;
}

/** Whether the corner handle can stretch a shape: one at a time, not an arrow (its ends move it), not locked. */
export const stretchable = (s: Pick<ShapeView, "type" | "locked"> | undefined) =>
  !!s && !s.locked && s.type !== "arrow";

/** Pictures (and pictures being made) keep their proportions when stretched. */
export const keepsRatio = (s: Pick<ShapeView, "type">) => s.type === "image" || s.type === "pending";

/** Shapes whose words the phone edits. */
export const holdsWords = (s: Pick<ShapeView, "type">) => s.type === "note" || s.type === "text" || s.type === "shape";

// ── Arrows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An arrow's line now (bound ends follow their shapes), or null when an end's shape is gone. */
export function arrowLine(
  arrow: ShapeView,
  byId: ReadonlyMap<string, ShapeView>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = resolveEnd(arrow.from, byId);
  const to = resolveEnd(arrow.to, byId);
  return from && to ? arrowPath(from, to) : null;
}

/** An arrow as the UI thread draws it: its ends (each a shape's box, by id, or a free point) and its dashes. */
export interface ArrowDraw {
  id: string;
  from: ArrowEndW & { shape: string | null };
  to: ArrowEndW & { shape: string | null };
  dashed: boolean;
}

/** The arrows to draw, their ends where their shapes are now; an arrow whose shape is gone isn't drawn. */
export function arrowDraws(shapes: readonly ShapeView[], byId: ReadonlyMap<string, ShapeView>): ArrowDraw[] {
  const out: ArrowDraw[] = [];
  for (const arrow of shapes) {
    if (arrow.type !== "arrow") continue;
    const ends = [arrow.from, arrow.to].map((end) => {
      const at = resolveEnd(end, byId);
      if (!at) return null;
      const shape = end && "shape" in end ? end.shape : null;
      return "w" in at
        ? { x: at.x, y: at.y, w: at.w, h: at.h, box: true, shape }
        : { x: at.x, y: at.y, w: 0, h: 0, box: false, shape };
    });
    const [from, to] = ends;
    if (from && to) out.push({ id: arrow.id, from, to, dashed: arrow.dashed === true });
  }
  return out;
}

/** The filled head at an arrow's end: its three corners, `size` long along the line. */
export function arrowHead(
  line: { x1: number; y1: number; x2: number; y2: number },
  size: number,
): [number, number, number, number, number, number] {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = line.x2 - ux * size;
  const by = line.y2 - uy * size;
  const half = size * 0.55;
  return [line.x2, line.y2, bx - uy * half, by + ux * half, bx + uy * half, by - ux * half];
}

// ── New things ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The size a new thing starts at (the web's: a note 200 square, a text line 320 by 60). */
export function newSize(type: "note" | "text"): { w: number; h: number } {
  return type === "note" ? { w: 200, h: 200 } : { w: 320, h: 60 };
}

/** The longest side a picture takes when it lands (as `addShape` does with a natural size). */
export const PICTURE_SIDE = 640;

/** A picture's size on the canvas from its pixels: as it is, its longest side at most `PICTURE_SIDE`. */
export function pictureSize(width: number | null, height: number | null): { w: number; h: number } {
  const w = width && width > 0 ? width : PICTURE_SIDE;
  const h = height && height > 0 ? height : PICTURE_SIDE;
  const k = Math.min(1, PICTURE_SIDE / Math.max(w, h));
  return { w: w * k, h: h * k };
}

/** Where new things go: free room nearest the middle of what the person looks at, one box each, never overlapping. */
export function placeNear(
  doc: Y.Doc,
  near: { x: number; y: number },
  sizes: readonly { w: number; h: number }[],
): Box[] {
  if (sizes.length === 0) return [];
  // Each one placed before the next looks for room, so several land side by side.
  const w = Math.max(...sizes.map((b) => b.w));
  const h = Math.max(...sizes.map((b) => b.h));
  const placed = placeBoxes(doc, { count: sizes.length, w, h, near, gap: 32 });
  return sizes.map((size, i) => {
    const slot = placed.boxes[i] ?? { x: near.x - size.w / 2, y: near.y - size.h / 2, w, h };
    return { x: slot.x + (w - size.w) / 2, y: slot.y + (h - size.h) / 2, w: size.w, h: size.h };
  });
}

// ── Pictures being made (ADR 0195) ───────────────────────────────────────────────────────────────────────────────

/** What a placeholder says, as a key: waiting, being made, or why it failed (`live.images.*`). */
export function pendingWords(s: Pick<ShapeView, "status" | "error">): string {
  if (s.status === "queued") return "live.images.queued";
  if (s.status === "running") return "live.images.making";
  return `live.images.failed.${failureKey(s.error)}`;
}

/** A failure's code ("no_key") as its words' key ("noKey"); "other" for a code this build doesn't know. */
export function failureKey(code: string | undefined): string {
  switch (code) {
    case "no_key":
      return "noKey";
    case "too_many":
      return "tooMany";
    case "budget":
    case "limit":
    case "blocked":
    case "provider":
      return code;
    default:
      return "other";
  }
}

/** Whether "Tentar de novo" can bring a failed placeholder back (its request is known, and it is the person's turn). */
export const retryable = (s: Pick<ShapeView, "type" | "status" | "request">) =>
  s.type === "pending" && s.status === "failed" && !!s.request;

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The note colors in the web's order. */
export const NOTE_ORDER: readonly NoteColor[] = ["yellow", "pink", "blue", "green", "purple", "gray"];

/** A note's words' size on the canvas (world units). */
export const NOTE_TEXT = 16;
/** A note's inner padding (world units). */
export const NOTE_PAD = 14;

// ── Presence ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everyone else's chosen shapes (that still exist), with who: their outline on the plane. */
export function peerPicks<P extends Pick<Peer, "self" | "state" | "clientId">>(
  peers: readonly P[],
  byId: ReadonlyMap<string, ShapeView>,
): { peer: P; ids: string[] }[] {
  return peers.flatMap((p) => {
    if (p.self) return [];
    const ids = (p.state.sel?.canvas ?? []).filter((id) => byId.has(id));
    return ids.length ? [{ peer: p, ids }] : [];
  });
}

/** Everyone else's pointer on the plane (world units), with who. */
export function peerPointers<P extends Pick<Peer, "self" | "state" | "clientId">>(peers: readonly P[]) {
  return peers.flatMap((p) => {
    const c = p.state.cursor;
    return !p.self && c && c.space === "canvas" ? [{ peer: p, at: { x: c.x, y: c.y } }] : [];
  });
}

/** Image shapes among the chosen ones (the pictures "Gerar" starts from). */
export function chosenPictures(ids: readonly string[], byId: ReadonlyMap<string, ShapeView>): string[] {
  return ids.filter((id) => {
    const s = byId.get(id);
    return s?.type === "image" && !!s.asset;
  });
}

/** The types the bottom bar adds. */
export type AddKind = Extract<ShapeType, "note" | "text">;
