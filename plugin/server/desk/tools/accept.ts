import { z } from "zod";
import { fileKinds } from "../../catalog/kit.ts";
import { currentBranch, diffCounts, git, outsideOwned } from "../../core/git.ts";
import { workState } from "../../catalog/project-files.ts";
import { IN_QUEUE, TASK } from "../../domain/task.ts";
import { no, ok, str } from "../context.ts";
import { gateNote } from "../gates.ts";
import { loadLedger } from "../ledger.ts";
import { letters } from "../letters.ts";
import { holderOf } from "../opening.ts";
import { defineTool } from "../services.ts";
import { startWaiting } from "../waiting.ts";
import { laneTask } from "./lane-task.ts";

/** What is in the way, named: a stray message file reads as unfinished work otherwise. */
async function uncommittedIn(cwd: string): Promise<string> {
  const run = await git(cwd, ["status", "--porcelain"]);
  const lines = run.stdout.split("\n").filter((line) => line.trim());
  const shown = lines.slice(0, 6).map((line) => line.trim()).join(", ");
  return lines.length > 6 ? `${shown} and ${lines.length - 6} more` : shown || "something git reports but does not name";
}

export const accept = defineTool({
  name: "accept",
  input: z.strictObject({ task: z.string() }),
  async handle(desk, caller, args) {
    const { ctx, agents, merges } = desk;
    const { project } = caller;
    const found = laneTask(loadLedger(project.state), caller, str(args.task));
    if (typeof found === "string") return no(found);
    const { lane, task } = found;
    if (task.kind !== "code") return no(`${task.id} is a review; cut it when you are done with it.`);
    if (!TASK.may(task.status, task.mode === "parallel" ? "queue" : "accept")) return no(`${task.id} is ${task.status}.`);
    if (task.mode === "parallel") {
      const queued = await ctx.moveTask(project, task.id, "queue", (entry) => (entry.queuedAt = Date.now()));
      if (typeof queued !== "object") return no(`${task.id} is ${queued ?? "gone"}.`);
      const ahead = Object.values(loadLedger(project.state).tasks).filter((entry) => IN_QUEUE.includes(entry.status)).length - 1;
      merges.enqueue(project, task.id);
      return ok(`${task.id} is in the merge queue${ahead > 0 ? ` behind ${ahead}` : ""}. MERGED or MERGE FAILED arrives as mail.`);
    }
    // A copy off the lane branch (mid-bisect) has commits on no branch; clean and detached is not landed.
    if (lane.worktree && (await currentBranch(lane.worktree)) !== lane.branch) {
      return no(
        `The lane's working copy is not on ${lane.branch}, so nothing committed in it is on the lane branch. Send rework asking the Peer on ${task.id} to put the copy back on ${lane.branch} — if it bisected, git bisect reset — and to commit its work there, then accept again.`,
      );
    }
    if (!lane.worktree) return no(`Lane ${lane.id} has no working copy.`);
    const copy = await workState(lane.worktree);
    if (copy === "unknown") return no(`git could not read the lane's working copy at ${lane.worktree}, so the desk cannot tell whether anything is uncommitted there.`);
    if (copy === "dirty") {
      // Named correctly: the uncommitted work may be another task's, and reworking this one would wake its Peer into it.
      const other = holderOf(loadLedger(project.state), lane, task.id);
      return no(
        other
          ? `The lane's working copy has uncommitted changes, and ${other.id} is the task holding it — they are not ${task.id}'s. Accept ${task.id} once ${other.id} has handed back and been accepted or cut.`
          : `The lane's working copy has uncommitted changes: ${await uncommittedIn(lane.worktree)}. Send rework asking the Peer on ${task.id} for those, then accept again.`,
      );
    }
    const counts = await diffCounts(lane.worktree, task.startSha ?? lane.base, "HEAD", fileKinds(ctx.kit));
    // Not rerun: a per-task gate already gave the Lead its verdict with the hand-back.
    const gate = gateNote(project, task);
    const updated = await ctx.moveTask(project, task.id, "accept");
    if (typeof updated !== "object") return no(`${task.id} is ${updated ?? "gone"}.`);
    await ctx.post(lane.lead, `merge:${task.id}:merged:${Date.now()}`, letters.merged(task, counts, outsideOwned(counts?.files ?? [], task.owned), gate));
    await agents.retire(project, updated, lane.branch);
    ctx.event(project, { kind: "task.accepted", task: task.id, mode: "lane" });
    await startWaiting(desk, project, true);
    return ok(
      counts && counts.files.length === 0
        ? `${task.id} is accepted; it changed nothing, so ${lane.branch} stands where it did. The working copy is free for the next task.`
        : `${task.id} is accepted; its commits are already on ${lane.branch}. The working copy is free for the next task.`,
    );
  },
});
