import assert from "node:assert/strict";
import { test } from "node:test";
import { heldRound, laneWithPeer } from "./harness.ts";

test("a round the daemon cannot answer moves nothing: the copy is not put back under its seats, and the project's workspace stays", async (t) => {
  const { h, sup, lane, peer } = await laneWithPeer();
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" })).ok, true);
  const home = [...h.workspaceNames].find(([, name]) => name === h.project.slug)![0];
  const branch = h.git(h.root, "branch", "--show-current").trim();
  // As Paseo's client answers while its socket to the daemon is down.
  const agents = (h.paseo as { agents: { list(): Promise<unknown> } }).agents;
  t.mock.method(agents, "list", async () => {
    throw new Error("Transport not connected (status: disconnected)");
  });
  await assert.rejects(h.tick(), /Transport not connected/);

  assert.deepEqual(h.ledger().lanes.L1!.restoring?.writers.sort(), [lane.lead!, peer].sort(), "both seats may still be writing in the copy");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), branch);
  assert.equal(h.archivedWorkspaces.has(home), false);
});

test("a seat started while a round runs is not taken for gone by that round, which listed the seats before it: no task stalls, no Lead is reported gone, no ask moves", async (t) => {
  const { h, sup, lane } = await laneWithPeer();
  const { round, release } = await heldRound(h, t);
  const parallel = (key: string, title: string, owned: string) => ({ tasks: [{ key, title, goal: "g", acceptance: ["a"], owned: [owned], outOfScope: ["the rest of the repository"], parallel: true }] });
  assert.equal((await h.call(lane.lead!, "lead", "add_tasks", parallel("u", "Second", "b.txt"))).ok, true);
  assert.equal((await h.call(sup, "supervisor", "open_lane", { title: "Rounding", outcome: "money rounds correctly", acceptance: ["a"], outOfScope: ["anything else"], isolate: true })).ok, true);
  const other = h.ledger().lanes.L2!;
  assert.equal((await h.call(other.lead!, "lead", "add_tasks", parallel("v", "Third", "c.txt"))).ok, true);
  const third = Object.values(h.ledger().tasks).find((task) => task.title === "Third")!;
  assert.equal((await h.call(third.peer!, "peer", "ask", { question: "Which rounding?", bestGuess: "half up" })).ok, true);
  release();
  await round;

  const second = Object.values(h.ledger().tasks).find((task) => task.title === "Second")!;
  assert.deepEqual([second.status, second.peerGone ?? false], ["running", false]);
  assert.deepEqual(Object.values(h.ledger().asks).map((ask) => ask.to), [other.lead]);
  await h.idle(lane.lead!);
  await h.idle(sup);
  assert.doesNotMatch(h.heard(lane.lead!).join("\n"), /was closed or archived/);
  assert.doesNotMatch(h.heard(sup).join("\n"), /LEAD GONE/);
});
