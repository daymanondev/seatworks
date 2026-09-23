import { configFault } from "../../core/config-file.ts";
import { branchExists, currentBranch, isAncestor, landLane, mergeBranch, trackedFiles } from "../../core/git.ts";
import { blockUncommitted } from "../../catalog/project-files.ts";
import { roleThatCan } from "../../catalog/kit.ts";
import { firstOverlap, serialPaths, serialReach } from "../../core/scope.ts";
import { type Args, type Caller, given, hash, no, ok, str, strs } from "../context.ts";
import { errorText } from "../../core/errors.ts";
import { laneGate } from "../gates.ts";
import { type Issue, fetchIssue } from "../issue.ts";
import { type Lane, type Ledger, type Task, amend, findLane, loadLedger, nextLaneId, slugify, tasksOf } from "../ledger.ts";
import { clip, letters, outside } from "../letters.ts";
import { type Project, type ProjectConfig, conceptFile, configFile, detectGate, loadConfig, saveConfig } from "../project.ts";
import type { Roster } from "../roster.ts";
import type { DeskServices, Tool } from "../services.ts";
import { namedOrNot } from "./shared.ts";

/** Why a lane cannot open, and what open_lane would do instead: the reason is shared, the advice is not. */
type Refusal = { why: string; instead: string };

function scopeProblem(serial: string[], open: Lane[], writeSet: string[], contracts: string[]): Refusal | undefined {
  if (open.length === 0) return undefined;
  const mine = serialReach(writeSet, serial);
  for (const other of open) {
    // No write set could mean any of them, and a copy of its own does not help: a merge cannot reconcile these.
    const theirs = other.writeSet.length === 0 ? serial : serialReach(other.writeSet, serial);
    const both = mine.filter((path) => theirs.includes(path));
    // Capped at four: resolved against real files, a Unity or Unreal tree can match tens of thousands.
    if (both.length > 0)
      return {
        why: `Lane ${other.id} may already be writing ${both.slice(0, 4).join(", ")}${both.length > 4 ? ` and ${both.length - 4} more` : ""}, and only one lane at a time may write those.`,
        instead: `Open this lane after ${other.id} lands, or keep those paths out of it.`,
      };
  }
  // Nothing is said when either declared nothing: that is the Supervisor's call, not a hole to refuse over.
  for (const other of open) {
    if (writeSet.length === 0 || other.writeSet.length === 0) continue;
    const clash = firstOverlap(writeSet, [...other.writeSet, ...other.contracts]) ?? firstOverlap(contracts, other.writeSet);
    if (clash) return { why: `This lane overlaps lane ${other.id} at ${clash}.`, instead: `Fold it in or open it after ${other.id} lands.` };
  }
  return undefined;
}

async function overlap(project: Project, open: Lane[], writeSet: string[], contracts: string[]): Promise<Refusal | undefined> {
  const serial = open.length > 0 ? serialPaths(await trackedFiles(project.root), loadConfig(project.state).serialOnly) : [];
  return scopeProblem(serial, open, writeSet, contracts);
}

/** An unreadable issue ref is a note on the lane, never a reason to refuse opening it. */
async function readIssue(args: Args, project: Project): Promise<{ issue?: Issue; unread?: string }> {
  const ref = str(args.issue);
  if (!ref) return {};
  const fetched = await fetchIssue(ref, project.root);
  return "error" in fetched ? { unread: `${ref} could not be read: ${fetched.error}` } : { issue: fetched };
}

const seatingKey = (project: Project, lane: string) => `${project.slug}:${lane}`;

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

/** Which gate regime this project runs, because a Lead plans its splits against it. */
function gateRegime(project: Project): string {
  const config = loadConfig(project.state);
  if (!config.gate) return "none set, so nothing is checked for you";
  return config.gateOn === "task" ? `${config.gate} runs on every task, and its verdict reaches the Lead with the hand-back — evidence, not a veto` : `${config.gate} runs on the whole lane when you report it ready`;
}

function openedReply(project: Project, lane: Lane, slot: { id?: string }, lead: string, issue: Issue | undefined): string {
  // An empty gate is the owner's answer, not a missing one, so it is not an invitation to set one.
  const stored = loadConfig(project.state).gate;
  const gate = stored ? stored : stored === "" ? "none set, by this project's own choice" : "none; call set_project with the project's test command";
  const issueText = issue
    ? `\n\nIssue #${issue.number} as the Lead received it: ${outside("issue", issue.title, 200)} (${outside("issue", issue.url, 300)})\n<issue>\n${outside("issue", issue.body, 4000)}\n</issue>`
    : "";
  const where = slot.id ? `in working copy ${slot.id}` : "in the project's own working copy";
  const on = lane.onBranch
    ? `carries on ${lane.branch} ${where}${lane.branch === loadConfig(project.state).base ? `, which is the project's base: nothing separates this work from it and there is no lane branch to fall back on` : ""}`
    : `is open on ${lane.branch} (off ${lane.base}) ${where}`;
  return `Lane ${lane.id} ${on}, and its Lead ${lead} is starting. Gate: ${gate}. Reports and asks arrive as mail; nothing to wait for now.${issueText}`;
}

