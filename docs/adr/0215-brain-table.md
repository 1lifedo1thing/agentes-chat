# 0215. The brains' table: every computer brain once, with what it can do

- Status: Accepted (step 1 built; steps 2 to 5 planned)
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

### 2. One turn pipeline in the runner (planned)

Each CLI keeps a driver with only what is its own: how it starts, how its events read, how it takes a message
mid-turn. The checks, the folder, the account, the secrets, the session file and where a mid-turn message goes are
written once, instead of in each brain's handler.

### 3. One engine for ACP agents (planned)

The Agent Client Protocol client that drives OpenCode becomes a generic driver; Grok and Antigravity move onto it,
gaining live events and, where the CLI allows, messages mid-turn, and any further ACP agent is a row in the table.

### 4. One computer-brain adapter in the engine (planned)

Claude Code's adapter and the one Codex shares with the other CLIs become one, led by the table, with optional hooks
(starting the CLI ahead, a model the plan refuses).

### 5. The API in a code session (planned)

An agent that thinks through the API works in the session's worktree with code tools of our own (read, edit, search,
run) through the runner, under the same approvals, so a session takes any model.

## Consequences

- A new computer brain is a row in the table and a driver; no list elsewhere names the kinds.
- Code sessions and their suggestion in the chat (0214 §11) work with every computer brain.
- Steps 2 to 4 change the path every turn of a computer brain takes, in the chat as well: they keep its behavior and
  go in a change of their own, checked in the chat on a real computer before it lands.
