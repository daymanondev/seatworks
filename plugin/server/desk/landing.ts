import type { Checkpoints } from "../catalog/team.ts";
import { commitsAhead, diffCounts, git, kindOf, outsideOwned } from "../core/git.ts";
import { globToRegex } from "../core/scope.ts";
import { weakened } from "../runtime/watch/facts.ts";
import { loadIncidents } from "./incidents.ts";
import { type Lane, type Ledger, tasksOf } from "./ledger.ts";
import { type Kit, fileKinds, testMarkers } from "../catalog/kit.ts";
import { type Project, serialOnlyOf } from "./project.ts";

type LandGate = { set: boolean; ok: boolean };

export const NOT_READY = "Its Lead has not reported it ready as it now stands: never, or the lane was amended since.";
export const GATE_FAILED = "The gate failed on the lane, and landing was asked for over it.";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

async function changed(root: string, range: string, filter: "D" | "M"): Promise<string[]> {
  const run = await git(root, ["diff", "-z", "--name-only", `--diff-filter=${filter}`, range]);
  return run.stdout.split("\0").filter(Boolean);
}

/**
 * What a lane brings onto its base, read from git and the record rather than from anything a seat said: `signals` are
 * the reasons a person should see it before it lands, any one enough; `evidence` is the rest of what they would read.
 */
export async function landCheck(kit: Kit, project: Project, ledger: Ledger, lane: Lane, gate: LandGate, checks: Checkpoints): Promise<{ signals: string[]; evidence: string[] }> {
  const { root } = project;
  const range = `${lane.base}..${lane.branch}`;
  const serial = serialOnlyOf(project, kit).map((rule) => globToRegex(rule));
  const kinds = fileKinds(kit);
  const markers = testMarkers(kit);
  const counts = await diffCounts(root, lane.base, lane.branch, kinds, (path) => serial.some((rule) => rule.test(path)));
  const files = [...new Set(counts?.files ?? [])];
  const lines = counts ? counts.src + counts.test + counts.docs : 0;
  const tests = files.filter((path) => kindOf(path, kinds) === "test");
  const deleted = (await changed(root, range, "D")).filter((path) => kindOf(path, kinds) === "test");
  const weaker: string[] = [];
  for (const path of (await changed(root, range, "M")).filter((file) => kindOf(file, kinds) === "test")) {
    const [before, after] = await Promise.all([lane.base, lane.branch].map(async (ref) => (await git(root, ["show", `${ref}:${path}`])).stdout));
    const how = weakened(before!, after!, markers);
    if (how) weaker.push(`${path}: ${how}.`);
  }
  const risky = new RegExp(checks.risk, "i");
  const tasks = tasksOf(ledger, lane.id);
  const open = Object.values(loadIncidents(project.state).items).filter((incident) => incident.open && incident.lane === lane.id);
  const signals = [
    ...(lane.ready ? [] : [NOT_READY]),
    ...(!gate.set ? ["This project has no gate, so nothing ran the lane's checks."] : gate.ok ? [] : [GATE_FAILED]),
    ...deleted.map((path) => `${path} is deleted.`),
    ...weaker,
    ...files.filter((path) => risky.test(path)).map((path) => `${path} is a path this project counts as risky.`),
    ...(lines > checks.landLines ? [`${lines} lines changed, over the ${checks.landLines} this project reviews in one sitting.`] : []),
    ...(lane.writeSet.length > 0 ? outsideOwned(files, lane.writeSet).map((path) => `${path} is outside the lane's write set, ${lane.writeSet.join(", ")}.`) : []),
    ...tasks.filter((task) => task.status === "merged" && task.handback?.gate?.ok === false).map((task) => `${task.id} was accepted over its red gate: ${task.handback!.gate!.note}.`),
    ...open.map((incident) => `Incident ${incident.id} on this lane is still open: ${incident.kind}.`),
  ];
  const commits = await commitsAhead(root, lane.base, lane.branch);
  const evidence = [
    `${commits === undefined ? "Commits unknown" : plural(commits, "commit")}; ${plural(files.length, "file")}, ${plural(lines, "line")} changed.`,
    `Gate: ${!gate.set ? "none set" : gate.ok ? "passed on the lane" : "failed on the lane"}.`,
    ...(tests.length > 0 ? [`Tests changed: ${tests.join(", ")}.`] : []),
    ...tasks.filter((task) => task.kind === "review" && task.handback).map((task) => `${task.id} review: ${task.handback!.outcome}.`),
  ];
  return { signals, evidence };
}
