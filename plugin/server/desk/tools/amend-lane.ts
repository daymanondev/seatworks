import { z } from "zod";
import { given, no, ok, str } from "../context.ts";
import { amend, findLane, loadLedger } from "../ledger.ts";
import { letters } from "../letters.ts";
import { defineTool } from "../services.ts";
import { overlap } from "../opening.ts";

/** Changes what a lane is asked while it is open or waiting, keeping what it was asked before; its Lead is told what moved. */
export const amendLane = defineTool({
  name: "amend_lane",
  input: z.strictObject({ lane: z.string(), why: z.string(), outcome: z.string().optional(), acceptance: z.array(z.string()).optional(), outOfScope: z.array(z.string()).optional(), writeSet: z.array(z.string()).optional(), contracts: z.array(z.string()).optional() }),
  async handle({ ctx }, caller, args) {
    const { project } = caller;
    const changes = given(args, ["outcome"], ["acceptance", "outOfScope", "writeSet", "contracts"]);
    if (changes.outcome === "" || changes.acceptance?.length === 0) return no("A lane keeps an outcome and at least one acceptance line; give what it is asked now.");
    const ledger = loadLedger(project.state);
    const lane = findLane(ledger, str(args.lane));
    if (!lane) return no(`There is no lane ${str(args.lane)}.`);
    if (lane.status === "closed") return no(`Lane ${lane.id} is closed; ask for the work again with open_lane.`);
    if (lane.status === "open" && (changes.writeSet || changes.contracts)) {
      const others = Object.values(ledger.lanes).filter((entry) => entry.status === "open" && entry.id !== lane.id);
      const problem = await overlap(ctx.kit, project, others, (changes.writeSet ?? lane.writeSet) as string[], (changes.contracts ?? lane.contracts) as string[]);
      if (problem) return no(`${problem.why} Leave those paths out of this lane, or ask for that work in a lane that waits for the other.`);
    }
    const done = ctx.transact(project, (current) => {
      const entry = current.lanes[lane.id];
      const amendment = entry && entry.status !== "closed" ? amend(entry, changes, caller.id, str(args.why)) : undefined;
      if (amendment) delete entry!.ready;
      return amendment && { lane: { ...entry! }, amendment };
    });
    if (!done) return no(`Nothing about lane ${lane.id} would change; pass the fields it is asked differently now.`);
    ctx.event(project, { kind: "lane.amended", lane: lane.id, fields: Object.keys(done.amendment.was), by: caller.id });
    if (done.lane.status === "waiting") return ok(`Lane ${lane.id} is amended; it opens as it is now.`);
    const posted = await ctx.post(done.lane.lead, `amended:${lane.id}:${done.lane.amended!.length}`, letters.amended(done.lane, done.amendment, "lead"));
    return ok(`Lane ${lane.id} is amended${posted === "nobody" ? ", and it has no Lead to tell" : " and its Lead has the change"}; a READY it reported before no longer stands.`);
  },
});
