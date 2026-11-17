import type { PeerUser } from "../awareness";
import type { RichDoc } from "../rich/types";
import type { Box, Point } from "./geometry";

/**
 * Canvases (ADR 0194 §2): shapes in a map, each with a box in world units, a stacking key and the frame it sits in.
 * One shape type per kind of thing: images (generated or dropped), notes, text, frames that group, shapes, arrows
 * between shapes, an agent's page (an `html` file drawn isolated), any Drive file as a card, and a placeholder for an
 * image being generated (ADR 0195).
 */

export type ShapeType = "image" | "note" | "text" | "frame" | "shape" | "arrow" | "html" | "file" | "pending";

export const SHAPE_TYPES: readonly ShapeType[] = [
  "image",
  "note",
  "text",
  "frame",
  "shape",
  "arrow",
  "html",
  "file",
  "pending",
];

export function isShapeType(value: unknown): value is ShapeType {
  return typeof value === "string" && (SHAPE_TYPES as readonly string[]).includes(value);
}

export type CanvasBackground = "dots" | "grid" | "plain";

export const CANVAS_BACKGROUNDS: readonly CanvasBackground[] = ["dots", "grid", "plain"];

export type NoteColor = "yellow" | "pink" | "blue" | "green" | "purple" | "gray";

export const NOTE_COLORS: readonly NoteColor[] = ["yellow", "pink", "blue", "green", "purple", "gray"];

export type CanvasShapeKind = "rect" | "ellipse" | "diamond";

export type PendingStatus = "queued" | "running" | "failed";

/** An arrow's end: bound to a shape (it follows it) or a free point. */
export type ArrowEnd = { shape: string } | Point;

export interface CanvasTextStyle {
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  weight?: 400 | 600 | 700;
}

/** How a generated image came to be (ADR 0195). */
export interface ImageGen {
  prompt: string;
  model: string;
  by: PeerUser;
  /** ISO time. */
  at: string;
  /** Asset ids of the images it started from (variations, edits). */
  from?: string[];
  /** The generation request's id. */
  request?: string;
}

/**
 * A shape as plain data. Common fields first; the rest belong to some types only:
 * image `asset`, `nw`, `nh` (natural size), `alt`, `gen`; note `color` and `text`; text `style` and `text`; frame `name`,
 * `fill`; shape `kind`, `fill`, `stroke` and `text` (its label); arrow `from`, `to`, `label`, `dashed`; html and file
 * `artifact` (a Drive file id); pending `request`, `index`, `status`, `error`, `prompt`, `by`.
 */
export interface ShapeView {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  z: string;
  /** The frame it sits in. */
  parent?: string;
  locked?: boolean;
  text?: RichDoc;
  asset?: string;
  nw?: number;
  nh?: number;
  alt?: string;
  gen?: ImageGen;
  color?: NoteColor;
  style?: CanvasTextStyle;
  name?: string;
  fill?: string;
  kind?: CanvasShapeKind;
  stroke?: string;
  from?: ArrowEnd;
  to?: ArrowEnd;
  label?: string;
  dashed?: boolean;
  artifact?: string;
  request?: string;
  index?: number;
  status?: PendingStatus;
  error?: string;
  prompt?: string;
  by?: PeerUser;
}

/** A new shape: its type and whatever it starts with; a box left out gets the type's size in free room. */
export type NewShape = { type: ShapeType; text?: string | RichDoc } & Partial<
  Omit<ShapeView, "id" | "type" | "z" | "text">
>;

/** A change to a shape: given keys change, `null` removes an optional one. */
export type ShapePatch = {
  [K in Exclude<keyof ShapeView, "id" | "type" | "text">]?: ShapeView[K] | null;
} & { text?: string | RichDoc };

/** What a canvas card draws: the bounds, and up to 40 of the biggest shapes. */
export interface CanvasPreviewShape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  /** A note's color, or a frame's or shape's fill. */
  color?: string;
  asset?: string;
  /** The first words of its text (a frame's name). */
  text?: string;
  /** Arrows: where they start and end. */
  line?: { x1: number; y1: number; x2: number; y2: number };
}

export interface CanvasPreview {
  bg: CanvasBackground;
  bounds: Box | null;
  count: number;
  shapes: CanvasPreviewShape[];
}

export interface PlaceOptions {
  count: number;
  w: number;
  h: number;
  /** Space between the boxes, and around them (default 40). */
  gap?: number;
  /** Try to place them around this point (else to the right of what's there). */
  near?: Point;
  /** Put them in a new frame with this name. */
  frame?: { name: string };
  /** Put them inside this existing frame (growing it when there's no room left). */
  within?: string;
}

export interface Placement {
  /** The new frame's box (with `frame`). */
  frame?: Box;
  boxes: Box[];
  /** The existing frame's new box, when it has to grow to hold them (with `within`). */
  grow?: { id: string; box: Box };
}
