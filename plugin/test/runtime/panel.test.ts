import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { contracts } from "../../shared/rpc.ts";
import { settle } from "./fake-timeline.ts";
import { laneWithPeer } from "./harness.ts";

const incidentsOf = (state: string) => JSON.parse(readFileSync(join(state, "incidents.json"), "utf-8")).items as Record<string, { kind: string; held?: string }>;

test("with mail off the desk records what the code sees and sends nothing until the owner turns mail on", async () => {
  const { h, sup, timeline } = await laneWithPeer();
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "tool_call", callId: "c1", name: "Bash", status: "running", detail: { type: "shell", command: "git push --force origin main" } }, "t1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await h.idle(sup);
  assert.deepEqual(Object.values(incidentsOf(h.project.state)).map((item) => [item.kind, item.held]), [["destructive", "shadow"]]);
  assert.doesNotMatch(h.agents.get(sup)!.sent.join("\n"), /INCIDENT/);
  const view = await h.rpc(contracts.flow, { project: h.project.slug });
  assert.ok("watch" in view);
  assert.deepEqual(view.watch.incidents.map((item) => [item.name, item.quote, item.held]), [["Peer · L1-T1 Clean build", "git push --force origin main", "shadow"]], "the card names the seat by its task, and shows the step and why it waits");
});

test("a desk call the harness refused for bad JSON is recorded, though it never reached the desk", async () => {
  const { h, sup } = await laneWithPeer();
  h.beginTurn(sup);
  await h.endTurn(sup, "Opening the lane.", {
    type: "tool_call",
    callId: "c1",
    name: "mcp__team__open_lane",
    status: "failed",
    error: { content: "InputValidationError: mcp__team__open_lane was called with input that could not be parsed as JSON." },
    detail: { type: "unknown", input: { __unparsedToolInput: { raw: '{"title": "Build"' } }, output: null },
  });
  // The call never reached the desk and no watch follows the Supervisor, so this log is its only record.
  const log = readFileSync(join(h.project.state, "events.log"), "utf-8");
  assert.match(log, /"kind":"call\.malformed"/);
  assert.match(log, /"tool":"mcp__team__open_lane"/);
  assert.match(log, /"role":"supervisor"/, "the Supervisor is the one role no watch follows, so this is the only way it is ever said");
  assert.equal(log.match(/"ok":false/g), null, "and no failed desk call was recorded, because the desk was never reached");

  // Paseo hands the hook the whole session, so the next turn carries the same failed call again.
  await h.endTurn(sup, "Now the task.", { type: "tool_call", callId: "c2", name: "status", status: "completed", detail: {} });
  assert.equal(readFileSync(join(h.project.state, "events.log"), "utf-8").match(/"kind":"call\.malformed"/g)!.length, 1);

  // No letter carries it, so the panel is where it is seen.
  const view = await h.rpc(contracts.flow, { project: h.project.slug });
  assert.ok("watch" in view);
  assert.deepEqual(view.watch.trouble.map((entry) => entry.kind), ["call.malformed"]);
});
