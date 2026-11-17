import { type ErrorCode, isErrorCode, type SheetData, type WorkbookData } from "@agenteschat/live";
import type { CellObject, WorkBook, WorkSheet } from "xlsx";
import { zip } from "../zip";
import { stripFunctionPrefixes } from "./formulas";
import { OFFICE_LIMITS, officeEncrypted, officeTooLarge, officeUnreadable } from "./limits";
import { isCompoundFile, isZipFile, OfficePackage } from "./package";
import { ptToPx, widthToPx } from "./xlsx-read";

/**
 * The formats the server doesn't read itself (ADR 0196): the legacy binary Excel workbook (`.xls`) and the
 * OpenDocument spreadsheet (`.ods`), read through SheetJS's community edition (Apache-2.0), loaded only when one is
 * opened. An `.ods` is a zip: its parts are first taken out by the server's own zip reader, within the same budget as
 * any Office file, and handed over repacked, so a zip bomb never reaches the library. Values, formulas, number
 * formats, solid fills, merged cells, column widths and row heights come through; what the community edition doesn't
 * read (fonts, borders, frozen panes) is left out.
 */

/** Excel's binary error numbers (0x00, 0x07, 0x0F, 0x17, 0x1D, 0x24, 0x2A). */
const ERRORS: Record<number, ErrorCode> = {
  0: "#NULL!",
  7: "#DIV/0!",
  15: "#VALUE!",
  23: "#REF!",
  29: "#NAME?",
  36: "#NUM!",
  42: "#N/A",
};

/** The parts of an `.ods` SheetJS reads (pictures and thumbnails are never inflated). */
const ODS_PARTS = /^(?:mimetype|content\.xml|styles\.xml|meta\.xml|settings\.xml|META-INF\/manifest\.xml)$/i;

/**
 * SheetJS's own patterns (xlsx 0.20.3) for the tags of an `.ods` part and their attributes: `odsCells` walks the tags
 * exactly as the library will, after taking out the comments the same way (`withoutComments`).
 */
