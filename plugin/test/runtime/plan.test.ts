import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness, laneWithPeer } from "./harness.ts";

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const task = (key: string, owned: string[], extra: Record<string, unknown> = {}) => ({ key, title: `Task ${key}`, goal: `do ${key}`, ...scope, owned, ...extra });
const runs = (state: string) =>
  existsSync(join(state, "checkpoints.log"))
    ? readFileSync(join(state, "checkpoints.log"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { decision: string; findings: string[]; mode: string })
    : [];

/** A lane with a Lead and nothing started, in a project whose settings say what the Human chose. */
async function lane(outbox: string, settings?: Record<string, unknown>) {
  const h = harness(outbox);
  if (settings) writeFileSync(join(h.project.state, "settings.json"), JSON.stringify(settings));
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope, writeSet: ["a.txt", "b.txt", "c.txt", "src/**"] });
  return { h, sup, lead: h.ledger().lanes.L1!.lead! };
}

test("a Lead lays its lane out at once: tasks in the lane's copy run in turn, parallel ones beside them, each starting once what it waits for is accepted", async () => {
  const { h, lane: opened, peer } = await laneWithPeer("outbox-plan.json");
  const lead = opened.lead!;
  const planned = await h.call(lead, "lead", "plan_tasks", {
    tasks: [task("totals", ["a.txt"], { after: ["L1-T1"] }), task("receipt", ["b.txt"], { parallel: true }), task("tax", ["c.txt"])],
  });
  assert.equal(planned.ok, true, planned.text);
  assert.match(planned.text, /- TOTALS is L1-T2 Task totals: waits for L1-T1/);
  assert.match(planned.text, /- RECEIPT is L1-T3 Task receipt: running, Peer/);
  assert.match(planned.text, /- TAX is L1-T4 Task tax: waits for L1-T2/, "the lane's copy takes one writer, so the plan's tasks there run one after another");
  assert.equal(h.ledger().lanes.L1!.plans, 1);
  assert.doesNotMatch(planned.text, /as evidence/, "nothing in it collides");
  await h.idle(lead);
  assert.match(h.agents.get(lead)!.sent.join("\n"), /WAITING L1-T3 \(Task receipt\), the task from your plan: Started L1-T3 in its own working copy/);

  h.commit(opened.worktree!, "a.txt", "T1\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  h.agents.get(peer)!.status = "idle";
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.deepEqual(["L1-T2", "L1-T4"].map((id) => h.ledger().tasks[id]!.status), ["running", "waiting"], "L1-T2 starts once L1-T1 is accepted, and L1-T4 still waits for it");
  h.runtime.dispose();
});

test("a plan that cannot run as given is refused whole, and nothing of it is recorded", async () => {
  const { h, lead } = await lane("outbox-plan-refused.json");
  const refused = async (tasks: unknown[]) => (await h.call(lead, "lead", "plan_tasks", { tasks })).text;
  assert.match(await refused([]), /plan_tasks was not carried out: it needs tasks/);
  assert.match(await refused([task("a", ["a.txt"]), task("A", ["b.txt"])]), /The key A names two tasks/);
  assert.match(await refused([task("a", ["a.txt"], { after: ["nope"] })]), /A: There is no task in this lane NOPE to wait for/);
  assert.match(await refused([task("a", ["a.txt"], { after: ["b"] }), task("b", ["b.txt"], { after: ["a"] })]), /The plan loops: A, B wait for each other/);
  assert.match(await refused([task("a", ["a.txt"], { skills: ["no-such-skill"] })]), /A: .*no skill called no-such-skill/);
  assert.match(await refused([task(" ", ["a.txt"])]), /Every task of a plan has a key/);
  await h.call(lead, "lead", "start_review", { focus: "is the cart shape right?" });
  assert.match(await refused([task("L1-R1", ["a.txt"])]), /The key L1-R1 is already a task of this project/);
  assert.deepEqual(Object.keys(h.ledger().tasks), ["L1-R1"], "none of those recorded a task");
  assert.equal(h.ledger().lanes.L1!.plans, undefined);
  h.runtime.dispose();
});

test("in shadow the plan check names what would collide and records it, and the plan is still taken", async () => {
  const { h, lead } = await lane("outbox-plan-shadow.json");
  const planned = await h.call(lead, "lead", "plan_tasks", {
    tasks: [task("left", ["src/x.ts"], { parallel: true }), task("right", ["src/x.ts"], { parallel: true }), task("lock", ["package-lock.json"], { parallel: true }), task("stray", ["docs/readme.md"])],
  });
  assert.equal(planned.ok, true, planned.text);
  assert.match(planned.text, /as evidence and not a refusal:/);
  assert.match(planned.text, /LEFT and RIGHT may run at once and both own src\/x\.ts/);
  assert.match(planned.text, /LOCK runs in parallel but owns package-lock\.json/);
  assert.match(planned.text, /STRAY owns docs\/readme\.md, outside the lane's write set/);
  assert.match(planned.text, /LOCK owns package-lock\.json, outside the lane's write set/);
  assert.equal(Object.keys(h.ledger().tasks).length, 4, "shadow holds nothing back");
  const [run] = runs(h.project.state);
  assert.deepEqual([run!.mode, run!.decision, run!.findings.length], ["shadow", "hold", 4]);
  assert.match((await h.call(h.ledger().lanes.L1!.opener, "supervisor", "status", {})).text, /- plan: shadow\. In checkpoints\.log: 1 checked, 1 would have been held; last held L1 at /);
  h.runtime.dispose();
});

test("in shadow a lane's first task started with no plan is recorded as one the check would have held", async () => {
  const { h, lead } = await lane("outbox-plan-none.json");
  assert.equal((await h.call(lead, "lead", "start_task", { title: "T", goal: "g", ...scope, owned: ["a.txt"] })).ok, true);
  assert.equal((await h.call(lead, "lead", "start_task", { title: "U", goal: "g", ...scope, owned: ["b.txt"], parallel: true })).ok, true);
  assert.deepEqual(runs(h.project.state).map((run) => [run.decision, run.findings[0]]), [["hold", "The lane's first task was started with no plan."]], "only the first task is the lane going without one");
  h.runtime.dispose();
});

test("with the plan check on, a plan it finds fault with goes back to the Lead and a lane's first task waits for a plan", async () => {
  const { h, sup, lead } = await lane("outbox-plan-on.json", { checkpoints: { plan: "on" } });
  assert.match((await h.call(lead, "lead", "start_task", { title: "T", goal: "g", ...scope, owned: ["a.txt"] })).text, /checks a lane's plan before its first task: lay the lane's tasks out with plan_tasks/);
  const clash = await h.call(lead, "lead", "plan_tasks", { tasks: [task("left", ["src/x.ts"], { parallel: true }), task("right", ["src/x.ts"], { parallel: true })] });
  assert.equal(clash.ok, false);
  assert.match(clash.text, /The plan was not taken[^]*LEFT and RIGHT may run at once[^]*send the whole plan again/);
  assert.deepEqual(Object.keys(h.ledger().tasks), []);
  const fixed = await h.call(lead, "lead", "plan_tasks", { tasks: [task("left", ["src/x.ts"], { parallel: true }), task("right", ["src/x.ts"], { parallel: true, after: ["left"] })] });
  assert.equal(fixed.ok, true, fixed.text);
  assert.deepEqual(runs(h.project.state).map((run) => run.decision), ["hold", "hold", "pass"], "every run is kept, the pass as well");
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /## Checkpoints\n\n- plan: on\. In checkpoints\.log: 3 checked, 2 held; last held L1 at [^:]+:[^:]+:[^:]+: The owned paths|## Checkpoints\n\n- plan: on\. In checkpoints\.log: 3 checked, 2 held; last held L1/);
  h.runtime.dispose();
});

test("settings the desk cannot read leave the plan check on, and say why, rather than falling to its default", async () => {
  const { h, sup, lead } = await lane("outbox-plan-unread.json");
  writeFileSync(join(h.project.state, "settings.json"), "{ not json");
  assert.match((await h.call(lead, "lead", "start_task", { title: "T", goal: "g", ...scope, owned: ["a.txt"] })).text, /checks a lane's plan before its first task/);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /- plan: on, because The project settings are not being used/);
  h.runtime.dispose();
});

test("a plan task that owns what a running task writes, and does not wait for it, is named", async () => {
  const { h, lane: opened } = await laneWithPeer("outbox-plan-active.json");
  const planned = await h.call(opened.lead!, "lead", "plan_tasks", { tasks: [task("beside", ["a.txt"], { parallel: true }), task("next", ["a.txt"], { parallel: true, after: ["L1-T1"] })] });
  assert.match(planned.text, /BESIDE owns a\.txt, which L1-T1 is still writing, and does not wait for it/);
  assert.doesNotMatch(planned.text, /NEXT owns a\.txt, which L1-T1/, "one that waits for it is not in its way");
  h.runtime.dispose();
});

test("a Lead changes what a task owns: the record and its Peer see the paths it owns now, and one beside others may not take theirs", async () => {
  const { h, lane: opened, peer } = await laneWithPeer("outbox-plan-amend-owned.json");
  const lead = opened.lead!;
  await h.call(lead, "lead", "start_task", { title: "B", goal: "g", ...scope, owned: ["b.txt"], parallel: true });
  await h.call(lead, "lead", "start_task", { title: "C", goal: "g", ...scope, owned: ["c.txt"], parallel: true });
  const amend = (id: string, owned: string[]) => h.call(lead, "lead", "amend_task", { task: id, why: "the plan check named a path", owned });
  assert.match((await amend("L1-T2", ["b.txt", "c.txt"])).text, /The owned paths overlap L1-T3 at c\.txt\. Leave those paths out of L1-T2/);
  assert.match((await amend("L1-T2", ["b.txt", "package-lock.json"])).text, /A parallel task can't own package-lock\.json/);
  assert.match((await amend("L1-T1", [])).text, /keeps at least one owned path/);
  assert.deepEqual(h.ledger().tasks["L1-T2"]!.owned, ["b.txt"], "a refused change leaves the record as it was");

  assert.equal((await amend("L1-T2", ["b.txt", "d.txt"])).ok, true, "its own paths are no clash with itself");
  const task = h.ledger().tasks["L1-T2"]!;
  assert.deepEqual([task.owned, task.amended?.[0]?.was], [["b.txt", "d.txt"], { owned: ["b.txt"] }]);
  await h.idle(task.peer!);
  assert.match(h.agents.get(task.peer!)!.sent.join("\n"), /owned, was:\n- b\.txt\nowned, now:\n- b\.txt\n- d\.txt/);
  assert.equal((await amend("L1-T1", ["a.txt", "c.txt"])).ok, true, "a task in the lane's copy is one writer at a time, as it is at its start");
  assert.equal(peer, h.ledger().tasks["L1-T1"]!.peer);
  h.runtime.dispose();
});
