import { configFault } from "../core/config-file.ts";
import { changedFiles, commitsAhead, diffCounts, git, kindOf, mergeBase, outsideOwned } from "../core/git.ts";
import { coverOf, globToRegex } from "../core/scope.ts";
import { type Kit, fileKinds, testMarkers, weakened } from "../catalog/kit.ts";
import { loadIncidents } from "./incidents.ts";
import { type Lane, type Ledger, type Task, tasksOf } from "./ledger.ts";
import { type Project, configFile, loadConfig, serialOnlyOf } from "./project.ts";

type LandGate = { set: boolean; ok: boolean };

/** What a lane changed, from where it left its base, or where an onBranch lane began on a branch that had history before it. */
type Change = { from?: string; files?: string[] };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const SHOWN = 5;

const shown = (paths: string[]) => (paths.length > SHOWN ? `${paths.slice(0, SHOWN).join(", ")} and ${paths.length - SHOWN} more` : paths.join(", "));

type Reviewed = Task & { handback: NonNullable<Task["handback"]> };

/**
 * What a lane's reviews leave standing, read from the record: no review of the whole lane, a latest review that did not
 * accept, and a task accepted over its own review's changes. Evidence for whoever lands it, never a refusal.
 */
export function reviewFacts(ledger: Ledger, lane: Lane): string[] {
  const tasks = tasksOf(ledger, lane.id);
  const reviews = tasks.filter((task): task is Reviewed => task.kind === "review" && task.handback !== undefined).sort((a, b) => a.handback.at - b.handback.at);
  const accepted = tasks.filter((task): task is Task & { acceptedAt: number } => task.kind === "code" && task.status === "merged" && task.acceptedAt !== undefined);
  const facts = reviews.some((review) => !review.of) ? [] : ["No review of the whole lane is on record."];
  const latest = reviews.at(-1);
  if (latest && latest.handback.outcome !== "accept") {
    const since = accepted.filter((task) => task.acceptedAt > latest.handback.at).map((task) => task.id);
    const after = since.length > 0 ? `; ${since.join(", ")} ${since.length === 1 ? "was" : "were"} accepted after it, with no review since.` : ", and nothing was accepted after it.";
    facts.push(`The lane's latest review, ${latest.id}, ended in ${latest.handback.outcome}${after}`);
  }
  for (const task of accepted) {
    const own = reviews.filter((review) => review.of === task.id && review.handback.at < task.acceptedAt).at(-1);
    if (own && own.handback.outcome !== "accept") facts.push(`${task.id} was accepted over ${own.id}, a review of it that ended in ${own.handback.outcome}.`);
  }
  return facts;
}

export async function changeOf(project: Project, lane: Lane): Promise<Change> {
  const from = lane.onBranch ? lane.startSha : await mergeBase(project.root, lane.base, lane.branch);
  return { from, files: from ? await changedFiles(project.root, `${from}..${lane.branch}`) : undefined };
}

/** Why landing `change` waits for the Human: the paths it touches that they asked to be asked about first, or orders that cannot be read. */
export function askFirstHits(project: Project, change: Change): string[] {
  const fault = configFault(configFile(project.state));
  if (fault) return [`The Human's standing orders cannot be read (${fault}), so no landing goes ahead without them.`];
  const { askFirst } = loadConfig(project.state);
  if (askFirst.length === 0) return [];
  const files = change.files;
  if (!files) return ["What the lane changed could not be read, so it is not known to stay clear of what the Human asked to be asked about first."];
  return askFirst.flatMap((path) => {
    const cover = coverOf(path);
    const hit = files.filter((file) => cover.test(file));
    return hit.length > 0 ? [`It changes ${shown(hit)}, under ${path}, which the Human asked to be asked about first.`] : [];
  });
}

async function changed(root: string, range: string, filter: "D" | "M"): Promise<string[]> {
  const run = await git(root, ["diff", "-z", "--name-only", `--diff-filter=${filter}`, range]);
  return run.stdout.split("\0").filter(Boolean);
}

/**
 * What a lane brings onto its base, read from git and the record rather than from anything a seat said: evidence for whoever
 * lands it and for the Human, never a reason to hold it. `gate` is left out where the gate's own verdict is already given.
 */
export async function landFacts(kit: Kit, project: Project, ledger: Ledger, lane: Lane, change: Change, gate?: LandGate): Promise<string[]> {
  const { root } = project;
  const { from } = change;
  if (!from) return [`What ${lane.branch} changed could not be read from git.`, ...reviewFacts(ledger, lane)];
  const range = `${from}..${lane.branch}`;
  const serial = serialOnlyOf(project, kit).map((rule) => globToRegex(rule));
  const kinds = fileKinds(kit);
  const counts = await diffCounts(root, from, lane.branch, kinds, (path) => serial.some((rule) => rule.test(path)));
  const files = [...new Set(counts?.files ?? [])];
  const lines = counts ? counts.src + counts.test + counts.docs : 0;
  const tests = files.filter((path) => kindOf(path, kinds) === "test");
  const deleted = (await changed(root, range, "D")).filter((path) => kindOf(path, kinds) === "test");
  const weaker: string[] = [];
  for (const path of (await changed(root, range, "M")).filter((file) => kindOf(file, kinds) === "test")) {
    const [before, after] = await Promise.all([from, lane.branch].map(async (ref) => (await git(root, ["show", `${ref}:${path}`])).stdout));
    const how = weakened(before!, after!, testMarkers(kit));
    if (how) weaker.push(`${path}: ${how}.`);
  }
  const tasks = tasksOf(ledger, lane.id);
  const open = Object.values(loadIncidents(project.state).items).filter((incident) => incident.open && incident.lane === lane.id);
  const commits = await commitsAhead(root, from, lane.branch);
  return [
    `${commits === undefined ? "Commits unknown" : plural(commits, "commit")}; ${plural(files.length, "file")}, ${plural(lines, "line")} changed.`,
    ...(!gate ? [] : !gate.set ? ["Gate: none set, so nothing ran the lane's checks."] : [`Gate: ${gate.ok ? "passed" : "failed"} on the lane.`]),
    ...(tests.length > 0 ? [`Tests changed: ${tests.join(", ")}.`] : []),
    ...deleted.map((path) => `${path} is deleted.`),
    ...weaker,
    ...(lane.writeSet.length > 0 ? outsideOwned(files, lane.writeSet).map((path) => `${path} is outside the lane's write set, ${lane.writeSet.join(", ")}.`) : []),
    ...tasks.filter((task) => task.status === "merged" && task.handback?.gate?.ok === false).map((task) => `${task.id} was accepted over its red gate: ${task.handback!.gate!.note}.`),
    ...open.map((incident) => `Incident ${incident.id} on this lane is still open: ${incident.kind}.`),
    ...tasks.filter((task) => task.kind === "review" && task.handback).map((task) => `${task.id} review: ${task.handback!.outcome}.`),
    ...reviewFacts(ledger, lane),
  ];
}
