import assert from "node:assert/strict";
import { test } from "node:test";
import { laneWithPeer } from "./harness.ts";

test("a Peer that changed files outside its owned paths is told so as it hands back, and its Lead reads it in the hand-back", async () => {
  const { h, lane, peer } = await laneWithPeer();
  h.commit(lane.worktree!, "a.txt", "A\n");
  h.commit(lane.worktree!, "b.txt", "B\n");
  const handed = await h.call(peer, "peer", "done", { outcome: "complete", summary: "a, and b on the way" });
  assert.match(handed.text, /^Handed back\. You changed b\.txt outside your owned paths; your Lead sees that with the hand-back\./);
  await h.idle(lane.lead!);
  assert.match(h.agents.get(lane.lead!)!.sent.join("\n"), /Discovered: nothing\nChanged outside its owned paths: b\.txt/);

  // A task beside it is measured from where its branch left the lane's, not from the lane's tip now.
  await h.call(lane.lead!, "lead", "add_tasks", { tasks: [{ key: "t", title: "Side", goal: "g", acceptance: ["a"], owned: ["c.txt"], outOfScope: ["the rest"], parallel: true }] });
  const side = h.ledger().tasks["L1-T2"]!;
  h.commit(side.worktree!, "c.txt", "C\n");
  h.commit(lane.worktree!, "a.txt", "moved on\n");
  const clean = await h.call(side.peer!, "peer", "done", { outcome: "complete", summary: "c" });
  assert.doesNotMatch(clean.text, /outside your owned paths/);
});
