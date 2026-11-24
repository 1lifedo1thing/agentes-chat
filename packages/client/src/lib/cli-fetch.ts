import type { TFunction } from "i18next";
import type { CliFetch } from "../api/types";
import { CLI_PROGRAMS } from "./activity";

/**
 * A computer fetching a coding CLI's pinned build by itself (ADR 0228 §6), as both apps word it: "Preparando o Claude
 * Code no MacBook… 45%" while it comes, and why when it failed (with "Tentar de novo" beside it). Null once it is
 * ready, or when nothing was fetched.
 */
export interface CliFetchLine {
  text: string;
  /** How far, 0–100; null while its size isn't known (and on a failure). */
  percent: number | null;
  failed: boolean;
}

export function cliFetchLine(
  t: TFunction,
  fetch: CliFetch | null | undefined,
  cli: string,
  computer: string,
): CliFetchLine | null {
  if (!fetch || fetch.state === "ready") return null;
  const program = CLI_PROGRAMS[cli] ?? cli;
  if (fetch.state === "fetching") {
    const percent = fetch.total ? Math.min(100, Math.floor(((fetch.done ?? 0) / fetch.total) * 100)) : null;
    const key = percent === null ? "connectAi.cliFetch.preparing" : "connectAi.cliFetch.preparingPct";
    return { text: t(key, { program, computer, percent: percent ?? 0 }), percent, failed: false };
  }
  return { text: t(`connectAi.cliFetch.failed.${fetch.reason ?? "failed"}`, { program, computer }), percent: null, failed: true };
}
