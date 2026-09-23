import { branchExists, currentBranch } from "../core/git.ts";
import { hash } from "./context.ts";
import { fetchIssue } from "./issue.ts";
import { type Lane, type Ledger, loadLedger } from "./ledger.ts";
import { letters } from "./letters.ts";
import { openedReply, placement, seatingKey, startLead } from "./opening.ts";
import type { Project } from "./project.ts";
import type { DeskServices } from "./services.ts";

/** Why a lane cannot wait on these, or the lanes of them still to land; every one must exist and none be dropped. */
export function waitsFor(ledger: Ledger, after: string[], onBranch: boolean): Lane[] | string {
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

/**
 * A lane open with no Lead that nothing is seating was left so by a stop. A Lead Paseo had already started is taken on;
 * otherwise what the lane took goes back, and it waits again or, its open_lane never answered, closes.
 */
async function putBackHalfOpen(desk: DeskServices, project: Project): Promise<void> {
  const { ctx, slots, roster } = desk;
  const halfOpen = (ledger: Ledger) => Object.values(ledger.lanes).filter((lane) => lane.status === "open" && !lane.lead && !ctx.seating.has(seatingKey(project, lane.id)));
  if (halfOpen(loadLedger(project.state)).length === 0) return;
  const seats = await roster.open();
  // An empty listing is a daemon that answered nothing, not word that no Lead was started.
  if (seats.length === 0) return;
  const stopped = await ctx.ledger(project, (ledger) =>
    halfOpen(ledger).map((lane) => {
      const slot = Object.values(ledger.slots).find((entry) => entry.lane === lane.id);
      const lead = seats.find((seat) => seat.labels?.["seatworks.project"] === project.slug && seat.labels["seatworks.lane"] === lane.id);
      if (lead) {
        Object.assign(lane, { lead: lead.id, worktree: lead.cwd, slot: slot?.id, workspaceId: slot?.workspaceId });
        ledger.agents[lead.id] = { id: lead.id, role: lead.labels!["seatworks.role"] ?? "lead", lane: lane.id };
      } else {
        lane.status = lane.after ? "waiting" : "closed";
        delete lane.held;
      }
      return { lane: { ...lane }, slot: slot?.id };
    }),
  );
  for (const { lane, slot } of stopped) {
    if (!lane.lead && slot) await slots.release(project, slot, lane.branch, lane.base);
    else if (!lane.lead && !lane.onBranch && (await currentBranch(project.root)) === lane.branch) await slots.giveBack(project, lane.base, lane.branch);
    ctx.event(project, { kind: "lane.halfOpen", lane: lane.id, status: lane.status, lead: lane.lead ?? null });
    if (lane.status !== "waiting") await ctx.post(await roster.supervisorFor(project, lane.opener), `halfopen:${lane.id}`, letters.halfOpen(lane));
  }
}
