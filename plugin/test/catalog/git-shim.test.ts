import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit.ts";
import { gitShim } from "../../server/catalog/launch.ts";
import { tempDir } from "../tempdir.ts";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const git = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
})!;

/** A repository with one commit on main, and a way to run a command in it as a seat's git. */
function repo() {
  const root = tempDir("sw2-shim-");
  execFileSync(git, ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync(git, ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const run = (bin: string[], ...args: string[]) => spawnSync(bin[0]!, [...bin.slice(1), ...args], { encoding: "utf-8" });
  return { root, run };
}

test("a seat's git refuses what only the desk does to branches and copies, however it is spelled, and runs the rest", () => {
  const { root, run } = repo();
  const shim = ["node", join(plugin, "bin", "git-shim.mjs"), git];
  const refused = (...args: string[]) => {
    const ran = run(shim, ...args);
    return ran.status === 1 && /^git: refused: /.test(ran.stderr);
  };
  assert.ok(refused("-C", root, "push", "origin", "main"), "-C does not hide a push");
  assert.ok(refused("-c", "alias.p=push", "-C", root, "p"), "nor does an alias given inline");
  assert.equal(run(shim, "-C", root, "config", "alias.sw", "switch").status, 0);
  assert.ok(refused("-C", root, "sw", "-c", "elsewhere"), "nor one kept in the repository's config");
  assert.ok(refused("--no-pager", `--git-dir=${join(root, ".git")}`, `--work-tree=${root}`, "checkout", "-b", "x"));
  assert.ok(refused("-C", root, "branch", "-D", "main"));
  // A pull is a merge, and deleting, renaming or overwriting a branch leaves the desk's record naming one that is gone; git takes a long option cut short.
  assert.ok(refused("-C", root, "pull", "--no-rebase", ".", "main"), "a pull merges as a merge does");
  for (const flags of [["-d"], ["--delete"], ["--del"], ["-m", "moved"], ["--move", "moved"], ["--mo", "moved"], ["-C", "copied"], ["-vd"], ["--forc", "HEAD"]]) assert.ok(refused("-C", root, "branch", ...flags.slice(0, 1), "main", ...flags.slice(1)), `git branch ${flags[0]}`);
  assert.ok(refused("-C", root, "worktree", "add", join(root, "..", "aside")));
  for (const allowed of [["status", "--short"], ["branch"], ["branch", "-vv"], ["branch", "-c", "main", "copy"], ["branch", "aside"], ["branch", "--sort", "-committerdate"], ["worktree", "list"], ["log", "--oneline"]]) {
    const ran = run(shim, "-C", root, ...allowed);
    assert.equal(ran.status, 0, `${allowed.join(" ")}: ${ran.stderr}`);
  }
  assert.equal(run(shim, "-C", root, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "work").status, 0);
  assert.match(run(shim, "-C", root, "log", "--oneline").stdout, /work\n[^\n]*seed/, "and what it runs is the real git's doing");
});

test("every seat's PATH starts at a launcher named git that runs the shim with the real git", () => {
  const { root, run } = repo();
  const dir = gitShim(loadKit(plugin), tempDir("sw2-shim-state-"))!;
  assert.ok(dir);
  assert.equal(run([join(dir, "git")], "-C", root, "push").status, 1);
  assert.equal(run([join(dir, "git")], "-C", root, "status").status, 0);
  const onPath = spawnSync("/bin/sh", ["-c", `git -C '${root}' push`], { encoding: "utf-8", env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` } });
  assert.match(onPath.stderr, /^git: refused: git push/, "found by name, as a seat's shell finds it");
});
