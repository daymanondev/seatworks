import { z } from "zod";
import { trackedFiles } from "../../core/git.ts";
import { serialPaths } from "../../core/scope.ts";
import { no, ok } from "../context.ts";
import { laneOfLead, loadLedger } from "../ledger.ts";
import { clip } from "../letters.ts";
import { planFindings, readPlan } from "../plan.ts";
import { serialOnlyOf } from "../project.ts";
import { defineTool } from "../services.ts";
import { startWaiting } from "../waiting.ts";
import { recordTask, workRoleFor } from "./lane-task.ts";

/** Records a lane's tasks at once, each waiting for what it names, and starts what can start; what would collide is told, not refused. */
export const planTasks = defineTool({
  name: "plan_tasks",
  input: z.strictObject({ tasks: z.array(z.strictObject({ key: z.string(), title: z.string(), goal: z.string(), acceptance: z.array(z.string()), owned: z.array(z.string()), outOfScope: z.array(z.string()), context: z.string().optional(), skills: z.array(z.string()).optional(), parallel: z.boolean().optional(), after: z.array(z.string()).optional(), role: z.string().optional() })) }),
  async handle(desk, caller, args) {
    const { ctx } = desk;
    const { project } = caller;
    const ledger = loadLedger(project.state);
    const lane = laneOfLead(ledger, caller.id);
    if (!lane?.worktree) return no("You have no open lane.");
    const plan = readPlan(ledger, lane, args.tasks);
    if (typeof plan === "string") return no(plan);
    const roles = new Map<string, string>();
    for (const task of plan) {
      const role = workRoleFor(ctx, project, task.args);
      if (typeof role === "string") return no(`${task.key}: ${role}`);
      roles.set(task.key, role.role);
    }
    const findings = planFindings(ledger, lane, plan, serialPaths(await trackedFiles(lane.worktree), serialOnlyOf(project, ctx.kit)));
    const ids = new Map<string, string>();
    for (const task of plan) {
      const after = task.after.map((id) => ids.get(id) ?? id);
      const recorded = await recordTask(desk, project, lane, task.args, task.parallel, undefined, { after, role: roles.get(task.key)! });
      ids.set(task.key, recorded.id);
    }
    ctx.event(project, { kind: "plan.recorded", lane: lane.id, tasks: [...ids.values()], findings: findings.length });
    await startWaiting(desk, project, true);
    const now = loadLedger(project.state).tasks;
    const lines = plan.map((task) => {
      const entry = now[ids.get(task.key)!]!;
      const state = entry.status === "waiting" ? `waits for ${entry.after!.join(", ") || "the lane's copy"}${entry.held ? ` (${clip(entry.held.why, 200)})` : ""}` : `${entry.status}, Peer ${entry.peer}`;
      return `- ${task.key} is ${entry.id} ${entry.title}: ${state}`;
    });
    const evidence = findings.length > 0 ? `\n\nThe desk found, as evidence and not a refusal:\n${findings.map((finding) => `- ${finding}`).join("\n")}` : "";
    return ok(`The plan is recorded; each task starts by itself once what it waits for is accepted, and hand-backs arrive as mail.\n${lines.join("\n")}${evidence}`);
  },
});
