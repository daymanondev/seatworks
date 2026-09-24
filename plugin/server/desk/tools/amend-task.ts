import { z } from "zod";
import { DECIDED } from "../../domain/task.ts";
import { given, no, ok, str } from "../context.ts";
import { amend, loadLedger } from "../ledger.ts";
import { letters } from "../letters.ts";
import { parallelProblem } from "../opening.ts";
import { defineTool } from "../services.ts";
import { laneTask } from "./lane-task.ts";

/** Changes what a task asks while its Peer works, keeping what it asked before; the Peer is told at its next turn, not cut off. */
export const amendTask = defineTool({
  name: "amend_task",
  input: z.strictObject({ task: z.string(), why: z.string(), goal: z.string().optional(), acceptance: z.array(z.string()).optional(), outOfScope: z.array(z.string()).optional(), owned: z.array(z.string()).optional() }),
  async handle({ ctx }, caller, args) {
    const changes = given(args, ["goal"], ["acceptance", "outOfScope", "owned"]);
    if (changes.goal === "" || changes.acceptance?.length === 0) return no("A task keeps a goal and at least one acceptance line; give what it asks now.");
    if (changes.owned?.length === 0) return no("A task keeps at least one owned path; give every path it owns now.");
    const ledger = loadLedger(caller.project.state);
    const current = laneTask(ledger, caller, str(args.task));
    // Checked as a start is: a task beside others that takes more paths could take what another is writing. A waiting one is checked when it starts.
    if (typeof current !== "string" && changes.owned && current.task.mode === "parallel" && current.task.status !== "waiting") {
      const problem = await parallelProblem(ctx.kit, caller.project, ledger, current.lane, changes.owned as string[], current.task.id);
      if (problem) return no(`${problem.why} Leave those paths out of ${current.task.id}.`);
    }
    const done = await ctx.ledger(caller.project, (ledger) => {
      const found = laneTask(ledger, caller, str(args.task));
      if (typeof found === "string") return found;
      const { task } = found;
      if (DECIDED.includes(task.status)) return `${task.id} is ${task.status}; start a task for what is asked now.`;
      const amendment = amend(task, changes, caller.id, str(args.why));
      if (!amendment) return `Nothing about ${task.id} would change; pass the fields it asks differently now.`;
      task.updatedAt = Date.now();
      return { task: { ...task }, amendment };
    });
    if (typeof done === "string") return no(done);
    ctx.event(caller.project, { kind: "task.amended", task: done.task.id, fields: Object.keys(done.amendment.was), by: caller.id });
    if (done.task.status === "waiting") return ok(`${done.task.id} is amended; it starts as it is now.`);
    const posted = await ctx.post(done.task.peer, `amended:${done.task.id}:${done.task.amended!.length}`, letters.amended(done.task, done.amendment, "worker"));
    return ok(`${done.task.id} is amended${posted === "nobody" ? ", and it has no Peer to tell" : "; its Peer has it at its next turn"}.`);
  },
});
