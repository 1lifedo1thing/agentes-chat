import type { RunAuthority } from "../authority";
import { toolKind } from "./run-policy";
import type { ToolDefinition } from "./types";

/**
 * The lock of a confidential thread (ADR 0187): after a run read a confidential result, it and every later run of
 * its thread keep reading, answer in the thread, and send nothing elsewhere. By name, never by kind alone: a kind is
 * wider than its name (`here` holds a GIF search and cards that make things; `self` holds the status line every
 * member sees), and a tool added later is refused until someone reads its handler and adds its name.
 */

/** In the run's own conversation: a reaction, a sticker, a question or a card people answer there, its own wake. */
const HERE = new Set([
  "react",
  "send_sticker",
  "ask_user",
  "ask_choices",
  "show_block",
  "start_poll",
  "follow_up",
  "cancel_follow_up",
  "release_waiting_agent",
]);

/** On the run or its agent alone, with nothing anyone else reads. */
const SELF = new Set(["withdraw_request", "set_reply_style", "wait_for_device", "commit_co_author"]);

/** Built-in reads whose words leave the server: the web, and the wiki's search (its query is embedded). */
const READS_OUT = new Set(["web_search", "web_fetch", "search_wiki"]);

/** What a run reads when the lock refuses a call. A refusal, never a card: an agent that never asks would lift one. */
export const CONFIDENTIAL_REFUSAL =
  "Refused: this conversation holds confidential text, so nothing leaves it. No message, mail or post elsewhere, no file, page, issue, task or memory, no command, browser or web, no write to a connected app. You can still read (files on your computer, the workspace's search, connected apps' reads), use the tools of the server that gave you the text, ask the people here and answer here. Say what you found in your reply.";

export interface LockedCall {
  /** One of the server's own tools, whatever connection id it carries for a credential. */
  own: boolean;
  /** The connections whose results marked the thread: all of their tools stay. */
  marking: readonly string[];
  authority: RunAuthority | null;
  /** The conversation the run answers in. */
  channelId: string;
}

/** Whether a run of a confidential thread may call `tool` (the tool a directory's `use_tool` reached, not the way in). */
export function confidentialLockAllows(tool: ToolDefinition, call: LockedCall): boolean {
  const what = toolKind(tool);
  if (what.kind === "directory") return true;
  if (tool.connectionId && !call.own) {
    if (call.marking.includes(tool.connectionId)) return true;
    // A read's arguments go to whoever runs the server: a catalog connector's vendor or the operator, nobody else's.
    return what.kind === "read" && (tool.server === "catalog" || tool.server === "vouched");
  }
  switch (what.kind) {
    case "pass":
      return true;
    case "hand_off":
      // A routine's report, only into the conversation its run already is in.
      return call.authority?.kind === "routine" && call.authority.brief?.deliverTo.channelId === call.channelId;
    case "here":
      return HERE.has(tool.name);
    case "self":
      return SELF.has(tool.name);
    case "read":
      return !READS_OUT.has(tool.name);
    default:
      return false;
  }
}
