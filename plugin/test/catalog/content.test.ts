import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderPrompt, renderText, skillProblems } from "../../server/catalog/content.ts";
import { makeKit } from "../kit.ts";

test("guides and state placeholders render into the prompt", () => {
  const kit = makeKit();
  const supervisor = kit.roles.find((role) => role.role === "supervisor")!;
  assert.equal(renderPrompt(kit, supervisor, { guides: "/g", state: "/s" }), "# Supervisor\n\nGuides live in /g; state in /s.\n");
});

test("a placeholder the renderer does not know is refused rather than shipped", () => {
  const kit = makeKit();
  const lead = kit.roles.find((role) => role.role === "lead")!;
  writeFileSync(join(kit.dir, "content/prompts/LEAD.md"), "Read {{notes}} first.\n");
  assert.throws(() => renderPrompt(kit, lead, { guides: "/g", state: "/s" }), /placeholder \{\{notes\}\}/);
});

test("the words a role must not see are looked for in what was written, not in the paths the desk puts in", () => {
  const kit = makeKit();
  const lead = kit.roles.find((role) => role.role === "lead")!;
  // Checked after substitution, a repository or home directory named after one of those words made the seat unbuildable.
  const text = renderText(lead, "Write your plans in {{state}}/plans.", { guides: "/g", state: "/Users/supervisor/projects/x" });
  assert.match(text, /\/Users\/supervisor\/projects\/x\/plans/);
  assert.throws(() => renderText(lead, "Ask the supervisor.", { guides: "/g", state: "/s" }), /must not see: supervisor/);
});

test("a role's text may name under the project's state only what the role writes, or the desk's own record to read", () => {
  const kit = makeKit();
  const lead = kit.roles.find((role) => role.role === "lead")!;
  const paths = { guides: "/g", state: "/s" };
  assert.doesNotThrow(() => renderText(lead, "Put the plan in {{state}}/plans/cart.md; the history is in $SEATWORKS_STATE/events.log.", paths));
  assert.throws(() => renderText(lead, "Keep a diary in {{state}}/diary.md.", paths), /the lead prompt names diary\.md under the project's state, which the role does not write/);
  const skill = join(kit.dir, "content", "skills", "peer", "notes");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "Write findings to $SEATWORKS_STATE/findings/.\n");
  assert.deepEqual(skillProblems(lead, "notes", skill), ["skill notes names findings under the project's state in SKILL.md, which the lead does not write: add it to the role's writes"]);
});
