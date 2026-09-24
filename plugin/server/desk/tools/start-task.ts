import { z } from "zod";
import { headSha } from "../../core/git.ts";
import { no, ok, strs } from "../context.ts";
import { laneOfLead, loadLedger } from "../ledger.ts";
import { startPeer, taskPlacement } from "../opening.ts";
import { defineTool } from "../services.ts";
import { taskWaitsFor } from "../waiting.ts";
import { recordTask, workRoleFor } from "./lane-task.ts";

export const startTask = defineTool({
  name: "start_task",
  input: z.strictObject({ title: z.string(), goal: z.string(), acceptance: z.array(z.string()), owned: z.array(z.string()), outOfScope: z.array(z.string()), context: z.string().optional(), skills: z.array(z.string()).optional(), parallel: z.boolean().optional(), after: z.array(z.string()).optional(), role: z.string().optional() }),
  async handle(desk, caller, args) {
    const { ctx } = desk;
    const { project } = caller;
    const owned = strs(args.owned);
    const parallel = args.parallel === true;
    const after = [...new Set(strs(args.after).map((id) => id.trim().toUpperCase()))];
    const ledger = loadLedger(project.state);
    const lane = laneOfLead(ledger, caller.id);
    if (!lane?.worktree) return no("You have no open lane.");
    const pending = after.length > 0 ? taskWaitsFor(ledger, lane.id, after) : [];
    if (typeof pending === "string") return no(`${pending} Start this task without waiting for it.`);
    const problem = pending.length > 0 ? undefined : await taskPlacement(desk.ctx.kit, project, ledger, lane, owned, parallel);
    if (problem) return no(`${problem.why} ${problem.instead}`);
    const workRole = workRoleFor(ctx, project, args);
    if (typeof workRole === "string") return no(workRole);
    if (pending.length > 0) {
      const task = await recordTask(desk, project, lane, args, parallel, undefined, { after, role: workRole.role });
      ctx.event(project, { kind: "task.waiting", task: task.id, after });
      return ok(`${task.id} waits for ${pending.map((entry) => `${entry.id} (${entry.status})`).join(", ")}. It starts by itself once they have all been accepted, checked again against the tasks running then; if it cannot, or one is cut, you get a letter. Cut it to drop it.`);
    }
    const task = await recordTask(desk, project, lane, args, parallel, parallel ? undefined : await headSha(lane.worktree));
    const started = await startPeer(desk, project, lane, task, { role: workRole.role, parent: caller.id, failed: "cut" });
    if (typeof started === "string") return no(started);
    return ok(`Started ${task.id} ${started.where} with Peer ${started.peer}. Its hand-back arrives as mail; there is nothing to wait for in this turn.`);
  },
});
