import { z } from "zod";
import { hash, no, ok, str, strs } from "../context.ts";
import { laneGate } from "../gates.ts";
import { laneOfLead, loadLedger } from "../ledger.ts";
import { letters } from "../letters.ts";
import { defineTool } from "../services.ts";

export const report = defineTool({
  name: "report",
  input: z.strictObject({ summary: z.string(), ready: z.boolean(), carried: z.array(z.string()).optional() }),
  async handle({ ctx, roster }, caller, args) {
    const summary = str(args.summary);
    const lane = laneOfLead(loadLedger(caller.project.state), caller.id);
    if (!lane) return no("You have no open lane.");
    const gate = args.ready === true ? await laneGate(ctx, caller.project, lane) : undefined;
    ctx.transact(caller.project, (current) => {
      const entry = current.lanes[lane.id];
      if (!entry) return;
      if (args.ready === true) entry.ready = { at: Date.now() };
      else delete entry.ready;
    });
    const to = await roster.supervisorFor(caller.project, lane.opener);
    const letter = letters.report(lane, summary, args.ready === true, strs(args.carried), gate);
    const posted = await ctx.post(to, `report:${lane.id}:${hash(summary)}`, letter);
    ctx.event(caller.project, { kind: "lane.report", lane: lane.id, ready: args.ready === true, gate: gate?.ok, to: to ?? null, text: posted === "nobody" ? letter : undefined });
    // With nobody supervising seated the post goes nowhere; it is kept in the event log and the Lead told so.
    if (posted === "nobody") {
      return ok(`Nobody supervising this project is seated, so the report reached no one. It is kept in ${caller.project.state}/events.log for whoever comes back; there is nothing to wait for until someone does.`);
    }
    return ok(
      gate && !gate.ok
        ? `Reported to ${to}, with what the gate did in it. Stay quiet until mail arrives.`
        : `Reported to ${to}. Stay quiet until mail arrives.`,
    );
  },
});
