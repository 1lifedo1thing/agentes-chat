import { and, eq, inArray, schema } from "@agenteschat/db";
import * as live from "@agenteschat/live";
import type * as Y from "yjs";
import type { ArtifactActor, ArtifactDeps } from "../../artifacts";
import { TextMeasurer } from "../../fonts/library";
import { outboundRefusal } from "../../outbound";
import type { ToolContext } from "../../tools/types";
import { copyAssetFrom, type LiveAsset, putAsset } from "../assets";
import { SVG_TYPE, sanitizeSvg } from "../svg";
import { fetchWebPicture, type WebPictureDeps } from "../web-pictures";
import { layoutHtml, type ParsedHtml, parseHtml } from "./html";
import type { LayoutResult, PictureSize, Piece, PieceTextStyle } from "./types";

/**
 * Where `add_html` (ADR 0220 §4) meets the files: the pictures the markup names become assets of the file (the same
 * paths as `add_image`), the layout takes the file's own fonts, size and color as what its root inherits, and the
 * pieces become a slide's elements or a canvas's shapes, with their groups, in the edit's transaction.
 */

export interface HtmlPictures {
  assets: Map<string, LiveAsset>;
  sizes: Map<string, PictureSize>;
  notes: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sizeOf(asset: LiveAsset): PictureSize {
  return asset.width && asset.height ? { w: asset.width, h: asset.height } : { w: 512, h: 512 };
}

/**
 * Brings in the pictures the markup names, as assets of `fileId`: an inline `<svg>` (sanitized), `asset:<id>` (one of
 * the file's own), `file:<id>` or a bare id (a Drive picture the agent reads, copied in), an `https` address
 * (downloaded through the outbound check), a `data:image/svg+xml` address. What can't be used is named, not fatal.
 */
export async function resolveHtmlPictures(
  deps: { artifacts: ArtifactDeps; web?: WebPictureDeps },
  ctx: ToolContext,
  actor: ArtifactActor,
  fileId: string,
  parsed: ParsedHtml,
): Promise<HtmlPictures> {
  const out: HtmlPictures = { assets: new Map(), sizes: new Map(), notes: [] };
  const bySource = new Map<string, LiveAsset>();
  const own = new Set(
    parsed.pictures.map((p) => (p.kind === "src" ? p.src.replace(/^asset:/, "") : "")).filter((id) => UUID.test(id)),
  );
  const ownRows =
    own.size === 0
      ? []
      : await deps.artifacts.db
          .select()
          .from(schema.liveAssets)
          .where(
            and(
              eq(schema.liveAssets.orgId, ctx.orgId),
              eq(schema.liveAssets.artifactId, fileId),
              inArray(schema.liveAssets.id, [...own]),
            ),
          );
  for (const request of parsed.pictures) {
    try {
      let asset: LiveAsset | undefined;
      if (request.kind === "svg") {
        const clean = sanitizeSvg(request.svg);
        const key = `svg:${clean.svg}`;
        asset = bySource.get(key);
        if (!asset) {
          asset = await putAsset(deps.artifacts, actor, ctx.orgId, fileId, {
            bytes: clean.bytes,
            contentType: SVG_TYPE,
            source: "drawn",
          });
          bySource.set(key, asset);
        }
      } else {
        const src = request.src.trim();
        asset = bySource.get(src);
        if (!asset) {
          const id = src.replace(/^(asset|file):/, "");
          const mine = ownRows.find((row) => row.id === id);
          if (mine) {
            asset = {
              id: mine.id,
              contentType: mine.contentType,
              size: mine.size,
              width: mine.width,
              height: mine.height,
            };
          } else if (UUID.test(id)) {
            asset = await copyAssetFrom(deps.artifacts, actor, ctx.orgId, fileId, { artifactId: id });
          } else if (/^data:image\/svg\+xml[;,]/i.test(src)) {
            const comma = src.indexOf(",");
            const meta = src.slice(0, comma);
            const body = src.slice(comma + 1);
            const text = /;base64$/i.test(meta)
              ? Buffer.from(body, "base64").toString("utf8")
              : decodeURIComponent(body);
            const clean = sanitizeSvg(text);
            asset = await putAsset(deps.artifacts, actor, ctx.orgId, fileId, {
              bytes: clean.bytes,
              contentType: SVG_TYPE,
              source: "drawn",
            });
          } else if (/^https:\/\//i.test(src)) {
            const refusal = await outboundRefusal(ctx, src);
            if (refusal) throw new Error(refusal.content);
            const picture = await fetchWebPicture(src, deps.web, ctx.signal);
            asset = await putAsset(deps.artifacts, actor, ctx.orgId, fileId, {
              bytes: picture.bytes,
              contentType: picture.contentType,
              source: "web",
              origin: { url: picture.url },
            });
          } else {
            throw new Error(
              "name a Drive picture (file:<id>), one of the file's (asset:<id>), an https address or an inline <svg>",
            );
          }
          bySource.set(src, asset);
        }
      }
      out.assets.set(request.key, asset);
      out.sizes.set(request.key, sizeOf(asset));
    } catch (error) {
      const what = request.kind === "svg" ? "an inline SVG" : `the picture ${request.src.slice(0, 80)}`;
      out.notes.push(`${what} couldn't be used (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return out;
}

/** A font-family name to one the file can use: a catalog font, or one of the file's own fonts (`files`: family → asset). */
export function fontResolver(files: ReadonlyMap<string, string>): (family: string) => live.FontRef | null {
  return (family) => {
    const own = files.get(family.trim().toLowerCase());
    if (own) return live.fontAssetRef(own);
    return live.catalogFontNamed(family)?.id ?? null;
  };
}

export interface HtmlLayoutInput {
  html: string;
  name?: string;
  pictures: HtmlPictures;
  /** The file's own fonts by lowercase family name, and their bytes by asset id (to measure with). */
  fonts?: { byFamily: ReadonlyMap<string, string>; bytes: ReadonlyMap<string, Uint8Array> };
}

/** Lays markup out for a slide: the box (the whole slide when none), the deck's body font and color as the root's. */
export function slideHtmlLayout(
  doc: Y.Doc,
  parsed: ParsedHtml,
  input: HtmlLayoutInput,
  box?: live.Box,
): { layout: LayoutResult; at: { x: number; y: number } } {
  const deck = live.readDeck(doc);
  const theme = live.themeOf(deck.theme);
  const roles = live.roleFonts(theme, deck.fonts);
  const area = box ?? { x: 0, y: 0, w: deck.w, h: deck.h };
  const layout = layoutHtml(parsed, {
    width: area.w,
    ...(box ? { height: box.h } : { height: deck.h }),
    // A browser's 16px for text the markup gives no size (it is laid out as a 1920-wide page), the deck's font and color.
    base: { font: roles.body, size: 16, color: theme.colors.text },
    fontNamed: fontResolver(input.fonts?.byFamily ?? new Map()),
    measurer: new TextMeasurer(input.fonts?.bytes),
    pictures: input.pictures.sizes,
    tables: true,
    ...(input.name ? { name: input.name } : {}),
  });
  return { layout, at: { x: area.x, y: area.y } };
}

/** Lays markup out for a canvas: `width` wide (1200 when not given), the canvas's own text look as the root's. */
export function canvasHtmlLayout(parsed: ParsedHtml, input: HtmlLayoutInput, width = 1200): LayoutResult {
  return layoutHtml(parsed, {
    width,
    base: { size: 24 },
    fontNamed: fontResolver(input.fonts?.byFamily ?? new Map()),
    measurer: new TextMeasurer(input.fonts?.bytes),
    pictures: input.pictures.sizes,
    tables: false,
    ...(input.name ? { name: input.name } : {}),
  });
}

export { parseHtml };

const shift = (box: { x: number; y: number; w: number; h: number }, at: { x: number; y: number }) => ({
  x: box.x + at.x,
  y: box.y + at.y,
  w: box.w,
  h: box.h,
});

function slideStyleOf(piece: Piece): live.ElementStyle {
  const style: live.ElementStyle = {};
  if (piece.kind === "box") {
    style.shape = "rect";
    if (piece.fill) style.fill = piece.fill;
    if (piece.gradient) style.gradient = piece.gradient;
    style.stroke = piece.stroke ?? "none";
    if (piece.strokeWidth) style.strokeWidth = piece.strokeWidth;
    if (piece.dash) style.dash = piece.dash;
    if (piece.radius) style.radius = piece.radius;
    if (piece.shadow) style.shadow = piece.shadow;
    if (piece.opacity !== undefined) style.opacity = piece.opacity;
    if (piece.padding !== undefined) style.padding = piece.padding;
  }
  const text = piece.kind === "text" ? piece.style : piece.kind === "box" ? piece.textStyle : undefined;
  if (text) {
    if (text.font) style.font = text.font;
    style.size = text.size;
    style.weight = text.weight;
    if (text.color) style.color = text.color;
    style.align = text.align;
    style.valign = text.valign;
    style.lineHeight = text.lineHeight;
    if (text.tracking) style.tracking = text.tracking;
    if (text.caps) style.caps = true;
  }
  if (piece.kind === "image") {
    if (piece.radius) style.radius = piece.radius;
    if (piece.shadow) style.shadow = piece.shadow;
    if (piece.opacity !== undefined) style.opacity = piece.opacity;
  }
  if (piece.kind === "line") {
    style.stroke = piece.stroke;
    style.strokeWidth = piece.width;
    if (piece.dash) style.dash = piece.dash;
  }
  return style;
}

/** Puts a layout on a slide, bottom to top in the markup's order, with its groups. Returns the elements made. */
export function placeOnSlide(
  doc: Y.Doc,
  slideId: string,
  layout: LayoutResult,
  at: { x: number; y: number },
  pictures: HtmlPictures,
  origin: unknown,
): string[] {
  const ids: string[] = [];
  live.putGroups(doc, slideId, layout.groups, origin);
  for (const piece of layout.pieces) {
    const box = shift(piece.box, at);
    const group = piece.group ? { group: piece.group } : {};
    const style = slideStyleOf(piece);
    let el: live.NewElement | null = null;
    switch (piece.kind) {
      case "box":
        el = { type: "shape", box, style, ...(piece.text ? { text: piece.text } : {}), ...group };
        break;
      case "text":
        el = { type: "text", box, style, text: piece.text, ...group };
        break;
      case "image": {
        const asset = pictures.assets.get(piece.picture);
        if (!asset) continue;
        el = {
          type: "image",
          box,
          asset: asset.id,
          fit: piece.fit,
          ...(piece.alt ? { alt: piece.alt } : {}),
          style,
          ...group,
        };
        break;
      }
      case "line":
        el = { type: "line", box, style, ...group };
        break;
      case "table":
        el = { type: "table", box, table: { rows: piece.rows, header: piece.header }, ...group };
        break;
    }
    if (el) ids.push(live.addElement(doc, slideId, el, origin));
  }
  return ids;
}

function canvasTextStyle(style: PieceTextStyle): live.CanvasTextStyle {
  const out: live.CanvasTextStyle = {
    size: style.size,
    weight: style.weight,
    align: style.align,
    valign: style.valign,
    lineHeight: style.lineHeight,
  };
  if (style.font && !live.isFontRole(style.font)) out.font = style.font;
  if (style.color) out.color = style.color;
  if (style.tracking) out.tracking = style.tracking;
  if (style.caps) out.caps = true;
  return out;
}

function textOf(piece: Piece): PieceTextStyle | undefined {
  return piece.kind === "text" ? piece.style : piece.kind === "box" ? piece.textStyle : undefined;
}

/** Puts a layout on a canvas at a point (inside `frame` when given), with its groups. Returns the shapes made. */
export function placeOnCanvas(
  doc: Y.Doc,
  layout: LayoutResult,
  at: { x: number; y: number },
  frame: string | undefined,
  pictures: HtmlPictures,
  origin: unknown,
): string[] {
  const ids: string[] = [];
  live.putShapeGroups(doc, layout.groups, origin);
  const common = (piece: Piece) => ({
    ...(piece.group ? { group: piece.group } : {}),
    ...(frame ? { parent: frame } : {}),
  });
  for (const piece of layout.pieces) {
    const box = shift(piece.box, at);
    let shape: live.NewShape | null = null;
    switch (piece.kind) {
      case "box": {
        const text = textOf(piece);
        shape = {
          type: "shape",
          ...box,
          kind: "rect",
          fill: piece.fill ?? "none",
          stroke: piece.stroke ?? "none",
          ...(piece.strokeWidth ? { strokeWidth: Math.max(1, Math.min(24, piece.strokeWidth)) } : {}),
          ...(piece.gradient ? { gradient: piece.gradient } : {}),
          ...(piece.dash ? { dash: piece.dash } : {}),
          ...(piece.radius ? { radius: Math.min(200, piece.radius) } : {}),
          ...(piece.shadow ? { shadow: piece.shadow } : {}),
          ...(piece.text ? { text: piece.text } : {}),
          ...(text
            ? {
                style: { ...canvasTextStyle(text), ...(piece.padding !== undefined ? { padding: piece.padding } : {}) },
              }
            : {}),
          ...common(piece),
        };
        break;
      }
      case "text":
        shape = { type: "text", ...box, text: piece.text, style: canvasTextStyle(piece.style), ...common(piece) };
        break;
      case "image": {
        const asset = pictures.assets.get(piece.picture);
        if (!asset) continue;
        shape = {
          type: "image",
          ...box,
          asset: asset.id,
          ...(asset.width && asset.height ? { nw: asset.width, nh: asset.height } : {}),
          ...(piece.alt ? { alt: piece.alt } : {}),
          ...(piece.radius ? { radius: Math.min(200, piece.radius) } : {}),
          ...(piece.shadow ? { shadow: piece.shadow } : {}),
          ...common(piece),
        };
        break;
      }
      case "line":
        shape = {
          type: "arrow",
          ...box,
          from: { x: box.x, y: box.y },
          to: { x: box.x + box.w, y: box.y + box.h },
          heads: { start: "none", end: "none" },
          stroke: piece.stroke,
          strokeWidth: Math.max(1, Math.min(24, piece.width)),
          ...(piece.dash ? { dashed: true } : {}),
          ...common(piece),
        };
        break;
      case "table":
        continue;
    }
    if (shape) ids.push(live.addShape(doc, shape, origin));
  }
  return ids;
}
