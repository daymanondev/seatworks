import assert from "node:assert/strict";
import { test } from "node:test";
import { saveLedger } from "../../server/desk/ledger.ts";
import { harness } from "./harness.ts";

const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
const work = (title: string, extra: Record<string, unknown> = {}) => ({ title, goal: "g", acceptance: ["a"], owned: ["a.txt"], outOfScope: ["the rest of the repository"], ...extra });

async function openLane() {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Build", ...scope });
  return { h, sup, lead: h.ledger().lanes.L1!.lead! };
}

/** Which of these tasks hold the lane's copy now: started in it and not yet decided. */
const writing = (h: ReturnType<typeof harness>, ids: string[]) => ids.filter((id) => h.ledger().tasks[id]?.status === "running");

test("two tasks started at once in a lane's copy put one writer there, and the other is told the copy is taken", async () => {
  const { h, lead } = await openLane();
  const [first, second] = await Promise.all([h.call(lead, "lead", "start_task", work("One")), h.call(lead, "lead", "start_task", work("Two"))]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.match((first.ok ? second : first).text, /is still writing in the lane's working copy/);
  assert.equal(writing(h, Object.keys(h.ledger().tasks)).length, 1);
});

test("a waiting task released while another is started beside it puts one writer in the lane's copy", async () => {
  const { h, lead } = await openLane();
  await h.call(lead, "lead", "start_task", work("First"));
  await h.call(lead, "lead", "start_task", work("After", { after: ["L1-T1"] }));
  // The first is accepted without its acceptance starting what waited, so the round and a new start meet.
  const ledger = h.ledger();
  ledger.tasks["L1-T1"]!.status = "merged";
  saveLedger(h.project.state, ledger);
  const [, started] = await Promise.all([h.runtime.desk.openWaiting(h.project), h.call(lead, "lead", "start_task", work("Beside"))]);
  assert.equal(writing(h, ["L1-T2", "L1-T3"]).length, 1, started.text);
});

test("two lanes opened at once in the project's own copy open one there, and the other is told the copy is taken", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  // A lane open elsewhere, so each opening reads the project's files before it can decide.
  await h.call(sup, "supervisor", "open_lane", { title: "Side", ...scope, isolate: true, writeSet: ["b.txt"] });
  const [first, second] = await Promise.all([h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope }), h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope })]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.match((first.ok ? second : first).text, /is working in the project's own copy/);
  const inOwnCopy = Object.values(h.ledger().lanes).filter((lane) => lane.status === "open" && !lane.slot);
  assert.equal(inOwnCopy.length, 1);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), inOwnCopy[0]!.branch, "and the copy is on the branch of the lane that has it");
});

test("a waiting lane released while another is opened beside it puts one lane in the project's own copy", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Side", ...scope, isolate: true, writeSet: ["b.txt"] });
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, after: ["L2"] });
  // The first lands without its close opening what waited, so the round and a new lane meet.
  const ledger = h.ledger();
  Object.assign(ledger.lanes.L2!, { status: "closed", landed: true });
  saveLedger(h.project.state, ledger);
  const [, pay] = await Promise.all([h.runtime.desk.openWaiting(h.project), h.call(sup, "supervisor", "open_lane", { title: "Pay", ...scope })]);
  // Whichever came second is told the copy is taken, not left to collide with the first in git.
  assert.match(pay.ok ? (h.ledger().lanes.L3!.held?.why ?? "") : pay.text, /is working in the project's own copy/);
  const inOwnCopy = Object.values(h.ledger().lanes).filter((lane) => lane.status === "open" && !lane.slot);
  assert.equal(inOwnCopy.length, 1);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), inOwnCopy[0]!.branch);
});

test("an amendment and a new task reaching for the same paths at once do not both get them", async () => {
  const { h, lead } = await openLane();
  await h.call(lead, "lead", "start_task", work("Beside", { owned: ["b.txt"], parallel: true }));
  const [amended, started] = await Promise.all([
    h.call(lead, "lead", "amend_task", { task: "L1-T1", why: "it needs c too", owned: ["b.txt", "c.txt"] }),
    h.call(lead, "lead", "start_task", work("Other", { owned: ["c.txt"], parallel: true })),
  ]);
  assert.deepEqual([amended.ok, started.ok].sort(), [false, true], `${amended.text}\n${started.text}`);
  const owners = Object.values(h.ledger().tasks).filter((task) => task.owned.includes("c.txt") && task.status === "running");
  assert.equal(owners.length, 1);
});

test("two lanes amended at once to write the same path do not both get it", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope, isolate: true, writeSet: ["a.txt"] });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, isolate: true, writeSet: ["b.txt"] });
  const [first, second] = await Promise.all([
    h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "it needs c too", writeSet: ["a.txt", "c.txt"] }),
    h.call(sup, "supervisor", "amend_lane", { lane: "L2", why: "it needs c too", writeSet: ["b.txt", "c.txt"] }),
  ]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true], `${first.text}\n${second.text}`);
  assert.match((first.ok ? second : first).text, /overlaps lane L[12] at c\.txt/);
});
