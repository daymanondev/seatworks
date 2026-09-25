import { keptLetters } from "./kept-letters.ts";
import type { AgentRef, Lane, Ledger, Task } from "./ledger.ts";
import type { Project } from "./project.ts";
import type { DeskServices } from "./services.ts";

/** The Peer kept idle in a lane's copy: bound to the lane, and its task there accepted and still naming it. */
export function keptPeer(ledger: Ledger, laneId: string): AgentRef | undefined {
  return Object.values(ledger.agents).find((agent) => {
    const task = ledger.tasks[agent.task ?? ""];
    return agent.lane === laneId && task?.peer === agent.id && task.kind === "code" && task.mode === "lane" && task.status === "merged";
  });
}

/**
 * Whom a task starting in the lane's copy goes to: the kept Peer, unless the task asks for a fresh one, needs another role,
 * the team now starts that role as another agent, model or thinking, or the Peer is gone.
 */
export async function keptTaker(desk: DeskServices, project: Project, kept: AgentRef | undefined, task: Task): Promise<string | undefined> {
  if (!kept || task.opening?.fresh || kept.role !== task.opening?.role) return undefined;
  if (!kept.startedAs || kept.startedAs !== desk.agents.startsAs(project, kept.role)) return undefined;
  return (await desk.roster.seated(kept.id)) ? kept.id : undefined;
}

/** Mails a task's brief to the kept Peer the claim bound it to, and records the hand-off. */
export async function handOver(desk: DeskServices, project: Project, lane: Lane, task: Task, from: string): Promise<void> {
  await desk.ctx.post(task.peer, keptLetters.brief(task, lane));
  desk.ctx.event(project, { kind: "task.handed", task: task.id, peer: task.peer!, from });
}
