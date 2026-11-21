import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  codeStartOptions,
  createCodeSuggestionToolSource,
  drainOutbox,
  insertMessage,
  orgOverview,
  postPersonMessage,
  SUGGEST_CODE_SESSION_TOOL,
  type ToolContext,
  updateSandboxSettings,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { connectedComputer, type FakeRunnerOptions } from "./machine-fixtures";

/**
 * An agent that thinks through the API in a code session (ADR 0215 §5): it can have one when its code tools are on,
 * and in the session's conversation those tools work in the worktree.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WORKTREE = ".worktrees/c-1a2b3c4d";

/** Dev's session on acme/app, its worktree ready, with the owner and Dev in its conversation. */
async function session() {
  const [channel] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: "code-1a2b3c4d",
      kind: "code",
      visibility: "private",
      createdByUserId: f.owner.id,
    })
    .returning();
  const channelId = channel?.id ?? "";
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Code session",
  });
  await f.db.insert(schema.channelMembers).values([
    { orgId: f.org.id, channelId, userId: f.owner.id },
    { orgId: f.org.id, channelId, agentId: f.agent.id, autoReply: true },
  ]);
  await f.db.insert(schema.codeSessions).values({
    orgId: f.org.id,
    channelId,
    rootMessageId: root.id,
    agentId: f.agent.id,
    repo: "acme/app",
    repoDir: "repos/acme/app",
    title: "Fix the login",
    branch: "agentes/dev/fix-login-1a2b",
    worktreePath: WORKTREE,
    worktreeState: "ready",
    createdBy: f.owner.id,
  });
  return channelId;
}

/** A real run of Dev's (the gateway records its steps) over the owner's message in `channelId`. */
async function runIn(channelId: string): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
  };
}

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

describe("who can have a session", () => {
  test("an API agent with its code tools on a computer: Code offers it, it starts sessions and suggests them", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await connectedComputer(f);
    const ctx = { db: f.db, orgId: f.org.id, agentId: f.agent.id, runId: "r", background: false } as ToolContext;
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).code).toBe(true);
    expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents.map((a) => a.agentId)).toEqual([f.agent.id]);
    expect((await createCodeSuggestionToolSource().tools(ctx)).map((t) => t.name)).toEqual([SUGGEST_CODE_SESSION_TOOL]);

    // Its code tools denied: no session.
    await f.db.insert(schema.agentScopes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: null,
      scope: "deny:run_code",
    });
    expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents).toEqual([]);
    expect((await createCodeSuggestionToolSource().tools(ctx)).map((t) => t.name)).toEqual([]);
  });

  test("the workspace's code environment off: no session for an API agent", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await connectedComputer(f);
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { enabled: false });
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).code).toBe(false);
    expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents).toEqual([]);
  });
});

describe("its code tools in the session", () => {
  test("files are the worktree's, never above it; commands run there; outside the session nothing changes", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const execs: Parameters<NonNullable<FakeRunnerOptions["exec"]>>[0][] = [];
    const { runner } = await connectedComputer(f, {
      exec: (req) => {
        execs.push(req);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const inSession = await runIn(await session());

    expect(
      (await call(inSession, "write_file", { path: "src/login.ts", content: "const a = 1;\n" })).isError,
    ).toBeFalsy();
    expect(text(runner.files.get(`${WORKTREE}/src/login.ts`))).toBe("const a = 1;\n");
    expect((await call(inSession, "read_file", { path: "src/login.ts" })).content).toContain("const a = 1;");
    expect((await call(inSession, "write_file", { path: "../escape.ts", content: "x" })).isError).toBe(true);

    await call(inSession, "run_code", { language: "bash", code: "git status" });
    const ran = execs.at(-1);
    expect(ran?.cwd).toBe(WORKTREE);
    expect(ran?.command).toMatch(/^bash \.\.\/\.\.\/\.agentes\/run-\d+\.sh$/);

    const outside = await runIn(f.general.id);
    await call(outside, "run_code", { language: "bash", code: "ls" });
    expect(execs.at(-1)?.cwd).toBeUndefined();
    expect(execs.at(-1)?.command).toMatch(/^bash \.agentes\/run-\d+\.sh$/);
    expect((await call(outside, "write_file", { path: "notes.md", content: "x" })).isError).toBeFalsy();
    expect(runner.files.has("notes.md")).toBe(true);
  });

  test("edit_file replaces the exact text once, every place with all, and changes nothing it can't find", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
    const ctx = await runIn(await session());
    const file = `${WORKTREE}/src/app.ts`;
    runner.files.set(file, new TextEncoder().encode("let total = 0;\nlet total2 = 0;\nconst label = 'a';\n"));

    const once = await call(ctx, "edit_file", { path: "src/app.ts", old_text: "'a'", new_text: "'$& b'" });
    expect(once.content).toBe(`Edited ${file}: replaced one place.`);
    expect(text(runner.files.get(file))).toContain("const label = '$& b';");

    const twice = await call(ctx, "edit_file", { path: "src/app.ts", old_text: "let total", new_text: "let sum" });
    expect(twice.isError).toBe(true);
    expect(twice.content).toContain("2 times");
    const every = await call(ctx, "edit_file", {
      path: "src/app.ts",
      old_text: "let total",
      new_text: "let sum",
      all: true,
    });
    expect(every.content).toBe(`Edited ${file}: replaced 2 places.`);
    expect(text(runner.files.get(file))).toBe("let sum = 0;\nlet sum2 = 0;\nconst label = '$& b';\n");

    const missing = await call(ctx, "edit_file", { path: "src/app.ts", old_text: "nowhere", new_text: "x" });
    expect(missing.isError).toBe(true);
    expect(text(runner.files.get(file))).toBe("let sum = 0;\nlet sum2 = 0;\nconst label = '$& b';\n");
    expect((await call(ctx, "edit_file", { path: "src/none.ts", old_text: "a", new_text: "b" })).isError).toBe(true);
  });
});
