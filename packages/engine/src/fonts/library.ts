import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogFont, type FontRef, fontAssetOf, nearestWeight } from "@agenteschat/live";
import { HELVETICA, HELVETICA_BOLD } from "../pdf";
import { type FontMetrics, fontMetrics } from "./sfnt";

/**
 * The fonts the server ships (ADR 0220 §1), read from `FONTS_DIR` as `scripts/fonts/build.py` lays it out:
 *
 *   <dir>/catalog.json                    { fonts: { <id>: { static: { "400": "inter/inter-400.ttf", "400i": … },
 *                                                            web: { normal: "inter/inter.woff2", italic: … },
 *                                                            license: "inter/OFL.txt" } } }
 *
 * Static TrueType instances are what the server measures text with, draws pictures with and embeds in PDFs; the
 * variable WOFF2 files are what browsers load. Without the directory (tests, development) every lookup is null and
 * text is measured with Helvetica's widths, so layouts still come out close.
 */

interface CatalogEntry {
  static: Record<string, string>;
  web: { normal?: string; italic?: string };
  license?: string;
}

let dir: string | null = null;
let entries: Record<string, CatalogEntry> | null = null;
const bytesCache = new Map<string, Uint8Array | null>();
const metricsCache = new Map<string, FontMetrics | null>();

/** Points the library at the built fonts (`FONTS_DIR`), or at nothing. */
export function setFontsDir(path: string | null): void {
  dir = path;
  entries = null;
  bytesCache.clear();
  metricsCache.clear();
}

function catalog(): Record<string, CatalogEntry> {
  if (entries) return entries;
  entries = {};
  if (!dir) return entries;
  try {
    const raw = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as { fonts?: Record<string, CatalogEntry> };
    if (raw.fonts && typeof raw.fonts === "object") entries = raw.fonts;
  } catch {
    // No built fonts here: everything falls back.
  }
  return entries;
}

/** Whether the server has the catalog's files (what `/api/fonts` can serve). */
export function hasFontFiles(): boolean {
  return Object.keys(catalog()).length > 0;
}

/** A path inside `FONTS_DIR` from the catalog, or null when it would leave it or isn't there. */
function inside(relative: string | undefined): string | null {
  if (!dir || !relative || relative.includes("..") || relative.startsWith("/")) return null;
  const path = join(dir, relative);
  return existsSync(path) ? path : null;
}

function read(relative: string | undefined): Uint8Array | null {
  if (!relative) return null;
  const hit = bytesCache.get(relative);
  if (hit !== undefined) return hit;
  const path = inside(relative);
  let bytes: Uint8Array | null = null;
  try {
    bytes = path ? new Uint8Array(readFileSync(path)) : null;
  } catch {
    bytes = null;
  }
  bytesCache.set(relative, bytes);
  return bytes;
}

/** The static TrueType file of a catalog font nearest to a weight and slant, or null. */
export function catalogStaticFont(id: string, weight: number, italic: boolean): Uint8Array | null {
  const font = catalogFont(id);
  const entry = catalog()[id];
  if (!font || !entry) return null;
  const keys = Object.keys(entry.static);
  const has = (w: number, it: boolean) => keys.includes(`${w}${it ? "i" : ""}`);
  const weights = [...new Set(keys.map((k) => Number.parseInt(k, 10)))].filter((w) => Number.isFinite(w));
  const want = nearestWeight({ weights: weights.length ? (weights as typeof font.weights) : font.weights }, weight);
  const key = has(want, italic) ? `${want}${italic ? "i" : ""}` : has(want, false) ? `${want}` : keys[0];
  return key ? read(entry.static[key]) : null;
}

/** A catalog font's file for browsers (`normal` or `italic`), as a path to serve, or null. */
export function catalogWebFile(id: string, style: "normal" | "italic"): string | null {
  const entry = catalog()[id];
  return entry ? inside(entry.web[style] ?? (style === "italic" ? undefined : entry.web.normal)) : null;
}

/** A catalog font's license text, as a path to serve, or null. */
export function catalogLicenseFile(id: string): string | null {
  return inside(catalog()[id]?.license);
}

/** One face to measure: a font ref resolved to a catalog id or a file's font, a weight and a slant. */
export interface Face {
  ref: FontRef;
  weight: number;
  italic: boolean;
}

/**
 * Measures text the way the apps will draw it, with the face's own widths when the server has its file (a catalog
 * font's static instance, or a file's font passed in `files`), else Helvetica's.
 */
export class TextMeasurer {
  constructor(private readonly files: ReadonlyMap<string, Uint8Array> = new Map()) {}

  private metrics(face: Face): FontMetrics | null {
    const asset = fontAssetOf(face.ref);
    const key = asset ? `asset:${asset}` : `${face.ref}:${face.weight}:${face.italic ? 1 : 0}`;
    const hit = metricsCache.get(key);
    if (hit !== undefined && !asset) return hit;
    let bytes: Uint8Array | null | undefined;
    if (asset) bytes = this.files.get(asset);
    else bytes = catalogStaticFont(face.ref, face.weight, face.italic);
    let metrics: FontMetrics | null = null;
    try {
      metrics = bytes ? fontMetrics(bytes) : null;
    } catch {
      metrics = null;
    }
    if (!asset) metricsCache.set(key, metrics);
    return metrics;
  }

  /** The width of `text` at `size`, letter spacing `tracking` in thousandths of the size. */
  width(text: string, face: Face, size: number, tracking = 0): number {
    const m = this.metrics(face);
    let units = 0;
    let chars = 0;
    for (const ch of text) {
      chars++;
      const cp = ch.codePointAt(0) ?? 32;
      const advance = m?.advanceOf(cp);
      if (m && advance !== null && advance !== undefined) units += (advance / m.unitsPerEm) * 1000;
      else units += fallbackAdvance(cp, face.weight >= 600);
    }
    return (units / 1000) * size + (tracking / 1000) * size * chars;
  }

  /** How far above and below the baseline a line of the face reaches, as fractions of the size. */
  extent(face: Face): { ascent: number; descent: number } {
    const m = this.metrics(face);
    if (!m) return { ascent: 0.93, descent: 0.24 };
    return { ascent: m.ascent / m.unitsPerEm, descent: Math.abs(m.descent) / m.unitsPerEm };
  }
}

/** Helvetica's width of a character (1/1000 em), and a fair guess past ASCII (wide for CJK). */
function fallbackAdvance(cp: number, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  if (cp >= 32 && cp <= 126) return table[cp - 32] ?? 556;
  if (cp >= 0x2e80 && cp <= 0x9fff) return 1000;
  if (cp >= 0xac00 && cp <= 0xd7af) return 1000;
  if (cp >= 0xc0 && cp <= 0x24f) return bold ? 611 : 556;
  return bold ? 600 : 556;
}
