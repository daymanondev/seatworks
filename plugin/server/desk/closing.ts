import { headSha, isAncestor, landLane, landedRef, mergeBranch } from "../core/git.ts";
import { LANE } from "../domain/lane.ts";
import { TASK } from "../domain/task.ts";
import { keepRun } from "./checkpoints.ts";
import { type Args, type ToolReply, no, ok, str } from "./context.ts";
import { laneGate } from "./gates.ts";
import { GATE_FAILED, NOT_READY, landCheck } from "./landing.ts";
import { type Lane, type Ledger, type Task, findLane, loadLedger, tasksOf } from "./ledger.ts";
import { letters } from "./letters.ts";
import { type Project, loadConfig } from "./project.ts";
import type { Roster } from "./roster.ts";
import type { DeskServices } from "./services.ts";
import { openWaiting } from "./waiting.ts";

type Closed = ToolReply & { blocked?: string };

/**
 * Merges base into the lane in its own copy; never under a seat mid-turn there, and an unseen seat counts as writing.
 * `why` is what stops it, for anyone; `then` is what the Supervisor can do about it.
 */
async function bringBaseIn(roster: Roster, ledger: Ledger, lane: Lane): Promise<{ why: string; then: string; writers?: string[] } | undefined> {
  if (!lane.worktree) return { why: `it has no working copy on record to merge ${lane.base} into`, then: "Close it with land false." };
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
      why: `${lane.base} has moved on, so landing it starts with merging ${lane.base} into ${lane.branch} in its copy, and a seat is mid-turn there`,
      then: "CAN LAND comes as mail when that turn ends; close it again then, or close it with land false.",
      writers: busy,
    };
  }
  const merged = await mergeBranch(lane.worktree, lane.base, `Bring ${lane.base} into ${lane.branch}`);
  if (merged.ok) return undefined;
  const why = merged.conflicts.length > 0 ? `conflicts in ${merged.conflicts.join(", ")}` : merged.message;
  return { why: `${lane.base} has moved on and does not merge into ${lane.branch}: ${why}`, then: `Nothing was changed. Message its Lead to merge ${lane.base} into the lane and settle it, or close it with land false.` };
}

/** What a lane lands under as one commit or a merge: its title, its outcome and the tasks that went into it. */
function landMessage(ledger: Ledger, lane: Lane): string {
  const tasks = tasksOf(ledger, lane.id).filter((task) => task.kind === "code" && task.status === "merged");
  return [`${lane.title} (${lane.id})`, "", lane.outcome, ...(tasks.length > 0 ? ["", ...tasks.map((task) => `- ${task.id} ${task.title}`)] : [])].join("\n");
}

type Held = NonNullable<Lane["landApproval"]>;

/**
 * The land check: off, nothing; shadow, recorded and landed; on, held for the Human on a signal or when every landing is.
 * An approval stands for the signals it was given: anything new that landing turns up holds it again, but a missing READY is the Lead's to give.
 */
