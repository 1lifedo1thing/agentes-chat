/**
 * What a canvas shows when the person comes back to it (ADR 0195): the pictures just asked for on the "Gerar" screen,
 * whose placeholders the server puts on the canvas. A route can't carry them back, so they wait here by file until the
 * canvas finds them among its shapes.
 */
const waiting = new Map<string, readonly string[]>();

/** The shapes to bring into view next time the canvas `fileId` shows (a request's placeholders, or its frame). */
export function revealLater(fileId: string, shapeIds: readonly string[]) {
  if (shapeIds.length > 0) waiting.set(fileId, shapeIds);
}

/** The shapes waiting to be shown on `fileId`'s canvas, if any (they stay until `revealed`). */
export const toReveal = (fileId: string): readonly string[] | null => waiting.get(fileId) ?? null;

export function revealed(fileId: string) {
  waiting.delete(fileId);
}
