# 0208. Code sessions: a request in its own worktree, on the Code page

- Status: Proposed (being built)
- Date: 2026-11-20
- Extends: 0025 (connected computers), 0032 (computer brains), 0044 (a mission's worktree), 0058 and 0065 (the agent's
  desktop and terminal), 0042 (phones), 0145 (a task's conversation is a thread of its own), 0156 (the GitHub App)
- Code: db `packages/db/src/schema/code.ts` (`code_sessions`), migration `0309_code_sessions.sql` (`channel_kind`
  gains `code`); engine `packages/engine/src/code-sessions.ts` (`createCodeSession`, `prepareCodeSession`,
  `ensureCodeSessionsOn`, `codeAgentSql`, `codeSessionCwd`, `codeSessionBrief`, `admitCodeMembers`,
  `codeSessionDiff`, `codeSessionGit`, `recordCodeSessionPr`, `codeStartOptions`), `messages.ts` (the session's agent
  answers like a DM; who is named joins), `jobs.ts` (never routed), `brains/select.ts` (the worktree as the brain's
  folder), `context.ts` (the session's brief), `notification-producers.ts` (`codeSessionId`); server
  `apps/server/src/routes/app/code-sessions.ts`, `engine.ts` (the computer-online hook); client
  `packages/client/src/code/*`; web `apps/web/src/components/code/*`, routes `org.$orgId.code.index.tsx` and
  `org.$orgId.code.$sessionId.tsx`, the sidebar tool `code`

## Context

People who program with agents work today in a tool of their own beside the chat: one terminal or window per task,
each in its own git worktree, the diff and the running app beside the conversation with the coding CLI. agentes.chat
already has every hard part of that: computers connected to the workspace with an OS user per agent (0025, 0057), the
agents' brains being Claude Code or Codex on them (0032), a mission's own worktree and branch (0044), the agent's
screen live with take-over (0058, 0065), phones the agents use (0042), PRs and approvals (0156). What is missing is a
place that puts them together around one request, and is as simple as typing into the CLI.

The page must work for any stack and any git flow: not only web projects, not only GitHub with pull requests and CI.

## Decision

### 1. A session is a request in its own worktree, with its own conversation

`code_sessions` holds the request's repository (`owner/name`), the agent, its computer, the branch
(`agentes/<handle>/<slug>-<4 hex>`: under the agent's own prefix, the only new branches the git proxy lets it push),
the base it started from, the worktree's folder (`.worktrees/c-<short id>` in the agent's folder) and its state
(`preparing`, `ready`, `failed`, `removed`).

Its conversation follows the task's model (0145): a channel of kind `code` (private, never listed) with one root
message (`meta.codeSession`), and the session is that thread's replies, so runs, steering, stop, approvals, live
events, receipts and the thread screen work unchanged. People are members of the channel: who opened it, and whoever
is named there with `@` (`admitCodeMembers`); agents named there join it too.

### 2. Its agent answers like in a DM, once its worktree is ready

What names nobody in the session goes to the session's agent (`codeAgentSql` in the `task_agent` step of
`insertMessageWithRuns`, `meta.forTask`), never to the router (`jobs.ts`). Before the worktree is ready nothing runs:
the request waits, and `prepareCodeSession` hands the newest person's message to the agent as one run once it is.

### 3. The worktree is the mission's, made for any request

`prepareCodeSession` clones or updates the repository's checkout through the git proxy (`git.sync`, `cloneOnMachine`)
and makes the worktree with the runner's `mission.worktree` op (0044: `.env` files copied, `info/exclude`), on the
agent's computer. Offline, paused or an older runner: it stays `preparing` and `ensureCodeSessionsOn` tries again when
the computer is back. The project's install is not run by the server: the agent's first turn is told the runner's
setup command (from the lockfile) and runs it like a person would.

A run in the session gets the worktree as its folder (`codeSessionCwd`, read by `resolveBrain`; the pre-turn checkout
sync of chat turns then doesn't apply) and a brief naming the repository, branch, base and folder, and how to work
there (`codeSessionBrief`).

### 4. The page: a list, a home in the agents' sky, and a session

- **List**: the sessions I take part in, grouped by repository, with their state in words (`preparing`, `working`,
  `waiting for you`, `ready`, the PR) and the change's size.
- **Home**: the field in the middle of the agents' fine sky (the agent page's cover sky), the agents that program
  standing on its horizon saying what they do. Writing and Enter opens a session with the picked agent and repository
  (the last ones used come back); the computer is the agent's own, so there is nothing else to pick.
- **Session**: its header (name, branch and state, the git button), the conversation, and a side panel whose sky
  rises from its foot behind what it shows, with the agent standing on it:
  - **Diff**: read with `git` in the worktree as its agent (the runner's `exec`, read-only commands): since the base
    (committed or not, new files included) or only what isn't committed.
  - **Screen**: the agent's computer as its computer dialog shows it (live, "Take control", full screen; a Mac's
    browser page). The worktree's server runs there on a port only that agent reaches (0096), so its screen is the
    preview. A menu also offers the phones the person may use (0042).
  - **Terminal**: a shell on the agent's computer opened in the worktree (the terminal of 0058 §6, with a folder), for
    running a script; the AI doesn't run there. Only who may drive that computer opens it, and a server that screens
    sessions keeps terminals off.

### 5. Git through the agent, so any host and flow works

The header's git button is labeled with the next step read from the worktree (`codeSessionGit`: uncommitted changes →
Commit; commits not pushed → Push; pushed and on GitHub → Open PR; a PR → Merge); its menu has the others. Each step
asks the session's agent in words in the conversation: it commits, pushes or opens the pull request with the tools it
already has, on any host. Merging stays an approval (`merge` is always sensitive). With CI on GitHub, a failing check
on the session's branch comes back to the agent as a notice in the session, so it reads the log and fixes it.

### 6. Notifications

A message in a session notifies as in a channel thread, named by the session (`label`) and with `codeSessionId`, so
the apps open it on the Code page.

## Consequences

- No new runner op for the worktree or the diff: the session reuses `mission.worktree` and `exec`. The terminal's
  folder needs a newer runner; an older one opens the shell in the agent's folder.
- Sessions need an agent whose brain is Claude Code or Codex on a computer with git access to the repository.
- The conversation is a thread like a task's: the phone app shows it with its thread screen through the notification's
  channel and thread until it has a Code screen of its own.
- Out of this first version: several agents writing in one session at once (one writes, the others read and review),
  a lead agent splitting work into child worktrees, line comments on the diff sent together, and a diff per turn with
  undo.
