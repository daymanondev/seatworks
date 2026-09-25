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

test("a lane reported ready carries what its reviews leave standing, and each fact goes once the record settles it", async () => {
  const h = harness();
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Rounding", outcome: "money rounds correctly", acceptance: ["a"], outOfScope: ["anything else"] });
  const lane = h.ledger().lanes.L1!;
  await h.call(lane.lead!, "lead", "add_tasks", { tasks: [{ key: "t", title: "Round", goal: "g", acceptance: ["a"], owned: ["a.txt"], outOfScope: ["the rest"] }] });
  h.commit(lane.worktree!, "a.txt", "rounded\n");
  await h.call(h.ledger().tasks["L1-T1"]!.peer!, "peer", "done", { outcome: "complete", summary: "rounded" });
  const finding = { severity: "P1", where: "a.txt:1", failure: "rounds half down", fix: "round half up" };
  const start = async (task?: string) => {
    await h.call(lane.lead!, "lead", "start_review", { ...(task ? { task } : {}), focus: "Is the rounding right?" });
    return Object.values(h.ledger().tasks).filter((entry) => entry.kind === "review").at(-1)!.peer!;
  };
  const handBack = async (reviewer: string, verdict: string) => {
    const handed = await h.call(reviewer, "reviewer", "done", { verdict, answer: "Read the diff.", ...(verdict === "accept" ? {} : { findings: [finding] }) });
    assert.equal(handed.ok, true, handed.text);
    await new Promise((resolve) => setTimeout(resolve, 2));
  };
  const ready = async (summary: string) => (await h.call(lane.lead!, "lead", "report", { summary, ready: true })).text;

  await handBack(await start("L1-T1"), "changes");
  assert.equal((await h.call(lane.lead!, "lead", "accept", { task: "L1-T1" })).ok, true);
  const first = await ready("first");
  assert.match(first, /No review of the whole lane is on record\. The lane's latest review, L1-R1, ended in changes; L1-T1 was accepted after it, with no review since\. L1-T1 was accepted over L1-R1, a review of it that ended in changes\./);
  assert.match(h.heard(sup).join("\n"), /REPORT L1 \(Rounding\): ready to land[^]*What the desk read of it:\n[^]*- No review of the whole lane is on record\.\n- The lane's latest review, L1-R1/);

  // Latest by when it came back, not by when it was asked for.
  const [asked, second] = [await start(), await start()];
  await handBack(second, "accept");
  await handBack(asked, "changes");
  const again = await ready("second");
  assert.doesNotMatch(again, /No review of the whole lane/);
  assert.match(again, /The lane's latest review, L1-R2, ended in changes, and nothing was accepted after it\. L1-T1 was accepted over L1-R1/);

  await handBack(await start(), "accept");
  const third = await ready("third");
  assert.doesNotMatch(third, /latest review/);
  assert.match(third, /It also carries what the record has of the lane's reviews: L1-T1 was accepted over L1-R1, a review of it that ended in changes\. Stay quiet/, "the Lead's own acceptance stands on the record, for whoever lands it to weigh");
});
