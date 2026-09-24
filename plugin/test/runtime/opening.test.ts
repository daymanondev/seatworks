import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

test("a Lead is told what its lane writes, what it depends on, and what only one writer at a time may write", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Build", outcome: "a.txt changes", acceptance: ["a"], outOfScope: ["z"], writeSet: ["a.txt", "package-lock.json"], contracts: ["b.txt"] });
  const directive = h.agents.get(h.ledger().lanes.L1!.lead!)!.prompt ?? "";
  assert.match(directive, /^Writes: a\.txt, package-lock\.json\. A task owning a path outside these is flagged when you lay out the plan and again at landing; if the work needs more, ask with kind need\.$/m);
  assert.match(directive, /^Depends on: b\.txt, which this lane uses and does not write\.$/m);
  assert.match(directive, /^One writer at a time: package-lock\.json\. A task that writes any of these works in the lane's working copy, not in parallel\.$/m, "read from the files the lane's copy holds");
  assert.match(directive, /^Gate: /m);
});
