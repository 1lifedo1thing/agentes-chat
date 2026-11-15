import type { AgentPointer, RunnerFrame } from "@agenteschat/adapters";
import { type Stream, screenOf } from "../streams";

/** A person with a screen open, and the agent they opened it for (the right hand's seat is shown under its agent). */
export interface DesktopPointerViewer {
  orgId: string;
  userId: string;
  agentId: string;
}

/** The user event the apps draw the agent's cursor from; `replay` marks the last one, sent as a view opens. */
export type DesktopPointerEvent = {
  type: "agent.desktop.pointer";
  agentId: string;
  pointer: AgentPointer & { replay?: true };
};

/**
 * The agent's pointer on its desktop (ADR 0062): each report to who has that screen open now, and the newest one per
 * screen kept in memory where its computer's socket is, sent once to a person whose view of it opens. A screen is
 * the agent's, or a seat of the right hand (ADR 0175), by the id its computer says it under. Forgotten when that
 * computer's socket closes here; never written anywhere.
 */
export function createDesktopPointers(deps: {
  viewers(screenId: string, machineId: string): DesktopPointerViewer[];
  send(viewer: DesktopPointerViewer, event: DesktopPointerEvent): void;
}) {
  const last = new Map<string, { machineId: string; pointer: AgentPointer }>();
  return {
    report(
      machineId: string,
      { type: _type, agentId: screenId, ...pointer }: Extract<RunnerFrame, { type: "desktop.pointer" }>,
    ) {
      last.set(screenId, { machineId, pointer });
      for (const viewer of deps.viewers(screenId, machineId)) {
        deps.send(viewer, { type: "agent.desktop.pointer", agentId: viewer.agentId, pointer });
      }
    },

    /** A person's stream of a screen opened (or changed mode): where the agent's pointer rests on it. */
    opened(stream: Pick<Stream, "orgId" | "userId" | "agentId" | "scope" | "machineId" | "request">) {
      if (stream.request.kind !== "desktop") return;
      const kept = last.get(screenOf(stream));
      if (!kept || kept.machineId !== stream.machineId) return;
      const { orgId, userId, agentId } = stream;
      deps.send(
        { orgId, userId, agentId },
        { type: "agent.desktop.pointer", agentId, pointer: { ...kept.pointer, replay: true } },
      );
    },

    /** The computer's socket closed here: its screens' pointers are forgotten. */
    closed(machineId: string) {
      for (const [screenId, kept] of last) if (kept.machineId === machineId) last.delete(screenId);
    },
  };
}

export type DesktopPointers = ReturnType<typeof createDesktopPointers>;
