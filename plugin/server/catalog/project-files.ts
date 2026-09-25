import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BLOCK_FILES = ["AGENTS.md", "CLAUDE.md"];
const BEGIN = "<!-- seatworks:begin";

/** The project's files that still hold the team block an earlier version wrote: the desk writes nothing of the Human's, so they take it out. */
export function oldBlockIn(root: string): string[] {
  return BLOCK_FILES.filter((name) => existsSync(join(root, name)) && readFileSync(join(root, name), "utf-8").includes(BEGIN));
}