async function checkLanding(desk: DeskServices, project: Project, lane: Lane, gateOk: boolean, by: string, overGate: boolean, approved?: Held): Promise<{ held?: string; blocked?: string; note: string }> {
  const { ctx } = desk;
  const checks = ctx.team(project).checkpoints;
  const mode = checks.land;
  if (mode === "off") return { note: "" };
  const { signals, evidence } = await landCheck(ctx.kit, project, loadLedger(project.state), lane, { set: Boolean(loadConfig(project.state).gate), ok: gateOk }, checks);
  const asks = signals.length > 0 || checks.landApprove === "every";
  const fresh = approved ? signals.filter((signal) => !approved.signals.includes(signal)) : signals;
  if (approved && fresh.length > 0 && fresh.every((signal) => signal === NOT_READY)) return { blocked: "its Lead has not reported it ready as it now stands", note: "" };
  const reason = signals.length > 0 ? signals.join(" ") : "this project approves every landing.";
  if (!approved || fresh.length > 0) keepRun(project, { checkpoint: "land", mode, lane: lane.id, by, decision: asks ? "ask" : "pass", findings: signals });
  if (mode === "on" && (approved ? fresh.length > 0 : asks)) {
    const head = (await headSha(project.root, lane.branch)) ?? "";
    await ctx.ledger(project, (current) => {
      const entry = current.lanes[lane.id];
      if (entry) entry.landApproval = { since: Date.now(), head, signals, evidence, overGate };
    });
    ctx.event(project, { kind: "land.held", lane: lane.id, signals: signals.length });
    await ctx.post(lane.lead, `landheld:${lane.id}:${head}`, letters.landHeld(lane, reason));
    return { held: `Lane ${lane.id} was not landed: it waits for the Human's approval, on the Flow tab of the panel, because ${reason}\n\nEvidence: ${evidence.join(" ")}\n\nYou cannot approve it; tell them it waits, and why. LANDED or SENT BACK comes as mail.`, note: "" };
  }
  const verdict = approved
    ? "Land check (on): the Human approved it."
    : mode === "shadow" && asks
      ? `Land check (shadow): the Human would have been asked, because ${reason}`
      : `Land check (${mode}): nothing held it.`;
  return { note: `\n\n${verdict}\nEvidence: ${evidence.join(" ")}` };
}

/** Closes a lane for `by`: the Supervisor that called, or the one the Human's approval lands it for. `blocked` is what kept a landing from happening. */
export async function close(desk: DeskServices, project: Project, by: string, args: Args): Promise<Closed> {
  const { ctx, merges } = desk;
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status === "waiting") {
    if (args.land === true) return no(`Lane ${lane.id} never opened, so there is nothing to land; close it with land false to drop it.`);
    await ctx.moveLane(project, lane.id, "drop");
    ctx.event(project, { kind: "lane.closed", lane: lane.id, land: false, landing: "dropped while waiting", reason: str(args.reason), writers: [] });
    return ok(`Lane ${lane.id} was waiting and is dropped; nothing had started for it.`);
  }
  if (lane.status !== "open") return no(`Lane ${lane.id} is already closed.`);
  // Wait for queued merges: they run in the lane's copy, which closing gates, lands and removes.
  await merges.settled(project);
  const landed = args.land === true ? await land(desk, project, ledger, lane, by, args.overGate === true) : { how: `the branch ${lane.branch} is kept for the Human`, note: "" };
  if ("text" in landed) return landed;
  return retire(desk, project, lane, args, landed);
}

/** A hold with no commit since stands while the land check still asks: the gate's verdict then is kept, READY, the write set and incidents are read again. */
async function stillHeld(desk: DeskServices, project: Project, ledger: Ledger, lane: Lane, held: Held): Promise<Closed | undefined> {
  const { ctx } = desk;
  const checks = ctx.team(project).checkpoints;
  const now = await landCheck(ctx.kit, project, ledger, lane, { set: Boolean(loadConfig(project.state).gate), ok: !held.signals.includes(GATE_FAILED) }, checks);
  if (checks.land !== "on" || (now.signals.length === 0 && checks.landApprove !== "every")) return undefined;
  await ctx.ledger(project, (current) => {
    const entry = current.lanes[lane.id]?.landApproval;
    if (entry && !entry.approved) Object.assign(entry, now);
  });
  return ok(`Lane ${lane.id} still waits for the Human's approval to land, since ${Math.round((Date.now() - held.since) / 60_000)} min ago, because ${now.signals.join(" ") || "this project approves every landing."} LANDED or SENT BACK comes as mail.`);
}

