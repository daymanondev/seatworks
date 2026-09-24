import { z } from "zod";
import { configFault } from "../../core/config-file.ts";
import { branchExists, currentBranch } from "../../core/git.ts";
import { blockUncommitted } from "../../catalog/project-files.ts";
import { type Args, type Caller, no, ok, str, strs } from "../context.ts";
import { type Issue, fetchIssue } from "../issue.ts";
import { type Lane, loadLedger, nextLaneId, slugify } from "../ledger.ts";
import { clip } from "../../core/text.ts";
import { type Project, configFile, detectGate, loadConfig, saveConfig } from "../project.ts";
import { type DeskServices, defineTool } from "../services.ts";
import { openedReply, placement, seatingKey, startLead } from "../opening.ts";
import { waitsFor } from "../waiting.ts";
import { seatCritic } from "../critique.ts";

/** An unreadable issue ref is a note on the lane, never a reason to refuse opening it. */
async function readIssue(args: Args, project: Project): Promise<{ issue?: Issue; unread?: string }> {
  const ref = str(args.issue);
  if (!ref) return {};
  const fetched = await fetchIssue(ref, project.root);
  return "error" in fetched ? { unread: `${ref} could not be read: ${fetched.error}` } : { issue: fetched };
}

function recordLane(desk: DeskServices, caller: Caller, args: Args, place: { base: string; onBranch: boolean; branch?: string }, issue: Issue | undefined, after?: string[]): Promise<Lane> {
  const title = str(args.title);
  return desk.ctx.ledger(caller.project, (ledger) => {
    const id = nextLaneId(ledger);
    const lane: Lane = {
      id,
      title,
      outcome: str(args.outcome),
      acceptance: strs(args.acceptance),
      appetite: str(args.appetite) || undefined,
      deadline: str(args.deadline) || undefined,
      outOfScope: strs(args.outOfScope),
      issue: issue?.url,
      base: place.base,
      branch: place.branch ?? `lane/${id.toLowerCase()}-${slugify(title, 24)}`,
      detourOf: str(args.detourOf).trim().toUpperCase() || undefined,
      onBranch: place.onBranch || undefined,
      writeSet: strs(args.writeSet),
      contracts: strs(args.contracts),
      opener: caller.id,
      status: after ? "waiting" : "open",
      after,
      // What decides how it opens, kept for when it does: the call that asked for it is long gone by then.
      opening: after && (args.isolate === true || str(args.role)) ? { isolate: args.isolate === true || undefined, role: str(args.role) || undefined } : undefined,
      openedAt: Date.now(),
      tasks: 0,
    };
    ledger.lanes[id] = lane;
    if (!after) desk.ctx.seating.add(seatingKey(caller.project, id));
    return { ...lane };
  });
}

export const openLane = defineTool({
  name: "open_lane",
  input: z.strictObject({ title: z.string(), outcome: z.string(), acceptance: z.array(z.string()), appetite: z.string().optional(), deadline: z.string().optional(), outOfScope: z.array(z.string()), issue: z.string().optional(), isolate: z.boolean().optional(), base: z.string().optional(), onBranch: z.boolean().optional(), newBranch: z.string().optional(), writeSet: z.array(z.string()).optional(), contracts: z.array(z.string()).optional(), after: z.array(z.string()).optional(), detourOf: z.string().optional(), role: z.string().optional() }),
  async handle(desk, caller, args) {
    const { project } = caller;
    const config = loadConfig(project.state);
    const onBranch = args.onBranch === true;
    const newBranch = str(args.newBranch).trim();
    const after = [...new Set(strs(args.after).map((id) => id.trim().toUpperCase()))];
    const here = await currentBranch(project.root);
    if (newBranch && !onBranch) return no("newBranch goes with onBranch: it starts the branch the lane then carries on.");
    if (onBranch && (args.isolate === true || str(args.base))) return no("onBranch carries on the branch the project's own copy is on, in that copy, so it takes no base and no isolate.");
    if (onBranch && !here) return no("The project's own copy is not on a branch, so there is no branch to carry on; open the lane without onBranch to start one.");
    if (newBranch && after.length > 0) return no("A lane that waits cannot start a branch from the copy as it is now: that is not the copy it will open in. Wait without newBranch, and start the branch when its turn comes.");
    if (newBranch && (await branchExists(project.root, newBranch))) return no(`The branch ${newBranch} already exists; carry it on after switching to it, or pick another name with the Human.`);
    const pending = after.length > 0 ? waitsFor(loadLedger(project.state), after, onBranch) : [];
    if (typeof pending === "string") return no(`${pending} Open this lane without waiting for it.`);
    const carried = pending.find((lane) => lane.onBranch)?.branch;
    const base = onBranch ? carried ?? (newBranch || here!) : str(args.base) || config.base || here || "main";
    if (!newBranch && !(await branchExists(project.root, base))) return no(`The base branch ${base} does not exist.`);
    // Seeded only when unanswered: `config.gate` is "" when the owner answered "no gate". A branch carried on is not a base.
    if (!config.base || config.gate === undefined) {
      const fault = configFault(configFile(project.state));
      if (fault) return no(`${fault}\nOnly the Human can repair it or move it aside — no seat may write the desk's own files — so tell them; the desk will not write its own defaults over a file it could not read.`);
      saveConfig(project.state, { ...config, base: config.base ?? (onBranch ? undefined : base), gate: config.gate ?? detectGate(project.root, desk.ctx.kit.ecosystem) });
    }
    const place = { base, onBranch, branch: onBranch ? base : undefined };
    if (pending.length > 0) {
      const { issue } = await readIssue(args, project);
      const lane = await recordLane(desk, caller, args, place, issue, after);
      desk.ctx.event(project, { kind: "lane.waiting", lane: lane.id, after });
      await seatCritic(desk, project, lane);
      return ok(`Lane ${lane.id} waits for ${pending.map((entry) => `${entry.id} (${entry.status})`).join(", ")}. It opens by itself once they have all landed, checked again against the lanes open then; if it cannot, or one closes without landing, you get a letter. Close it to drop it.`);
    }
    const placed = await placement(desk.ctx.kit, project, { onBranch, writeSet: strs(args.writeSet), contracts: strs(args.contracts), detourOf: str(args.detourOf).trim().toUpperCase() || undefined }, args.isolate === true);
    if ("why" in placed) return no(`${placed.why} ${placed.instead}`.trim());
    const { issue, unread } = await readIssue(args, project);
    const lane = await recordLane(desk, caller, args, place, issue);
    const started = await startLead(desk, project, lane, { ownCopy: placed.ownCopy, failed: "close", from: newBranch ? here : undefined, role: str(args.role), parent: caller.id, issue });
    if (typeof started === "string") return no(started);
    await seatCritic(desk, project, lane);
    const unshared = started.slot.id && (await blockUncommitted(project.root))
      ? "\n\nThe team block in AGENTS.md and CLAUDE.md is not committed, so this lane's copy was made without it: ask the Human to commit those two files now."
      : "";
    return ok(`${openedReply(project, lane, started.slot, started.lead, issue)}${unshared}${unread ? `\n\nThe issue was not read into the lane: ${clip(unread, 300)}. The Lead has the outcome and the checks; give it the issue yourself if it needs one.` : ""}`);
  },
});
