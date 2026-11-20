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
  diff: (orgId: string, sessionId: string, scope: CodeDiffScope) =>
    ["org", orgId, "code", "one", sessionId, "diff", scope] as const,
  git: (orgId: string, sessionId: string) => ["org", orgId, "code", "one", sessionId, "git"] as const,
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

/** The panel's diff: read on demand from the computer, kept a few seconds. */
export const useCodeDiff = (orgId: string, sessionId: string, scope: CodeDiffScope, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: codeKeys.diff(orgId, sessionId, scope),
    queryFn: () => api.code.diff(orgId, sessionId, scope),
    enabled,
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
