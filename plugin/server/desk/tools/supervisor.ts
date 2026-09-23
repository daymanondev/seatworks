import { configFault } from "../../core/config-file.ts";
import { branchExists, currentBranch, isAncestor, landLane, mergeBranch } from "../../core/git.ts";
import { blockUncommitted } from "../../catalog/project-files.ts";
import { type Args, type Caller, given, no, ok, str, strs } from "../context.ts";
import { laneGate } from "../gates.ts";
import { type Issue, fetchIssue } from "../issue.ts";
import { type Lane, type Ledger, type Task, amend, findLane, loadLedger, nextLaneId, slugify, tasksOf } from "../ledger.ts";
import { clip, letters } from "../letters.ts";
import { type Project, type ProjectConfig, configFile, detectGate, loadConfig, saveConfig } from "../project.ts";
import type { Roster } from "../roster.ts";
import type { DeskServices, Tool } from "../services.ts";
import { overlap, openedReply, placement, seatingKey, startLead } from "../opening.ts";
import { openWaiting, waitsFor } from "../waiting.ts";

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

export const openLane: Tool = async (desk, caller, args) => {
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
    saveConfig(project.state, { ...config, base: config.base ?? (onBranch ? undefined : base), gate: config.gate ?? detectGate(project.root) });
  }
  const place = { base, onBranch, branch: onBranch ? base : undefined };
  if (pending.length > 0) {
    const { issue } = await readIssue(args, project);
    const lane = await recordLane(desk, caller, args, place, issue, after);
    desk.ctx.event(project, { kind: "lane.waiting", lane: lane.id, after });
    return ok(`Lane ${lane.id} waits for ${pending.map((entry) => `${entry.id} (${entry.status})`).join(", ")}. It opens by itself once they have all landed, checked again against the lanes open then; if it cannot, or one closes without landing, you get a letter. Close it to drop it.`);
  }
  const placed = await placement(project, { onBranch, writeSet: strs(args.writeSet), contracts: strs(args.contracts), detourOf: str(args.detourOf).trim().toUpperCase() || undefined }, args.isolate === true);
  if ("why" in placed) return no(`${placed.why} ${placed.instead}`.trim());
  const { issue, unread } = await readIssue(args, project);
  const lane = await recordLane(desk, caller, args, place, issue);
  const started = await startLead(desk, project, lane, { ownCopy: placed.ownCopy, failed: "closed", from: newBranch ? here : undefined, role: str(args.role), parent: caller.id, issue });
  if (typeof started === "string") return no(started);
  const unshared = started.slot.id && (await blockUncommitted(project.root))
    ? "\n\nThe team block in AGENTS.md and CLAUDE.md is not committed, so this lane's copy was made without it: ask the Human to commit those two files now."
    : "";
  return ok(`${openedReply(project, lane, started.slot, started.lead, issue)}${unshared}${unread ? `\n\nThe issue was not read into the lane: ${clip(unread, 300)}. The Lead has the outcome and the checks; give it the issue yourself if it needs one.` : ""}`);
};

/** Merges base into the lane in its own copy; never under a seat mid-turn there, and an unseen seat counts as writing. */
async function bringBaseIn(roster: Roster, ledger: Ledger, lane: Lane): Promise<{ why: string; writers?: string[] } | undefined> {
  if (!lane.worktree) return { why: `it has no working copy on record to merge ${lane.base} into.` };
  if (await isAncestor(lane.worktree, lane.base, lane.branch)) return undefined;
  const writers = [lane.lead, ...tasksOf(ledger, lane.id).filter((task) => task.mode !== "parallel").map((task) => task.peer)];
  const writing = await Promise.all(
    writers.map(async (id) => {
      if (typeof id !== "string") return false;
      try {
        const seat = await roster.look(id);
        return !seat.archivedAt && (seat.status === "running" || seat.status === "initializing");
      } catch {
        return true;
      }
    }),
  );
  const busy = writers.filter((id, index): id is string => typeof id === "string" && writing[index] === true);
  if (busy.length > 0) {
    return {
      why: `${lane.base} has moved on, so landing it starts with merging ${lane.base} into ${lane.branch} in its copy, and a seat is mid-turn there. CAN LAND comes as mail when that turn ends; close it again then, or close it with land false.`,
      writers: busy,
    };
  }
  const merged = await mergeBranch(lane.worktree, lane.base, `Bring ${lane.base} into ${lane.branch}`);
  if (merged.ok) return undefined;
  const why = merged.conflicts.length > 0 ? `conflicts in ${merged.conflicts.join(", ")}` : merged.message;
  return { why: `${lane.base} has moved on and does not merge into ${lane.branch}: ${why}. Nothing was changed. Message its Lead to merge ${lane.base} into the lane and settle it, or close it with land false.` };
}

