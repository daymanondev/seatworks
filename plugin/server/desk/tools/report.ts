import { z } from "zod";
import { no, ok, str, strs } from "../context.ts";
import { laneGate } from "../gates.ts";
import { laneOfLead, loadLedger } from "../ledger.ts";
import { letters } from "../letters.ts";
import { putOnHold } from "../hold.ts";
import type { Project } from "../project.ts";
import { type DeskServices, defineTool } from "../services.ts";

/** A lane that went on without the Human's answer to a costly question stops at its ready report; says which, when it did. */
async function parkAtCheckpoint(desk: DeskServices, project: Project, lane: string): Promise<string | undefined> {
  const waiting = desk.ctx.transact(project, (ledger) => {
    const open = Object.values(ledger.questions).filter((question) => question.lane === lane && question.status === "open" && question.class === "costly");
    for (const question of open) question.parked = true;
    return open.map((question) => question.id);
  });
  if (waiting.length === 0) return undefined;
  const reason = `it went on without the Human's answer to ${waiting.join(", ")}, and stops at its ready report until they answer`;
  const held = await putOnHold(desk, project, lane, "desk", reason);
  return typeof held === "string" ? undefined : `It is on hold: ${reason}.`;
}

export const report = defineTool({
  name: "report",
  input: z.strictObject({ summary: z.string(), ready: z.boolean(), carried: z.array(z.string()).optional() }),
  async handle(desk, caller, args) {
    const { ctx, roster } = desk;
    const summary = str(args.summary);
    const lane = laneOfLead(loadLedger(caller.project.state), caller.id);
    if (!lane) return no("You have no open lane.");
    const gate = args.ready === true ? await laneGate(ctx, caller.project, lane) : undefined;
    // Recorded on the lane the caller still leads: it may have closed, or had its Lead replaced, while the gate ran.
    const still = ctx.transact(caller.project, (current) => {
      const entry = laneOfLead(current, caller.id);
      if (entry?.id !== lane.id) return false;
      if (args.ready === true) entry.ready = { at: Date.now() };
      else delete entry.ready;
      return true;
    });
    if (!still) return no(`Lane ${lane.id} is no longer yours to report on: it closed, or has another Lead, while this was asked.`);
    const to = await roster.supervisorFor(caller.project, lane.opener);
    const parked = args.ready === true ? await parkAtCheckpoint(desk, caller.project, lane.id) : undefined;
    const letter = letters.report(lane, summary, args.ready === true, strs(args.carried), gate, parked);
    const posted = await ctx.post(to, letter);
    ctx.event(caller.project, { kind: "lane.report", lane: lane.id, ready: args.ready === true, gate: gate?.ok, to: to ?? null, text: posted === "nobody" ? letter.text : undefined });
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
