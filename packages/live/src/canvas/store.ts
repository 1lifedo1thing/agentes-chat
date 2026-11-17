import * as Y from "yjs";
import type { PeerUser } from "../awareness";
import { compareStack } from "../fractional";
import { readRich } from "../rich/yjs";
import { type Box, center, isBoxEnd, isPoint, type Point, rotatedBounds, union } from "./geometry";
import {
  type ArrowEnd,
  CANVAS_BACKGROUNDS,
  type CanvasBackground,
  type CanvasShapeKind,
  type CanvasTextStyle,
  type ImageGen,
  isShapeType,
  NOTE_COLORS,
  type NoteColor,
  type PendingStatus,
  type ShapeType,
  type ShapeView,
} from "./types";

/**
 * Where a canvas lives in its document and how its values are read and checked (ADR 0191 §2):
 * `canvas` (a map: `bg`) and `shapes` (a map of shape id to a `Y.Map` per shape). Reading is lenient (a value an app
 * doesn't know is left out, never a crash); writing goes through `cleanProp`, so nothing off-shape gets in.
 */

export function canvasMapOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("canvas");
}

export function shapesMapOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("shapes");
}

export function shapeMapOf(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const value: unknown = shapesMapOf(doc).get(id);
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function canvasBackground(doc: Y.Doc): CanvasBackground {
  const bg = canvasMapOf(doc).get("bg");
  return typeof bg === "string" && (CANVAS_BACKGROUNDS as readonly string[]).includes(bg)
    ? (bg as CanvasBackground)
    : "dots";
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SHAPE_KINDS: readonly string[] = ["rect", "ellipse", "diamond"];
const STATUSES: readonly string[] = ["queued", "running", "failed"];
/** Coordinates past this are a broken shape, not a big canvas. */
export const CANVAS_COORD_MAX = 1e7;

export function isShapeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= CANVAS_COORD_MAX ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function colorOf(value: unknown, allowNone = false): string | undefined {
  if (typeof value !== "string") return undefined;
  if (allowNone && (value === "none" || value === "transparent")) return "none";
  return COLOR.test(value) ? value : undefined;
}

function userOf(value: unknown): PeerUser | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if ((o.kind !== "person" && o.kind !== "agent") || typeof o.id !== "string" || !o.id || o.id.length > 64) {
    return undefined;
  }
  return { kind: o.kind, id: o.id };
}

function endOf(value: unknown): ArrowEnd | undefined {
  if (!value || typeof value !== "object") return undefined;
  const shape = (value as { shape?: unknown }).shape;
  if (isShapeId(shape)) return { shape };
  if (isPoint(value)) {
    const x = finite(value.x);
    const y = finite(value.y);
    return x !== undefined && y !== undefined ? { x, y } : undefined;
  }
  return undefined;
}

function genOf(value: unknown): ImageGen | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const by = userOf(o.by);
  if (typeof o.prompt !== "string" || typeof o.model !== "string" || !by || typeof o.at !== "string") return undefined;
  const gen: ImageGen = { prompt: o.prompt.slice(0, 4000), model: o.model.slice(0, 200), by, at: o.at.slice(0, 64) };
  if (Array.isArray(o.from)) {
    const from = o.from.filter(isShapeOrAssetId).slice(0, 16);
    if (from.length) gen.from = from;
  }
  if (typeof o.request === "string" && o.request.length <= 64) gen.request = o.request;
  return gen;
}

/** Asset and file ids are uuids; shape ids are ours. */
function isShapeOrAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function styleOf(value: unknown): CanvasTextStyle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const style: CanvasTextStyle = {};
  const size = finite(o.size);
  if (size !== undefined && size >= 4 && size <= 1000) style.size = size;
  const color = colorOf(o.color);
  if (color) style.color = color;
  if (o.align === "left" || o.align === "center" || o.align === "right") style.align = o.align;
  if (o.weight === 400 || o.weight === 600 || o.weight === 700) style.weight = o.weight;
  return Object.keys(style).length ? style : undefined;
}

/** Keys each type holds besides the common ones. */
export const TYPE_PROPS: Record<ShapeType, readonly string[]> = {
  image: ["asset", "nw", "nh", "alt", "gen"],
  note: ["color"],
  text: ["style"],
  frame: ["name", "fill"],
  shape: ["kind", "fill", "stroke"],
  arrow: ["from", "to", "label", "dashed"],
  html: ["artifact"],
  file: ["artifact"],
  pending: ["request", "index", "status", "error", "prompt", "by"],
};

/** Types whose shape carries rich text (`text`). */
export const TEXT_TYPES: readonly ShapeType[] = ["note", "text", "shape"];

