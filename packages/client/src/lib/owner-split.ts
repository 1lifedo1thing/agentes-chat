/** Anything the team or one person owns (the Vault's split, ADR 0144): a skill, a connection, a mailbox. */
export interface Owned {
  /** The person it belongs to; null or absent (older servers): the team's. */
  ownerUserId?: string | null;
}

/** Which tab of "Equipe | Pessoal" a thing is in for `userId`, or `others` for someone else's personal one. */
export type OwnerScope = "team" | "mine" | "others";

export const ownerScopeOf = (item: Owned, userId: string): OwnerScope =>
  item.ownerUserId ? (item.ownerUserId === userId ? "mine" : "others") : "team";

/**
 * A list split as the Vault splits its items: the team's, the person's own personal ones, and other people's (only
 * who manages them gets those, name and person only).
 */
export function ownerSplit<T extends Owned>(items: readonly T[], userId: string) {
  const split: Record<OwnerScope, T[]> = { team: [], mine: [], others: [] };
  for (const item of items) split[ownerScopeOf(item, userId)].push(item);
  return split;
}
