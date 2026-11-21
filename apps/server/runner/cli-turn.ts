import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { BRAINS, type ComputerBrainKind } from "@agenteschat/providers/brains";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  type AccountGrant,
  accountSignIn,
} from "./accounts";
import { RunnerError } from "./errors";
import { resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/*
 * What every CLI brain's turn starts with on this computer (ADR 0215 §2), written once: the computer's switch for its
 * program, the request's ids, the folder it works in, the agent's secrets, the options its process starts with and
 * the file its sessions are kept in. Each brain's own file keeps only what is its own: its account, how its CLI starts
 * and how its events read.
 */

/** A run's or a session's id, which the runner names files and processes after. */
const TURN_ID = /^[a-zA-Z0-9-]{8,64}$/;

/** The computer's switch for the brain's program is on, else the runner refuses the turn. */
export function requireBrainSwitch(kind: ComputerBrainKind, on: boolean) {
  if (on) return;
  // Codex follows the runner's commands switch (a runner paired with `--no-exec`).
  if (kind === "codex")
    throw new RunnerError(
      "exec_disabled",
      "Commands are turned off on this computer (the runner was paired with --no-exec)",
    );
  throw new RunnerError("not_allowed", `${BRAINS[kind].name} is turned off on this computer`);
}

/** The request's agent and ids, checked: an agent's turn, with its run's and session's ids and its bridge's token. */
export function turnIds<
  R extends { agent?: unknown; runId?: unknown; session?: { id?: unknown } | null; mcp?: { token?: unknown } | null },
>(req: R) {
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !TURN_ID.test(req.runId))
    throw new RunnerError("bad_request", "runId is invalid");
  const sessionId = req.session?.id;
  if (typeof sessionId !== "string" || !TURN_ID.test(sessionId))
    throw new RunnerError("bad_request", "session.id is invalid");
  const token = req.mcp?.token;
  if (typeof token !== "string" || !token) throw new RunnerError("bad_request", "mcp.token is required");
  return { agent: req.agent as NonNullable<R["agent"]>, runId: req.runId, sessionId, token };
}

/**
 * The folder a `chat` turn starts in: one per agent under the runner home (Cursor finds a chat again by its folder),
 * emptied on every turn, so no project config, rules or instructions are there to read.
 */
export function chatFolder(runnerHome: string, agentId: string): string {
  const dir = path.join(runnerHome, "brain", "chat", agentId.replace(/[^\w-]/g, "_"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { recursive: true, force: true });
  return dir;
}

/**
 * Where the turn works: a `chat` turn (protocol 41) in a folder of its own whatever the request names (`chatIn`: an
 * empty one, or the agent's own for a CLI that keeps its config there), with no grants nor secrets; any other turn in
 * the agent's folder, or the folder the request names in it or in one granted to it (a checkout, a code session's
 * worktree). `base`: the folder the turn belongs to (the chat's, else the agent's).
 */
export async function turnFolder(
  ctx: { folder: string; runnerHome: string; grants?: string[] },
  req: { permissions?: { mode?: unknown } | null; cwd?: unknown },
  agentId: string,
  chatIn: "empty" | "own" = "empty",
): Promise<{ chat: boolean; base: string; cwd: string }> {
  const chat = req.permissions?.mode === "chat";
  const base = chat && chatIn === "empty" ? chatFolder(ctx.runnerHome, agentId) : ctx.folder;
  if (chat || typeof req.cwd !== "string" || req.cwd.trim() === "") return { chat, base, cwd: base };
  const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd);
  if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
  return { chat, base, cwd: resolved.abs };
}

/** The agent's secrets for the turn's environment; none for a `chat` turn. */
export const turnSecrets = (
  secretsDir: string | undefined,
  agent: Parameters<typeof agentSecrets>[1],
  chat: boolean,
) => (chat ? Promise.resolve(null) : agentSecrets(secretsDir, agent));

type Secrets = Awaited<ReturnType<typeof agentSecrets>>;

/**
 * The options every CLI's process starts with: where its events go, its stop, the runner home, our bridge, the
 * agent's secrets in its environment and masked in what it prints (`hold`: also while a value arrives in pieces), the
 * program and how it is spawned.
 */
export function turnRunOptions<E>(
  ctx: { runnerHome: string; mcp?: { socketPath: string; command: string[] }; bin?: string; spawn?: Spawn },
  scope: { signal: AbortSignal; emit: (event: E) => void },
  secrets: Secrets,
  options: { hold?: boolean } = {},
) {
  return {
    emit: scope.emit,
    signal: scope.signal,
    runnerHome: ctx.runnerHome,
    ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
    ...(secrets
      ? { env: secrets.env, redact: secrets.redact, ...(options.hold === false ? {} : { redactHold: secrets.hold }) }
      : {}),
    ...(ctx.bin ? { bin: ctx.bin } : {}),
    ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
  };
}

/** The file-backed store of a CLI's sessions, one per file in this process; a test hands its own. */
export function sessionStore<T>(stores: Map<string, T>, file: string, given: T | undefined, make: (file: string) => T) {
  const store = given ?? stores.get(file) ?? make(file);
  stores.set(file, store);
  return store;
}

/** What every CLI's turn takes from the request: its ids, where it works, its model and its words. */
export function turnInput(
  req: { model?: unknown; system?: unknown; prompt?: unknown },
  ids: { runId: string; sessionId: string },
  cwd: string,
  chat: boolean,
) {
  return {
    runId: ids.runId,
    sessionId: ids.sessionId,
    cwd,
    ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
    system: typeof req.system === "string" ? req.system : "",
    prompt: typeof req.prompt === "string" ? req.prompt : "",
    ...(chat ? { chat } : {}),
  };
}

/** Our bridge for the turn: the run's token, and the server's address when it reaches the CLI over the network. */
export const turnBridge = (token: string, req: { mcp?: { url?: unknown } | null }) => ({
  token,
  ...(typeof req.mcp?.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}),
});

/**
 * The turn's sign-in for a CLI that thinks only with an account of the agent's (ADR 0041): its folder (handed by root
 * in a worker, protocol 67), or nothing once the turn ended with what went wrong (signed out, gone, or not handed).
 */
export async function turnSignIn(
  ctx: { accounts?: AccountFolders; grant?: AccountGrant },
  kind: "grok" | "antigravity",
  accountId: string,
  scope: { emit: (event: { type: "error"; code: string; message: string; retryable: boolean }) => void },
): Promise<{ home: string; release?: () => void } | null> {
  let signIn: Awaited<ReturnType<typeof accountSignIn>>;
  try {
    signIn = await accountSignIn(ctx.accounts, kind, accountId, ctx.grant);
  } catch (err) {
    scope.emit({
      type: "error",
      code: `${kind}_failed`,
      message: `This computer couldn't hand the agent its ${BRAINS[kind].plan} sign-in (${(err as Error).message}). Try again.`,
      retryable: true,
    });
    return null;
  }
  if (signIn === "signed_out") {
    scope.emit({ type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true });
    return null;
  }
  if (signIn === "missing") {
    scope.emit({ type: "error", code: "account_missing", message: ACCOUNT_MISSING_MESSAGE[kind], retryable: false });
    return null;
  }
  return signIn;
}
