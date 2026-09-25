import { commitsAhead, diffCounts, git, mergeBranch, mergeOf, outsideOwned } from "../core/git.ts";
import { fileKinds } from "../catalog/kit.ts";
import { workState } from "../catalog/project-files.ts";
import type { Agents } from "./agents.ts";
import { type DeskContext } from "./context.ts";
import { errorText } from "../core/errors.ts";
import { IN_QUEUE, TASK } from "../domain/task.ts";
import { gateNote } from "./gates.ts";
import { type Lane, type Task, loadLedger } from "./ledger.ts";
import { type Letter, letters } from "./letters.ts";
import type { Project } from "./project.ts";

type Outcome = "merged" | "unmerged" | "conflict" | "fail";

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
    void this.after(project, () =>
      this.merge(project, taskId).catch(async (error) => {
        this.ctx.log(project, `merge ${taskId} crashed: ${errorText(error)}`);
        this.ctx.moveTask(project, taskId, "fail");
      }),
    );
  }

  /**
   * What a stop left accepted and unmerged goes through again, in the order it was accepted. It waits its turn in the
   * queue, so a task it finds merging was cut off by the stop and is not one this run is merging.
   */
  resume(project: Project): Promise<void> {
    return this.after(project, () => this.takeUp(project));
  }

  /** One merge at a time per project, each after the one before whatever became of it. */
  private after(project: Project, run: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(project.slug) ?? Promise.resolve()).then(run);
    this.queues.set(project.slug, next.catch(() => undefined));
    return next;
  }

  private async takeUp(project: Project): Promise<void> {
    const ledger = loadLedger(project.state);
    const left = Object.values(ledger.tasks).filter((task) => IN_QUEUE.includes(task.status)).sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0));
    for (const task of left) {
      const lane = ledger.lanes[task.lane];
      if (task.status === "merging" && lane && (await this.cutOff(project, task, lane))) continue;
      this.enqueue(project, task.id);
    }
  }

  /** A merge a stop cut off: finished if git had made it, else undone and queued again; true when nothing is left to do. */
  private async cutOff(project: Project, task: Task, lane: Lane): Promise<boolean> {
    const cwd = lane.worktree;
    const made = cwd && task.branch ? await mergeOf(cwd, task.branch) : undefined;
    if (cwd && made) {
      await this.landed(project, task, lane, cwd, made);
      return true;
    }
    // Undone rather than finished: git stopped halfway leaves the copy dirty, and merging reads that as another writer there.
    if (cwd) await git(cwd, ["merge", "--abort"]);
    this.ctx.moveTask(project, task.id, "requeue");
    return false;
  }

  private async merge(project: Project, taskId: string): Promise<void> {
    const picked = this.ctx.transact(project, (ledger) => {
      const task = ledger.tasks[taskId];
      const lane = task ? ledger.lanes[task.lane] : undefined;
      if (!task || !lane || !TASK.move(task, "merge")) return undefined;
      return { task: { ...task }, lane: { ...lane } };
    });
    if (!picked) return;
    const { task, lane } = picked;
    const finish = (move: Outcome, letter: Letter) => this.finish(project, task, lane, move, letter);
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
        ? finish("conflict", letters.conflict(task, merged.conflicts, lane.branch, await this.settleIn(task, lane)))
        : finish("fail", letters.mergeFailed(task, "git merge failed", merged.message));
    }
    await this.landed(project, task, lane, cwd, merged);
  }

  /** No seat may run git merge, so the task's own copy is given the lane branch to settle against, conflicts and all. */
  private async settleIn(task: Task, lane: Lane): Promise<"left" | "clean" | { not: string }> {
    if (!task.worktree) return { not: "its copy is not on record" };
    const copy = await workState(task.worktree);
    if (copy !== "clean") return { not: copy === "dirty" ? "it has uncommitted changes" : "git could not read it" };
    const merged = await mergeBranch(task.worktree, lane.branch, `Bring ${lane.branch} into ${task.branch ?? task.id}`, true);
    return merged.ok ? "clean" : merged.conflicts.length > 0 ? "left" : { not: merged.message.split("\n")[0] || "git merge failed" };
  }

  /** A merge git made, recorded and told with what it changed. */
  private async landed(project: Project, task: Task, lane: Lane, cwd: string, merged: { before: string; after: string }): Promise<void> {
    const counts = await diffCounts(cwd, merged.before, merged.after, fileKinds(this.ctx.kit));
    // No gate here: the Lead accepted with the verdict in hand, and undoing the merge on red would take that decision back.
    const gate = gateNote(project, task);
    this.ctx.setTask(project, task.id, (entry) => {
      entry.mergeSha = merged.after;
    });
    await this.finish(project, task, lane, "merged", letters.merged(task, counts, outsideOwned(counts?.files ?? [], task.owned), gate));
  }

  /** The record follows what the merge did, and its Lead is told. */
  private async finish(project: Project, task: Task, lane: Lane, move: Outcome, letter: Letter): Promise<void> {
    const moved = this.ctx.moveTask(project, task.id, move);
    if (typeof moved !== "object") return;
    await this.ctx.post(lane.lead, letter);
    this.ctx.event(project, { kind: `merge.${moved.status}`, task: task.id });
    if (moved.status === "merged") await this.agents.retire(project, task, lane.branch);
  }
}
