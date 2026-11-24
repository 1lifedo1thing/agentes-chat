/**
 * GitHub as the workspace's and as a person's own (ADR 0099, ADR 0215 §5a). The workspace has one GitHub connection,
 * the team's: the git proxy, repository lists, webhooks and the agents' tools read that one. A person's own GitHub
 * connection (`owner_user_id`) is their account in code sessions (`git/person-account.ts`): it has no tools and no
 * grants of its own, and is never read as the workspace's. No imports here: every reader of either takes it from this
 * file.
 */
interface Owned {
  connector: string;
  ownerUserId: string | null;
}

/** The workspace's GitHub connection: the team's one, never a person's own account. */
export const teamGitHub = <C extends Owned>(connections: readonly C[]) =>
  connections.find((c) => c.connector === "github" && !c.ownerUserId);

/** A person's own GitHub account. */
export const isOwnGitHub = (c: Owned) => c.connector === "github" && Boolean(c.ownerUserId);
