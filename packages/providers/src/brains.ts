/**
 * The computer brains (ADR 0215): the coding CLIs an agent can think with on its computer, each listed once with what
 * people call it, the plan it thinks with, its program on the computer, where it runs and what it can do. Pure data,
 * read by the engine, the runner and the apps (`@agenteschat/client/lib/brains`): a brain is added here and in its
 * driver, never in a list of kinds somewhere else. A capability is what the brain does on an up-to-date runner; an
 * older runner, or an older CLI, still answers for itself (a turn that can't take a message mid-turn says so).
 */

/** Every computer brain, in the order the apps list them. */
export const COMPUTER_BRAIN_KINDS = ["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"] as const;
export type ComputerBrainKind = (typeof COMPUTER_BRAIN_KINDS)[number];

/** An agent's brain: the workspace's models through the API (`model`), or a CLI on its computer. */
export type BrainKind = "model" | ComputerBrainKind;
export const BRAIN_KINDS: readonly BrainKind[] = ["model", ...COMPUTER_BRAIN_KINDS];

/** A brain's program on the computer: the runner's `hello.executors` key and the computer's switch for it. */
export type BrainExecutor = "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";

/** What a computer brain can do, read wherever the answer depends on the brain (never its kind). */
export interface BrainCaps {
  /** Works in the folder its turn names, such as a code session's worktree (ADR 0214). */
  folder: boolean;
  /** Reads a person's message mid-turn (`live`), or only once the turn ended (`between_turns`). */
  steer: "live" | "between_turns";
  /** Each call of its own tools can reach our approval prompt; otherwise an always-asking agent's turn only plans. */
  asksEachCall: boolean;
  /** Its shell reaches folders outside the turn's workspace, such as a computer's shared folders. */
  outsideFolders: boolean;
  /** Picks who answers a message nobody mentioned, with a person's own plan (`brain.route`, ADR 0074). */
  routes: boolean;
}

export interface BrainSpec {
  kind: ComputerBrainKind;
  /** What people call its CLI, in messages. */
  name: string;
  /** The plan it thinks with, as people buy it. */
  plan: string;
  executor: BrainExecutor;
  /** Runs on Windows computers (a CLI keeping its sign-in in the computer user's one credential store doesn't yet). */
  windows: boolean;
  /** Its shell runs in a sandbox of the CLI's own (ADR 0053 §3, 0114, 0142, 0143), the limit of what its turns do. */
  sandboxed: boolean;
  caps: BrainCaps;
}

export const BRAINS: Readonly<Record<ComputerBrainKind, BrainSpec>> = {
  claude_code: {
    kind: "claude_code",
    name: "Claude Code",
    plan: "Claude",
    executor: "claude",
    windows: true,
    sandboxed: false,
    caps: { folder: true, steer: "live", asksEachCall: true, outsideFolders: true, routes: true },
  },
  codex: {
    kind: "codex",
    name: "Codex",
    plan: "ChatGPT",
    executor: "codex",
    windows: true,
    sandboxed: true,
    // Live on its app-server; a turn run by `codex exec` reads messages between turns.
    caps: { folder: true, steer: "live", asksEachCall: false, outsideFolders: true, routes: true },
  },
  cursor: {
    kind: "cursor",
    name: "Cursor",
    plan: "Cursor",
    executor: "cursor",
    windows: false,
    sandboxed: true,
    caps: { folder: true, steer: "between_turns", asksEachCall: false, outsideFolders: false, routes: false },
  },
  opencode: {
    kind: "opencode",
    name: "OpenCode",
    plan: "OpenCode",
    executor: "opencode",
    windows: true,
    sandboxed: false,
    // Live from OpenCode 2; its permissions keep the shell in the turn's workspace (ADR 0132).
    caps: { folder: true, steer: "live", asksEachCall: false, outsideFolders: false, routes: false },
  },
  grok: {
    kind: "grok",
    name: "Grok Build",
    plan: "Grok",
    executor: "grok",
    windows: false,
    sandboxed: true,
    caps: { folder: true, steer: "between_turns", asksEachCall: false, outsideFolders: false, routes: false },
  },
  antigravity: {
    kind: "antigravity",
    name: "Antigravity CLI",
    plan: "Gemini",
    executor: "antigravity",
    windows: false,
    sandboxed: true,
    caps: { folder: true, steer: "between_turns", asksEachCall: false, outsideFolders: false, routes: false },
  },
};

export const isComputerBrain = (v: unknown): v is ComputerBrainKind =>
  typeof v === "string" && Object.hasOwn(BRAINS, v);

export const isBrainKind = (v: unknown): v is BrainKind => v === "model" || isComputerBrain(v);

type Flag = { [K in keyof BrainCaps]: BrainCaps[K] extends boolean ? K : never }[keyof BrainCaps];

/** The computer brains that can (`cap`), in the apps' order. */
export const brainsWith = (cap: Flag): ComputerBrainKind[] => COMPUTER_BRAIN_KINDS.filter((k) => BRAINS[k].caps[cap]);

/** Whether `brain` (an agent's, any string) is a computer brain that can (`cap`). */
export const brainCan = (brain: unknown, cap: Flag): boolean => isComputerBrain(brain) && BRAINS[brain].caps[cap];

/** Every brain's program, in the apps' order. */
export const BRAIN_EXECUTORS: readonly BrainExecutor[] = COMPUTER_BRAIN_KINDS.map((k) => BRAINS[k].executor);

/** The brain a program runs. */
export const brainOfExecutor = (executor: BrainExecutor): ComputerBrainKind =>
  COMPUTER_BRAIN_KINDS.find((k) => BRAINS[k].executor === executor) as ComputerBrainKind;
