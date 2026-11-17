import {
  listenResumedTopic,
  liveTopic,
  orgTopic,
  type PubSub,
  type RealtimeEvent,
  type Unsubscribe,
} from "@agenteschat/adapters";
import { and, type Executor, eq, schema } from "@agenteschat/db";
import { isLiveOrigin, LIVE_LIMITS, type LiveKind, type LiveOrigin } from "@agenteschat/live";
import {
  agentClientId,
  type PeerKind,
  type PeerState,
  type PeerUser,
  sanitizePeerState,
} from "@agenteschat/live/awareness";
import {
  LIVE_CLOSE,
  type LiveControl,
  type LiveMode,
  MSG_SYNC,
  readMessage,
  SYNC_STEP2,
  SYNC_UPDATE,
  syncStep1,
  updateMessage,
  writeAwarenessUpdate,
} from "@agenteschat/live/protocol";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import { type ArtifactAuthor, type ArtifactDeps, liveSnapshotOf } from "../artifacts";
import { recordAudit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { assertStorageRoom } from "../limits";
import { changeActorOf, originFor, personHides } from "./access";
import { DocPresence, type PresencePeer } from "./awareness";
import { agentCheckpointDue, restoredNote, writeCheckpoint } from "./checkpoints";
import { armIdleCheckpoint, checkpointWindow, compactLiveDoc, enqueueCompaction, LIVE_COMPACTION } from "./jobs";
import { createPresenceBoard, PRESENCE_BOARD_TIMING, type PresenceBoardTiming, unref } from "./presence";
import { overLimit, replaceLiveDoc } from "./preview";
import {
  type Appended,
  appendChanges,
  docOf,
  fromB64,
  type LiveChangeActor,
  loadHeadState,
  loadStored,
  readSince,
  toB64,
  updateInserts,
} from "./store";

/**
 * The live documents a process holds (ADR 0191 §3–§6): people's sockets join them, agents' tools and the server's
 * jobs edit them, from any process.
 *
 * - **Every change is stored before anyone else sees it.** A socket's changes are applied to the document this
 *   process holds, merged for up to `coalesceMs` (one row per author) and numbered under the document's row lock
 *   (`appendChanges`); only then do the file's other sockets get them and the socket hear `live.saved`. Each stored
 *   change is published on `liveTopic` (inline when the event stays under `INLINE_BYTES`, else its number alone).
 * - **Other processes catch up.** A process holding the file applies a change numbered one past its own head at once,
 *   and reads anything else from the database (a gap, a change too big for the event, a missed event); it also reads
 *   the tail every `tailCheckMs`, and when its LISTEN comes back after a gap, since NOTIFY is best effort.
 * - **Edits** (`edit`) run one at a time per document at its head, store what they changed (in steps for a
 *   progressive one) and publish it; an agent's carry its presence while they work, and write a version per the
 *   policy of `checkpoints.ts`.
 * - **Presence** is the Yjs awareness of `DocPresence`, relayed between processes (`live.aw`, at most `relayMs`
 *   apart, `announceMs` again in full), and summed up across processes for the Drive's cards (`presence.ts`).
 * - **Limits** (`LIVE_LIMITS`): a frame over `updateBytes` is refused, and a document past a count or `docBytes` takes
 *   only deletions until it is back under them (`live.error` `too_large`); the full rules of shape are read at
 *   compaction. A document nobody uses stays loaded `lingerMs`, then goes.
 */

export interface LiveLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** How long things take; tests make them shorter. */
export interface LiveTiming {
  /** A socket's changes are merged this long before they are stored. */
  coalesceMs: number;
  /** A held document reads its tail this often anyway (NOTIFY is best effort). */
  tailCheckMs: number;
  /** A document nobody uses stays loaded this long. */
  lingerMs: number;
  /** Presence goes to the other processes at most this often per document (5 a second). */
  relayMs: number;
  /** ...and again in full this often. */
  announceMs: number;
  /** An agent's presence stays this long after its last edit or update. */
  agentLingerMs: number;
  /** An agent's presence is said again this often while it lasts (others drop a state unheard of for 30 s). */
  agentRenewMs: number;
  /** A progressive edit lands over at most this long. */
  progressiveMs: number;
  /** ...in steps at most this far apart. */
  stepMs: number;
  /** Waits before storing again after the database failed; past the last, the document is dropped. */
  retryMs: number[];
  /** Changes waiting to be stored past this: the document is dropped (its sockets keep them and send them again). */
  maxPendingBytes: number;
  /** A document's exact size is measured at most this often (when its estimate passes `docBytes`). */
  measureMs: number;
  board: Partial<PresenceBoardTiming>;
}

export const LIVE_TIMING: LiveTiming = {
  coalesceMs: 40,
  tailCheckMs: 10_000,
  lingerMs: 30_000,
  relayMs: 200,
  announceMs: 15_000,
  agentLingerMs: 20_000,
  agentRenewMs: 10_000,
  progressiveMs: 3000,
  stepMs: 120,
  retryMs: [200, 1000, 3000, 10_000],
  maxPendingBytes: 16 * 1024 * 1024,
  measureMs: 10_000,
  board: PRESENCE_BOARD_TIMING,
};

/** A stored change goes inline in its event while the event's JSON stays under this (NOTIFY takes under 7900). */
export const INLINE_BYTES = 6000;

export interface LiveDeps extends ArtifactDeps {
  pubsub: PubSub;
  /** This process, as the other processes tell it apart (its own events come back to it). */
  replicaId: string;
  log: LiveLog;
  now?: () => Date;
  timing?: Partial<LiveTiming>;
}

/** A person's socket as a document sees it. */
export interface LiveConn {
  send(data: Uint8Array | string): void;
  close(code: number, reason?: string): void;
  /** Bytes queued to the app and not sent yet. */
  buffered(): number;
  /** The app takes bytes as base64 text frames (the phone): the socket turns them, this only says so. */
  text: boolean;
  /** Whose socket it is (the server's say, never the app's): `user`, or `userId` for a person. */
  user?: PeerUser;
  userId?: string;
  /** The mode it opens with (`liveFileAccess`); `edit` when absent. */
  readonly mode?: LiveMode;
}

/** A socket joined to a document. */
export interface LiveSession {
  readonly mode: LiveMode;
  /** One binary message from the app (sync or awareness). Throws `LiveProtocolError` for one that isn't. */
  message(bytes: Uint8Array): void;
  leave(): void;
  /** What access allows now (the socket tells the app with `live.mode`). */
  setMode(mode: LiveMode): void;
}

export interface LiveEditOptions {
  /** The agent's presence while it works (and `agentLingerMs` after): where it is, what it selects and does. */
  presence?: Partial<PeerState>;
  /** The work lands in steps (`step()` between chunks) so people watch it fill in, within `progressiveMs`. */
  progressive?: boolean;
  /** Write a version once it is stored, with this note. */
  checkpoint?: { note?: string };
}

export interface LiveDocs {
  /** A socket joins a document (loading it into this process). */
  join(orgId: string, fileId: string, conn: LiveConn): Promise<LiveSession>;
  /**
   * Tools and jobs, any process: `fn` applied to the document at its head with `origin`, what it changed stored and
   * published, a version per the policy. `step` stores what is done so far (a progressive edit's pace).
   */
  edit<T>(
    orgId: string,
    fileId: string,
    origin: LiveOrigin,
    fn: (doc: Y.Doc, step: () => Promise<void>) => T | Promise<T>,
    opts?: LiveEditOptions,
  ): Promise<{ result: T; seq: number }>;
  /** A fresh copy at the head (agents' reads, exports, previews): the caller's to destroy. */
  read(orgId: string, fileId: string): Promise<{ doc: Y.Doc; seq: number }>;
  /** The head as one update (an app's first load over HTTP). */
  state(orgId: string, fileId: string): Promise<{ state: Uint8Array; seq: number }>;
  /** An agent's presence in a file (`null`: gone), from whatever process runs its tool. */
  setAgentPresence(
    orgId: string,
    fileId: string,
    who: { agentId: string; runId: string },
    state: Partial<PeerState> | null,
  ): Promise<void>;
  /** Who is in each file, as this process and the others' summaries say. */
  presenceOf(fileIds: string[]): Map<string, { kind: PeerKind; id: string; mode: "viewing" | "editing" }[]>;
  /** A version now (what this process holds is stored first): its number, or null when nothing new. */
  checkpoint(
    orgId: string,
    fileId: string,
    opts: { author: ArtifactAuthor; runId?: string | null; note?: string; force?: boolean },
  ): Promise<number | null>;
  /** Brings the file back to `version` for everyone in it, and records a version saying so: its number. */
  restore(orgId: string, fileId: string, version: number, actor: ArtifactAuthor): Promise<number>;
  /** Folds the stored changes into the state now (the job's work, in this process). */
  compact(orgId: string, fileId: string): Promise<void>;
  /** Shutdown: what this process holds is stored, its presence withdrawn, and it holds nothing more. */
  stop(): Promise<void>;
}

/** Changes applied from the database or another process: already stored, never stored again. */
const STORE = Symbol("live.store");

interface Pending {
  update: Uint8Array;
  actor: LiveChangeActor;
  session: Session | null;
}

interface Hosted {
  orgId: string;
  fileId: string;
  kind: LiveKind;
  channelId: string | null;
  doc: Y.Doc;
  presence: DocPresence;
  /** The newest stored change applied here. */
  seq: number;
  /** Changes this process stored past `seq` (applied already, skipped when they come back). */
  own: Set<number>;
  compactedSeq: number;
  /** Bytes stored since the last compaction this process saw. */
  sinceCompaction: number;
  /** The head a compaction was last asked at. */
  compactAsked: number;
  /** The five-minute window a quiet-spell job was armed for. */
  armedWindow: number;
  sessions: Set<Session>;
  /** Edits, reads and joins in progress. */
  users: number;
  linger: ReturnType<typeof setTimeout> | null;
  pending: Pending[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Batches are stored one at a time, in order. */
  storing: Promise<unknown>;
  failures: number;
  catching: Promise<void> | null;
  catchAgain: boolean;
  /** Edits run one at a time. */
  editing: Promise<unknown>;
  /** Its size, estimated from what was applied (measured exactly when it passes `docBytes`). */
  bytes: number;
  measuredAt: number;
  /** The limit it is past, or null. */
  over: string | null;
  relayDue: Set<number>;
  relayTimer: ReturnType<typeof setTimeout> | null;
  answeredAt: number;
  timers: ReturnType<typeof setInterval>[];
  off: Unsubscribe[];
  dead: boolean;
  /** Dropped because its file has no live document any more (purged, or its workspace deleted). */
  gone: boolean;
}

/** An agent's presence this process keeps saying. */
interface AgentHere {
  orgId: string;
  fileId: string;
  clientId: number;
  user: PeerUser;
  state: PeerState;
  clock: number;
  until: number;
  /** Edits in progress that hold it. */
  held: number;
  renew: ReturnType<typeof setInterval> | null;
}

class Session implements LiveSession {
  left = false;
  hidden = false;
  constructor(
    readonly hosted: Hosted,
    readonly conn: LiveConn,
    readonly user: PeerUser,
    public mode: LiveMode,
    private readonly owner: {
      message(s: Session, bytes: Uint8Array): void;
      leave(s: Session): void;
      setMode(s: Session, mode: LiveMode): void;
    },
  ) {}
  message(bytes: Uint8Array) {
    this.owner.message(this, bytes);
  }
  leave() {
    this.owner.leave(this);
  }
  setMode(mode: LiveMode) {
    this.owner.setMode(this, mode);
  }
}

/** A sync frame's update, when the frame writes (step 2 or update); null for anything else (or unreadable). */
function writtenUpdate(bytes: Uint8Array): Uint8Array | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== MSG_SYNC) return null;
    const kind = decoding.readVarUint(decoder);
    if (kind !== SYNC_STEP2 && kind !== SYNC_UPDATE) return null;
    return decoding.readVarUint8Array(decoder);
  } catch {
    return null;
  }
}

