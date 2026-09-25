import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { oldBlockIn } from "../../server/catalog/project-files.ts";
import { tempDir } from "../tempdir.ts";

test("the files that still hold the team block an earlier version wrote are found by its mark, and a Human's file without it is not", () => {
  const root = tempDir("sw2-files-");
  assert.deepEqual(oldBlockIn(root), []);
  writeFileSync(join(root, "AGENTS.md"), "# Ours\n\n<!-- seatworks:begin (written by Seatworks) -->\nTeam rules.\n<!-- seatworks:end -->\n");
  writeFileSync(join(root, "CLAUDE.md"), "Be brief.\n");
  assert.deepEqual(oldBlockIn(root), ["AGENTS.md"]);
});
