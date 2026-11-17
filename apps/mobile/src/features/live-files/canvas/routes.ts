/**
 * "Gerar" on the phone (ADR 0195): its own pushed screen, with the canvas's chosen pictures to start from (`refs`) and
 * where on the canvas (world units) the person was looking (`x`, `y`), where the new pictures go.
 */
export const generateRoute = (id: string, from: { refs?: readonly string[]; at?: { x: number; y: number } } = {}) => ({
  pathname: "/generate/[id]" as const,
  params: {
    id,
    ...(from.refs && from.refs.length > 0 ? { refs: from.refs.join(",") } : {}),
    ...(from.at ? { x: String(Math.round(from.at.x)), y: String(Math.round(from.at.y)) } : {}),
  },
});

/** The picture ids a route's `refs` carries (safe ids only, at most four). */
export function refsOf(raw: string | string[] | undefined): string[] {
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s))
    .slice(0, 4);
}

/** A world point a route carries, or null. */
export function pointOf(x: string | string[] | undefined, y: string | string[] | undefined) {
  const nx = Number(Array.isArray(x) ? x[0] : x);
  const ny = Number(Array.isArray(y) ? y[0] : y);
  return x !== undefined && y !== undefined && Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
}