/** Lands an open lane for `by`, or says what kept it from landing: a hold for the Human, base that will not merge, a red gate. */
async function land(desk: DeskServices, project: Project, ledger: Ledger, lane: Lane, by: string, overGate: boolean): Promise<Closed | { how: string; note: string }> {
  const { ctx, roster } = desk;
  const held = lane.landApproval;
  const tip = await headSha(project.root, lane.branch);
  // A commit after the hold makes it a lane nobody has looked at: it is checked again from the start.
  const approved = held?.approved && held.head === tip ? held : undefined;
  const waits = held && !held.approved && held.head === tip ? await stillHeld(desk, project, ledger, lane, held) : undefined;
  if (waits) return waits;
  // Land before closing: a closed lane cannot be closed again, so a landing that cannot happen is refused while open.
  const synced = await bringBaseIn(roster, ledger, lane);
  if (synced?.writers) {
    await ctx.ledger(project, (current) => {
      const entry = current.lanes[lane.id];
      if (entry) entry.landing = { by, writers: synced.writers! };
    });
  }
  if (synced) return { ...no(`Lane ${lane.id} was not closed: ${synced.why}. ${synced.then}`), blocked: synced.why };
  const merged = approved ? await headSha(project.root, lane.branch) : tip;
  // Base merged in by the desk itself is not the lane changing under an approval.
  if (approved && merged && merged !== tip) {
    await ctx.ledger(project, (current) => {
      const entry = current.lanes[lane.id]?.landApproval;
      if (entry) entry.head = merged;
    });
  }
  const gate = await laneGate(ctx, project, lane);
  // A red gate stops landing unless the Supervisor passes `overGate`: the verdict is evidence, not a veto.
  if (!gate.ok && !overGate) {
    return { ...no(`Lane ${lane.id} was not closed: ${gate.text}\nMessage its Lead, close it with land false, or land it over the gate with overGate true — that is your call.`), blocked: gate.text.split("\n")[0]!.replace(/\.$/, "") };
  }
  let note = "";
  if (!lane.onBranch) {
    const check = await checkLanding(desk, project, lane, gate.ok, by, overGate, approved);
    if (check.held) return ok(check.held);
    if (check.blocked) return { ...no(`Lane ${lane.id} was not landed: ${check.blocked}. The Human's approval stands; close_lane with land true lands it once that is cleared.`), blocked: check.blocked };
    note = check.note;
  }
  const how = { as: loadConfig(project.state).landAs, message: landMessage(ledger, lane), keep: landedRef(lane.id) };
  const result = lane.onBranch ? { landed: true, how: `the work stays on ${lane.branch}, the branch it carried on; nothing was merged anywhere` } : await landLane(project.root, lane.base, lane.branch, how);
  if (!result.landed) return { ...no(`Lane ${lane.id} was not closed: it could not land, because ${result.how}. Close it again once that is cleared, or close it with land false.`), blocked: result.how };
  if (!gate.ok) ctx.event(project, { kind: "gate.overridden", lane: lane.id, by });
  return { how: `${result.how}${gate.ok ? "" : ", over a red gate"}`, note };
}

