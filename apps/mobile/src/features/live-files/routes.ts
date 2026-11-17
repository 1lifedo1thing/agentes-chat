import type { LiveKind } from "@agenteschat/client";
import type { SFSymbolName } from "../../ui/headerActions";
import type { IconName } from "../../ui/icons.data";

/**
 * Where live files open on the phone (ADR 0194 §9), and their marks: kept apart from the screens' logic so the files'
 * routing (`fileRoute`) reads it without loading the documents' code.
 */

/** The screen each kind of live file opens on. */
export const LIVE_SCREENS = {
  spreadsheet: "/spreadsheet/[id]",
  slides: "/slides/[id]",
  canvas: "/canvas/[id]",
} as const satisfies Record<LiveKind, string>;

export type LiveScreen = (typeof LIVE_SCREENS)[LiveKind];

/** A live file's own screen: it always opens as it is now (its versions are the web's history). */
export const liveRoute = (kind: LiveKind, id: string): { pathname: LiveScreen; params: { id: string } } => ({
  pathname: LIVE_SCREENS[kind],
  params: { id },
});

/** Who is in a live file, and following one of them (`here/[id]`). */
export const hereRoute = (id: string) => ({ pathname: "/here/[id]" as const, params: { id } });

/** The kinds "Novo" makes, in its order (ADR 0194 §9). */
export const LIVE_KINDS_MADE: readonly LiveKind[] = ["spreadsheet", "slides", "canvas"];

/** Each kind's line icon (the Drive, cards, New) and its SF Symbol (bar buttons and menus on iOS). */
export const LIVE_ICON: Record<LiveKind, IconName> = { spreadsheet: "spreadsheet", slides: "slides", canvas: "canvas" };
export const LIVE_SF: Record<LiveKind, SFSymbolName> = {
  spreadsheet: "tablecells",
  slides: "rectangle.on.rectangle",
  canvas: "square.on.circle",
};

/** The editors' tools, as line icons with their SF Symbols (the slides and canvas screens' bars and menus). */
export const LIVE_TOOL_SF = {
  frame: "rectangle.dashed",
  note: "note.text",
  shape: "square.on.circle",
  textTool: "textformat",
  follow: "location.north.line",
  present: "play.rectangle",
  redo: "arrow.uturn.forward",
  paste: "doc.on.clipboard",
} as const satisfies Partial<Record<IconName, SFSymbolName>>;
