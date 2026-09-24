import { z } from "zod";
import { SETTLED } from "../../domain/task.ts";
import { no, ok, str } from "../context.ts";
import { type Ask, type AskKind, laneOfLead, loadLedger, nextAskId, taskOfPeer } from "../ledger.ts";
import { letters } from "../letters.ts";
import { defineTool } from "../services.ts";

export const askOwner = defineTool({
  name: "ask",
  input: z.strictObject({ kind: z.enum(["need", "blocked", "question"]), text: z.string(), default: z.string().optional() }),
  async handle({ ctx, roster }, caller, args) {
    const kind = str(args.kind) as AskKind;
    const text = str(args.text);
    const lane = laneOfLead(loadLedger(caller.project.state), caller.id);
    if (!lane) return no("You have no open lane.");
    const to = await roster.supervisorFor(caller.project, lane.opener);
    if (!to) return no("Nobody above you is running to answer; keep working on your default and report when the lane is ready.");
    // Opened on the lane the caller still leads: it may have closed while whoever answers was looked up.
    const entry = ctx.transact(caller.project, (ledger) => {
      if (laneOfLead(ledger, caller.id)?.id !== lane.id) return undefined;
      const created: Ask = {
        id: nextAskId(ledger),
        from: caller.id,
        fromRole: caller.role.role,
        to,
        lane: lane.id,
        kind,
        text,
        default: str(args.default) || undefined,
        status: "open",
        openedAt: Date.now(),
        reminders: 0,
      };
      ledger.asks[created.id] = created;
      return { ...created };
    });
    if (!entry) return no("You have no open lane.");
    await ctx.post(to, `ask:${entry.id}`, letters.askTo(entry, `the Lead of ${lane.id} (${lane.title})`));
    ctx.event(caller.project, { kind: "ask.opened", ask: entry.id, from: caller.id, to });
    return ok(`Asked as ${entry.id}. Keep working on your default where you can; the answer arrives as mail.`);
  },
});

export const askLead = defineTool({
  name: "ask",
  input: z.strictObject({ question: z.string(), tried: z.string().optional() }),
  async handle({ ctx, roster }, caller, args) {
    const question = str(args.question);
    const { project } = caller;
    const ledger = loadLedger(project.state);
    const task = taskOfPeer(ledger, caller.id);
    const lane = task ? ledger.lanes[task.lane] : undefined;
    if (!task || !lane?.lead) return no("Nobody is assigned to answer you; end your turn with the question.");
    // A gone Lead would never answer; it goes up a level instead, and the Peer is told so.
    const to = (await roster.seated(lane.lead)) ? lane.lead : await roster.supervisorFor(project, lane.opener);
    if (!to) return no("Your lead is not there and nobody above it is either, so nobody can answer now. Carry on with your default where you can, and end your turn with the question.");
    const tried = str(args.tried);
    // Opened for the task the caller still works: it may have been cut while whoever answers was looked up.
    const entry = ctx.transact(project, (current) => {
      const now = taskOfPeer(current, caller.id);
      if (now?.id !== task.id || SETTLED.includes(now.status)) return undefined;
      const created: Ask = {
        id: nextAskId(current),
        from: caller.id,
        fromRole: caller.role.role,
        to,
        lane: lane.id,
        task: task.id,
        kind: "question",
        text: tried ? `${question}\n\nTried: ${tried}` : question,
        status: "open",
        openedAt: Date.now(),
        reminders: 0,
      };
      current.asks[created.id] = created;
      return { ...created };
    });
    if (!entry) return no(`${task.id} was accepted or cut while you asked, so there is nothing to ask about; end your turn.`);
    await ctx.post(to, `ask:${entry.id}`, letters.askTo(entry, `the Peer on ${task.id} (${task.title})`));
    ctx.event(project, { kind: "ask.opened", ask: entry.id, from: caller.id, to });
    return ok(`Asked as ${entry.id}${to === lane.lead ? "" : ", of the owner, because your lead is not there"}. End your turn; the answer arrives as a message.`);
  },
});
