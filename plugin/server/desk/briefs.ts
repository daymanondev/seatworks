import type { Lane, Task } from "./ledger.ts";
import { list } from "./letters.ts";

export function taskBrief(task: Task, lane: Lane): string {
  return [
    `TASK ${task.id}: ${task.title}`,
    "",
    `Goal: ${task.goal}`,
    "",
    "Acceptance:",
    list(task.acceptance),
    "",
    "Owned paths (change only these):",
    list(task.owned),
    "",
    "Out of scope:",
    list(task.outOfScope),
    "",
    `Context: ${task.context?.trim() || "none"}`,
    task.skills && task.skills.length > 0 ? `\nSkills to open: ${task.skills.join(", ")}` : "",
    "",
    task.mode === "parallel"
      ? `You are on branch ${task.branch} in your own working copy, branched from ${lane.branch}. Commit your work on this branch, then call done.`
      : `You work on branch ${lane.branch} in the lane's working copy. Commit your work there, then call done.${task.startSha ? ` Your task started from ${task.startSha}: that is BASE for anything that asks what existed before you began.` : ""}`,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

/** `change` says where the change can be read and how; the desk works it out, because where it is depends on what has happened to the task's copy and branch since. */
export function reviewBrief(review: Task, target: Task | undefined, focus: string, laneBranch: string, change?: { where: string; range: string }): string {
  const lines = target
    ? [
        `REVIEW ${review.id} of ${target.id}: ${target.title}`,
        "",
        `${change?.where ?? "Your working copy holds the change"}; see it with ${change?.range ?? ""}.`,
        "",
        `Goal of the change: ${target.goal}`,
        "",
        "Acceptance it must meet:",
        list(target.acceptance),
      ]
    : [`REVIEW ${review.id}: ${review.title}`, "", `Your working copy is on ${laneBranch}. Read whatever the question needs.`];
  lines.push("", "Open question:", focus);
  if (review.asked) lines.push("", "The project asks every review of a change like this, answered in order in answers:", ...review.asked.map((question, index) => `${index + 1}. ${question}`));
  lines.push("", "Read only: don't edit files or commit. When finished, call done with your verdict and findings.");
  return lines.join("\n");
}
