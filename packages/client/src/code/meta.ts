/** A code session's root message (ADR 0213, `meta.codeSession`): which session its thread is. */
export interface CodeSessionRoot {
  sessionId: string;
  repo: string;
  title: string;
}

/** The session a thread's root stands for, if it is a code session's (its conversation shows it, not the root). */
export function codeSessionOf(meta: unknown): CodeSessionRoot | null {
  if (!meta || typeof meta !== "object") return null;
  const c = (meta as { codeSession?: unknown }).codeSession;
  if (!c || typeof c !== "object") return null;
  const { sessionId, repo, title } = c as Record<string, unknown>;
  return typeof sessionId === "string" && typeof repo === "string" && typeof title === "string"
    ? { sessionId, repo, title }
    : null;
}
