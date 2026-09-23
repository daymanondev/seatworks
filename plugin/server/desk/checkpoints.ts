import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointMode } from "../catalog/team.ts";
import type { Project } from "./project.ts";
import { appendRecord } from "./records.ts";

/** One time a checkpoint ran: what it was run on, what it found, and what it decided, whether or not that held anything. */
export type Run = {
  checkpoint: "plan";
  mode: CheckpointMode;
  lane: string;
  by: string;
  decision: "pass" | "hold" | "ask" | "approved" | "sent back";
  findings: string[];
  /** On a decision, how long the plan waited for it. */
  waitedMs?: number;
};

/** Every run is kept, passes too: they are the count a shadow period is read against before the check is turned on. */
export function keepRun(project: Project, run: Run): void {
  appendRecord(project.state, "checkpoints", `${JSON.stringify({ at: new Date().toISOString(), ...run })}\n`);
}

/** What the log since it last rolled says of one checkpoint. */
export function runsOf(project: Project, checkpoint: Run["checkpoint"]): { runs: number; held: number; asked: number; last?: Run & { at: string } } {
  const file = join(project.state, "checkpoints.log");
  const runs = existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          // A line cut short by a stop mid-write is skipped, not allowed to take the status page down with it.
          try {
            return [JSON.parse(line) as Run & { at: string }];
          } catch {
            return [];
          }
        })
        .filter((run) => run.checkpoint === checkpoint && ["pass", "hold", "ask"].includes(run.decision))
    : [];
  const held = runs.filter((run) => run.decision === "hold");
  return { runs: runs.length, held: held.length, asked: runs.filter((run) => run.decision === "ask").length, last: held.at(-1) };
}