export const closeLane: Tool = async (desk, caller, args) => {
  const { ctx, roster, slots, agents, merges } = desk;
  const { project } = caller;
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status === "waiting") {
    if (args.land === true) return no(`Lane ${lane.id} never opened, so there is nothing to land; close it with land false to drop it.`);
    await ctx.ledger(project, (current) => {
      const entry = current.lanes[lane.id];
      if (entry?.status === "waiting") entry.status = "closed";
    });
    ctx.event(project, { kind: "lane.closed", lane: lane.id, land: false, landing: "dropped while waiting", reason: str(args.reason), writers: [] });
    return ok(`Lane ${lane.id} was waiting and is dropped; nothing had started for it.`);
  }
  if (lane.status !== "open") return no(`Lane ${lane.id} is already closed.`);
  // Wait for queued merges: they run in the lane's copy, which closing gates, lands and removes.
  await merges.settled(project);
  let landing = `the branch ${lane.branch} is kept for the Human`;
  if (args.land === true) {
    // Land before closing: a closed lane cannot be closed again, so a landing that cannot happen is refused while open.
    const synced = await bringBaseIn(roster, ledger, lane);
    if (synced?.writers) {
      await ctx.ledger(project, (current) => {
        const entry = current.lanes[lane.id];
        if (entry) entry.landing = { by: caller.id, writers: synced.writers! };
      });
    }
    if (synced) return no(`Lane ${lane.id} was not closed: ${synced.why}`);
    const gate = await laneGate(ctx, project, lane);
    // A red gate stops landing unless the Supervisor passes `overGate`: the verdict is evidence, not a veto.
    if (!gate.ok && args.overGate !== true) {
      return no(`Lane ${lane.id} was not closed: ${gate.text}\nMessage its Lead, close it with land false, or land it over the gate with overGate true — that is your call.`);
    }
    const result = lane.onBranch ? { landed: true, how: `the work stays on ${lane.branch}, the branch it carried on; nothing was merged anywhere` } : await landLane(project.root, lane.base, lane.branch);
    if (!result.landed) return no(`Lane ${lane.id} was not closed: it could not land, because ${result.how}. Close it again once that is cleared, or close it with land false.`);
    if (!gate.ok) ctx.event(project, { kind: "gate.overridden", lane: lane.id, by: caller.id });
    landing = `${result.how}${gate.ok ? "" : ", over a red gate"}`;
  }
  const retired = await ctx.ledger(project, (current) => {
    const entry = current.lanes[lane.id];
    if (entry) Object.assign(entry, { status: "closed", landed: args.land === true || undefined });
    const tasks: Task[] = [];
    for (const task of Object.values(current.tasks).filter((item) => item.lane === lane.id)) {
      if (["running", "rework", "queued", "done", "failed", "stalled"].includes(task.status)) task.status = "cut";
      tasks.push({ ...task });
    }
    return tasks;
  });
  const kept: string[] = [];
  for (const task of retired) {
    const branch = await agents.retire(project, task, lane.branch);
    if (branch) kept.push(branch);
  }
  await roster.archive(lane.lead);
  // Mid-turn seats are still writing in the lane's copy; it goes when their turn ends, not under them.
  const writers = [lane.lead, ...retired.filter((task) => task.mode !== "parallel").map((task) => task.peer)].filter(
    (id): id is string => typeof id === "string" && roster.pendingArchive.has(id),
  );
  // A branch carried on is the Human's: nothing switches the copy off it or deletes it.
  if (!lane.onBranch) {
    const drop = args.land === true ? { dropBranch: lane.branch, into: lane.base } : {};
    const branch = await slots.putAway({ project, slot: lane.slot, restore: lane.base, lane: lane.id, branch: lane.branch, ...drop }, writers);
    if (branch) kept.push(branch);
  }

  if (lane.detourOf) {
    const waiting = loadLedger(project.state).lanes[lane.detourOf];
    if (waiting?.status === "open" && waiting.lead) await ctx.post(waiting.lead, `detour:${lane.id}:${Date.now()}`, letters.detourLanded(lane, waiting, landing));
  }
  ctx.event(project, { kind: "lane.closed", lane: lane.id, land: args.land === true, landing, reason: str(args.reason), writers });
  const copy = lane.onBranch
    ? `The project's own copy stays on ${lane.branch}.`
    : writers.length > 0
      ? `Its working copy is put away once ${writers.join(" and ")} finish the turn they are in.`
      : "Its working copy is free for the next lane.";
  const branches = kept.length > 0 ? ` ${kept.join(" and ")} ${kept.length === 1 ? "holds commits" : "hold commits"} nothing else has and ${kept.length === 1 ? "is" : "are"} kept.` : "";
  await openWaiting(desk, project, true);
  return ok(`Lane ${lane.id} closed and its agents archived; ${landing}. ${copy}${branches}`);
};

