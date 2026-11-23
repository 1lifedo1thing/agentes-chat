import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import type { Database } from "@agenteschat/db";
import { recordProcessVitals } from "@agenteschat/engine";
import type { EventLoopLag } from "./event-loop-lag";
import type { Logger } from "./logger";

export const PROCESS_VITALS_EVERY_MS = 60_000;

export interface ProcessHealthDeps {
  db: Database;
  log: Pick<Logger, "info" | "warn" | "error">;
  role: string;
  version: string;
  eventLoopLag: () => EventLoopLag | null;
  /** `HEAP_SNAPSHOT_MB`: past this heap, one snapshot; absent: never. */
  heapSnapshotMb?: number;
  heapSnapshotDir?: string;
  memoryUsage?: () => NodeJS.MemoryUsage;
  writeSnapshot?: (path: string) => string;
}

/**
 * Writes this process's memory and event loop delay to `server_processes` once a minute, for the operator's
 * `GET /vitals`, and its one heap snapshot once its heap passes `HEAP_SNAPSHOT_MB`. Returns a tick (tests) and a stop.
 */
export function watchProcessHealth(deps: ProcessHealthDeps, everyMs = PROCESS_VITALS_EVERY_MS) {
  const id = crypto.randomUUID();
  const startedAt = new Date();
  const memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage());
  const writeSnapshot = deps.writeSnapshot ?? writeHeapSnapshot;
  let snapshot: { at: Date; file: string } | null = null;
  let snapshotTried = false;

  const tick = async () => {
    const memory = memoryUsage();
    const limit = deps.heapSnapshotMb;
    if (limit && !snapshotTried && memory.heapUsed > limit * 1024 * 1024) {
      // Once per process start, failed or not: a second one would pause the process again for what the first showed.
      snapshotTried = true;
      const file = `heap-${deps.role}-${startedAt.toISOString().replace(/[:.]/g, "-")}-${process.pid}.heapsnapshot`;
      const path = join(deps.heapSnapshotDir ?? tmpdir(), file);
      deps.log.warn("heap past HEAP_SNAPSHOT_MB: writing a heap snapshot", { heapUsed: memory.heapUsed, path });
      try {
        writeSnapshot(path);
        snapshot = { at: new Date(), file };
        deps.log.warn("heap snapshot written", { path });
      } catch (error) {
        deps.log.error("heap snapshot failed", { path, error });
      }
    }
    const lag = deps.eventLoopLag();
    await recordProcessVitals(deps.db, {
      id,
      role: deps.role,
      version: deps.version,
      startedAt,
      seenAt: new Date(),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      eventLoopP99Ms: lag?.p99Ms ?? null,
      eventLoopMaxMs: lag?.maxMs ?? null,
      heapSnapshotAt: snapshot?.at ?? null,
      heapSnapshotFile: snapshot?.file ?? null,
    });
  };
  const run = () =>
    void tick().catch((error: unknown) => deps.log.warn("process vitals not recorded", { error: String(error) }));
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return { id, tick, stop: () => clearInterval(timer) };
}
