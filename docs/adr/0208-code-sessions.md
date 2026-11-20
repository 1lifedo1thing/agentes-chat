# 0208. Code sessions: a request in its own worktree, on the Code page

- Status: Proposed (being built)
- Date: 2026-11-20
- Extends: 0025 (connected computers), 0032 (computer brains), 0044 (a mission's worktree), 0058 and 0065 (the agent's
  desktop and terminal), 0042 (phones), 0145 (a task's conversation is a thread of its own), 0156 (the GitHub App)
- Code: db `packages/db/src/schema/code.ts` (`code_sessions`), migration `0309_code_sessions.sql` (`channel_kind`
  gains `code`); engine `packages/engine/src/code-sessions.ts` (`createCodeSession`, `prepareCodeSession`,
  `ensureCodeSessionsOn`, `codeAgentSql`, `codeSessionCwd`, `codeSessionBrief`, `admitCodeMembers`,
  `codeSessionDiff`, `codeSessionGit`, `codeSessionGitLog`, `codeSessionFiles`, `codeSessionFile`,
  `recordCodeSessionPr`, `codeStartOptions`), `messages.ts` (the session's agent
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
is named there with `@` (`admitCodeMembers`); agents named there join it too. Its faces stand in the header: whoever
opened it, or an admin, takes someone out, anyone else leaves (`removeChannelMember`, which lets a code session be
left and always keeps its own agent and whoever opened it).

A session may also start with no repository: a name with no owner (`hello-world`) is a project only on the agent's
computer, `projects/<name>` in its folder, made with `git init` on first use (or adopted with its files in a first
commit when the folder is there). Its session has the same worktree, diff and terminal; with no remote, its git button
offers Commit and Merge (into the project's base branch, on the computer), never Push or a pull request. A clone that
fails for want of GitHub access is said in the person's words with that way out (`errorCode: github_access`).

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
there (`codeSessionBrief`): among it, that its screen is the session's preview, so what can be looked at it serves on
localhost and opens in its browser itself, looks at and fixes before saying it's done (the browser opens only http
and https), never asking the person to open it. Where the repository has no name for commits, the agent's goes in its
config once the worktree is made (`ensureGitIdentity`): the CLI commits with plain `git commit`.

### 4. The page: a list, a home in the agents' sky, and a session

- **List**: the sessions I take part in, grouped by repository, with their state in words (`preparing`, `working`,
  `waiting for you`, `ready`, the PR) and the change's size.
- **Home**: the field in the middle of the agents' fine sky (the agent page's cover sky), the agents that program
  standing on its horizon saying what they do. Writing and Enter opens a session with the picked agent and repository
  (the last ones used come back); the computer is the agent's own, so there is nothing else to pick.
- **Session**: the conversation under its header (name, state and branch, who is in it, the git button, only when
  there is a next step and the agent is free to take it), with the agent's model (the DM's picker, changed in place)
  and its plan's limits under the composer like a coding CLI's status line, and a side panel with the kit's tabs, Git,
  Files and Screen, and a Terminal under any of them. The list, the conversation and the terminal's height drag, each
  kept on the device, and a session squeezed
  by the window folds the app's sidebar to its rail until the room comes back (`usePageRoom`, as beside a live file's
  conversation):
  - **Git**: read with `git` in the worktree as its agent (the runner's `exec`, read-only commands), again every few
    seconds while it works (`codeSessionGitLog`): the branch and what it came from, the whole change since the base
    (committed or not, new files included), what isn't committed as `git status` letters it (with its lines), and the
    branch's commits since the base as a line of nodes. Any row opens its diff in place (an uncommitted file's, a
    commit's `git show`, everything's), unified or side by side from the diff's own head. The sky rises behind it from
    the panel's foot, with the agent standing on it.
  - **Files**: the worktree's tree, the files git tracks and the new ones it doesn't ignore (`ls-files -co
    --exclude-standard`), changed ones marked with the Git tab's letters and their folders open at first, and a search
    by path. A file opens in place, read-only, with line numbers and the shared highlighter's colors
    (`codeSessionFile`): never one git ignores, a `.env` one or one reached through a link out of the worktree (each
    step resolved on the computer), only its first 512 KB, and a binary one only said to be one.
  - **Screen**: the agent's computer as its computer dialog shows it (live, "Take control", full screen; a Mac's
    browser page). The worktree's server runs there on a port only that agent reaches (0096), so its screen is the
    preview. It stands in the agents' fine sky; where the person may use phones (0042), a picker offers them. The
    conversation's browser and desktop cards are one line there ("See on Screen", `ScreenPanelContext`), and the panel
    turns to the screen once as the agent starts using it.
  - **Terminal**: a drawer at the panel's foot, under the diff or the screen, opened and closed by its switch beside
    the tabs: a shell on the agent's computer opened in the worktree (the terminal of 0058 §6, with a folder), for
    running a script; the AI doesn't run there. Where the computer's terminal is off, it offers the app's way to turn it
    on (`ToolOffWayOut`: whoever paired it turns it on there, anyone else asks them). Only who may drive that computer opens it, and a server that screens
    sessions keeps terminals off. The stream takes a `cwd` (`TERMINAL_CWD_PROTOCOL`, 74) that the server sets from the
    session (`/api/terminal?…&session=`, checked with `requireCodeSession`) and the runner resolves inside the agent's
    folder; an older runner opens the shell in the agent's folder and the pane says so (`cwd_ignored`). The pane is
    xterm (keystrokes as binary frames, `resize` as text) and lives on while another tab shows.