/** Where a lane opens given the project as it is now, or why it cannot; asked again when a waiting lane's turn comes. */
async function placement(project: Project, lane: Pick<Lane, "onBranch" | "writeSet" | "contracts" | "detourOf">, isolate: boolean, self?: string): Promise<{ ownCopy: boolean } | Refusal> {
  const lanes = Object.values(loadLedger(project.state).lanes).filter((entry) => entry.id !== self);
  const open = lanes.filter((entry) => entry.status === "open");
  // A closed lane still putting the copy back holds it too: its Lead may be mid-turn in there.
  const holder = open.find((entry) => !entry.slot) ?? lanes.find((entry) => entry.restoring);
  if (lane.onBranch && holder) return { why: `Lane ${holder.id} is working in the project's own copy on ${holder.branch}, and one checkout holds one branch.`, instead: `Carry this branch on once ${holder.id} closes, or open the lane on a branch of its own.` };
  // A detour must name a real open lane, or the letter back out of it has nowhere to go.
  if (lane.detourOf && !open.some((entry) => entry.id === lane.detourOf)) return { why: `There is no open lane ${lane.detourOf} for this one to clear the way for.`, instead: "" };
  const problem = await overlap(project, open, lane.writeSet, lane.contracts);
  if (problem) return problem;
  // One checkout is one branch: a second lane gets its own copy rather than switching the first lane's.
  return { ownCopy: !lane.onBranch && (isolate || holder !== undefined) };
}

type Seating = { ownCopy: boolean; from?: string; role?: string; parent?: string; issue?: Issue };
type Seated = { slot: { id?: string; path: string; workspaceId?: string }; lead: string };

/** Seats the Lead of a lane marked seating; a failure puts back what it took, sets the lane to `failed`, and comes back as the reason. */
async function startLead(desk: DeskServices, project: Project, lane: Lane, how: Seating & { failed: "closed" | "waiting" }): Promise<Seated | string> {
  const { ctx } = desk;
  try {
    const started = await seatLead(desk, project, lane, how);
    if (typeof started === "string") {
      await ctx.ledger(project, (ledger) => {
        const entry = ledger.lanes[lane.id];
        if (entry) entry.status = how.failed;
      });
    }
    return started;
  } finally {
    ctx.seating.delete(seatingKey(project, lane.id));
  }
}

async function seatLead(desk: DeskServices, project: Project, lane: Lane, how: Seating): Promise<Seated | string> {
  const { ctx, slots, agents } = desk;
  const giveBack = async (taken: { id?: string }) => {
    if (taken.id) await slots.release(project, taken.id, lane.branch, lane.base);
    else if (how.from) await slots.unstart(project, how.from, lane.branch);
    else if (!lane.onBranch) await slots.giveBack(project, lane.base, lane.branch);
  };
  let slot: { id?: string; path: string; workspaceId?: string };
  try {
    slot = lane.onBranch ? await slots.carryOn(project, lane.branch, how.from) : how.ownCopy ? await slots.acquire(project, lane.branch, lane.base, { lane: lane.id }) : await slots.inPlace(project, lane.branch, lane.base);
  } catch (error) {
    return `The lane could not get a working copy: ${errorText(error)}`;
  }
  try {
    const leadRole = roleThatCan(ctx.kit, "lead", how.role || undefined);
    if (!leadRole) {
      await giveBack(slot);
      return namedOrNot(ctx.kit, "lead", how.role ?? "", "lead a lane");
    }
    const lead = await agents.start(project, slot, leadRole.role, {
      parent: how.parent,
      title: `${lane.id} ${lane.title}`,
      prompt: letters.directive(lane, how.issue, conceptFile(project.state), gateRegime(project)),
      labels: { "seatworks.lane": lane.id, "seatworks.role": leadRole.role },
    });
    await ctx.ledger(project, (ledger) => {
      const entry = ledger.lanes[lane.id];
      if (entry) Object.assign(entry, { lead, worktree: slot.path, slot: slot.id, workspaceId: slot.workspaceId });
      ledger.agents[lead] = { id: lead, role: leadRole.role, lane: lane.id };
    });
    ctx.event(project, { kind: "lane.opened", lane: lane.id, lead, branch: lane.branch, base: lane.base, slot: slot.id ?? "in place" });
    return { slot, lead };
  } catch (error) {
    await giveBack(slot);
    return `The Lead could not start: ${errorText(error)}`;
  }
}

