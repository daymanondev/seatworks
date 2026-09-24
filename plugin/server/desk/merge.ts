import { commitsAhead, diffCounts, mergeBranch, outsideOwned } from "../core/git.ts";
import { fileKinds } from "../catalog/kit.ts";
import { workState } from "../catalog/project-files.ts";
import type { Agents } from "./agents.ts";
import { type DeskContext } from "./context.ts";
import { errorText } from "../core/errors.ts";
import { TASK } from "../domain/task.ts";
import { gateNote } from "./gates.ts";
import { letters } from "./letters.ts";
import type { Project } from "./project.ts";

export class MergeQueue {
  private readonly ctx: DeskContext;
  private readonly agents: Agents;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(ctx: DeskContext, agents: Agents) {
    this.ctx = ctx;
    this.agents = agents;
  }

  settled(project: Project): Promise<unknown> {
    return this.queues.get(project.slug) ?? Promise.resolve();
  }

  enqueue(project: Project, taskId: string): void {
    const previous = this.queues.get(project.slug) ?? Promise.resolve();
    const run = previous
      .then(() => this.merge(project, taskId))
      .catch((error) => {
        this.ctx.log(project, `merge ${taskId} crashed: ${errorText(error)}`);
        return this.ctx.moveTask(project, taskId, "fail");
      });
    this.queues.set(project.slug, run);
  }

  private async merge(project: Project, taskId: string): Promise<void> {
    const picked = await this.ctx.ledger(project, (ledger) => {
      const task = ledger.tasks[taskId];
      const lane = task ? ledger.lanes[task.lane] : undefined;
      if (!task || !lane || !TASK.move(task, "merge")) return undefined;
      return { task: { ...task }, lane: { ...lane } };
    });
    if (!picked) return;
    const { task, lane } = picked;
    // A task cut while it merged stays cut, and its Lead is not told otherwise.
    const finish = async (move: "merged" | "unmerged" | "conflict" | "fail", text: string) => {
      const moved = await this.ctx.moveTask(project, taskId, move);
      if (typeof moved !== "object") return;
      await this.ctx.post(lane.lead, `merge:${taskId}:${moved.status}:${Date.now()}`, text);
      this.ctx.event(project, { kind: `merge.${moved.status}`, task: taskId });
      if (moved.status === "merged") await this.agents.retire(project, task, lane.branch);
    };
    const cwd = lane.worktree;
    if (!cwd) return finish("fail", letters.mergeFailed(task, "the lane has no working copy", ""));
    const copy = await workState(cwd);
    if (copy === "dirty") {
      return finish("unmerged", letters.mergeFailed(task, "the lane's working copy has uncommitted changes from its current writer; accept again after that task hands back", ""));
    }
    // A copy git could not read has no writer in it: it is already gone.
    if (copy === "unknown") {
      return finish("fail", letters.mergeFailed(task, `git could not read the lane's working copy at ${cwd}`, ""));
    }
    if (!task.branch) return finish("fail", letters.mergeFailed(task, "the task branch is not on record", ""));
    const ahead = await commitsAhead(cwd, "HEAD", task.branch);
    if (ahead === undefined) return finish("fail", letters.mergeFailed(task, `git could not count what ${task.branch} carries beyond the lane branch`, ""));
    if (ahead === 0) return finish("fail", letters.mergeFailed(task, `${task.branch} has no commits beyond the lane branch`, ""));
    const merged = await mergeBranch(cwd, task.branch, `Merge ${task.id}: ${task.title}`);
    if (!merged.ok) {
      return merged.conflicts.length > 0
        ? finish("conflict", letters.conflict(task, merged.conflicts, lane.branch))
        : finish("fail", letters.mergeFailed(task, "git merge failed", merged.message));
    }
    const counts = await diffCounts(cwd, merged.before, merged.after, fileKinds(this.ctx.kit));
    // No gate here: the Lead accepted with the verdict in hand, and undoing the merge on red would take that decision back.
    const gate = gateNote(project, task);
    await this.ctx.setTask(project, taskId, (entry) => {
      entry.mergeSha = merged.after;
    });
    await finish("merged", letters.merged(task, counts, outsideOwned(counts?.files ?? [], task.owned), gate));
  }
}
