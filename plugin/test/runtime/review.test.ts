import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

test("a review hands back a verdict and its findings, and the Lead is told both", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Rounding", outcome: "money rounds correctly", acceptance: ["a"], outOfScope: ["anything else"] });
  const lane = h.ledger().lanes.L1!;
  await h.call(lane.lead!, "lead", "add_tasks", { tasks: [{ key: "t", title: "Round", goal: "g", acceptance: ["a"], owned: ["a.txt"], outOfScope: ["the rest"] }] });
  h.commit(lane.worktree!, "a.txt", "rounded\n");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  h.agents.get(peer)!.status = "idle";

  const opened = await h.call(lane.lead!, "lead", "start_review", { task: "L1-T1", focus: "Is half-up right for money here?" });
  assert.equal(opened.ok, true, opened.text);
  const review = Object.values(h.ledger().tasks).find((task) => task.kind === "review")!;
  const reviewer = review.peer!;

  // A reviewer hands back a judgement in its own tool set's words, which must reach the Lead intact.
  const finding = { severity: "P3", where: "a.txt:1", failure: "banker's rounding would be safer at the boundary", fix: "none needed: half-up matches the spec" };
  const unnamed = await h.call(reviewer, "reviewer", "done", { verdict: "changes", answer: "Half-up is wrong here." });
  assert.match(unnamed.text, /A verdict of changes names what must change: give each finding\./);
  const handed = await h.call(reviewer, "reviewer", "done", { verdict: "accept", answer: "Half-up is right for money here.", findings: [finding], read: ["the diff"], ran: ["npm test -- rounding"] });
  assert.equal(handed.ok, true, handed.text);
  assert.equal(h.ledger().tasks[review.id]!.handback?.outcome, "accept", "an accepted review is recorded as accepted, not as changes");
  assert.equal(h.ledger().tasks[review.id]!.handback?.summary, "Half-up is right for money here.");

  await h.idle(lane.lead!);
  const toLead = h.agents.get(lane.lead!)!.sent.join("\n");
  assert.match(toLead, /Verdict: accept\n\nHalf-up is right for money here\.\n\nFindings:\n- P3 a\.txt:1: banker's rounding would be safer at the boundary Fix: none needed: half-up matches the spec\n\nRead: the diff\nRan: npm test -- rounding/, "the review itself reaches the Lead rather than being dropped");
});