const ODS_TAG = /<(\/?)([^\s?><!/:"]*:|)([^\s?<>:/"]+)(?:\s+[^<>=?"'\s]+="[^"]*?")*\s*\/?>/g;
const ODS_ATTR = /\s([^"\s?>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^'">\s]+))/g;

/** The text without its `<!-- -->` comments, as SheetJS takes them out (an unclosed one ends the text). */
function withoutComments(text: string): string {
  let si = text.indexOf("<!--");
  if (si === -1) return text;
  const out: string[] = [];
  let last = 0;
  while (si > -1) {
    out.push(text.slice(last, si));
    const ei = text.indexOf("-->", si + 4);
    if (ei === -1) break;
    last = ei + 3;
    si = text.indexOf("<!--", last);
    if (si === -1) out.push(text.slice(last));
  }
  return out.join("");
}

/** The largest repeat a tag asks for in `attribute` (by its local name, as SheetJS keys it), read the way it reads it. */
function repeatOf(tag: string, attribute: string, read: (value: string) => number): number {
  let most = 1;
  for (const m of tag.matchAll(ODS_ATTR)) {
    const name = m[1] ?? "";
    const colon = name.indexOf(":");
    let local = colon >= 0 ? name.slice(colon + 1) : name;
    if (colon < 0 && local.indexOf("_") > 0) local = local.slice(0, local.indexOf("_"));
    if (local.toLowerCase() !== attribute) continue;
    // Not a number, or below one, leaves it at one, as the library counts it; `Infinity` stays endless.
    const n = read(m[2] ?? m[3] ?? m[4] ?? "");
    if (n > most) most = n;
  }
  return most;
}

/**
 * How many cells SheetJS writes out for an `.ods` content part: each cell that ends (`</table:table-cell>`) is written
 * once per column it repeats (`number-columns-repeated`) and per row its row repeats (`number-rows-repeated`), all
 * held at once before anything is returned. A few bytes asking for a million rows of a thousand cells would fill the
 * server's memory, so the cells are counted first, as the library will see them (its tag pattern, its comments taken
 * out, a cell's repeat from the last cell tag, a row's until the row ends); a cell that turns out empty is counted
 * too, which only errs toward refusing. Counting stops past `stopAt`.
 */
function odsCells(content: string, stopAt: number): number {
  let rows = 1;
  let cols = 1;
  let cells = 0;
  for (const m of withoutComments(content).matchAll(ODS_TAG)) {
    const close = m[1] === "/";
    const raw = m[3] ?? "";
    const name = raw.indexOf("_") >= 0 ? raw.slice(0, raw.indexOf("_")) : raw;
    if (name === "table-row" || name === "行") {
      rows = close ? 1 : repeatOf(m[0], "number-rows-repeated", (v) => +v);
    } else if (name === "table-cell" || name === "数据" || name === "covered-table-cell") {
      if (!close) cols = repeatOf(m[0], "number-columns-repeated", (v) => Number.parseInt(v, 10));
      else if (name !== "covered-table-cell") cells += rows * cols;
    }
    if (cells > stopAt) return cells;
  }
  return cells;
}

/** An `.ods` rebuilt from its parts as the server's zip reader inflated them (each at most its declared size). */
function repackOds(bytes: Uint8Array): Uint8Array {
  const pkg = OfficePackage.open(bytes);
  const files: [string, Uint8Array][] = [];
  for (const name of pkg.names()) {
    if (!ODS_PARTS.test(name)) continue;
    const part = pkg.bytes(name);
    if (part) files.push([name === "meta-inf/manifest.xml" ? "META-INF/manifest.xml" : name, part]);
  }
  const content = files.find(([name]) => name === "content.xml")?.[1];
  if (!content) throw officeUnreadable("it has no content");
  // The cells the library would expand, counted before it runs (`odsCells`). The part must be UTF-8 without a
  // document type, so it reads here exactly as the library reads it.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw officeUnreadable("its content is not UTF-8");
  }
  if (/<!DOCTYPE/i.test(text)) throw officeUnreadable("content.xml declares a document type");
  if (odsCells(text, OFFICE_LIMITS.cells) > OFFICE_LIMITS.cells) throw officeTooLarge("cells");
  // `mimetype` first and stored, as the format asks.
  files.sort((a, b) => (a[0] === "mimetype" ? -1 : b[0] === "mimetype" ? 1 : 0));
  return zip(files, { store: (path) => path === "mimetype" });
}

/** A JavaScript date (what the library makes of a date cell) as a serial in the 1900 date system. */
function dateSerial(date: Date): number {
  const ms = date.getTime() - Date.UTC(1899, 11, 30) - date.getTimezoneOffset() * 60_000;
  const serial = ms / 86_400_000;
  return serial < 61 ? serial - 1 : serial;
}

function cellsOf(ws: WorkSheet, XLSX: typeof import("xlsx")): [number, number, CellObject][] {
  const out: [number, number, CellObject][] = [];
  const dense = (ws as { "!data"?: (CellObject | undefined)[][] })["!data"];
  if (Array.isArray(dense)) {
    dense.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, c) => {
        if (cell) out.push([r, c, cell]);
      });
    });
    return out;
  }
  for (const key of Object.keys(ws)) {
    if (key.startsWith("!")) continue;
    const at = XLSX.utils.decode_cell(key);
    const cell = ws[key] as CellObject | undefined;
    if (cell && at.r >= 0 && at.c >= 0) out.push([at.r, at.c, cell]);
  }
  return out;
}

