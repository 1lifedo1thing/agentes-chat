/**
 * The tools a code session's conversation hides (ADR 0214), for every brain: the person sees the worktree's files and
 * the agent's screen in the session's panel, so nothing goes to the Drive or onto a reply from there, and suggesting
 * a session is for a conversation outside one (`code-suggestions.ts`). The gateway leaves them out of the tools of any
 * run whose tool context says it is in a session (`ToolContext.codeSession`): neither listed nor called. A module of its own, with no imports, so
 * the gateway reads it without pulling the session's module in.
 */
export const CODE_SESSION_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "upload_file",
  "export_file",
  "suggest_code_session",
]);
