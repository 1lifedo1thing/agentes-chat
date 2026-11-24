/**
 * Whether what a person typed names a repository on a git host, as the server takes it for a code session:
 * `owner/name` (GitHub), a repository with its host first (`gitlab:group/project`), or its address.
 */
export const looksLikeRepo = (typed: string) =>
  /^(?:(?:gitlab|bitbucket):[\w.-]+(?:\/[\w.-]+)+|git:[\w.-]+(?:\/[\w.-]+)*|[\w.-]+\/[\w.-]+|https:\/\/\S+\/\S+)$/.test(
    typed,
  );

/** Whether a session's place is a project only on the agent's computer: a plain name, on no host. */
export const isLocalPlace = (repo: string) => !repo.includes("/") && !repo.includes(":");
