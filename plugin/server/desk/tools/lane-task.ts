import { type RoleSpec, namedOrNot, roleThatCan } from "../../catalog/kit.ts";
import { skillSources } from "../../catalog/content.ts";
import { skillDirsFor } from "../../catalog/team.ts";
import { type Args, type Caller, type DeskContext, str, strs } from "../context.ts";
import { type Lane, type Ledger, type Task, findTask, laneOfLead, nextTaskId, slugify } from "../ledger.ts";
import { seatingKey } from "../opening.ts";
import type { Project } from "../project.ts";
import type { DeskServices } from "../services.ts";

export function laneTask(ledger: Ledger, caller: Caller, id: string): { lane: Lane; task: Task } | string {
  const lane = laneOfLead(ledger, caller.id);
  const task = findTask(ledger, id);
  if (!lane) return "You have no open lane.";
  if (!task || task.lane !== lane.id) return `${id} is not a task in your lane.`;
  return { lane, task };
}

export function recordTask(desk: DeskServices, project: Project, lane: Lane, args: Args, parallel: boolean, startSha: string | undefined, waiting?: { after: string[]; role: string }): Task {
  const title = str(args.title);
  return desk.ctx.transact(project, (current) => {
    const id = nextTaskId(current.lanes[lane.id]!, "code");
    const now = Date.now();
    const task: Task = {
      id,
      lane: lane.id,
      kind: "code",
      mode: parallel ? "parallel" : "lane",
      title,
      goal: str(args.goal),
      acceptance: strs(args.acceptance),
      owned: strs(args.owned),
      outOfScope: strs(args.outOfScope),
      context: str(args.context) || undefined,
      skills: strs(args.skills),
      branch: parallel ? `task/${id.toLowerCase()}-${slugify(title, 24)}` : lane.branch,
      worktree: parallel ? undefined : lane.worktree,
      slot: parallel ? undefined : lane.slot,
      startSha,
      status: waiting ? "waiting" : "running",
      after: waiting?.after,
      // Who takes it, kept for when it starts: the call that asked for it is long gone by then.
      opening: waiting && { role: waiting.role },
      openedAt: now,
      updatedAt: now,
      silent: 0,
    };
    current.tasks[id] = task;
    // Marked where it is recorded running, so a round cannot take it for one a stop left half started.
    if (!waiting) desk.ctx.seating.add(seatingKey(project, id));
    return { ...task };
  });
}

/** The role that takes a task, or why none can: a skill it lacks is refused here, since the Lead's context does not list them. */
export function workRoleFor(ctx: DeskContext, project: Project, args: Args): RoleSpec | string {
  // Writing, not `work`: a reviewing role holds `work` too, and would be offered as a Peer that cannot write.
  const asked = str(args.role);
  const workRole = roleThatCan(ctx.kit, "write", asked || undefined);
  if (!workRole) return namedOrNot(ctx.kit, "write", asked, "take a task");
  const held = [...skillSources(ctx.kit, workRole, skillDirsFor(ctx.team(project), workRole.role)).keys()];
  const unknown = strs(args.skills).filter((name) => !held.includes(name));
  if (unknown.length === 0) return workRole;
  return held.length === 0 ? `This kit gives ${workRole.label}s no skills, so ${unknown.join(", ")} cannot be opened.` : `${workRole.label}s have no skill called ${unknown.join(", ")}. They have: ${held.sort().join(", ")}.`;
}
