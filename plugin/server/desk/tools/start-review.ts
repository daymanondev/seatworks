import { z } from "zod";
import { namedOrNot, roleThatCan } from "../../catalog/kit.ts";
import { branchExists } from "../../core/git.ts";
import { type DeskContext, no, ok, str } from "../context.ts";
import { errorText } from "../../core/errors.ts";
import { type Lane, type Task, findTask, laneOfLead, loadLedger, nextTaskId } from "../ledger.ts";
import { clip } from "../../core/text.ts";
import { letters } from "../letters.ts";
import { seatingKey } from "../opening.ts";
import type { Project } from "../project.ts";
import { defineTool } from "../services.ts";

/** A landed parallel task's copy and branch are gone, so its change is read from the merge, not `laneBranch...HEAD`. */
async function changeOf(project: Project, target: Task, lane: Lane, inOwnCopy: boolean): Promise<{ where: string; range: string } | undefined> {
  if (target.mode !== "parallel") return { where: "Your working copy holds the change", range: `git diff ${target.startSha ?? lane.branch}..HEAD` };
  if (inOwnCopy) return { where: "Your working copy holds the change", range: `git diff ${lane.branch}...HEAD` };
  if (target.mergeSha) return { where: `The change is in ${lane.branch}, as the merge ${target.mergeSha.slice(0, 7)}`, range: `git diff ${target.mergeSha}^1..${target.mergeSha}` };
  if (target.branch && (await branchExists(project.root, target.branch)))
    return { where: `The change is on ${target.branch}, not in your working copy`, range: `git diff ${lane.branch}...${target.branch}` };
  return undefined;
}

/** A review is a task of the lane that owns nothing, recorded running and marked seating like any other. */
function recordReview(ctx: DeskContext, project: Project, lane: Lane, target: Task | undefined, title: string, focus: string, slot: { id?: string; path: string }): Promise<Task> {
  return ctx.ledger(project, (current) => {
    const id = nextTaskId(current.lanes[lane.id]!, "review");
    const now = Date.now();
    const created: Task = {
      id,
      lane: lane.id,
      kind: "review",
      mode: "lane",
      of: target?.id,
      title: title || (target ? `Review ${target.id}` : clip(focus.split(/\r?\n/)[0] ?? "Review", 50)),
      goal: focus,
      acceptance: target?.acceptance ?? [],
      owned: [],
      outOfScope: [],
      context: lane.branch,
      worktree: slot.path,
      slot: slot.id,
      status: "running",
      openedAt: now,
      updatedAt: now,
      silent: 0,
    };
    current.tasks[id] = created;
    ctx.seating.add(seatingKey(project, id));
    return { ...created };
  });
}

export const startReview = defineTool({
  name: "start_review",
  input: z.strictObject({ task: z.string().optional(), focus: z.string(), title: z.string().optional(), role: z.string().optional() }),
  async handle({ ctx, agents }, caller, args) {
    const { project } = caller;
    const focus = str(args.focus);
    const ledger = loadLedger(project.state);
    const lane = laneOfLead(ledger, caller.id);
    if (!lane?.worktree) return no("You have no open lane.");
    const target = str(args.task) ? findTask(ledger, str(args.task)) : undefined;
    if (str(args.task) && (!target || target.lane !== lane.id || target.kind !== "code")) return no(`${str(args.task)} is not a code task in your lane.`);
    // A slot marked for teardown still answers as the task's copy; a reviewer seated there loses it at the Peer's turn end.
    const holds = target?.slot ? ledger.slots[target.slot] : undefined;
    const own = target?.mode === "parallel" && holds?.task === target.id && !holds.releasing ? holds : undefined;
    const change = target ? await changeOf(project, target, lane, Boolean(own)) : undefined;
    if (target && !change)
      return no(`${target.id} worked in a copy that has been given back, and neither a merge nor a branch is left to read it from. Ask for a review of the lane instead.`);
    const slot: { id?: string; path: string; workspaceId?: string } | undefined =
      own ?? (lane.slot ? ledger.slots[lane.slot] : { path: lane.worktree, workspaceId: lane.workspaceId });
    if (!slot) return no("The working copy for that review is gone.");
    // No fallback to a plain worker: read-only comes from the reviewer role's settings, so a stand-in could rewrite.
    const lens = str(args.role);
    const reviewRole = roleThatCan(ctx.kit, "review", lens || undefined);
    if (!reviewRole) return no(namedOrNot(ctx.kit, "review", lens, "review, so there is nobody to ask a read-only question of"));
    const review = await recordReview(ctx, project, lane, target, str(args.title), focus, slot);
    try {
      const reviewer = await agents.start(project, slot, reviewRole.role, {
        parent: caller.id,
        title: `${review.id} ${target?.title ?? review.title}`,
        prompt: letters.reviewBrief(review, target, focus, lane.branch, change),
        labels: { "seatworks.lane": lane.id, "seatworks.task": review.id, "seatworks.role": reviewRole.role },
      });
      await ctx.setTask(project, review.id, (entry) => {
        entry.peer = reviewer;
      });
      await ctx.ledger(project, (current) => {
        current.agents[reviewer] = { id: reviewer, role: reviewRole.role, lane: lane.id, task: review.id };
      });
      ctx.event(project, { kind: "review.started", task: review.id, of: target?.id ?? null, reviewer });
      return ok(`Started ${review.id}${target ? ` on ${target.id}` : ""} with reviewer ${reviewer}. The verdict arrives as mail.`);
    } catch (error) {
      await ctx.moveTask(project, review.id, "cut");
      return no(`The reviewer could not start: ${errorText(error)}`);
    } finally {
      ctx.seating.delete(seatingKey(project, review.id));
    }
  },
});
