import assert from "node:assert/strict";
import { test } from "node:test";
import { laneWithPeer } from "./harness.ts";

test("a round whose listing holds no seat stalls no task and tells no Lead its Peer went, since that is a daemon that answered nothing", async () => {
  const { h, lane } = await laneWithPeer();
  const listed = new Map(h.agents);
  h.agents.clear();
  await h.tick();
  for (const [id, agent] of listed) h.agents.set(id, agent);

  assert.equal(h.ledger().tasks["L1-T1"]!.status, "running");
  await h.idle(lane.lead!);
  assert.doesNotMatch(h.heard(lane.lead!).join("\n"), /was closed or archived/);
});