### 5. Git through the agent, so any host and flow works

The header's git button is labeled with the next step read from the worktree (`codeSessionGit`: uncommitted changes →
Commit; commits not pushed → Push; pushed and on GitHub → Open PR; a PR → Merge); its menu has the others. Each step
asks the session's agent in words in the conversation: it commits, pushes or opens the pull request with the tools it
already has, on any host. Merging stays an approval (`merge` is always sensitive). With CI on GitHub, a failing check
on the session's branch comes back to the agent as a notice in the session, so it reads the log and fixes it.

### 6. Claude Code's own subagents and skills, and the repository's

A session's turn tells the runner it is one (`codeSession` on `brain.turn`): on the agent's own Claude Code (not a
shared sign-in, not the owner's MCP servers, which already keep everything) the turn also gets `Agent` (its
subagents, with the turn's tools and permission mode), `Task` (its name before 2.1.63) and `Skill`. The worktree's
`.claude/agents`, `.claude/skills` and `.claude/commands` load as a plugin (`--plugin-dir`, `repoPlugin`): copied
into the turn's folder as regular files only, never through a link, each Markdown file without the frontmatter keys
that would act outside the turn's checks (`hooks`, `mcpServers`, `permissionMode`, `allowed-tools`), and nothing
else of the checkout's `.claude/`, so its settings (hooks, allow rules, env) stay unread as ADR 0117 wants. Only on a
Claude Code the runner knows takes the plugin (2.1.63 or newer, `REPO_PLUGIN_MIN_CLAUDE`).

Files and pictures stay in the session's panel: `upload_file` and `export_file` aren't given to a computer brain in
a session (`CODE_SESSION_HIDDEN_TOOLS`), and its brief says not to paste screenshots.

### 7. The brain's own tool calls, one line each

In a code session each call the CLI makes on its own (read, search, edit, write, run, fetch) is one line of the run's
work, as in a terminal: a `context` step `cliTool` (`packages/engine/src/cli-tools.ts`: verb, target relative to the
worktree, counts such as lines added and removed or tests passed, an output excerpt masked), written when the call
ends. A `context` row keeps them out of every Tool Gateway reader (cost brakes, outbound checks, other runs' context,
continuation). Live, `agent.step` carries the line at its start (the runner now sends the input with `tool_started`)
and at its end (`ended`, `failed`); `meta.work.cliCalls` counts them and they show with the work summary off, in a
block closed like every other (the diff and the screen say what changed). Elsewhere they stay off the trail (ADR 0032
addendum: a row per call on every turn of every chat is not worth its writes).

### 8. A failing check comes back to the agent

The GitHub App subscribes `check_run`. A check that completes failed, timed out or waiting on an action, on an
`agentes/` branch, becomes a `github_check` notice in the open session on that branch (its thread, from its agent,
waking it with trigger `dm`): which check, on which PR or commit, the link and the check's own output as outside text.
It asks the agent to read the log, fix it in the worktree, run what failed, push again and say what it changed, or to
say so when the change didn't cause it. Once per session, commit and check name. The session keeps the pull request
opened from its branch (`open_pull_request`, and `pull_request` opened or merged).

### 9. Notifications

A message in a session notifies as in a channel thread, named by the session (`label`) and with `codeSessionId`, so
the apps open it on the Code page.

## Consequences

- No new runner op for the worktree or the diff: the session reuses `mission.worktree` and `exec`. The terminal's
  folder needs a newer runner (protocol 74); an older one opens the shell in the agent's folder and says so. Claude
  Code's subagents and the repository's skills need a runner that reads `codeSession`; an older one runs the turn as
  before.
- Apps registered before this need "Check run" ticked on GitHub; until then no check comes back (Settings says so).
- A branch that keeps failing wakes the agent at each push that fails again, within its budgets; no other cap yet.
- Sessions need an agent whose brain is Claude Code or Codex on a computer with git access to the repository.
- The conversation is a thread like a task's: the phone app shows it with its thread screen through the notification's
  channel and thread until it has a Code screen of its own.
- Out of this first version: several agents writing in one session at once (one writes, the others read and review),
  a lead agent splitting work into child worktrees, line comments on the diff sent together, and a diff per turn with
  undo.
