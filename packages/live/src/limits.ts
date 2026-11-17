/**
 * The kinds of live file and the limits every app and the server hold them to (ADR 0191 §2). This module imports
 * nothing, so any part of the package can read the limits without an import cycle through `kinds.ts`.
 */

export type LiveKind = "spreadsheet" | "slides" | "canvas";

export const LIVE_KINDS: readonly LiveKind[] = ["spreadsheet", "slides", "canvas"];

export function isLiveKind(kind: string): kind is LiveKind {
  return (LIVE_KINDS as readonly string[]).includes(kind);
}

/**
 * What a live document may hold. The server refuses an update past these (ADR 0191 §2), so a buggy or hostile client
 * can't leave a document no app can open; the apps and the agents' tools check them before writing.
 */
export const LIVE_LIMITS = {
  /** The whole document, encoded. */
  docBytes: 32 * 1024 * 1024,
  /** One update frame from a socket. */
  updateBytes: 1024 * 1024,
  /** One peer's presence, encoded as JSON. */
  awarenessBytes: 4096,
  spreadsheet: { sheets: 50, rows: 20_000, cols: 500, cells: 300_000, cellChars: 32_000, formulaChars: 8192 },
  /** `elements` is per slide, `textChars` per text box (and per slide's notes). */
  slides: { slides: 300, elements: 200, textChars: 20_000 },
  /** `textChars` is per shape. */
  canvas: { shapes: 5000, textChars: 20_000 },
} as const;