/**
 * A refusal of `@agenteschat/live`'s edits (`LiveEditError`) as the engine's errors: past a limit `live.too_large`,
 * anything else a plain invalid request, its words kept (they say what to fix).
 */
function editRefusal(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "LiveEditError") return error;
  const code = (error as { code?: unknown }).code;
  const message = error.message;
  if (code === "too_many" || code === "too_large") return new ValidationError(message, "live.too_large");
  return new ValidationError(message);
}

const actorKey = (a: LiveChangeActor) => `${a.type}:${a.id ?? ""}:${a.runId ?? ""}`;

export function createLiveDocs(deps: LiveDeps): LiveDocs {
  const { db, pubsub, replicaId, log } = deps;
  const timing: LiveTiming = { ...LIVE_TIMING, ...deps.timing, board: { ...LIVE_TIMING.board, ...deps.timing?.board } };
  const now = deps.now ?? (() => new Date());
  const entries = new Map<string, { promise: Promise<Hosted>; hosted: Hosted | null }>();
  const agents = new Map<string, Map<number, AgentHere>>();
  /** Files agents are in here that this process doesn't hold: their conversation (for `live.presence`). */
  const agentChannels = new Map<string, string | null>();
  const orgWatch = new Map<string, { off: Unsubscribe; docs: number }>();
  let stopped = false;

  const hostedOf = (fileId: string) => {
    const h = entries.get(fileId)?.hosted;
    return h && !h.dead ? h : null;
  };
  const allHosted = () => [...entries.values()].map((e) => e.hosted).filter((h): h is Hosted => !!h && !h.dead);

  // ── Presence across processes ─────────────────────────────────────────────────────────────────────────────────

  const board = createPresenceBoard({
    pubsub,
    replicaId,
    own: (fileId) => {
      const h = hostedOf(fileId);
      const mine = h ? h.presence.ownPeers() : [];
      for (const a of agents.get(fileId)?.values() ?? []) {
        mine.push({ kind: "agent", id: a.user.id, mode: a.state.mode });
      }
      return mine;
    },
    files: () => [...new Set([...allHosted().map((h) => h.fileId), ...agents.keys()])],
    channelOf: (fileId) => hostedOf(fileId)?.channelId ?? agentChannels.get(fileId) ?? null,
    timing: timing.board,
    now: () => now().getTime(),
  });

  const offResumed = pubsub.subscribe(listenResumedTopic, () => {
    // Events were missed while LISTEN was down: every held document reads its tail, presence is said again.
    for (const h of allHosted()) {
      void catchUp(h).catch((error: unknown) =>
        log.warn("live catch-up failed", { fileId: h.fileId, error: String(error) }),
      );
      relayNow(h, h.presence.ownedClients());
      void pubsub.publish(liveTopic(h.fileId), { type: "live.aw?", id: h.fileId, from: replicaId }).catch(() => {});
    }
    for (const list of agents.values()) for (const a of list.values()) publishAgent(a, a.state);
    void board.announceAll();
  });

  // ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────

  function send(s: Session, data: Uint8Array | string) {
    if (s.left) return;
    try {
      s.conn.send(data);
    } catch (error) {
      log.warn("live send failed", { fileId: s.hosted.fileId, error: String(error) });
    }
  }

  const control = (s: Session, c: LiveControl) => send(s, JSON.stringify(c));

  function broadcast(h: Hosted, message: Uint8Array, except: object | null) {
    for (const s of h.sessions) if (s !== except) send(s, message);
  }

  const broadcastUpdate = (h: Hosted, update: Uint8Array, except: Session | null) => {
    if (h.sessions.size === 0 || (h.sessions.size === 1 && except && h.sessions.has(except))) return;
    broadcast(h, updateMessage(update), except);
  };

  // ── Size and limits ───────────────────────────────────────────────────────────────────────────────────────────

  /** After `bytes` more were applied: whether the document is past a limit now. */
  function grew(h: Hosted, bytes: number) {
    h.bytes += bytes;
    let over = overLimit(h.doc, h.kind);
    if (!over && h.bytes > LIVE_LIMITS.docBytes) {
      const t = Date.now();
      if (t - h.measuredAt >= timing.measureMs) {
        h.bytes = Y.encodeStateAsUpdate(h.doc).byteLength;
        h.measuredAt = t;
      }
      if (h.bytes > LIVE_LIMITS.docBytes) over = "bytes";
    }
    const was = h.over;
    h.over = over;
    // Back under its limits: the apps whose changes were refused send them again (a Yjs app's later changes wait on
    // its earlier ones, so until then none of its changes could land).
    if (was && !over) for (const s of h.sessions) if (s.mode === "edit") send(s, syncStep1(h.doc));
  }

  // ── Loading and unloading ─────────────────────────────────────────────────────────────────────────────────────

  async function load(orgId: string, fileId: string): Promise<Hosted> {
    // Listening first: nothing published between the read and the subscription is missed.
    const early: RealtimeEvent[] = [];
    let held: Hosted | null = null;
    const offTopic = pubsub.subscribe(liveTopic(fileId), (event) => {
      if (event.from === replicaId) return;
      if (held) onTopic(held, event);
      else early.push(event);
    });
    try {
      const stored = await loadStored(db, orgId, fileId);
      if (!stored) throw new NotFoundError("Artifact not found", "artifact.not_found");
      const kind = stored.row.kind as LiveKind;
      const [artifact] = await db
        .select({ channelId: schema.artifacts.channelId })
        .from(schema.artifacts)
        .where(and(eq(schema.artifacts.id, fileId), eq(schema.artifacts.orgId, orgId)));
      const doc = docOf(stored.state, stored.changes, STORE);
      // The document's presence calls back into it once it is made.
      const ref: { hosted: Hosted | null } = { hosted: null };
      const presence = new DocPresence(doc, {
        broadcast: (message, except) => {
          if (ref.hosted) broadcast(ref.hosted, message, except);
        },
        relay: (ids) => {
          if (ref.hosted) relay(ref.hosted, ids);
        },
        changed: () => board.changed(fileId),
      });
      const h: Hosted = {
        orgId,
        fileId,
        kind,
        channelId: artifact?.channelId ?? null,
        doc,
        presence,
        seq: stored.seq,
        own: new Set(),
        compactedSeq: stored.row.compactedSeq,
        sinceCompaction: stored.changes.reduce((n, c) => n + c.bytes, 0),
        compactAsked: 0,
        armedWindow: -1,
        sessions: new Set(),
        users: 0,
        linger: null,
        pending: [],
        pendingBytes: 0,
        flushTimer: null,
        storing: Promise.resolve(),
        failures: 0,
        catching: null,
        catchAgain: false,
        editing: Promise.resolve(),
        bytes: stored.row.stateBytes + stored.changes.reduce((n, c) => n + c.bytes, 0),
        measuredAt: 0,
        over: null,
        relayDue: new Set(),
        relayTimer: null,
        answeredAt: 0,
        timers: [],
        off: [offTopic],
        dead: false,
        gone: false,
      };
      ref.hosted = h;
      grew(h, 0);
      const tail = setInterval(() => {
        void catchUp(h).catch((error: unknown) => log.warn("live tail check failed", { fileId, error: String(error) }));
      }, timing.tailCheckMs);
      const announce = setInterval(() => relayNow(h, h.presence.ownedClients()), timing.announceMs);
      unref(tail);
      unref(announce);
      h.timers.push(tail, announce);
      watchOrg(h);
      held = h;
      for (const event of early) onTopic(h, event);
      // Agents this process already shows in the file, and everyone the other processes hold, here too.
      for (const a of agents.get(fileId)?.values() ?? []) h.presence.applyAgent(a.clientId, a.clock, a.state, a.user);
      void pubsub.publish(liveTopic(fileId), { type: "live.aw?", id: fileId, from: replicaId }).catch(() => {});
      return h;
    } catch (error) {
      offTopic();
      throw error;
    }
  }

  async function acquire(orgId: string, fileId: string): Promise<Hosted> {
    for (;;) {
      let entry = entries.get(fileId);
      if (!entry) {
        const made: { promise: Promise<Hosted>; hosted: Hosted | null } = {
          promise: load(orgId, fileId),
          hosted: null,
        };
        entries.set(fileId, made);
        made.promise.then(
          (h) => {
            made.hosted = h;
          },
          () => {
            if (entries.get(fileId) === made) entries.delete(fileId);
          },
        );
        entry = made;
      }
      const h = await entry.promise;
      // Unloaded meanwhile: loaded again.
      if (h.dead) continue;
      if (h.orgId !== orgId) throw new NotFoundError("Artifact not found", "artifact.not_found");
      h.users++;
      if (h.linger) {
        clearTimeout(h.linger);
        h.linger = null;
      }
      return h;
    }
  }

  function release(h: Hosted) {
    h.users = Math.max(0, h.users - 1);
    lingerOn(h);
  }

  const busy = (h: Hosted) => h.dead || h.users > 0 || h.sessions.size > 0;

  function lingerOn(h: Hosted) {
    if (busy(h) || h.linger) return;
    h.linger = setTimeout(() => void unload(h), stopped ? 0 : timing.lingerMs);
    unref(h.linger);
  }

  async function unload(h: Hosted) {
    h.linger = null;
    if (busy(h)) return;
    // What sockets that left sent and isn't stored yet goes first.
    if (h.pending.length > 0) await flushAll(h);
    if (busy(h) || h.linger) return;
    dispose(h);
  }

  /** Lets go of a document: nothing more is read or sent for it here. */
  function dispose(h: Hosted) {
    if (h.dead) return;
    h.dead = true;
    if (entries.get(h.fileId)?.hosted === h) entries.delete(h.fileId);
    if (h.linger) clearTimeout(h.linger);
    if (h.flushTimer) clearTimeout(h.flushTimer);
    if (h.relayTimer) clearTimeout(h.relayTimer);
    h.linger = h.flushTimer = h.relayTimer = null;
    for (const timer of h.timers) clearInterval(timer);
    h.timers = [];
    for (const off of h.off) off();
    h.off = [];
    unwatchOrg(h.orgId);
    h.presence.destroy();
    h.doc.destroy();
    board.changed(h.fileId);
  }

  /**
   * Gives up on a document this process can't keep (its file is gone, or the database refuses its changes): its
   * sockets close (`code`), and what it holds unstored is dropped, since their apps keep their changes and send them
   * again to whichever process opens it next, which reads it fresh from the database.
   */
  function drop(h: Hosted, code: number, reason: string) {
    if (h.dead) return;
    h.gone = code === LIVE_CLOSE.notFound;
    const sessions = [...h.sessions];
    h.sessions.clear();
    h.pending = [];
    h.pendingBytes = 0;
    for (const s of sessions) {
      s.left = true;
      try {
        s.conn.close(code, reason);
      } catch {}
    }
    dispose(h);
  }

  // ── Who hides (ADR 0084) ──────────────────────────────────────────────────────────────────────────────────────

  function watchOrg(h: Hosted) {
    const watched = orgWatch.get(h.orgId);
    if (watched) {
      watched.docs++;
      return;
    }
    const off = pubsub.subscribe(orgTopic(h.orgId), (raw) => {
      const event = raw as { type?: string; event?: { type?: string; userId?: unknown } };
      if (event.type !== "org.broadcast" || event.event?.type !== "member.status") return;
      const userId = event.event.userId;
      if (typeof userId === "string") void hideAgain(h.orgId, userId);
    });
    orgWatch.set(h.orgId, { off, docs: 1 });
  }

  function unwatchOrg(orgId: string) {
    const watched = orgWatch.get(orgId);
    if (!watched) return;
    watched.docs--;
    if (watched.docs > 0) return;
    watched.off();
    orgWatch.delete(orgId);
  }

  /** A person changed their availability: in every file here, they show or hide from now on. */
  async function hideAgain(orgId: string, userId: string) {
    const theirs = allHosted().filter((h) => h.orgId === orgId && [...h.sessions].some((s) => s.user.id === userId));
    if (theirs.length === 0) return;
    const hides = await personHides(db, orgId, userId).catch(() => null);
    if (hides === null) return;
    for (const h of theirs) {
      for (const s of h.sessions) {
        if (s.user.id !== userId || s.hidden === hides) continue;
        s.hidden = hides;
        // Hidden now: gone from everyone's view. Shown again: their app's next presence update brings them back.
        if (hides) h.presence.dropSocket(s, s);
      }
    }
  }

  // ── Presence relay ────────────────────────────────────────────────────────────────────────────────────────────

  function relay(h: Hosted, ids: number[]) {
    for (const id of ids) h.relayDue.add(id);
    if (h.relayTimer || h.dead) return;
    h.relayTimer = setTimeout(() => {
      h.relayTimer = null;
      const due = [...h.relayDue];
      h.relayDue.clear();
      relayNow(h, due);
    }, timing.relayMs);
    unref(h.relayTimer);
  }

  function relayNow(h: Hosted, ids: number[]) {
    if (ids.length === 0 || h.dead) return;
    for (const part of h.presence.encode(ids)) {
      void pubsub
        .publish(liveTopic(h.fileId), { type: "live.aw", id: h.fileId, from: replicaId, u: toB64(part) })
        .catch(() => {});
    }
  }

  // ── Agents' presence ──────────────────────────────────────────────────────────────────────────────────────────

  /** An agent's clock: later than anything it said before, close to the time so another process's says later still. */
  const nextClock = (last: number) => Math.max(last + 1, Date.now());

  function publishAgent(a: AgentHere, state: PeerState | null) {
    const update = writeAwarenessUpdate([{ clientId: a.clientId, clock: a.clock, state }]);
    void pubsub
      .publish(liveTopic(a.fileId), { type: "live.aw", id: a.fileId, from: replicaId, u: toB64(update) })
      .catch(() => {});
    hostedOf(a.fileId)?.presence.applyAgent(a.clientId, a.clock, state, a.user);
  }

  function removeAgent(a: AgentHere) {
    const list = agents.get(a.fileId);
    if (list?.get(a.clientId) !== a) return;
    list.delete(a.clientId);
    if (list.size === 0) {
      agents.delete(a.fileId);
      agentChannels.delete(a.fileId);
    }
    if (a.renew) clearInterval(a.renew);
    a.renew = null;
    a.clock = nextClock(a.clock);
    publishAgent(a, null);
    board.changed(a.fileId);
  }

  async function setAgent(
    orgId: string,
    fileId: string,
    who: { agentId: string; runId: string },
    partial: Partial<PeerState>,
    until: number,
  ): Promise<AgentHere | null> {
    const user: PeerUser = { kind: "agent", id: who.agentId };
    const state = sanitizePeerState({ ...partial, mode: partial.mode ?? "editing", user }, { user, viewOnly: false });
    if (!state) return null;
    const clientId = agentClientId(who.runId, who.agentId);
    let list = agents.get(fileId);
    if (!list) {
      list = new Map();
      agents.set(fileId, list);
    }
    if (!hostedOf(fileId) && !agentChannels.has(fileId)) {
      const [row] = await db
        .select({ channelId: schema.artifacts.channelId })
        .from(schema.artifacts)
        .where(and(eq(schema.artifacts.id, fileId), eq(schema.artifacts.orgId, orgId)));
      agentChannels.set(fileId, row?.channelId ?? null);
    }
    let a = list.get(clientId);
    if (!a) {
      a = { orgId, fileId, clientId, user, state, clock: 0, until, held: 0, renew: null };
      list.set(clientId, a);
    }
    a.state = state;
    a.until = until;
    a.clock = nextClock(a.clock);
    publishAgent(a, state);
    if (!a.renew) {
      const here = a;
      here.renew = setInterval(
        () => {
          if (here.held === 0 && Date.now() >= here.until) return removeAgent(here);
          here.clock = nextClock(here.clock);
          publishAgent(here, here.state);
        },
        Math.min(timing.agentRenewMs, Math.max(50, timing.agentLingerMs)),
      );
      unref(here.renew);
    }
    board.changed(fileId);
    return a;
  }

  // ── Topic events ──────────────────────────────────────────────────────────────────────────────────────────────

  function onTopic(h: Hosted, event: RealtimeEvent) {
    if (h.dead) return;
    switch (event.type) {
      case "live.update": {
        const seq = Number(event.seq);
        if (!Number.isSafeInteger(seq) || seq <= h.seq || h.own.has(seq)) return;
        if (seq === h.seq + 1 && typeof event.u === "string") {
          applyStored(h, fromB64(event.u));
          h.seq = seq;
          advanceOwn(h);
          return;
        }
        void catchUp(h).catch((error: unknown) =>
          log.warn("live catch-up failed", { fileId: h.fileId, error: String(error) }),
        );
        return;
      }
      case "live.aw": {
        if (typeof event.u !== "string" || typeof event.from !== "string") return;
        try {
          h.presence.applyRemote(event.from, fromB64(event.u));
        } catch (error) {
          log.warn("live presence from another process unreadable", { fileId: h.fileId, error: String(error) });
        }
        return;
      }
      case "live.aw?": {
        // A process started holding the file: what this one holds goes to it (at most once a second).
        const t = Date.now();
        if (t - h.answeredAt < 1000) return;
        h.answeredAt = t;
        relayNow(h, h.presence.ownedClients());
        for (const a of agents.get(h.fileId)?.values() ?? []) publishAgent(a, a.state);
        return;
      }
      case "live.versions":
        for (const s of h.sessions) control(s, { type: "live.versions" });
        return;
    }
  }

  /** A change already stored (another process's, or read back): applied here and sent to this process's sockets. */
  function applyStored(h: Hosted, update: Uint8Array) {
    try {
      Y.applyUpdate(h.doc, update, STORE);
    } catch (error) {
      log.error("live stored change unreadable", { fileId: h.fileId, error: String(error) });
      return;
    }
    broadcastUpdate(h, update, null);
    h.sinceCompaction += update.byteLength;
    grew(h, update.byteLength);
  }

  /** `seq` moves past the changes this process stored itself, in order. */
  function advanceOwn(h: Hosted) {
    while (h.own.has(h.seq + 1)) {
      h.own.delete(h.seq + 1);
      h.seq++;
    }
    for (const seq of h.own) if (seq <= h.seq) h.own.delete(seq);
  }

  /** Reads what this process lacks from the database (one read at a time; a later ask reads once more after). */
  function catchUp(h: Hosted): Promise<void> {
    if (h.catching) {
      h.catchAgain = true;
      return h.catching;
    }
    const run = (async () => {
      do {
        h.catchAgain = false;
        const since = await readSince(db, h.orgId, h.fileId, h.seq);
        if (h.dead) return;
        if (!since) return drop(h, LIVE_CLOSE.notFound, "file gone");
        if (since.state) {
          // Behind a compaction: the whole state again, and the sockets get only what they lack.
          const before = Y.encodeStateVector(h.doc);
          Y.applyUpdate(h.doc, since.state, STORE);
          for (const change of since.changes) if (!h.own.has(change.seq)) Y.applyUpdate(h.doc, change.update, STORE);
          const missing = Y.encodeStateAsUpdate(h.doc, before);
          broadcastUpdate(h, missing, null);
          grew(h, missing.byteLength);
        } else {
          for (const change of since.changes) {
            if (change.seq <= h.seq || h.own.has(change.seq)) continue;
            applyStored(h, change.update);
          }
        }
        if (since.row.compactedSeq > h.compactedSeq) {
          h.compactedSeq = since.row.compactedSeq;
          h.sinceCompaction = 0;
        }
        h.seq = Math.max(h.seq, since.head);
        advanceOwn(h);
      } while (h.catchAgain && !h.dead);
    })().finally(() => {
      h.catching = null;
    });
    h.catching = run;
    return run;
  }

  // ── Storing ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * After changes are stored: this process skips them when they come back, the other processes hear of them, and
   * the jobs the change arms (a quiet-spell version, a compaction) were armed in its transaction.
   */
  function stored(h: Hosted, appended: Appended, changes: readonly { update: Uint8Array }[], at: Date) {
    for (const seq of appended.seqs) h.own.add(seq);
    advanceOwn(h);
    if (appended.compactedSeq > h.compactedSeq) {
      h.compactedSeq = appended.compactedSeq;
      h.sinceCompaction = 0;
    }
    h.armedWindow = checkpointWindow(at);
    for (const [i, seq] of appended.seqs.entries()) {
      const update = changes[i]?.update;
      if (!update) continue;
      h.sinceCompaction += update.byteLength;
      const event: RealtimeEvent = { type: "live.update", id: h.fileId, seq, from: replicaId };
      // Base64 grows bytes by a third: one that can't fit isn't even encoded.
      const inline = update.byteLength < (INLINE_BYTES * 3) / 4 ? { ...event, u: toB64(update) } : null;
      const fits = inline !== null && JSON.stringify(inline).length < INLINE_BYTES;
      void pubsub.publish(liveTopic(h.fileId), fits ? inline : event).catch(() => {});
    }
  }

  /** In the changes' transaction: the quiet-spell version (once a window) and a compaction once enough waits. */
  async function armJobs(tx: Executor, h: Hosted, appended: Appended, at: Date, bytes: number) {
    if (h.armedWindow !== checkpointWindow(at)) await armIdleCheckpoint(tx, h.orgId, h.fileId, at);
    const waiting = appended.headSeq - appended.compactedSeq;
    const heavy = h.sinceCompaction + bytes >= LIVE_COMPACTION.bytes;
    // Asked again only after half as many more changes, while the one asked hasn't run.
    const askedLately = appended.headSeq - h.compactAsked < LIVE_COMPACTION.changes / 2;
    if ((waiting >= LIVE_COMPACTION.changes || heavy) && !askedLately) {
      await enqueueCompaction(tx, h.orgId, h.fileId, appended.headSeq);
      h.compactAsked = appended.headSeq;
    }
  }

  /** Stores what the sockets sent since the last batch: one row per author. True when stored (or nothing was due). */
  async function storeBatch(h: Hosted): Promise<boolean> {
    if (h.dead || h.pending.length === 0) return true;
    const batch = h.pending;
    const bytes = h.pendingBytes;
    h.pending = [];
    h.pendingBytes = 0;
    const groups = new Map<string, { actor: LiveChangeActor; updates: Uint8Array[] }>();
    for (const p of batch) {
      const key = actorKey(p.actor);
      const group = groups.get(key) ?? { actor: p.actor, updates: [] };
      group.updates.push(p.update);
      groups.set(key, group);
    }
    const changes = [...groups.values()].map((g) => ({
      actor: g.actor,
      update: g.updates.length === 1 ? (g.updates[0] as Uint8Array) : Y.mergeUpdates(g.updates),
    }));
    const at = now();
    let appended: Appended;
    try {
      appended = await appendChanges(db, h.orgId, h.fileId, changes, at, {
        inTx: (tx, a) => armJobs(tx, h, a, at, bytes),
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        drop(h, LIVE_CLOSE.notFound, "file gone");
        return false;
      }
      h.pending = [...batch, ...h.pending];
      h.pendingBytes += bytes;
      h.failures++;
      log.warn("live changes not stored yet", { fileId: h.fileId, failures: h.failures, error: String(error) });
      if (h.failures > timing.retryMs.length || h.pendingBytes > timing.maxPendingBytes) {
        drop(h, LIVE_CLOSE.internal, "changes can't be stored");
      }
      return false;
    }
    h.failures = 0;
    stored(h, appended, changes, at);
    // Stored: now the file's other sockets see them, each frame as it came.
    for (const p of batch) broadcastUpdate(h, p.update, p.session);
    // A socket whose changes are all stored hears so.
    const senders = new Set(batch.map((p) => p.session).filter((s): s is Session => s !== null));
    for (const s of senders) {
      if (!h.pending.some((p) => p.session === s)) control(s, { type: "live.saved", seq: appended.headSeq });
    }
    return true;
  }

  /** One batch, after any before it. */
  function storeNext(h: Hosted): Promise<boolean> {
    const run = h.storing.then(() => storeBatch(h));
    h.storing = run.catch(() => false);
    return run;
  }

  function scheduleFlush(h: Hosted, delay = timing.coalesceMs) {
    if (h.flushTimer || h.dead || h.pending.length === 0) return;
    h.flushTimer = setTimeout(() => {
      h.flushTimer = null;
      void storeNext(h).then((ok) => {
        if (h.pending.length > 0) {
          const wait = ok ? timing.coalesceMs : (timing.retryMs[Math.max(0, h.failures - 1)] ?? timing.coalesceMs);
          scheduleFlush(h, wait);
        }
      });
    }, delay);
    unref(h.flushTimer);
  }

  /** Stores everything this process holds of the document now (a version, a compaction, shutdown). */
  async function flushAll(h: Hosted) {
    if (h.flushTimer) {
      clearTimeout(h.flushTimer);
      h.flushTimer = null;
    }
    for (let round = 0; round < 20 && !h.dead; round++) {
      await h.storing;
      if (h.pending.length === 0) return;
      if (!(await storeNext(h))) {
        scheduleFlush(h, timing.retryMs[0]);
        return;
      }
    }
  }

  /** A socket's change, applied already: it waits `coalesceMs` to be stored with what follows it. */
  function took(h: Hosted, update: Uint8Array, s: Session) {
    h.pending.push({ update, actor: { type: "person", id: s.user.id }, session: s });
    h.pendingBytes += update.byteLength;
    grew(h, update.byteLength);
    if (h.pendingBytes > timing.maxPendingBytes) {
      drop(h, LIVE_CLOSE.internal, "changes can't be stored");
      return;
    }
    scheduleFlush(h);
  }

  // ── Sockets ───────────────────────────────────────────────────────────────────────────────────────────────────

  function message(s: Session, bytes: Uint8Array) {
    const h = s.hosted;
    if (s.left || h.dead) return;
    if (bytes.byteLength > LIVE_LIMITS.updateBytes) return control(s, { type: "live.error", code: "too_large" });
    const written = writtenUpdate(bytes);
    // Past its limits, a document takes only what removes (or changes nothing new).
    if (written && s.mode === "edit" && h.over && updateInserts(written)) {
      return control(s, { type: "live.error", code: "too_large" });
    }
    const result = readMessage(bytes, {
      doc: h.doc,
      awareness: h.presence.awareness,
      origin: s,
      allowWrite: s.mode === "edit",
      filterAwareness: (entry) =>
        h.presence.filter(s, { user: s.user, viewOnly: s.mode !== "edit", hidden: s.hidden }, entry),
    });
    if (result.rejected) control(s, { type: "live.error", code: "read_only" });
    if (result.reply) send(s, result.reply);
    if (result.type === "sync" && result.update) took(h, result.update, s);
    if (result.error) {
      log.warn("live change applied with an observer error", { fileId: h.fileId, error: String(result.error) });
    }
  }

  function leave(s: Session) {
    if (s.left) return;
    s.left = true;
    const h = s.hosted;
    h.sessions.delete(s);
    if (h.dead) return;
    h.presence.dropSocket(s, s);
    if (h.sessions.size === 0) {
      // A minute after the last person leaves, what they did is folded in.
      if (h.seq > h.compactedSeq) {
        const at = new Date(now().getTime() + LIVE_COMPACTION.afterLeaveMs);
        void enqueueCompaction(db, h.orgId, h.fileId, h.seq, at).catch((error: unknown) =>
          log.warn("live compaction not asked", { fileId: h.fileId, error: String(error) }),
        );
      }
      lingerOn(h);
    }
    board.changed(h.fileId);
  }

  /**
   * What access allows a socket now. Allowed to change the file again, the app is asked what the document lacks: a
   * change refused while it was read-only holds back every later change of that app until it arrives.
   */
  function setMode(s: Session, mode: LiveMode) {
    const was = s.mode;
    s.mode = mode;
    if (was === "view" && mode === "edit" && !s.left && !s.hosted.dead) send(s, syncStep1(s.hosted.doc));
  }

  const sessionOwner = { message, leave, setMode };

  // ── Edits ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A document let go of while in use: its file is gone, or this process gave it up (the caller may try again). */
  function alive(h: Hosted) {
    if (!h.dead) return;
    if (h.gone) throw new NotFoundError("Artifact not found", "artifact.not_found");
    throw new Error("The file was closed while in use here: try again");
  }

  /** One edit at a time per document. */
  function serially<T>(h: Hosted, work: () => Promise<T>): Promise<T> {
    const run = h.editing.then(work);
    h.editing = run.catch(() => undefined);
    return run;
  }

  /** Stores an edit's change: numbered, published, then sent to the file's sockets. Its number. */
  async function storeEdit(h: Hosted, update: Uint8Array, actor: LiveChangeActor): Promise<number> {
    const at = now();
    const appended = await appendChanges(db, h.orgId, h.fileId, [{ update, actor }], at, {
      inTx: (tx, a) => armJobs(tx, h, a, at, update.byteLength),
    });
    stored(h, appended, [{ update }], at);
    broadcastUpdate(h, update, null);
    return appended.headSeq;
  }

  /**
   * The edit itself on a document past its limits: run on a copy first, and refused when it would add anything
   * (deletions still land, so the file can come back under its limits).
   */
  async function editPastLimit<T>(
    h: Hosted,
    origin: LiveOrigin,
    fn: (doc: Y.Doc, step: () => Promise<void>) => T | Promise<T>,
  ) {
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(h.doc));
      const before = Y.encodeStateVector(copy);
      const result = await copy.transact(() => fn(copy, async () => {}), origin);
      const update = Y.encodeStateAsUpdate(copy, before);
      if (updateInserts(update)) {
        throw new ValidationError("This file is at its size limit: remove something from it first", "live.too_large");
      }
      return { result, update };
    } finally {
      copy.destroy();
    }
  }

  async function runEdit<T>(
    h: Hosted,
    origin: LiveOrigin,
    fn: (doc: Y.Doc, step: () => Promise<void>) => T | Promise<T>,
    opts: LiveEditOptions,
  ): Promise<{ result: T; seq: number }> {
    await catchUp(h);
    alive(h);
    const actor = changeActorOf(origin);
    const agent =
      origin.kind === "agent" && origin.agentId ? { agentId: origin.agentId, runId: origin.runId ?? null } : null;
    let here: AgentHere | null = null;
    if (agent?.runId && opts.presence) {
      here = await setAgent(h.orgId, h.fileId, { agentId: agent.agentId, runId: agent.runId }, opts.presence, Infinity);
      if (here) here.held++;
    }
    const captured: Uint8Array[] = [];
    const capture = (update: Uint8Array, from: unknown) => {
      if (from !== STORE && !(from instanceof Session)) captured.push(update);
    };
    const startSeq = h.seq;
    let seq = h.seq;
    const storeCaptured = async () => {
      if (captured.length === 0) return;
      const update = captured.length === 1 ? (captured[0] as Uint8Array) : Y.mergeUpdates(captured);
      captured.length = 0;
      try {
        seq = await storeEdit(h, update, actor);
      } catch (error) {
        // In this document and not stored: it can't stay. Its sockets reload from the database.
        if (error instanceof NotFoundError) drop(h, LIVE_CLOSE.notFound, "file gone");
        else drop(h, LIVE_CLOSE.internal, "changes can't be stored");
        throw error;
      }
    };
    const deadline = Date.now() + timing.progressiveMs;
    const step = opts.progressive
      ? async () => {
          await storeCaptured();
          const wait = Math.min(timing.stepMs, deadline - Date.now());
          if (wait > 0) await Bun.sleep(wait);
        }
      : async () => {};
    let result: T | undefined;
    let failure: unknown = null;
    try {
      if (h.over) {
        const done = await editPastLimit(h, origin, fn);
        result = done.result;
        Y.applyUpdate(h.doc, done.update, origin);
        captured.push(done.update);
      } else {
        // Each change the work makes is caught as it lands, so a step stores what came before it (one transaction
        // around the whole work would only end at its first wait).
        h.doc.on("update", capture);
        try {
          result = await fn(h.doc, step);
        } finally {
          h.doc.off("update", capture);
        }
      }
    } catch (error) {
      failure = editRefusal(error);
    }
    try {
      // What it changed before failing is in the document: stored all the same.
      await storeCaptured();
    } finally {
      if (here) {
        here.held = Math.max(0, here.held - 1);
        here.until = Date.now() + timing.agentLingerMs;
      }
    }
    if (failure) throw failure;
    grew(h, 0);
    if (seq > startSeq) await afterEdit(h, origin, agent, opts);
    return { result: result as T, seq };
  }

  /** The version an edit writes: the one it asked for, or an agent's per the policy (a failure only logged). */
  async function afterEdit(
    h: Hosted,
    origin: LiveOrigin,
    agent: { agentId: string; runId: string | null } | null,
    opts: LiveEditOptions,
  ) {
    try {
      const author: ArtifactAuthor | null = agent
        ? { type: "agent", id: agent.agentId }
        : origin.userId
          ? { type: "person", id: origin.userId }
          : null;
      const due =
        opts.checkpoint !== undefined ||
        (agent !== null && (await agentCheckpointDue(db, h.fileId, agent.agentId, agent.runId, now())));
      if (!due) return;
      const version = await writeCheckpoint(deps, h.orgId, h.fileId, {
        author,
        runId: agent?.runId ?? null,
        note: opts.checkpoint?.note ?? null,
        force: opts.checkpoint !== undefined,
        now: now(),
      });
      if (version !== null) versionWritten(h.fileId);
    } catch (error) {
      log.warn("live version not written", { fileId: h.fileId, error: String(error) });
    }
  }

  /** A version was written: this process's sockets on the file refresh their history, and the others' do too. */
  function versionWritten(fileId: string) {
    const h = hostedOf(fileId);
    if (h) for (const s of h.sessions) control(s, { type: "live.versions" });
    void pubsub.publish(liveTopic(fileId), { type: "live.versions", id: fileId, from: replicaId }).catch(() => {});
  }

  // ── The documents ─────────────────────────────────────────────────────────────────────────────────────────────

  const docs: LiveDocs = {
    async join(orgId, fileId, conn) {
      if (stopped) throw new Error("This server is stopping");
      const userId = conn.user?.id ?? conn.userId;
      if (!userId) throw new ValidationError("A live file's socket needs its person");
      const user: PeerUser = { kind: conn.user?.kind ?? "person", id: userId };
      const h = await acquire(orgId, fileId);
      try {
        const hidden = user.kind === "person" ? await personHides(db, orgId, userId) : false;
        alive(h);
        const s = new Session(h, conn, user, conn.mode ?? "edit", sessionOwner);
        s.hidden = hidden;
        h.sessions.add(s);
        control(s, { type: "live.ready", mode: s.mode, seq: h.seq });
        send(s, syncStep1(h.doc));
        const everyone = h.presence.everyone();
        if (everyone) send(s, everyone);
        return s;
      } finally {
        release(h);
      }
    },

    async edit(orgId, fileId, origin, fn, opts = {}) {
      if (!isLiveOrigin(origin)) throw new ValidationError("A live edit needs its origin");
      const h = await acquire(orgId, fileId);
      try {
        return await serially(h, () => runEdit(h, origin, fn, opts));
      } finally {
        release(h);
      }
    },

    async read(orgId, fileId) {
      const h = await acquire(orgId, fileId);
      try {
        await catchUp(h);
        alive(h);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(h.doc));
        return { doc, seq: h.seq };
      } finally {
        release(h);
      }
    },

    async state(orgId, fileId) {
      const h = hostedOf(fileId);
      if (h && h.orgId === orgId) return { state: Y.encodeStateAsUpdate(h.doc), seq: h.seq };
      const head = await loadHeadState(db, orgId, fileId);
      if (!head) throw new NotFoundError("Artifact not found", "artifact.not_found");
      return { state: head.state, seq: head.seq };
    },

    async setAgentPresence(orgId, fileId, who, state) {
      if (state === null) {
        const a = agents.get(fileId)?.get(agentClientId(who.runId, who.agentId));
        if (a) removeAgent(a);
        return;
      }
      await setAgent(orgId, fileId, who, state, Date.now() + timing.agentLingerMs);
    },

    presenceOf(fileIds) {
      const out = new Map<string, { kind: PeerKind; id: string; mode: "viewing" | "editing" }[]>();
      for (const fileId of fileIds) {
        const peers = new Map<string, PresencePeer>();
        const add = (p: PresencePeer) => {
          const key = `${p.kind}:${p.id}`;
          const seen = peers.get(key);
          if (!seen || (seen.mode === "viewing" && p.mode === "editing")) peers.set(key, p);
        };
        const h = hostedOf(fileId);
        if (h) for (const p of h.presence.peers()) add(p);
        for (const a of agents.get(fileId)?.values() ?? []) add({ kind: "agent", id: a.user.id, mode: a.state.mode });
        for (const p of board.remoteOf(fileId)) add(p);
        out.set(fileId, [...peers.values()]);
      }
      return out;
    },

    async checkpoint(orgId, fileId, opts) {
      const h = hostedOf(fileId);
      if (h && h.orgId === orgId) await flushAll(h);
      const version = await writeCheckpoint(deps, orgId, fileId, {
        author: opts.author,
        runId: opts.runId ?? null,
        note: opts.note ?? null,
        force: opts.force,
        now: now(),
      });
      if (version !== null) versionWritten(fileId);
      return version;
    },

    async restore(orgId, fileId, version, actor) {
      const snapshot = await liveSnapshotOf(deps, orgId, fileId, version);
      // The version this writes must fit before anything changes, or the file would go back with nothing saying so.
      const location = await deps.blobs.forOrg(orgId);
      if (location.storageConfigId === null) await assertStorageRoom(db, orgId, snapshot.byteLength);
      const from = new Y.Doc();
      try {
        Y.applyUpdate(from, snapshot);
        const origin = originFor(actor);
        await docs.edit(orgId, fileId, origin, (doc) => replaceLiveDoc(doc, from, origin));
      } finally {
        from.destroy();
      }
      const note = await restoredNote(db, actor, version);
      const written = await docs.checkpoint(orgId, fileId, { author: actor, note, force: true });
      const [row] = await db
        .select({ currentVersion: schema.artifacts.currentVersion })
        .from(schema.artifacts)
        .where(and(eq(schema.artifacts.id, fileId), eq(schema.artifacts.orgId, orgId)));
      const current = written ?? row?.currentVersion ?? version;
      await recordAudit(db, {
        orgId,
        actor: { type: actor.type, id: actor.id },
        action: "artifact.version_restored",
        target: { type: "artifact", id: fileId },
        details: { from: version, version: current },
      });
      return current;
    },

    async compact(orgId, fileId) {
      const h = hostedOf(fileId);
      if (h && h.orgId === orgId) await flushAll(h);
      const done = await compactLiveDoc({ ...deps, log }, orgId, fileId, now());
      if (h && done?.compacted && done.seq > h.compactedSeq) {
        h.compactedSeq = done.seq;
        h.sinceCompaction = 0;
      }
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      offResumed();
      const held = allHosted();
      for (const h of held) {
        for (const s of [...h.sessions]) {
          try {
            s.conn.close(LIVE_CLOSE.goingAway, "server restarting");
          } catch {}
          leave(s);
        }
      }
      await Promise.all(
        held.map((h) =>
          flushAll(h).catch((error: unknown) =>
            log.warn("live changes not stored at shutdown", { fileId: h.fileId, error: String(error) }),
          ),
        ),
      );
      for (const list of [...agents.values()]) for (const a of [...list.values()]) removeAgent(a);
      await board.stop();
      for (const h of held) if (h.users === 0) dispose(h);
    },
  };
  return docs;
}
