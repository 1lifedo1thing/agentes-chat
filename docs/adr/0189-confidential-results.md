# 0189. Confidential results: a listed server's answer seals the thread that read it

- Status: Accepted
- Date: 2026-11-16
- Code: engine `packages/engine/src/confidential.ts` (`markThreadConfidential`, `sealStragglers`, `unsealed`,
  `runConfidentiality`, `isConfidentialRun`), `confidential-prune.ts` (`pruneConfidential`),
  `tools/confidential-lock.ts` (`confidentialLockAllows`), `tools/gateway.ts` (`markedStep`, the lock in `invoke`
  and `runApproved`), `connectors/mcp.ts` (a result's `_meta`, `ToolDefinition.server`), `messages.ts` (the `sealed`
  part of `insertMessageWithRuns`, `messageView`), `context.ts` (`buildRunContext`'s `unseal`), `executor.ts`
  (`followThread`, `CONFIDENTIAL_AI_CHANGED`), `judge.ts` (`refuseConfidential`), `format.ts` (`inertLinks`); schema
  `packages/db/src/schema/chat.ts` (`confidential_threads`, migration 0282); server
  `apps/server/src/workers.ts` (`confidentialPrune`); tests `packages/engine/test/confidential-results.test.ts`,
  `confidential-lock.test.ts`, `confidential-copies.test.ts`, `confidential-prune.test.ts`

## Context

A workspace connects an MCP server by address (ADR 0016), and whoever runs an instance can list the hosts of their
own servers (`MCP_CALLER_IDENTITY`, ADR 0181). Some of what such a server answers is somebody's private text: a
secret from a vault, a person's record from an internal system. An agent that reads it needs to go on working, and
the text must not travel: every published account of prompt injection says the same, that an agent which reads text
it does not control can be steered, that nothing detects it reliably, and that the control is what the agent can do
afterwards.

Text from outside already has a mark (ADR 0117): a connector's result is `external`, its step carries
`outside: true`, and what the run posts next carries `meta.readOutside`, so memory built from it stays low trust.
That mark lowers trust. It does not stop the text from being posted elsewhere, searched, summarized, quoted in a
notification or kept for good.

## Decision

A server the operator vouches for can mark a tool result as confidential. A run that read one goes on reading,
answers in a thread under the message that asked it, and sends nothing elsewhere. Outside that thread no model is
given its text, and what the product kept of it is removed 60 days later. Nothing here is on until a listed server
marks a result: an install with no such result stores, posts and runs as before.

### 1. The mark

`callTool` passes a result's `_meta` on. A result whose `_meta["chat.agentes/confidential"]` is `true`, from a
server by address whose host is in `MCP_CALLER_IDENTITY` (over https, on its own port, never through a connections
broker), comes back from the connector source with `confidential: true`, and the Tool Gateway writes
`data.confidential: true` on its step, beside `outside`. From any other server the key changes nothing: a connected
server must not be able to lock a run.

### 2. The thread, and the seal

The step and its thread's mark are written in one transaction (`markedStep`): a row in `confidential_threads`, keyed
by the root message of the run's thread, with the connections whose results marked it. The mark follows the thread
alone. It never looks at the channel's newest messages, as `runReadOutside` does: one finding would then lock every
later run of the channel. A run is confidential when its thread is, and a run never leaves such a thread (it is not
moved to the background, and the tool that moves a run elsewhere is refused).

Every message of a confidential thread is **sealed**, the root included, since the root may hold what a person pasted
before any mark existed: `messages.body` holds a stub (`[confidential: readable only in its own thread]`), the words
live in `meta.sealedBody`, and `meta.confidential` is true. The statement that writes a message seals it when its
thread is confidential or when a run of such a thread writes it; that is the same single statement as before, with
no query added. So whatever reads a message's body gets the stub without knowing any of this: another run's
context, the router, a search, a summary, a notification, a quote. Two readers get the words back (`unsealed`): the
people who read the conversation (`messageView`), and a run of that same thread that thinks through the Model
Gateway (`buildRunContext` with `unseal`, and the messages it is handed mid-run).

A message written while the mark was being committed, and a note the server rewords in place, are sealed by the
daily job (`sealStragglers`).

### 3. Where a confidential run posts

Under the message that asked it. A run asked in the main timeline answers there (`replyThreadOf`), so its finding
would sit among the channel's messages with no thread around it. It is decided in the statement that writes the
message: a message that names no thread, written by a run of a confidential thread, goes under that thread's root.
One place covers the reply, a card, a question, a block and a note. What the run posted before its first
confidential result stays where it is: it holds none of the words. Web addresses in a message such a run writes are
stored inert (`inertLinks`: a link keeps its words, a bare address becomes code), so no app renders a link whose
address could carry words out on a click.

### 4. The stub, outside the thread

Outside its own thread a confidential message reaches no model, whatever thinks for the run. The stub stands in its
place and does not mark the run that reads it: in the rest of the channel that every run's context is built from, in
a `search_context` hit, in a message read by its link, in an open question listed for the agent in another thread,
and in the lines about what other runs did (`(confidential, not shown)`). So a run asked by another message of the
same channel is neither given the words nor locked by them.

### 5. The lock

One check in the Tool Gateway's `invoke`, after the run's policy and before anything asks a person, and again when
an approved action runs. **By name, not by kind**: a kind is wider than its name (`here` holds a GIF search and
cards that make things, `self` holds the status line every member sees). In a run of a confidential thread a tool
runs only when it is on this list:

- every tool of a connection that marked the thread;
- a built-in read: `computer_status`, `expand`, `find_agent`, `get_my_usage`, `get_summary`, `list_artifacts`,
  `list_files`, `list_issues`, `list_reminders`, `list_routines`, `load_skill`, `read_artifact`,
  `read_conversation`, `read_file`, `read_skill_file`, `read_wiki_page`, `search_context` and any other built-in
  tool the run policy sorts as a read. Not `web_search`, `web_fetch` or `search_wiki`: their words leave the server
  (the wiki's search embeds its query). `search_context` searches by words only, with no call to an embeddings
  provider, and shows the stub for a sealed message; from any thread it leaves out the steps of a run of a
  confidential one;
- a connected app's read, only on a catalog connector or on a server the operator listed. A custom server by
  address, a tool reached through a connections broker, a mailbox and a workspace's database are refused: a read's
  arguments go to whoever runs the server. A read an admin marked to ask is no read;
- in the run's own conversation: `react`, `send_sticker`, `ask_user`, `ask_choices`, `show_block`, `start_poll`,
  `follow_up`, `cancel_follow_up`, `release_waiting_agent`. A routine's own run posts what it asks a person where the
  routine reports: when that is another conversation, its question and any tool that would ask for an approval are
  refused;
- on the run or its agent alone: `withdraw_request`, `set_reply_style`, `wait_for_device`, `commit_co_author`;
- `pass`; `hand_off` only for a routine's run whose routine delivers into the conversation the run is already in;
  `find_tools`, `use_tool` and `run_approved_action`, with the lock judging the tool they reach.

Everything else is refused, a tool added later included, with the code `confidential.outbound`. It is among the
codes the turn's judge reads as final (`SAFETY_CODES`), so nothing nudges the agent to find another way. It is a
refusal and never an approval card: an agent set to never ask would have the card lifted.

Five tools were weighed for the list and left off it, since none is needed to read, ask or answer: `update_thread`
(a thread's title is read outside the thread), `share_artifact` (it gives a file to people outside the
conversation), `offer_answers` (a card that makes something that outlives the run), and `browser_ask_person` and
`desktop_ask_person` (the browser and the desktop are refused, so there is nothing to hand over).

The audit log keeps which tool a run of a confidential thread called and how it ended, never its arguments, title
or reason: that log is kept for good.

### 6. A program on a computer cannot be locked

Its own shell and web fetch never pass the gateway. So a run that does not think through the Model Gateway never
gets confidential text, in its own thread either: the stub stands in for the tool's result (and nothing is marked),
for a search hit, and for the thread's messages in its context. A run that read the thread and comes back to
another provider's model, or to a program on a computer, ends there with a line that says so
(`CONFIDENTIAL_AI_CHANGED`): its transcript holds the words.

### 7. No other model reads it, and nothing copies it

- **Learning.** No learning job is queued for a run of a confidential thread, a job queued before the mark does
  nothing, and a refused approval of such a thread leaves no lesson.
- **Summaries, reflection, the thread's name and assessment** skip a confidential thread whole (`loadThread`,
  `ensurePeriodSummary`, `nameConversation`, `assessThread`); a summary made before the mark is archived with it.
- **The small judge.** No judge answers for a run of a confidential thread (`refuseConfidential`): it fails like a
  judge that is off, which every caller already does without. That covers the turn's end, a held reply, the stuck
  check, the context budget, the tool loader, the status line, a question's check, the automatic model and the
  reaction or GIF after a reply (which is also skipped by the reply's own mark). A judgment about a message reads
  its stored body, which is the stub: a stop said in words, a mention's need, an alert's triage.
- **Who is asked.** A message typed into a confidential thread that names several agents, or everyone, is not put
  to a judge: every agent named is asked.
- **The routing model** reads stored bodies, so the stub, and no quote a sealed message carries.
- **The conversation layer** that answers for a working run is not asked for a run of a confidential thread: its
  snapshot is made of the run's own steps.
- **The search index.** Its builders answer nothing for a sealed message, and nothing for a block or a poll shown in
  a confidential thread. When a thread is marked, the documents of its messages are deleted in that transaction.
- **Notifications.** A notification of a sealed message keeps no snippet, no quote and no preview, so the phone
  push and a mail that quotes it say only that there is something to open; snippets kept before the mark are
  blanked with it. A question's and an approval's notification keep no text.
- **A task.** A reply in a confidential thread is not copied onto the task it works on.
- **A mail about requests left waiting** counts one made in a confidential thread and quotes nothing of it.
- **The lines other readers get of a run's calls** show a confidential result as `(confidential, not shown)`
  (`runCalls`, so the judge's and the hand-off's lines), and the agent's recent work lists nothing a run of a
  confidential thread did.

Every reader of the outside mark was walked for this one: `apps/tools` (an app's post into such a thread is sealed
like any message), `cache` (the confidential runs have their own list, `sealedRuns`), `chat-tools` and
`consultations` (posting elsewhere and asking another agent are refused by the lock), `context` (the stub outside
the thread), `context/backfill` (skips a confidential message), `context/summaries` (skips the thread),
`context/tools` (the stub for a hit and a read by link), `delivery`, `git/github-events`, `hand-off`,
`machine-tasks` and `missions` (what they write into such a thread is sealed by the statement that writes it; their
tools are refused), `executor` (the reply's mark comes from that same statement), `outside` (unchanged: it reads no
confidential text) and `tools/types` (`ToolOutput.confidential`, set by the connector source alone).

### 8. The prune

A daily job (`confidentialPrune`), with `CONFIDENTIAL_KEEP_DAYS = 60` in code.

- **A thread** marked more than 60 days ago: every message of it, the root and a person's replies included, loses
  its text in every column that holds it and reads as removed (`meta.bodyCode` `confidential_removed`, worded by the
  apps). Files its messages carried, and the blocks and polls shown in it, become tombstones whose contents the
  purge of deleted files takes; a voice message loses its words and its recording; the thread's title goes. A
  message added later is blanked by the next pass.
- **A run** of such a thread that ended and is older than that loses the kept text of its steps (a step keeps its
  tool's name, how it ended and its code), its transcript, the words of its error after the code, its questions'
  text and answers, and its approvals' title, detail, why, arguments and result. The rows remain. A run still at
  work is blanked by the pass after it ends.
- Each blanked message is sent to the apps as a message written again in place, so a copy a browser or a phone kept
  goes too.
- "Continuar" on a run the prune emptied is refused: it has no transcript to go on from.

### 9. The server is told who thinks, and where

The caller statement (ADR 0181, addendum of 2026-11-16) gains `brain`, `provider`, `channel` and `thread`, so a
server can refuse to hand out what a program on a computer would keep, what would go to a provider it does not
accept, or what is asked from another conversation than the one it serves.

## Accepted

- The lock bounds where words go, not what the agent concludes or writes in its own thread.
- A read's own arguments reach the catalog app or the listed server it reads.
- A person can still copy a confidential message by hand, and a person's own voice message is made out by the
  speech engine before it is posted.
- What left before the mark stays where it went: a push already sent for the root, and a judgment made on it.
- A stop said in words is not recognized in a confidential thread (the judge reads the stub): the stop button is.
- An agent's message keeps `meta` that is not its body (a card's fields); it reaches no model outside the thread
  (the stub carries none of it) and is blanked by the prune.

## Consequences

- One new table, `confidential_threads` (migration 0282). No setting: `MCP_CALLER_IDENTITY` is the switch, and the
  key in a result's `_meta` is the server's to send.
- Every tool call reads the run's row joined to that table (one query more, sent with the ones the call already
  made), and the message insert reads the table inside its one statement.
- A new tool is refused in a confidential thread until someone reads its handler and adds its name to the list.
- After a confidential result an agent can no longer mail, post elsewhere, message a person or another agent, write
  an issue, a page, a file, a task or a memory, run a command, use a browser or the web, write to a connected app,
  set its status line or send a GIF, in that run and in any later run of the thread.
