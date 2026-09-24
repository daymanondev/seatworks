import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { currentBranch, headSha } from "../../core/git.ts";
import { workState } from "../../catalog/project-files.ts";
import { IN_QUEUE, SETTLED, TASK } from "../../domain/task.ts";
import { type Args, type Caller, type ToolReply, no, ok, str } from "../context.ts";
import { taskGate } from "../gates.ts";
import { type Task, loadLedger, taskOfPeer } from "../ledger.ts";
import { clip } from "../../core/text.ts";
import { letters } from "../letters.ts";
import { type DeskServices, defineTool } from "../services.ts";

function handbackBody(task: Task, args: Args, commit: string | undefined, uncommitted: boolean): { outcome: string; body: string } {
  if (task.kind === "review") {
    const outcome = str(args.verdict) || "changes";
    return { outcome, body: [`Verdict: ${outcome}`, "", str(args.findings) || "No findings given.", "", `Checks: ${str(args.checks) || "not given"}`].join("\n") };
  }
  const outcome = str(args.outcome) || "complete";
  const lines = [
    `Outcome: ${outcome}`,
    `Commit: ${commit ?? "none"}${uncommitted ? " (the working copy still has uncommitted changes)" : ""}`,
    "",
    str(args.summary) || "No summary given.",
    "",
    `Checks: ${str(args.checks) || "not given"}`,
    `Left undone: ${str(args.leftUndone) || "nothing"}`,
    `Discovered: ${str(args.discovered) || "nothing"}`,
  ];
  return { outcome, body: lines.join("\n") };
}

const HandBack = z.strictObject({ outcome: z.enum(["complete", "partial", "blocked"]), commit: z.string().optional(), summary: z.string(), checks: z.string().optional(), leftUndone: z.string().optional(), discovered: z.string().optional() });

const Verdict = z.strictObject({ verdict: z.enum(["accept", "changes", "reopen"]), findings: z.string(), checks: z.string().optional() });

/** What the Peer must fix before its turn ends: work left uncommitted, or a copy off the branch, where a commit belongs to no branch and goes with the copy. */
async function reminderOf(task: Task, laneBranch: string | undefined, uncommitted: boolean): Promise<string> {
  const meant = task.mode === "parallel" ? task.branch : laneBranch;
  const adrift = meant && task.worktree ? (await currentBranch(task.worktree)) !== meant : false;
  if (uncommitted) return " Your working copy still has uncommitted changes: commit them before ending your turn.";
  return adrift ? ` Your working copy is not on ${meant} any more, so anything you committed is on no branch and will be collected. Put it back — after a bisect that is git bisect reset — and commit there before your turn ends.` : "";
}

/** One hand-back for tasks and reviews: the task's kind says which of the two a seat sent. */
async function handBack({ ctx, roster }: DeskServices, caller: Caller, args: Partial<z.infer<typeof HandBack> & z.infer<typeof Verdict>>): Promise<ToolReply> {
  const { project } = caller;
  const ledger = loadLedger(project.state);
  const task = taskOfPeer(ledger, caller.id);
  if (!task) return no("No task is assigned to you.");
  if (SETTLED.includes(task.status)) return no(`This task is already ${task.status === "merged" ? "accepted" : "cut"}; there is nothing to hand back.`);
  const review = task.kind === "review";
  const commit = review ? undefined : str(args.commit) || (task.worktree ? await headSha(task.worktree) : undefined);
  // Only what git actually said: a copy it could not read is not a copy with work left in it.
  const uncommitted = !review && task.worktree ? (await workState(task.worktree)) === "dirty" : false;
  const handed = handbackBody(task, args, commit, uncommitted);
  const { outcome } = handed;
  // Gated at hand-back so the Lead has the verdict in time; gating after accept undid a merge already chosen.
  const run = !review && task.worktree ? await taskGate(project, task.id, task.worktree) : undefined;
  const body = run
    ? `${handed.body}\n\nGate: ${run.ok ? run.note : `${run.note}. This is evidence for your decision, not a decision.\n\n${run.tail}\n\nFull log: ${run.logFile}`}`
    : handed.body;
  const file = join(project.state, "handbacks", `${task.id}-${Date.now()}.md`);
  mkdirSync(join(project.state, "handbacks"), { recursive: true });
  writeFileSync(file, `# ${task.id} ${task.title}\n\n${body}\n`);
  // Decided under the lock: an accept or cut can land during the gate, and `done` over `queued` made the merge queue skip it.
  const already = ctx.transact(project, (current) => {
    const entry = current.tasks[task.id];
    if (!entry) return "gone";
    if (!TASK.move(entry, "handBack")) return entry.status;
    entry.silent = 0;
    entry.handback = { file, outcome, commit, summary: clip(str(args.summary) || str(args.findings), 400), at: Date.now(), ...(run ? { gate: { ok: run.ok, note: run.note } } : {}) };
    return undefined;
  });
  if (already) {
    return no(
      already !== "gone" && IN_QUEUE.includes(already)
        ? `${task.id} is already accepted and waiting to be merged; handing it back again would take it out of the queue. End your turn.`
        : `${task.id} is already ${already === "merged" ? "accepted" : already}; there is nothing to hand back.`,
    );
  }
  const heading = review ? { ...task, title: task.of ? `review of ${task.of}` : `review: ${task.title}` } : task;
  // A Lead no longer seated would never read it; the level above is told instead and can seat one.
  const lead = ledger.lanes[task.lane]?.lead;
  const reader = lead && (await roster.seated(lead)) ? lead : await roster.supervisorFor(project, ledger.lanes[task.lane]?.opener);
  await ctx.post(reader, letters.handback(heading, file, body, caller.id));
  ctx.event(project, { kind: review ? "review.done" : "task.done", task: task.id, outcome, commit });
  const reminder = review ? "" : await reminderOf(task, ledger.lanes[task.lane]?.branch, uncommitted);
  return ok(`Handed back.${reminder} End your turn now; if anything changes you will get a message.`);
}

export const done = defineTool({ name: "done", input: HandBack, handle: handBack });

export const doneReview = defineTool({ name: "done", input: Verdict, handle: handBack });
