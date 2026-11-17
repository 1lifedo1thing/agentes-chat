import type { Artifact, LiveRoom } from "@agenteschat/client";
import type { Peer } from "@agenteschat/live/awareness";

/**
 * What the live file page hands every editor (ADR 0194): the spreadsheet, the presentation and the canvas each get
 * these props from `LiveFilePage` and draw everything below the page's header.
 */
export interface LiveEditorProps {
  /** The file's document, presence, undo and connection. */
  room: LiveRoom;
  orgId: string;
  /** The file as the Drive knows it: title, where it lives, who sees it. */
  artifact: Artifact;
  /** Nothing can be changed (the file is in the trash, its workspace is closing, or it is an older version). */
  readOnly: boolean;
  /** The person's language: formulas, number formats and dates are typed and shown in it. */
  locale: string;
  /** Where the page's address says to start (a sheet, a slide, presenting). */
  search: LiveEditorSearch;
  /** Keeps the address in step with the editor (replaces the history entry). */
  onSearch(patch: Partial<LiveEditorSearch>): void;
  /** The person this person follows: the editor moves its view along with theirs. Null: nobody. */
  following: Peer | null;
  /** The person moved the view themselves, or the one they follow left: stop following. */
  onStopFollowing(): void;
  /** What is selected now, for "Ask an agent" and the page's header. Null: nothing in particular (the whole file). */
  onSelection(selection: LiveSelection | null): void;
  /** Opens "Ask an agent" about what is selected (an editor's own menus offer it); absent: the page doesn't. */
  onAsk?(): void;
}

/** The page's address parameters an editor reads and writes. */
export interface LiveEditorSearch {
  /** A spreadsheet's sheet id. */
  sheet?: string;
  /** A presentation's slide id. */
  slide?: string;
  /** The presentation opens presenting. */
  present?: boolean;
}

/**
 * The selection as words and as data: the words go on "Ask an agent"'s context line ("Planilha 1!B2:E9", "Slide 3",
 * "2 imagens"), the data to the agent (`meta.liveRef.selection`).
 */
export interface LiveSelection {
  label: string;
  sheet?: string;
  range?: string;
  slide?: string;
  shapes?: string[];
}
