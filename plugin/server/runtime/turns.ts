import { type Kit, type RoleSpec, can, seatOf, worksTasks } from "../catalog/kit.ts";
import type { TurnEnded } from "../core/ports.ts";
import { DECIDED, TASK } from "../domain/task.ts";
import type { Desk } from "../desk/desk.ts";
import { type Ledger, laneOfLead, loadLedger, taskOfPeer } from "../desk/ledger.ts";
import { letters } from "../desk/letters.ts";
import { type Project, projectOf } from "../desk/project.ts";
import { deniedCall, lastToolCall, outputText } from "./timeline.ts";

type TurnDeps = {
  kit: Kit;
  desk: Desk;
  remember: (project: Project) => void;
};

export class TurnRules {
  readonly lastEnding = new Map<string, string>();
  private readonly deps: TurnDeps;
  private readonly startedAt = new Map<string, number>();

  constructor(deps: TurnDeps) {
    this.deps = deps;
  }

  started(agentId: string): void {
    this.startedAt.set(agentId, Date.now());
  }

  forget(agentId: string): void {
    this.startedAt.delete(agentId);
    this.lastEnding.delete(agentId);
  }

  async ownerOf(project: Project, agentId: string, role: RoleSpec): Promise<string | undefined> {
    // A Lead's owner is whoever supervises; an unreadable ledger must not stop its failures reaching anyone.
    if (can(role, "lead")) {
      let opener: string | undefined;
      try {
        opener = laneOfLead(loadLedger(project.state), agentId)?.opener;
      } catch {}
      return this.deps.desk.supervisorFor(project, opener);
    }
    const ledger = loadLedger(project.state);
    const task = taskOfPeer(ledger, agentId);
    return task ? ledger.lanes[task.lane]?.lead : undefined;
  }

  async ended(event: TurnEnded): Promise<void> {
    const { agent, outcome, timeline } = event;
    const role = seatOf(this.deps.kit, agent.provider)?.role;
    if (!role?.tools) return;
    const project = projectOf(agent.cwd);
    this.deps.remember(project);
    const started = this.startedAt.get(agent.id) ?? Date.now() - 30 * 60_000;
    this.startedAt.delete(agent.id);
    if (outcome.kind === "canceled") return;
    const text = outputText(timeline);
    this.lastEnding.set(agent.id, text);
    if (outcome.kind === "failed") {
      const owner = await this.ownerOf(project, agent.id, role);
      await this.deps.desk.post(owner, `failed:${agent.id}:${event.turnId ?? Date.now()}`, letters.failed(`${role.label} ${agent.title ?? agent.id}`, outcome.error.message));
      return;
    }
    const ledger = loadLedger(project.state);
    const recorded = (ledger.agents[agent.id]?.recordedAt ?? 0) >= started;
    // The read-only status tool counts as heard from, but not as reaching somebody.
    const spoke = (ledger.agents[agent.id]?.spokeAt ?? 0) >= started;
    if (worksTasks(role)) await this.workerEnded(project, ledger, event, text, recorded, spoke);
  }

  private async workerEnded(project: Project, ledger: Ledger, event: TurnEnded, text: string, recorded: boolean, spoke: boolean): Promise<void> {
    const { desk } = this.deps;
    const { agent, timeline } = event;
    const task = taskOfPeer(ledger, agent.id);
    if (!task) return;
    if (DECIDED.includes(task.status) && !recorded) return;
    const lane = ledger.lanes[task.lane];
    if (recorded || task.status === "done") {
      // Heard from, so the quiet count restarts; left standing it was a lifetime tally.
      if (spoke && task.silent > 0) await desk.setTask(project, task.id, (entry) => { entry.silent = 0; });
      // Nothing else sets a stalled task back to running once its Peer works again.
      if (recorded && task.status === "stalled") await desk.moveTask(project, task.id, "resume", (entry) => { delete entry.peerGone; });
      return;
    }
    // A call still in flight is not silence: a nudge here started a second gate beside the first.
    if (desk.inFlight(agent.id)) return;
    const denied = deniedCall(timeline, this.deps.kit.ecosystem.watch.refused);
    desk.event(project, { kind: "turn.silent", task: task.id, denied: denied?.what ?? null, refused: denied?.refused ?? false, lastCall: JSON.stringify(lastToolCall(timeline) ?? null).slice(0, 600) });
    const updated = await desk.setTask(project, task.id, (entry) => {
      entry.silent += 1;
      if (entry.silent >= 2 || denied) TASK.move(entry, "stall");
    });
    if (!updated) return;
    if (updated.status !== "stalled") {
      await desk.post(agent.id, `nudge:${task.id}:${updated.silent}:${Date.now()}`, letters.nudge("done"));
      return;
    }
    await desk.post(lane?.lead, `silent:${task.id}:${updated.silent}`, letters.stalled(task, text, updated.silent, denied));
    desk.event(project, { kind: "task.silent", task: task.id, denied: denied?.what ?? null, refused: denied?.refused ?? false });
  }
}
