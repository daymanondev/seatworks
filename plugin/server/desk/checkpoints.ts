import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointMode } from "../../shared/settings.ts";
import type { Project } from "./project.ts";
import { appendRecord } from "./records.ts";

/** One time a checkpoint ran: what it was run on, what it found, and what it decided, whether or not that held anything. */
type Run = {
  checkpoint: "land";
  mode: CheckpointMode;
  lane: string;
  by: string;
  decision: "pass" | "ask" | "approved" | "sent back";
  findings: string[];
  /** On a decision, how long what it held waited for it. */
  waitedMs?: number;
};

/** Every run is kept, passes too: they are the count a shadow period is read against before the check is turned on. */
export function keepRun(project: Project, run: Run): void {
  appendRecord(project.state, "checkpoints", `${JSON.stringify({ at: new Date().toISOString(), ...run })}\n`);
}

type Logged = Run & { at: string };

/** Every run the log holds since it last rolled; a line cut short by a stop mid-write is skipped, not allowed to take the status page down. */
function readRuns(project: Project): Logged[] {
  const file = join(project.state, "checkpoints.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Logged];
      } catch {
        return [];
      }
    });
}

/** What the log since it last rolled says of the land check. */
export function runsOf(project: Project): { runs: number; asked: number; last?: Logged } {
  const runs = readRuns(project).filter((run) => run.checkpoint === "land" && ["pass", "ask"].includes(run.decision));
  return { runs: runs.length, asked: runs.filter((run) => run.decision === "ask").length, last: runs.filter((run) => run.decision !== "pass").at(-1) };
}
