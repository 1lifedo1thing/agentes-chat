import { describe, expect, test } from "bun:test";
import type { Connection, CustomServer } from "../src/api/types";
import { connectedItems, connectionActs, personalAllowed } from "../src/lib/connected";
import { ownerScopeOf, ownerSplit } from "../src/lib/owner-split";

const connection = (id: string, ownerUserId?: string | null): Connection => ({
  id,
  connector: "linear",
  label: `Linear ${id}`,
  serverUrl: "https://mcp.linear.app/mcp",
  authType: "api_key",
  accountLabel: null,
  tokenExpiresAt: null,
  createdAt: `2026-11-1${id.length}T10:00:00.000Z`,
  revokedAt: null,
  ...(ownerUserId === undefined ? {} : { ownerUserId }),
});
const server = (id: string, ownerUserId: string | null): CustomServer => ({
  id,
  serverUrl: "",
  label: `Stripe ${id}`,
  authType: "oauth",
  tools: [],
  reviewedAt: null,
  createdAt: "2026-11-15T10:00:00.000Z",
  ownerUserId,
});

describe("Equipe | Pessoal for connections", () => {
  test("a row is the team's, the viewer's own, or someone else's; an older server's rows are the team's", () => {
    expect(ownerScopeOf({}, "walter")).toBe("team");
    expect(ownerScopeOf({ ownerUserId: null }, "walter")).toBe("team");
    expect(ownerScopeOf({ ownerUserId: "walter" }, "walter")).toBe("mine");
    expect(ownerScopeOf({ ownerUserId: "bia" }, "walter")).toBe("others");
  });

  test("the list splits into the tabs and the others' group, kinds kept together, counts from the split", () => {
    const items = connectedItems(
      [connection("a"), connection("bb", "walter"), connection("ccc", "bia")],
      [server("s1", "walter"), server("s2", null)],
      [],
    );
    const split = ownerSplit(items, "walter");
    expect(split.team.map((i) => i.id).sort()).toEqual(["a", "s2"]);
    expect(split.mine.map((i) => i.id).sort()).toEqual(["bb", "s1"]);
    expect(split.others.map((i) => i.id)).toEqual(["ccc"]);
  });
});

describe("what a viewer may do with a row (the engine's rule)", () => {
  test("their own: everything, and moving it to the team only when they manage connectors", () => {
    expect(connectionActs({ ownerUserId: "walter" }, "walter", false)).toEqual({
      open: true,
      rename: true,
      change: true,
      remove: true,
      giveToAgents: true,
      takeOffAgent: true,
      moveToTeam: false,
    });
    expect(connectionActs({ ownerUserId: "walter" }, "walter", true).moveToTeam).toBe(true);
  });

  test("someone else's: never opened; who manages connectors removes it or takes it off an agent, nothing else", () => {
    expect(connectionActs({ ownerUserId: "bia" }, "walter", true)).toEqual({
      open: false,
      rename: false,
      change: false,
      remove: true,
      giveToAgents: false,
      takeOffAgent: true,
      moveToTeam: false,
    });
    const member = connectionActs({ ownerUserId: "bia" }, "walter", false);
    expect(Object.values(member).every((may) => !may)).toBe(true);
  });

  test("the team's: every member opens it, who manages connectors changes it", () => {
    expect(connectionActs({ ownerUserId: null }, "walter", false)).toMatchObject({
      open: true,
      rename: false,
      remove: false,
      giveToAgents: false,
    });
    expect(connectionActs({ ownerUserId: null }, "walter", true)).toMatchObject({ rename: true, remove: true });
  });

  test("GitHub connects for the team only; any other connector or a server by address may be personal", () => {
    expect(personalAllowed("github")).toBe(false);
    expect(personalAllowed("linear")).toBe(true);
    expect(personalAllowed(null)).toBe(true);
  });
});
