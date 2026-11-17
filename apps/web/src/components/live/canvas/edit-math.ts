import {
  type Box,
  center,
  containsPoint,
  descendantsOf,
  type Point,
  rectsIntersect,
  resolveEnd,
  type ShapeView,
  shapeBounds,
  union,
} from "@agenteschat/live/canvas";

/**
 * The canvas editor's geometry (ADR 0194 §2), apart from React so it is tested on its own: what a press lands on,
 * what a marquee takes, how a box follows a resize handle (turned shapes too), the angle a rotation handle gives, and
 * where an arrow's line runs.
 */

/** A resize handle: the corners and the middles of the sides. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNERS: readonly Handle[] = ["nw", "ne", "se", "sw"];

/** Which way each handle pulls: -1 the left or top side, 1 the right or bottom one, 0 neither. */
export const HANDLE_DIR: Record<Handle, readonly [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

/** The smallest a shape gets by its handles, in world units. */
export const MIN_SIDE = 16;

const rad = (deg: number) => (deg * Math.PI) / 180;

function rotate(p: Point, deg: number): Point {
  if (!deg) return { x: p.x, y: p.y };
  const a = rad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Where a handle sits on a (turned) box, in world units. */
export function handlePoint(box: Box, rot: number, handle: Handle): Point {
  const [hx, hy] = HANDLE_DIR[handle];
  const c = center(box);
  const off = rotate({ x: (hx * box.w) / 2, y: (hy * box.h) / 2 }, rot);
  return { x: c.x + off.x, y: c.y + off.y };
}

/**
 * A box dragged by one of its handles by `delta` (world units): the opposite side or corner stays where it is, also
 * on a turned box. `ratio` keeps its proportions (pictures always; Shift for the rest); no side goes under `min`.
 */
export function resizeBox(
  box: Box,
  rot: number,
  handle: Handle,
  delta: Point,
  opts: { ratio?: boolean; min?: number } = {},
): Box {
  const min = opts.min ?? MIN_SIDE;
  const [hx, hy] = HANDLE_DIR[handle];
  const local = rotate(delta, -rot);
  let w = box.w + hx * local.x;
  let h = box.h + hy * local.y;
  if (opts.ratio && box.w > 0 && box.h > 0) {
    const r = box.w / box.h;
    if (hx !== 0 && hy !== 0) {
      // A corner: the side pulled further leads.
      if (Math.abs(w / box.w) > Math.abs(h / box.h)) h = w / r;
      else w = h * r;
    } else if (hx !== 0) h = w / r;
    else w = h * r;
    if (w < min || h < min) {
      const k = Math.max(min / Math.max(w, 1e-9), min / Math.max(h, 1e-9));
      w *= k;
      h *= k;
    }
  } else {
    w = Math.max(min, w);
    h = Math.max(min, h);
  }
  // The fixed point: the side or corner opposite the handle (its middle, along a side that doesn't move).
  const c = center(box);
  const anchorLocal = { x: (-hx * box.w) / 2, y: (-hy * box.h) / 2 };
  const anchor = rotate(anchorLocal, rot);
  const anchorWorld = { x: c.x + anchor.x, y: c.y + anchor.y };
  const nextLocal = rotate({ x: (-hx * w) / 2, y: (-hy * h) / 2 }, rot);
  const nc = { x: anchorWorld.x - nextLocal.x, y: anchorWorld.y - nextLocal.y };
  return { x: nc.x - w / 2, y: nc.y - h / 2, w, h };
}

/**
 * Several shapes resized together by a corner of the box around them: each one keeps its place and size relative
 * to that box (`ratio` keeps the group's proportions).
 */
export function scaleGroup(
  bounds: Box,
  handle: Handle,
  delta: Point,
  boxes: readonly Box[],
  opts: { ratio?: boolean } = {},
): { bounds: Box; boxes: Box[] } {
  const next = resizeBox(bounds, 0, handle, delta, { ratio: opts.ratio, min: MIN_SIDE });
  const kx = bounds.w > 0 ? next.w / bounds.w : 1;
  const ky = bounds.h > 0 ? next.h / bounds.h : 1;
  return {
    bounds: next,
    boxes: boxes.map((b) => ({
      x: next.x + (b.x - bounds.x) * kx,
      y: next.y + (b.y - bounds.y) * ky,
      w: Math.max(1, b.w * kx),
      h: Math.max(1, b.h * ky),
    })),
  };
}

/** The angle (degrees, 0..360) a rotation handle above the box gives with the pointer at `p`; Shift snaps to 15°. */
export function rotationAt(c: Point, p: Point, snap = false): number {
  let deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
  if (snap) deg = Math.round(deg / 15) * 15;
  return ((deg % 360) + 360) % 360;
}

/** How far `p` is from the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** An arrow's line now: its ends' boxes from border to border (bound ends follow their shapes), or null. */
export function arrowLine(
  arrow: ShapeView,
  byId: ReadonlyMap<string, ShapeView>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = resolveEnd(arrow.from, byId);
  const to = resolveEnd(arrow.to, byId);
  if (!from || !to) return null;
  const a = "w" in from ? center(from) : from;
  const b = "w" in to ? center(to) : to;
  const start = "w" in from ? exitPoint(from, b) : a;
  const end = "w" in to ? exitPoint(to, a) : b;
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** Where the line from a box's center towards `toward` leaves the box, a little outside it. */
function exitPoint(box: Box, toward: Point): Point {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(box.w / 2 / dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(box.h / 2 / dy);
  const t = Math.min(tx, ty, 1);
  const len = Math.hypot(dx, dy);
  // A few units of air between the shape and the arrow's end.
  const gap = t < 1 ? 6 / len : 0;
  return { x: c.x + dx * (t + gap), y: c.y + dy * (t + gap) };
}

/** The filled head of an arrow ending at (x2, y2), as polygon points, `size` world units long. */
export function arrowHead(line: { x1: number; y1: number; x2: number; y2: number }, size = 14): string {
  const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
  const spread = Math.PI / 7;
  const p = (a: number) => `${line.x2 - size * Math.cos(a)},${line.y2 - size * Math.sin(a)}`;
  return `${line.x2},${line.y2} ${p(angle - spread)} ${p(angle + spread)}`;
}

/** How near (screen pixels) a press must be to an arrow or a frame's edge to take it. */
export const HIT_SLOP = 6;

/** What a press on a shape's body takes: a frame's inside is room for a marquee unless the frame is chosen. */
export type HitPart = "body" | "frameInside" | "frameEdge";

/**
 * The topmost shape under the world point `p` (`z`: the zoom, for slop in screen pixels): arrows near their line,
 * frames on their edge or (as `frameInside`) anywhere inside, the rest inside their turned box. Locked shapes are
 * taken too (they still select; they don't move).
 */
export function hitShape(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  p: Point,
  z: number,
): { id: string; part: HitPart } | null {
  const slop = HIT_SLOP / z;
  let inside: string | null = null;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (!s) continue;
    if (s.type === "arrow") {
      const line = arrowLine(s, byId);
      if (line && distanceToSegment(p, { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }) <= slop) {
        return { id: s.id, part: "body" };
      }
      continue;
    }
    if (s.type === "frame") {
      const grown = { x: s.x - slop, y: s.y - slop, w: s.w + 2 * slop, h: s.h + 2 * slop };
      if (!containsPoint(grown, p, s.rot ?? 0)) continue;
      const shrunk = { x: s.x + slop, y: s.y + slop, w: s.w - 2 * slop, h: s.h - 2 * slop };
      if (shrunk.w <= 0 || shrunk.h <= 0 || !containsPoint(shrunk, p, s.rot ?? 0))
        return { id: s.id, part: "frameEdge" };
      // Frames are drawn first: anything else over this point wins, so keep looking and fall back to the frame.
      inside ??= s.id;
      continue;
    }
    if (containsPoint(s, p, s.rot ?? 0)) return { id: s.id, part: "body" };
  }
  return inside ? { id: inside, part: "frameInside" } : null;
}

/**
 * What a marquee over the world box `rect` takes: shapes it touches, frames only when it holds them whole (a marquee
 * started inside a frame never takes the frame), and nothing inside a frame it takes (the frame carries them).
 */
export function marqueeHits(shapes: readonly ShapeView[], byId: ReadonlyMap<string, ShapeView>, rect: Box): string[] {
  const hits: string[] = [];
  for (const s of shapes) {
    const b = shapeBounds(s, byId);
    if (s.type === "frame") {
      if (b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h) {
        hits.push(s.id);
      }
      continue;
    }
    if (rectsIntersect(b, rect) || (b.w === 0 && b.h === 0 && containsPoint(rect, b))) hits.push(s.id);
  }
  return topLevelOf(hits, shapes);
}

/** The ids without the ones inside a frame that is among them. */
export function topLevelOf(ids: readonly string[], shapes: readonly ShapeView[]): string[] {
  const frames = ids.filter((id) => shapes.some((s) => s.id === id && s.type === "frame"));
  if (!frames.length) return [...ids];
  const inside = descendantsOf(frames, shapes);
  return ids.filter((id) => !inside.has(id));
}

/** The box around shapes (their turned bounds), or null. */
export function boundsOf(ids: readonly string[], byId: ReadonlyMap<string, ShapeView>): Box | null {
  const boxes: Box[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) boxes.push(shapeBounds(s, byId));
  }
  return union(boxes);
}

/**
 * The boxes a moving selection snaps to: every shape on screen that isn't moving (nor inside a moving frame), and
 * isn't an arrow.
 */
export function snapTargets(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  moving: ReadonlySet<string>,
  visible: Box,
): Box[] {
  const inside = descendantsOf(moving, shapes);
  const out: Box[] = [];
  for (const s of shapes) {
    if (s.type === "arrow" || moving.has(s.id) || inside.has(s.id)) continue;
    const b = shapeBounds(s, byId);
    if (rectsIntersect(b, visible, 200)) out.push(b);
  }
  return out;
}

/** A box from two corners (a drag in any direction). */
export function boxFrom(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
