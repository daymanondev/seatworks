import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LAND_AS, type LandAs, gitCommonDir } from "../core/git.ts";
import { stateRoot } from "../core/paths.ts";
import { readJson, writeJson } from "../core/store.ts";
import type { Ecosystem, Kit } from "../catalog/kit.ts";

export type Project = { root: string; slug: string; state: string };

type GateOn = "lane" | "task";

/** `serialOnly` is the project's own list when it set one; without one the kit's holds, so a change to the kit reaches it. */
export type ProjectConfig = { base?: string; gate?: string; gateTimeoutMinutes: number; gateOn: GateOn; serialOnly?: string[]; landAs: LandAs };

const cache = new Map<string, Project>();

export function gitRoot(cwd: string): string {
  const common = gitCommonDir(cwd);
  if (!common) return cwd;
  return basename(common) === ".git" ? dirname(common) : common;
}

export function slugFor(root: string): string {
  const name =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
  return `${name}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`;
}

export function projectOf(cwd: string, base = stateRoot(), rootOf: (cwd: string) => string = gitRoot): Project {
  const key = `${base}\n${cwd}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const root = rootOf(cwd);
  const slug = slugFor(root);
  const project = { root, slug, state: join(base, "projects", slug) };
  cache.set(key, project);
  return project;
}

export function clearProjects(): void {
  cache.clear();
}

/** A script a package file names, unless it is the placeholder its tool writes when there is none. */
function scriptIn(file: string, name: string, unset: string): boolean {
  try {
    const body = JSON.parse(readFileSync(file, "utf-8"))?.scripts?.[name];
    return typeof body === "string" && !body.includes(unset);
  } catch {
    return false;
  }
}

/** The first of the ecosystem's gates whose files the project holds; one that runs a package script needs that script. */
export function detectGate(root: string, ecosystem: Ecosystem): string | undefined {
  const has = (name: string) => existsSync(join(root, name));
  for (const gate of ecosystem.gates) {
    const file = gate.files.find(has);
    if (!file || (gate.script && !scriptIn(join(root, file), gate.script, ecosystem.unsetScript))) continue;
    return Object.entries(gate.lockfiles ?? {}).find(([lockfile]) => has(lockfile))?.[1] ?? gate.run;
  }
  return undefined;
}

/** The commands that run `gate`: the gate first, then the test runner its script starts, which is how a seat runs its own module's tests. */
export function gateCommands(root: string, gate: string | undefined, ecosystem: Ecosystem): string[] {
  if (!gate?.trim()) return [];
  const script = new RegExp(`^(?:${ecosystem.scriptRunners.join("|")})(?: run)? ([\\w:.-]+)$`).exec(gate.trim())?.[1];
  let body: unknown;
  try {
    body = script ? JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))?.scripts?.[script] : undefined;
  } catch {}
  if (typeof body !== "string") return [gate];
  // The script's last command runs the tests; its runner is the program plus at most one word, never a path.
  const words = body.split(/&&|\|\||;/).at(-1)!.trim().split(/\s+/).slice(0, 2);
  const runner = words.slice(0, words.findIndex((word) => !/^[\w@.:-]+$/.test(word)) >>> 0).join(" ");
  return runner && runner !== gate ? [gate, runner] : [gate];
}

export function configFile(state: string): string {
  return join(state, "project.json");
}

/** The Supervisor alone writes it; a Lead is pointed at it once there is one. */
export function conceptFile(state: string): string | undefined {
  const file = join(state, "CONTEXT.md");
  return existsSync(file) ? file : undefined;
}

/** An empty gate is the owner's decision and must survive a read: as `undefined`, `open_lane` would seed a detected gate over it. */
export function loadConfig(state: string): ProjectConfig {
  const stored = readJson<Partial<ProjectConfig>>(configFile(state), {});
  const minutes = Number(stored.gateTimeoutMinutes);
  return {
    base: typeof stored.base === "string" && stored.base ? stored.base : undefined,
    gate: typeof stored.gate === "string" ? stored.gate : undefined,
    gateTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
    gateOn: stored.gateOn === "task" ? "task" : "lane",
    serialOnly: Array.isArray(stored.serialOnly) ? stored.serialOnly.map(String) : undefined,
    landAs: LAND_AS.find((as) => as === stored.landAs) ?? "squash",
  };
}

/** The paths only one writer at a time may write in this project. */
export function serialOnlyOf(project: Project, kit: Kit): string[] {
  return loadConfig(project.state).serialOnly ?? kit.ecosystem.serialOnly;
}

export function saveConfig(state: string, config: ProjectConfig): void {
  writeJson(configFile(state), config);
}