/** Closes the lane on record, cuts what it still had going, and puts away its seats and copy, each once nothing is writing there. */
async function retire(desk: DeskServices, project: Project, lane: Lane, args: Args, landed: { how: string; note: string }): Promise<Closed> {
  const { ctx, roster, slots, agents } = desk;
  const retired = await ctx.ledger(project, (current) => {
    const entry = current.lanes[lane.id];
    if (entry && LANE.move(entry, "close")) entry.landed = args.land === true || undefined;
    delete entry?.landApproval;
    const tasks: Task[] = [];
    for (const task of Object.values(current.tasks).filter((item) => item.lane === lane.id)) {
      TASK.move(task, "drop");
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
    const drop = args.land === true ? { dropBranch: lane.branch, into: landedRef(lane.id) } : {};
    const branch = await slots.putAway({ project, slot: lane.slot, restore: lane.base, lane: lane.id, branch: lane.branch, ...drop }, writers);
    if (branch) kept.push(branch);
  }
  if (lane.detourOf) {
    const waiting = loadLedger(project.state).lanes[lane.detourOf];
    if (waiting?.status === "open" && waiting.lead) await ctx.post(waiting.lead, `detour:${lane.id}:${Date.now()}`, letters.detourLanded(lane, waiting, landed.how));
  }
  ctx.event(project, { kind: "lane.closed", lane: lane.id, land: args.land === true, landing: landed.how, reason: str(args.reason), writers });
  const copy = lane.onBranch
    ? `The project's own copy stays on ${lane.branch}.`
    : writers.length > 0
      ? `Its working copy is put away once ${writers.join(" and ")} finish the turn they are in.`
      : "Its working copy is free for the next lane.";
  const branches = kept.length > 0 ? ` ${kept.join(" and ")} ${kept.length === 1 ? "holds commits" : "hold commits"} nothing else has and ${kept.length === 1 ? "is" : "are"} kept.` : "";
  await openWaiting(desk, project, true);
  return ok(`Lane ${lane.id} closed and its agents archived; ${landed.how}. ${copy}${branches}${landed.note}`);
}

/**
 * The Human's word on a held landing. Approved, the desk lands it now for the Supervisor; what stops it (a seat mid-turn,
 * a dirty copy) leaves the approval standing for the next `close_lane`. Sent back, the lane stays open with their note.
 */
export async function decideLand(desk: DeskServices, project: Project, laneId: string, approve: boolean, note: string): Promise<ToolReply> {
  const { ctx } = desk;
  const lane = loadLedger(project.state).lanes[laneId];
  const held = lane?.status === "open" ? lane.landApproval : undefined;
  if (!lane || !held || held.approved) return no(`Lane ${laneId} has no landing waiting for your approval.`);
  const supervisor = await desk.roster.supervisorFor(project, lane.opener);
  const tell = (how: Parameters<typeof letters.landDecided>[1], text: string) => ctx.post(supervisor, `land:${laneId}:${how}:${Date.now()}`, letters.landDecided(lane, how, text));
  const drop = () =>
    ctx.ledger(project, (current) => {
      delete current.lanes[laneId]?.landApproval;
    });
  if ((await headSha(project.root, lane.branch)) !== held.head) {
    await drop();
    await tell("changed", "");
    return ok(`Lane ${laneId} changed after it was held, so this approval is not for what it holds now. It is checked again when the Supervisor lands it.`);
  }
  keepRun(project, { checkpoint: "land", mode: "on", lane: laneId, by: "human", decision: approve ? "approved" : "sent back", findings: note ? [note] : [], waitedMs: Date.now() - held.since });
  ctx.event(project, { kind: approve ? "land.approved" : "land.sentBack", lane: laneId });
  if (!approve) {
    await drop();
    await ctx.post(lane.lead, `landback:${laneId}:${held.head}`, letters.landSentBack(lane, note));
    await tell("sent back", note);
    return ok(`Lane ${laneId} is sent back to its Lead with your note; it stays open.`);
  }
  await ctx.ledger(project, (current) => {
    const entry = current.lanes[laneId]?.landApproval;
    if (entry) entry.approved = { at: Date.now(), note };
  });
  const closed = await close(desk, project, supervisor ?? lane.opener, { lane: laneId, land: true, overGate: held.overGate });
  const now = loadLedger(project.state).lanes[laneId];
  const said = `${note ? `${note}. ` : ""}${closed.text}`;
  if (now?.status === "closed") {
    await tell("landed", said);
    return ok(`Approved: ${closed.text}`);
  }
  if (now?.landApproval && !now.landApproval.approved) {
    await tell("again", closed.text);
    return ok(`Approved, but landing lane ${laneId} turned up more, so it waits for you again: ${closed.text}`);
  }
  const blocked = closed.blocked ?? closed.text;
  await tell("blocked", blocked);
  return ok(`Approved. It could not land yet: ${blocked}. The Supervisor lands it once that is cleared.`);
}