/** Why a lane cannot wait on these, or the lanes of them still to land; every one must exist and none be dropped. */
function waitsFor(ledger: Ledger, after: string[], onBranch: boolean): Lane[] | string {
  const lanes = after.map((id) => ledger.lanes[id]);
  const missing = after.filter((_, index) => !lanes[index]);
  if (missing.length > 0) return `There is no lane ${missing.join(", ")} to wait for.`;
  const dropped = lanes.find((lane) => lane!.status === "closed" && !lane!.landed);
  if (dropped) return `Lane ${dropped.id} closed without landing, so nothing of it is there to build on.`;
  // A branch carried on merges nowhere: a lane opened off the base after it would not have its work.
  const carried = lanes.find((lane) => lane!.onBranch);
  if (carried && !onBranch) return `Lane ${carried.id} carries on ${carried.branch} and merges nowhere, so a lane waiting for it carries on that branch too: pass onBranch.`;
  return lanes.filter((lane) => !lane!.landed) as Lane[];
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

/**
 * Opens each waiting lane whose lanes have all landed; one that cannot, or waits on a lane dropped, is told once per reason.
 * A lane whose start was tried and failed is tried again only when `retryHeld`: a closing lane frees what held it, a round does not.
 */
export async function openWaiting(desk: DeskServices, project: Project, retryHeld: boolean): Promise<void> {
  await putBackHalfOpen(desk, project);
  const ledger = loadLedger(project.state);
  for (const waiting of Object.values(ledger.lanes).filter((lane) => lane.status === "waiting" && (retryHeld || !lane.held?.tried))) {
    const pending = waitsFor(ledger, waiting.after ?? [], waiting.onBranch === true);
    if (Array.isArray(pending) && pending.length > 0) continue;
    const held = typeof pending === "string" ? { why: `${pending} Close this lane to drop it, or close it and open the work again without waiting.` } : await release(desk, project, waiting);
    if (!held) continue;
    const told = await desk.ctx.ledger(project, (current) => {
      const entry = current.lanes[waiting.id];
      if (!entry || entry.status !== "waiting" || entry.held?.why === held.why) return false;
      entry.held = held;
      return true;
    });
    if (!told) continue;
    desk.ctx.event(project, { kind: "lane.held", lane: waiting.id, reason: held.why });
    await desk.ctx.post(await desk.roster.supervisorFor(project, waiting.opener), `held:${waiting.id}:${hash(held.why)}`, letters.waited(waiting, `it is not open: ${held.why}`));
  }
}

/** Asked first with nothing taken, so a round can ask every time; then claimed under the ledger lock, so nothing opens it twice. */
async function release(desk: DeskServices, project: Project, lane: Lane): Promise<Lane["held"]> {
  const here = await currentBranch(project.root);
  const placed = lane.onBranch && here !== lane.branch
    ? `it carries on ${lane.branch}, and the project's own copy is on ${here ?? "no branch"} now.`
    : !lane.onBranch && !(await branchExists(project.root, lane.base))
      ? `its base branch ${lane.base} no longer exists.`
      : await placement(project, lane, lane.opening?.isolate === true, lane.id);
  if (typeof placed === "string" || "why" in placed) return { why: `${typeof placed === "string" ? placed : placed.why} It opens by itself once that clears; amend it, or close it to drop it.` };
  const claimed = await desk.ctx.ledger(project, (ledger) => {
    const entry = ledger.lanes[lane.id];
    if (entry?.status !== "waiting") return undefined;
    entry.status = "open";
    desk.ctx.seating.add(seatingKey(project, lane.id));
    return { ...entry };
  });
  if (!claimed) return undefined;
  const fetched = claimed.issue ? await fetchIssue(claimed.issue, project.root) : undefined;
  const issue = fetched && !("error" in fetched) ? fetched : undefined;
  const started = await startLead(desk, project, claimed, { ownCopy: placed.ownCopy, failed: "waiting", role: claimed.opening?.role, parent: claimed.opener, issue });
  if (typeof started === "string") return { why: `${started} It is tried again when a lane closes; close it to drop it.`, tried: true };
  await desk.ctx.ledger(project, (ledger) => {
    const entry = ledger.lanes[lane.id];
    if (entry) delete entry.held;
  });
  await desk.ctx.post(await desk.roster.supervisorFor(project, claimed.opener), `opened:${lane.id}`, letters.waited(claimed, openedReply(project, claimed, started.slot, started.lead, issue)));
  return undefined;
}

/** A lane open with no Lead that nothing is seating was left so by a stop: what it took goes back, and it waits again or, never answered, closes. */
async function putBackHalfOpen(desk: DeskServices, project: Project): Promise<void> {
  const { ctx, slots, roster } = desk;
  const stopped = await ctx.ledger(project, (ledger) =>
    Object.values(ledger.lanes)
      .filter((lane) => lane.status === "open" && !lane.lead && !ctx.seating.has(seatingKey(project, lane.id)))
      .map((lane) => {
        lane.status = lane.after ? "waiting" : "closed";
        delete lane.held;
        return { lane: { ...lane }, slot: Object.values(ledger.slots).find((slot) => slot.lane === lane.id)?.id };
      }),
  );
  for (const { lane, slot } of stopped) {
    if (slot) await slots.release(project, slot, lane.branch, lane.base);
    else if (!lane.onBranch && (await currentBranch(project.root)) === lane.branch) await slots.giveBack(project, lane.base, lane.branch);
    ctx.event(project, { kind: "lane.halfOpen", lane: lane.id, status: lane.status });
    if (lane.status === "closed") await ctx.post(await roster.supervisorFor(project, lane.opener), `halfopen:${lane.id}`, letters.halfOpen(lane));
  }
}

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
