import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api/context";
import type { CodeDiffScope, CodeSession, CreateCodeSessionInput } from "./types";

/**
 * React Query hooks for code sessions (ADR 0208). The user event `code_session.updated` (a session's row changed:
 * its worktree, title, PR) refetches them (`applyCodeSessionEvent`); the conversation itself is the chat's.
 */
export const codeKeys = {
  all: (orgId: string) => ["org", orgId, "code"] as const,
  list: (orgId: string) => ["org", orgId, "code", "list"] as const,
  start: (orgId: string) => ["org", orgId, "code", "start"] as const,
  one: (orgId: string, sessionId: string) => ["org", orgId, "code", "one", sessionId] as const,
  diff: (orgId: string, sessionId: string, scope: CodeDiffScope, sha?: string) =>
    ["org", orgId, "code", "one", sessionId, "diff", scope, sha ?? ""] as const,
  git: (orgId: string, sessionId: string) => ["org", orgId, "code", "one", sessionId, "git"] as const,
  gitLog: (orgId: string, sessionId: string) => ["org", orgId, "code", "one", sessionId, "git", "log"] as const,
  files: (orgId: string, sessionId: string) => ["org", orgId, "code", "one", sessionId, "files"] as const,
  file: (orgId: string, sessionId: string, path: string) =>
    ["org", orgId, "code", "one", sessionId, "file", path] as const,
};

type QC = ReturnType<typeof useQueryClient>;

/** A session came back: the one in the cache, and the list refetched. */
export function cacheCodeSession(qc: QC, orgId: string, session: CodeSession) {
  qc.setQueryData(codeKeys.one(orgId, session.id), session);
  void qc.invalidateQueries({ queryKey: codeKeys.list(orgId) });
}

/** `code_session.updated` (a user event): the list and that session refetch. */
export function applyCodeSessionEvent(qc: QC, orgId: string, event: { type: string; sessionId?: unknown }) {
  if (event.type !== "code_session.updated") return;
  void qc.invalidateQueries({ queryKey: codeKeys.list(orgId) });
  if (typeof event.sessionId === "string")
    void qc.invalidateQueries({ queryKey: codeKeys.one(orgId, event.sessionId), exact: false });
}

/** The sessions I take part in; live runs and what waits on me move with the chat, so it also refetches often. */
export const useCodeSessions = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.list(orgId),
    queryFn: () => api.code.list(orgId),
    refetchInterval: 10_000,
    meta: { quiet: true },
  });
};

export const useCodeSession = (orgId: string, sessionId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.one(orgId, sessionId ?? ""),
    queryFn: () => api.code.get(orgId, sessionId as string),
    enabled: Boolean(sessionId),
    // While its worktree is being made, the header follows it.
    refetchInterval: (q) => (q.state.data?.worktree.state === "preparing" ? 3_000 : 15_000),
  });
};

export const useCodeStart = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: codeKeys.start(orgId), queryFn: () => api.code.start(orgId), staleTime: 60_000 });
};

/** The panel's diff: read on demand from the computer, kept a few seconds (`sha`: one commit's, with "commit"). */
export const useCodeDiff = (
  orgId: string,
  sessionId: string,
  scope: CodeDiffScope,
  enabled: boolean,
  sha?: string,
) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.diff(orgId, sessionId, scope, sha),
    queryFn: () => api.code.diff(orgId, sessionId, scope, sha),
    enabled,
    staleTime: 3_000,
    retry: false,
  });
};

/** The Git tab's lists, read again every few seconds while the agent works (`live`). */
export const useCodeGitLog = (orgId: string, sessionId: string, enabled: boolean, live = false) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.gitLog(orgId, sessionId),
    queryFn: () => api.code.gitLog(orgId, sessionId),
    enabled,
    staleTime: 3_000,
    refetchInterval: live ? 8_000 : false,
    retry: false,
  });
};

/** The Files tab's list, read again every few seconds while the agent works (`live`). */
export const useCodeFiles = (orgId: string, sessionId: string, enabled: boolean, live = false) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.files(orgId, sessionId),
    queryFn: () => api.code.files(orgId, sessionId),
    enabled,
    staleTime: 5_000,
    refetchInterval: live ? 15_000 : false,
    retry: false,
  });
};

/** One file of the worktree, read-only; nothing asked without a path. */
export const useCodeFile = (orgId: string, sessionId: string, path: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.file(orgId, sessionId, path ?? ""),
    queryFn: () => api.code.file(orgId, sessionId, path ?? ""),
    enabled: path !== null,
    staleTime: 3_000,
    retry: false,
  });
};

export const useCodeGit = (orgId: string, sessionId: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.git(orgId, sessionId),
    queryFn: () => api.code.git(orgId, sessionId),
    enabled,
    refetchInterval: 15_000,
    retry: false,
    meta: { quiet: true },
  });
};

export const useCreateCodeSession = (orgId: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCodeSessionInput) => api.code.create(orgId, input),
    onSuccess: (session) => cacheCodeSession(qc, orgId, session),
  });
};

export const useRenameCodeSession = (orgId: string, sessionId: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.code.rename(orgId, sessionId, title),
    onSuccess: (session) => cacheCodeSession(qc, orgId, session),
  });
};

export const useRetryCodeSession = (orgId: string, sessionId: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.code.retry(orgId, sessionId),
    onSuccess: (session) => cacheCodeSession(qc, orgId, session),
  });
};

export const useCloseCodeSession = (orgId: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.code.close(orgId, sessionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: codeKeys.all(orgId) }),
  });
};
