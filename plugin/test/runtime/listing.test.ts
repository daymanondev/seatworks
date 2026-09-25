import assert from "node:assert/strict";
import { test } from "node:test";
import { laneWithPeer } from "./harness.ts";

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