/** One sheet of the library's workbook as data. */
function sheetOf(name: string, ws: WorkSheet, XLSX: typeof import("xlsx"), counted: { n: number }): SheetData {
  const sheet: SheetData = { name, rows: 1, cols: 1, cells: [] };
  let maxRow = 0;
  let maxCol = 0;
  for (const [r, c, cell] of cellsOf(ws, XLSX)) {
    const out: SheetData["cells"][number] = { r, c };
    if (typeof cell.f === "string" && cell.f.trim() !== "") out.f = stripFunctionPrefixes(cell.f);
    switch (cell.t) {
      case "n":
        if (typeof cell.v === "number" && Number.isFinite(cell.v)) out.v = cell.v;
        break;
      case "s":
        if (typeof cell.v === "string" && cell.v !== "") out.v = cell.v;
        break;
      case "b":
        if (typeof cell.v === "boolean") out.v = cell.v;
        break;
      case "d":
        if (cell.v instanceof Date && Number.isFinite(cell.v.getTime())) out.v = dateSerial(cell.v);
        break;
      case "e": {
        const shown = typeof cell.w === "string" ? cell.w : "";
        out.e = isErrorCode(shown) ? shown : (ERRORS[Number(cell.v)] ?? "#N/A");
        break;
      }
    }
    const style: NonNullable<SheetData["cells"][number]["s"]> = {};
    if (typeof cell.z === "string" && cell.z.toLowerCase() !== "general") style.nf = cell.z.slice(0, 255);
    const s = cell.s as { patternType?: string; fgColor?: { rgb?: string } } | undefined;
    const rgb = s?.fgColor?.rgb;
    if (s?.patternType === "solid" && typeof rgb === "string" && /^[0-9a-f]{6,8}$/i.test(rgb)) {
      style.bg = `#${rgb.slice(-6).toLowerCase()}`;
    }
    if (Object.keys(style).length > 0) out.s = style;
    if (out.v === undefined && out.f === undefined && out.e === undefined && out.s === undefined) continue;
    if (++counted.n > OFFICE_LIMITS.cells) throw officeTooLarge("cells");
    sheet.cells.push(out);
    maxRow = Math.max(maxRow, r + 1);
    maxCol = Math.max(maxCol, c + 1);
  }
  const merges = (ws["!merges"] ?? [])
    .map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }))
    .filter((m) => m.r1 >= 0 && m.c1 >= 0 && (m.r1 !== m.r2 || m.c1 !== m.c2));
  for (const m of merges) {
    maxRow = Math.max(maxRow, m.r2 + 1);
    maxCol = Math.max(maxCol, m.c2 + 1);
  }
  if (merges.length > 0) sheet.merges = merges;
  const widths: Record<number, number> = {};
  (ws["!cols"] ?? []).forEach((col, i) => {
    if (!col || col.hidden || i >= Math.max(maxCol, 1)) return;
    const px = col.wpx ?? (col.width ? widthToPx(col.width) : col.wch ? widthToPx(col.wch) : undefined);
    if (px && Number.isFinite(px) && px > 0) widths[i] = Math.round(px);
  });
  if (Object.keys(widths).length > 0) sheet.colWidths = widths;
  const heights: Record<number, number> = {};
  (ws["!rows"] ?? []).forEach((row, i) => {
    if (!row || row.hidden || i >= Math.max(maxRow, 1)) return;
    const px = row.hpx ?? (row.hpt ? ptToPx(row.hpt) : undefined);
    if (px && Number.isFinite(px) && px > 0) heights[i] = Math.round(px);
  });
  if (Object.keys(heights).length > 0) sheet.rowHeights = heights;
  sheet.rows = Math.max(maxRow, 1);
  sheet.cols = Math.max(maxCol, 1);
  return sheet;
}

/** A legacy `.xls` or an `.ods` workbook as data: its visible sheets in order. */
export async function readXls(bytes: Uint8Array): Promise<WorkbookData> {
  if (bytes.byteLength > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
  let input: Uint8Array;
  if (isZipFile(bytes)) input = repackOds(bytes);
  else if (isCompoundFile(bytes)) input = bytes;
  else throw officeUnreadable("it is not a spreadsheet");
  const XLSX = await import("xlsx");
  let wb: WorkBook;
  try {
    wb = XLSX.read(input, {
      type: "array",
      dense: true,
      cellFormula: true,
      cellStyles: true,
      cellNF: true,
      cellDates: false,
      cellHTML: false,
      bookVBA: false,
      bookFiles: false,
      WTF: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) throw officeEncrypted();
    throw officeUnreadable("it is damaged or not a spreadsheet");
  }
  const counted = { n: 0 };
  const sheets: SheetData[] = [];
  wb.SheetNames.forEach((name, i) => {
    const hidden = wb.Workbook?.Sheets?.[i]?.Hidden;
    if (hidden === 1 || hidden === 2) return;
    const ws = wb.Sheets[name];
    if (!ws) return;
    sheets.push(sheetOf(name, ws, XLSX, counted));
  });
  if (sheets.length === 0) throw officeUnreadable("it has no sheet to show");
  return { sheets };
}