/** Changes what a lane is asked while it is open or waiting, keeping what it was asked before; its Lead is told what moved. */
export const amendLane: Tool = async ({ ctx }, caller, args) => {
  const { project } = caller;
  const changes = given(args, ["outcome"], ["acceptance", "outOfScope", "writeSet", "contracts"]);
  if (changes.outcome === "" || changes.acceptance?.length === 0) return no("A lane keeps an outcome and at least one acceptance line; give what it is asked now.");
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status === "closed") return no(`Lane ${lane.id} is closed; ask for the work again with open_lane.`);
  if (lane.status === "open" && (changes.writeSet || changes.contracts)) {
    const others = Object.values(ledger.lanes).filter((entry) => entry.status === "open" && entry.id !== lane.id);
    const problem = await overlap(project, others, (changes.writeSet ?? lane.writeSet) as string[], (changes.contracts ?? lane.contracts) as string[]);
    if (problem) return no(`${problem.why} Leave those paths out of this lane, or ask for that work in a lane that waits for the other.`);
  }
  const done = await ctx.ledger(project, (current) => {
    const entry = current.lanes[lane.id];
    const amendment = entry && entry.status !== "closed" ? amend(entry, changes, caller.id, str(args.why)) : undefined;
    return amendment && { lane: { ...entry! }, amendment };
  });
  if (!done) return no(`Nothing about lane ${lane.id} would change; pass the fields it is asked differently now.`);
  ctx.event(project, { kind: "lane.amended", lane: lane.id, fields: Object.keys(done.amendment.was), by: caller.id });
  if (done.lane.status === "waiting") return ok(`Lane ${lane.id} is amended; it opens as it is now.`);
  const posted = await ctx.post(done.lane.lead, `amended:${lane.id}:${done.lane.amended!.length}`, letters.amended(done.lane, done.amendment, "lead"));
  return ok(`Lane ${lane.id} is amended${posted === "nobody" ? ", and it has no Lead to tell" : " and its Lead has the change"}; a READY it reported before no longer stands.`);
};

export const setProject: Tool = async (_desk, caller, args) => {
  // Refused as open_lane refuses: read as all defaults, an unreadable file was saved over with them.
  const unreadable = configFault(configFile(caller.project.state));
  if (unreadable) return no(`${unreadable}\nOnly the Human can repair it or move it aside; nothing was saved over it.`);
  const config = loadConfig(caller.project.state);
  const base = str(args.base);
  if (base && !(await branchExists(caller.project.root, base))) return no(`The branch ${base} does not exist.`);
  const minutes = Number(args.gateTimeoutMinutes);
  const next: ProjectConfig = {
    ...config,
    base: base || config.base,
    gate: typeof args.gate === "string" ? args.gate.trim() : config.gate,
    gateTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : config.gateTimeoutMinutes,
    gateOn: args.gateOn === "task" ? "task" : args.gateOn === "lane" ? "lane" : config.gateOn,
    serialOnly: Array.isArray(args.serialOnly) ? strs(args.serialOnly) : config.serialOnly,
  };
  saveConfig(caller.project.state, next);
  return ok(`Base ${next.base ?? "unset"}; gate ${next.gate || "none"}, run per ${next.gateOn}; gate timeout ${next.gateTimeoutMinutes} minutes.`);
};
