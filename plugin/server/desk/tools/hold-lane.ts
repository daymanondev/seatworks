import { z } from "zod";
import { no, ok, str } from "../context.ts";
import { findLane, laneSeats } from "../ledger.ts";
import { letters } from "../letters.ts";
import { defineTool } from "../services.ts";

/** Stops a lane where it stands: each of its seats is cut short now, reads nothing more, and nothing in it starts or lands until resume_lane. */
export const holdLane = defineTool({
  name: "hold_lane",
  input: z.strictObject({ lane: z.string(), reason: z.string() }),
  async handle({ ctx, roster }, caller, args) {
    const { project } = caller;
    const reason = str(args.reason);
    const held = ctx.transact(project, (ledger) => {
      const lane = findLane(ledger, args.lane);
      if (!lane) return `There is no lane ${str(args.lane)}.`;
      if (lane.status === "closed") return `Lane ${lane.id} is closed; there is nothing to hold.`;
      if (lane.onHold) return `Lane ${lane.id} has been on hold since ${new Date(lane.onHold.at).toISOString().slice(11, 16)}: ${lane.onHold.reason}`;
      // A landing it was waiting to finish, or waiting for the Human to approve, would otherwise go ahead under the hold.
      const calledOff = Boolean(lane.landing || lane.landApproval);
      delete lane.landing;
      delete lane.landApproval;
      lane.onHold = { at: Date.now(), by: caller.id, reason };
      return { lane: { ...lane }, seats: laneSeats(ledger, lane), calledOff };
    });
    if (typeof held === "string") return no(held);
    const stopped: string[] = [];
    for (const { seat, task } of held.seats) if (await roster.interrupt(seat, letters.onHold(held.lane, reason, task))) stopped.push(seat);
    ctx.event(project, { kind: "lane.onHold", lane: held.lane.id, by: caller.id, reason, stopped });
    const landing = held.calledOff ? " The landing it was waiting on is called off: land it again once it resumes." : "";
    return ok(`Lane ${held.lane.id} is on hold. ${stopped.length} of its seats were told to stop: where their agent allows it the running turn was cut short, else they stop when it ends. Nothing reaches them, no task starts and nothing lands until resume_lane.${landing}`);
  },
});
