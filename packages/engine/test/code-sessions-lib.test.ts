import { describe, expect, test } from "bun:test";
import {
  agentFolderOf,
  codeBranchName,
  codeSessionOf,
  codeWorktreePath,
  isLocalSession,
  localProjectName,
  shellQuote,
  splitPatch,
  titleOfRequest,
} from "../src/code-sessions";

// Code sessions (ADR 0213): the pure pieces (names, the branch, the diff's split).

describe("titleOfRequest", () => {
  test("the first sentence of the first line, capitalized, without its period", () => {
    expect(titleOfRequest("a linha do frete não some. arruma e cobre com teste")).toBe("A linha do frete não some");
  });
  test("skips blank lines and keeps a line with no period whole", () => {
    expect(titleOfRequest("\n\n  fix the flaky cart test  \nmore words")).toBe("Fix the flaky cart test");
  });
  test("cuts a long line at a word, with an ellipsis", () => {
    const title = titleOfRequest(`${"word ".repeat(30)}end`);
    expect(title.length).toBeLessThanOrEqual(73);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });
  test("nothing to name falls back", () => {
    expect(titleOfRequest("   ")).toBe("Code session");
  });
});

describe("codeBranchName and codeWorktreePath", () => {
  const id = "0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f";
  test("under the agent's own prefix, with the title's slug and a short tail", () => {
    expect(codeBranchName("atlas", "Linha do frete com cupom", id)).toBe("agentes/atlas/linha-do-frete-com-cupom-5e6f");
  });
  test("a title with nothing to slug still names a branch", () => {
    expect(codeBranchName("atlas", "!!!", id)).toBe("agentes/atlas/work-5e6f");
  });
  test("the worktree folder is per session", () => {
    expect(codeWorktreePath(id)).toBe(".worktrees/c-3c4d5e6f");
  });
});

describe("codeSessionOf", () => {
  test("reads the root's meta", () => {
    expect(codeSessionOf({ codeSession: { sessionId: "s", repo: "acme/web", title: "T" } })).toEqual({
      sessionId: "s",
      repo: "acme/web",
      title: "T",
    });
  });
  test("anything else is not a session's root", () => {
    expect(codeSessionOf({ taskConversation: { issueId: "i" } })).toBeNull();
    expect(codeSessionOf(null)).toBeNull();
  });
});

describe("splitPatch", () => {
  const diff = [
    "diff --git a/src/cart/free.ts b/src/cart/free.ts",
    "index 1111111..2222222 100644",
    "--- a/src/cart/free.ts",
    "+++ b/src/cart/free.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "-old",
    "+new",
    "+added",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  test("one patch per file, with its counts (headers not counted)", () => {
    const files = splitPatch(diff);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/cart/free.ts", 2, 1],
      ["README.md", 1, 1],
    ]);
    expect(files[0]?.patch.startsWith("diff --git a/src/cart/free.ts")).toBe(true);
  });
  test("an empty diff has no files", () => {
    expect(splitPatch("")).toEqual([]);
  });
});

describe("shellQuote", () => {
  test("single quotes, a quote inside escaped", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("agentFolderOf", () => {
  test("the agent's folder as the runner names it: its handle, then the first 8 of its id", () => {
    expect(agentFolderOf({ id: "9A9BD9B2-7b3c-7d4e-8f90-1a2b3c4d5e6f", handle: "Leo.Dev" })).toBe("leo-dev-9a9bd9b2");
    expect(agentFolderOf({ id: "0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f", handle: "--" })).toBe("agent-0193f1a2");
  });
});

describe("local projects", () => {
  test("a folder-like name is a local project's, anything else isn't", () => {
    expect(localProjectName("hello-world")).toBe("hello-world");
    expect(localProjectName(" site_v2.1/ ")).toBe("site_v2.1");
    expect(localProjectName(".hidden")).toBeNull();
    expect(localProjectName("a b")).toBeNull();
    expect(localProjectName("acme/web")).toBeNull();
  });
  test("a session on a local project has no owner in its repo", () => {
    expect(isLocalSession({ repo: "hello-world" })).toBe(true);
    expect(isLocalSession({ repo: "acme/web" })).toBe(false);
  });
});
