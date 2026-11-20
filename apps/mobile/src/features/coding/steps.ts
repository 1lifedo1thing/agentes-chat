import type { CodeGit, CodeGitStep, CodeSession } from "@agenteschat/client";
import type { useTranslation } from "react-i18next";
import type { HeaderMenuItem, IconName } from "@/ui";

type T = ReturnType<typeof useTranslation>["t"];

/** Each git step's mark (menus, the conversation's step line, the Git view's button), as the web's menu draws it. */
export const STEP: Record<CodeGitStep, { icon: IconName; sf: HeaderMenuItem["sf"] }> = {
  commit: { icon: "check", sf: "checkmark.circle" },
  push: { icon: "up", sf: "arrow.up.circle" },
  pr: { icon: "pullRequest", sf: "arrow.triangle.pull" },
  merge: { icon: "gitPull", sf: "arrow.triangle.merge" },
};

/** The steps a session has: a project only on the computer has no remote (Commit, then Merge into its base there). */
export const stepsOf = (s: Pick<CodeSession, "local">): CodeGitStep[] =>
  s.local ? ["commit", "merge"] : ["commit", "push", "pr", "merge"];

/** What a step asks the session's agent, as the person's message in its conversation (ADR 0208: never a git call). */
export const stepAsk = (t: T, s: Pick<CodeSession, "local" | "baseBranch">, step: CodeGitStep) =>
  s.local && step === "merge"
    ? t("codeSessions.git.ask.mergeLocal", { base: s.baseBranch ?? "main" })
    : t(`codeSessions.git.ask.${step}`);

/**
 * Where the branch stands for its next step, in a few words ("3 files changed", "2 commits not pushed", "PR #12
 * is open"): the line the step's word ends.
 */
export function stepWords(t: T, s: Pick<CodeSession, "local" | "baseBranch">, git: CodeGit, step: CodeGitStep) {
  if (step === "commit") return t("codeSessions.git.hint.commit", { count: git.uncommitted });
  if (step === "push") return t("codeSessions.git.hint.push", { count: git.ahead });
  if (step === "pr") return t("mobile.coding.next.pr");
  if (s.local) return t("mobile.coding.next.mergeLocal", { base: s.baseBranch ?? "main" });
  return git.pr ? t("codeSessions.git.hint.prOpen", { number: git.pr.number }) : t("codeSessions.git.hint.merge");
}

/** The agent is free to take a step: its worktree is ready and it isn't working (or preparing it). */
export const freeForStep = (s: Pick<CodeSession, "work" | "worktree"> | null, busy = false) =>
  s !== null && !busy && s.worktree.state === "ready" && s.work !== "working" && s.work !== "preparing";
