import { eq, schema } from "@agenteschat/db";
import { ASK_CHOICES_TOOL, SHOW_BLOCK_TOOL, START_POLL_TOOL } from "../blocks";
import { actionLevel, nameWords } from "../connectors/classify";
import { ALWAYS_SENSITIVE } from "../tools/gateway";
import type { ToolContext, ToolDefinition } from "../tools/types";
import { surfaceOn } from "./config";
import { surfaceOfRun } from "./deliveries";

/**
 * What a surface turn (ADR 0187) may not do: the person reads it outside the app, where a card can't be answered
 * and nothing they confirm there is checked like a signed-in session.
 */

export type SurfaceRefusalClass =
  | "card"
  | "approval"
  | "sends_deletes_pays"
  | "roles_budgets_money"
  | "routine_elsewhere";

const CARD_TOOLS = new Set([
  SHOW_BLOCK_TOOL,
  START_POLL_TOOL,
  ASK_CHOICES_TOOL,
  "offer_connect_ai",
  "propose_agent",
  "propose_remove_agents",
  "offer_connect_app",
  "offer_invites",
  "offer_approvals",
  "propose_member_changes",
  "offer_open_page",
]);

const MONEY_AND_ROLES = new Set(
  "role roles member members permission permissions admin budget budgets billing plan subscription invoice payment price wallet".split(
    " ",
  ),
);

/** The first class the call falls in, or null. No database: the run is asked about only for a match. */
export function surfaceRefusalClass(
  tool: Pick<ToolDefinition, "name" | "scope" | "sensitive">,
  input: Record<string, unknown>,
): SurfaceRefusalClass | null {
  if (CARD_TOOLS.has(tool.name)) return "card";
  // `unasked` is ignored on purpose: a surface turn never runs these, whoever would have approved them.
  if (
    tool.sensitive === true ||
    ALWAYS_SENSITIVE.test(tool.name) ||
    ALWAYS_SENSITIVE.test(tool.scope) ||
    tool.name === "schedule_action"
  ) {
    return "approval";
  }
  if (actionLevel(tool.name) === "sensitive") return "sends_deletes_pays";
  if (nameWords(tool.name).some((w) => MONEY_AND_ROLES.has(w))) return "roles_budgets_money";
  if (
    (tool.name === "create_routine" || tool.name === "update_routine") &&
    (input.channel !== undefined ||
      input.agent !== undefined ||
      (Array.isArray(input.own_actions) && input.own_actions.length > 0))
  ) {
    return "routine_elsewhere";
  }
  return null;
}

/** The line the model reads instead of the result when a surface turn calls a tool of a refused class; else null. */
export async function surfaceRefusal(
  ctx: ToolContext,
  tool: Pick<ToolDefinition, "name" | "scope" | "sensitive">,
  input: Record<string, unknown>,
): Promise<string | null> {
  const surface = surfaceOn();
  if (!surface || !surfaceRefusalClass(tool, input)) return null;
  const turn = await surfaceOfRun(ctx.db, ctx.orgId, ctx.runId);
  if (!turn) return null;
  const [person] = await ctx.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, turn.userId));
  const who = person?.name ?? "the person";
  return `This can't be done from ${surface.name}: tell ${who} in one line to do it in the agentes.chat app. Don't try another way.`;
}
