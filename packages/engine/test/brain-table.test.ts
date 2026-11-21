import { describe, expect, test } from "bun:test";
import { ACCOUNT_KINDS, CLI_NAMES } from "@agenteschat/adapters";
import {
  BRAIN_EXECUTORS,
  BRAIN_KINDS,
  BRAINS,
  brainCan,
  brainOfExecutor,
  brainsWith,
  COMPUTER_BRAIN_KINDS,
  isBrainKind,
  isComputerBrain,
} from "@agenteschat/providers/brains";
import { BRAIN_NAMES, BRAIN_PLAN_NAMES, brainRunsOn, isSandboxedBrain } from "../src";
import { CODE_BRAINS, isCodeBrain } from "../src/code-sessions";

/** The computer brains are one table (ADR 0215): every list and rule elsewhere is read from it. */

describe("the brains' table", () => {
  test("each brain once, under its own kind, with its own name and program", () => {
    expect(Object.keys(BRAINS)).toEqual([...COMPUTER_BRAIN_KINDS]);
    for (const kind of COMPUTER_BRAIN_KINDS) expect(BRAINS[kind].kind).toBe(kind);
    expect(new Set(COMPUTER_BRAIN_KINDS.map((k) => BRAINS[k].name)).size).toBe(COMPUTER_BRAIN_KINDS.length);
    expect(new Set(BRAIN_EXECUTORS).size).toBe(COMPUTER_BRAIN_KINDS.length);
    for (const kind of COMPUTER_BRAIN_KINDS) expect(brainOfExecutor(BRAINS[kind].executor)).toBe(kind);
    expect(BRAIN_KINDS).toEqual(["model", ...COMPUTER_BRAIN_KINDS]);
  });

  test("the wire speaks of the same brains, in the same order", () => {
    expect([...ACCOUNT_KINDS]).toEqual([...COMPUTER_BRAIN_KINDS]);
    expect([...CLI_NAMES]).toEqual([...BRAIN_EXECUTORS]);
  });

  test("a kind is one of the table's, and nothing a plain object carries", () => {
    expect(isComputerBrain("grok")).toBe(true);
    for (const v of ["model", "toString", "hasOwnProperty", "", "Claude_Code", null, 3]) {
      expect(isComputerBrain(v)).toBe(false);
    }
    expect(isBrainKind("model")).toBe(true);
    expect(isBrainKind("constructor")).toBe(false);
    expect(brainCan("model", "folder")).toBe(false);
  });

  test("the rules read from it say what they said before", () => {
    expect(BRAIN_NAMES).toEqual({
      claude_code: "Claude Code",
      codex: "Codex",
      cursor: "Cursor",
      opencode: "OpenCode",
      grok: "Grok Build",
      antigravity: "Antigravity CLI",
    });
    expect(BRAIN_PLAN_NAMES).toEqual({
      claude_code: "Claude",
      codex: "ChatGPT",
      cursor: "Cursor",
      opencode: "OpenCode",
      grok: "Grok",
      antigravity: "Gemini",
    });
    expect(COMPUTER_BRAIN_KINDS.filter((k) => !brainRunsOn(k, "windows"))).toEqual(["cursor", "grok", "antigravity"]);
    expect(COMPUTER_BRAIN_KINDS.every((k) => brainRunsOn(k, "darwin") && brainRunsOn(k, null))).toBe(true);
    expect(COMPUTER_BRAIN_KINDS.filter((k) => isSandboxedBrain(k))).toEqual(["codex", "cursor", "grok", "antigravity"]);
    expect(isSandboxedBrain("model")).toBe(false);
    expect(brainsWith("routes")).toEqual(["claude_code", "codex"]);
    expect(brainsWith("outsideFolders")).toEqual(["claude_code", "codex"]);
    expect(brainsWith("asksEachCall")).toEqual(["claude_code"]);
    expect(COMPUTER_BRAIN_KINDS.filter((k) => BRAINS[k].caps.steer === "between_turns")).toEqual([
      "cursor",
      "grok",
      "antigravity",
    ]);
  });

  test("a code session takes every computer brain that works in its folder, never the API", () => {
    expect(CODE_BRAINS).toEqual([...COMPUTER_BRAIN_KINDS]);
    expect(isCodeBrain("antigravity")).toBe(true);
    expect(isCodeBrain("model")).toBe(false);
  });
});
