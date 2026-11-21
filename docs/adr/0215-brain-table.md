# 0215. The brains' table: every computer brain once, with what it can do

- Status: Accepted (steps 1, 2 and 5 built; steps 3 and 4 planned)
- Date: 2026-11-21
- Extends: 0032 (computer brains), 0114 (Cursor), 0132 (OpenCode), 0142 (Grok), 0143 (Antigravity), 0214 (code
  sessions)
- Code: `packages/providers/src/brains.ts` (`@agenteschat/providers/brains`: `BRAINS`, `BrainCaps`,
  `COMPUTER_BRAIN_KINDS`, `isComputerBrain`, `brainsWith`, `brainCan`); read by the engine
  (`packages/engine/src/brains/types.ts`, which derives `BRAIN_NAMES`, `BRAIN_PLAN_NAMES`, `brainRunsOn` and
  `isSandboxedBrain` from it), the runner (`apps/server/runner/handlers.ts`) and the apps
  (`@agenteschat/client/lib/brains`)

## Context

An agent thinks with the workspace's models through the API or with a coding CLI on its computer: Claude Code, Codex,
Cursor, OpenCode, Grok Build or the Antigravity CLI. Each was added in its own ADR, and each addition wrote its kind
into every list that names the brains: about 45 files across the engine, the runner and the apps, with what a brain can
do spread among them (`brainRunsOn`, `isSandboxedBrain`, the runner's maps of who takes a message mid-turn, an ad hoc
list of who picks who answers, who reaches a shared folder). Code sessions (0214) inherited the habit: a list of two
brains, `["claude_code", "codex"]`, kept the other four out although their turns open in the folder the turn names
through the same path as Codex's.

The rule we want: the product speaks to one contract, every brain declares what it can do, and a decision reads the
capability, never the kind.

## Decision

### 1. One table (built)

`@agenteschat/providers/brains` lists every computer brain once (pure data, importable by the engine, the runner and the
apps): its kind, what people call it, the plan it thinks with, its program on the computer (`hello.executors`, the
computer's switch), whether it runs on Windows, whether its shell has a sandbox of its own, and its capabilities:

- `folder`: works in the folder its turn names, such as a code session's worktree;
- `steer`: reads a person's message mid-turn (`live`) or only between turns;
- `asksEachCall`: each call of its own tools can reach our approval prompt (else an always-asking agent's turn plans);
- `outsideFolders`: its shell reaches folders outside the turn's workspace (a computer's shared folders);
- `routes`: picks who answers a message nobody mentioned with a person's plan (`brain.route`, 0074).

A capability is what the brain does on an up-to-date runner; an older runner or CLI still answers for itself. Every
list of kinds and every rule above is read from the table, and a test keeps the wire's lists (`ACCOUNT_KINDS`,
`CLI_NAMES`) equal to it. A code session takes every brain with `folder`: all six.

### 2. One start for every CLI's turn in the runner (built)

Every CLI brain's turn starts in `apps/server/runner/cli-turn.ts`: the computer's switch for its program
(`requireBrainSwitch`), the request's ids (`turnIds`), the folder it works in (`turnFolder`: a chat turn's own, the
agent's, or the folder the turn names in it or in a granted one), the agent's secrets (`turnSecrets`), what the turn
takes from the request (`turnInput`, `turnBridge`), the options its process starts with (`turnRunOptions`), its session
file (`sessionStore`) and, for a CLI that thinks only with an account of the agent's, its sign-in (`turnSignIn`). Each
brain's file keeps only its account and how its CLI starts and reads; the handler hands each kind its turn through one
table (`CLI_TURNS`) with the same context for all. Where a mid-turn message goes reads `BrainCaps.steer`.

### 3. One engine for ACP agents (planned)

The Agent Client Protocol client that drives OpenCode becomes a generic driver; Grok and Antigravity move onto it,
gaining live events and, where the CLI allows, messages mid-turn, and any further ACP agent is a row in the table.

### 4. One computer-brain adapter in the engine (planned)

Claude Code's adapter and the one Codex shares with the other CLIs become one, led by the table, with optional hooks
(starting the CLI ahead, a model the plan refuses).

### 5. The API in a code session (built)

An agent that thinks through the API has a session when it has a computer and its code tools (`sandbox:run`, or
`run_code` alone, not denied) with the workspace's code environment on (`apiCodes`, `codeAgent`). In the session's
conversation those tools work in its worktree (`codeSessionCwd`, `createSandboxToolSource`): a relative path in
`read_file`, `write_file`, `edit_file` and `list_files` is inside it and never climbs out, and `run_code` runs there,
its script reached from it. `edit_file`, new for every agent with code tools, replaces an exact piece of a file (once,
or every place with `all`), so a change never rewrites the whole file. The session's brief says what fits the brain:
its own subagents where it has them (`BrainCaps.subagents`), these tools for the API. A session takes any model.

## Consequences

- A new computer brain is a row in the table and a driver; no list elsewhere names the kinds.
- Code sessions and their suggestion in the chat (0214 §11) work with every computer brain, and with the API where
  the agent's code tools are on.
- Step 2 changes the path every CLI turn takes, in the chat as well, keeping its behavior: each brain's runner tests
  pass unchanged. Steps 3 and 4 wait for each CLI's agent protocol to be checked on a real computer.