/** A prop's value as stored, or undefined when it isn't one this key may hold. */
export function cleanProp(key: string, value: unknown): unknown {
  switch (key) {
    case "x":
    case "y":
      return finite(value);
    case "w":
    case "h": {
      const n = finite(value);
      return n !== undefined && n >= 0 ? n : undefined;
    }
    case "rot": {
      const n = finite(value);
      return n === undefined ? undefined : ((n % 360) + 360) % 360;
    }
    case "parent":
    case "asset":
    case "artifact":
    case "request":
      return isShapeOrAssetId(value) ? value : undefined;
    case "locked":
    case "dashed":
      return value === true ? true : undefined;
    case "nw":
    case "nh": {
      const n = finite(value);
      return n !== undefined && n > 0 ? n : undefined;
    }
    case "alt":
      return text(value, 1000);
    case "gen":
      return genOf(value);
    case "color":
      return typeof value === "string" && (NOTE_COLORS as readonly string[]).includes(value) ? value : undefined;
    case "style":
      return styleOf(value);
    case "name":
      return text(value, 200);
    case "fill":
      return colorOf(value, true);
    case "stroke":
      return colorOf(value, true);
    case "kind":
      return typeof value === "string" && SHAPE_KINDS.includes(value) ? value : undefined;
    case "from":
    case "to":
      return endOf(value);
    case "label":
      return text(value, 500);
    case "index": {
      const n = finite(value);
      return n !== undefined && Number.isInteger(n) && n >= 0 && n < 100 ? n : undefined;
    }
    case "status":
      return typeof value === "string" && STATUSES.includes(value) ? value : undefined;
    case "error":
      return text(value, 64);
    case "prompt":
      return text(value, 4000);
    case "by":
      return userOf(value);
    default:
      return undefined;
  }
}

/** What a read takes: `text: false` leaves the rich text out (placement and geometry never need it, and it costs). */
export interface ReadShapesOptions {
  text?: boolean;
}

/** A shape's map as plain data, or null when it isn't a shape any app can draw. */
export function readShape(id: string, map: Y.Map<unknown>, opts: ReadShapesOptions = {}): ShapeView | null {
  const type = map.get("type");
  if (!isShapeType(type)) return null;
  const z = map.get("z");
  const view: ShapeView = {
    id,
    type,
    x: finite(map.get("x")) ?? 0,
    y: finite(map.get("y")) ?? 0,
    w: Math.max(0, finite(map.get("w")) ?? 0),
    h: Math.max(0, finite(map.get("h")) ?? 0),
    z: typeof z === "string" ? z : "",
  };
  const rot = cleanProp("rot", map.get("rot"));
  if (typeof rot === "number" && rot !== 0) view.rot = rot;
  const parent = cleanProp("parent", map.get("parent"));
  if (typeof parent === "string" && parent !== id) view.parent = parent;
  if (map.get("locked") === true) view.locked = true;
  const fragment = opts.text === false ? undefined : map.get("text");
  if (fragment instanceof Y.XmlFragment) view.text = readRich(fragment);
  const props = view as unknown as Record<string, unknown>;
  for (const key of TYPE_PROPS[type]) {
    const value = cleanProp(key, map.get(key));
    if (value !== undefined) props[key] = value;
  }
  if (type === "note" && !view.color) view.color = "yellow" satisfies NoteColor;
  if (type === "shape" && !view.kind) view.kind = "rect" satisfies CanvasShapeKind;
  if (type === "pending" && !view.status) view.status = "queued" satisfies PendingStatus;
  return view;
}

/**
 * Every shape as plain data, in drawing order: frames first (they sit under what's in them), then everything else,
 * each group by stacking key, then id.
 */
export function readShapes(doc: Y.Doc, opts: ReadShapesOptions = {}): ShapeView[] {
  const shapes: ShapeView[] = [];
  shapesMapOf(doc).forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const view = readShape(id, value as Y.Map<unknown>, opts);
    if (view) shapes.push(view);
  });
  return shapes.sort((a, b) => Number(b.type === "frame") - Number(a.type === "frame") || compareStack(a, b));
}

export function readShapeById(doc: Y.Doc, id: string, opts: ReadShapesOptions = {}): ShapeView | null {
  const map = shapeMapOf(doc, id);
  return map ? readShape(id, map, opts) : null;
}

/** Where an arrow's end is: a bound shape's box (null when that shape is gone) or the free point. */
export function resolveEnd(end: ArrowEnd | undefined, byId: ReadonlyMap<string, ShapeView>): Box | Point | null {
  if (!end) return null;
  if ("shape" in end) {
    const shape = byId.get(end.shape);
    return shape && shape.type !== "arrow" ? { x: shape.x, y: shape.y, w: shape.w, h: shape.h } : null;
  }
  return end;
}

/** The axis-aligned box a shape covers (rotation included; an arrow's from its ends when they resolve). */
export function shapeBounds(shape: ShapeView, byId: ReadonlyMap<string, ShapeView>): Box {
  if (shape.type === "arrow") {
    const from = resolveEnd(shape.from, byId);
    const to = resolveEnd(shape.to, byId);
    if (from && to) {
      const points = [from, to].map((end) => (isBoxEnd(end) ? center(end) : end));
      return union(points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))) ?? { x: shape.x, y: shape.y, w: 0, h: 0 };
    }
  }
  return rotatedBounds(shape, shape.rot ?? 0);
}

/** Shapes by id. */
export function shapeIndex(shapes: readonly ShapeView[]): Map<string, ShapeView> {
  return new Map(shapes.map((s) => [s.id, s]));
}

/** The frames a shape sits in, innermost first (stops at a loop people made by moving frames at once). */
export function ancestorsOf(id: string, byId: ReadonlyMap<string, ShapeView>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.parent;
  while (parent && !seen.has(parent)) {
    const frame = byId.get(parent);
    if (frame?.type !== "frame") break;
    out.push(parent);
    seen.add(parent);
    parent = frame.parent;
  }
  return out;
}

/** A frame's whole contents: its children, theirs, and so on. */
export function descendantsOf(ids: Iterable<string>, shapes: readonly ShapeView[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const s of shapes) {
    if (!s.parent) continue;
    const list = children.get(s.parent) ?? [];
    list.push(s.id);
    children.set(s.parent, list);
  }
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const child of children.get(id) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}
