/**
 * Code sessions (ADR 0208): a request worked on in its own git worktree on an agent's computer, with its own
 * conversation (a thread in a channel of kind `code`: `channelId` + `rootId`). The same shapes as the server's.
 */

export type CodeWorktreeState = "preparing" | "ready" | "failed" | "removed";

/** What a session is doing now, for the list: preparing, failed, a live run, waiting on me, or idle. */
export type CodeSessionWork = "preparing" | "failed" | "working" | "waiting" | "idle";

export interface CodeSession {
  id: string;
  /** Its conversation: post there with the chat's routes, with `rootId` as the thread. */
  channelId: string;
  rootId: string;
  title: string;
  /** `owner/name`. */
  repo: string;
  branch: string | null;
  baseBranch: string | null;
  agentId: string;
  machineId: string | null;
  worktree: { state: CodeWorktreeState; error: string | null };
  pr: { number: number; url: string | null } | null;
  /** The last known size of the change against the base (`at` null: never read). */
  stat: { files: number; added: number; removed: number; at: string | null };
  work: CodeSessionWork;
  createdBy: string | null;
  createdAt: string;
  lastAt: string;
}

/** Where a session can start: the agents that think on a computer, each with the repositories it may use. */
export interface CodeStartOptions {
  agents: { agentId: string; repos: string[]; any: boolean }[];
}

export interface CreateCodeSessionInput {
  agentId: string;
  repo: string;
  text: string;
}

export type CodeDiffScope = "base" | "uncommitted";

export interface CodeDiffFile {
  path: string;
  /** Its unified patch; empty when the whole diff was too large to send. */
  patch: string;
  added: number;
  removed: number;
  untracked?: boolean;
}

export interface CodeDiff {
  scope: CodeDiffScope;
  base: { branch: string | null; sha: string | null };
  files: CodeDiffFile[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** The step the header's git button offers next. */
export type CodeGitStep = "commit" | "push" | "pr" | "merge";

export interface CodeGit {
  uncommitted: number;
  ahead: number;
  upstream: boolean;
  pr: { number: number; url: string | null } | null;
  next: CodeGitStep | null;
}
