import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SensorSpec } from "../../server/catalog/kit.ts";
import { stateRoot } from "../../server/core/paths.ts";
import type { Judge, Question } from "../../server/core/ports.ts";
import { harness } from "./harness.ts";

const KEY = "a-key-for-tests-only";

/** A sensor answering every question `says`, or failing with it, and what it was asked, with which key. */
function sensor(says: number | Error) {
  const asked: { key: string; state: Record<string, unknown>; questions: Record<string, Question> }[] = [];
  const make = (_spec: SensorSpec, key: string): Judge => ({
    async ask(state, questions) {
      asked.push({ key, state, questions });
      if (says instanceof Error) throw says;
      return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, says])), model: "vendor/model-1-20260917", tokens: 321 };
    },
  });
  return { asked, make };
}

/** The machine settings with the watch judged by `judge`, and its key where one is given. */
function judgedBy(judge: string, key?: string): void {
  const file = join(stateRoot(), "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf-8"));
  writeFileSync(file, JSON.stringify({ ...settings, attention: { judge }, sensor: key ? { [judge]: { key } } : undefined }));
}

type Kept = { at: string; subject: string; episode: string; by: string; state: Record<string, unknown>; checks: Record<string, string>; questions?: Record<string, Question>; model?: string; tokens?: number; answers?: Record<string, number>; verdicts?: Record<string, string>; unasked?: string };

const kept = (state: string): Kept[] => {
  const file = join(state, "assessments.log");
  return existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Kept) : [];
};

/** What a hand-back sets going is not awaited by it: this lets it finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

async function lane(h: ReturnType<typeof harness>, owned: string) {
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Rounding", outcome: "money rounds correctly", acceptance: ["a"], outOfScope: ["anything else"] });
  const opened = h.ledger().lanes.L1!;
  await h.call(opened.lead!, "lead", "add_tasks", { tasks: [{ key: "t", title: "Round", goal: "g", acceptance: ["a"], owned: [owned], outOfScope: ["the CSV export"] }] });
  return opened;
}

test("a complete hand-back is asked whether its summary admits a gap, and what the sensor says is kept, not sent", async () => {
  const { asked, make } = sensor(0.9);
  const h = harness({ sensor: make });
  judgedBy("jev", KEY);
  const opened = await lane(h, "a.txt");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  h.commit(opened.worktree!, "a.txt", "rounded\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "Rounds half up; the refund path is stubbed for now." });
  await settled();

  const catalog = h.runtime.kit.checks.summary_admits_gap!;
  assert.deepEqual(asked, [{ key: KEY, state: { summary: "Rounds half up; the refund path is stubbed for now.", out_of_scope: ["the CSV export"] }, questions: { summary_admits_gap: { type: "noul", instructions: catalog.instructions, criteria: catalog.criteria } } }]);
  const { at, episode, ...first } = kept(h.project.state)[0]!;
  assert.ok(Date.parse(at) > 0);
  assert.match(episode, /^L1-T1-\d+\.md$/, "the hand-back it is about");
  assert.deepEqual(first, {
    subject: "L1-T1", by: "jev", state: asked[0]!.state, checks: { summary_admits_gap: "summary_admits_gap" },
    questions: asked[0]!.questions, model: "vendor/model-1-20260917", tokens: 321, answers: { summary_admits_gap: 0.9 }, verdicts: { summary_admits_gap: "yes" },
  });
  await h.idle(opened.lead!);
  assert.match(h.heard(opened.lead!).join("\n"), /HANDBACK L1-T1/);
  assert.doesNotMatch(h.heard(opened.lead!).join("\n"), /summary_admits_gap|vendor\/model-1/, "in shadow nothing the sensor said reaches a seat");

  await h.call(opened.lead!, "lead", "rework", { task: "L1-T1", text: "Do the refund path too." });
  await h.call(peer, "peer", "done", { outcome: "partial", summary: "The refund path needs a key." });
  await h.call(opened.lead!, "lead", "start_review", { task: "L1-T1", focus: "Is the rounding right?" });
  const reviewer = Object.values(h.ledger().tasks).find((task) => task.kind === "review")!.peer!;
  await h.call(reviewer, "reviewer", "done", { verdict: "accept", answer: "Right." });
  await settled();
  assert.equal(asked.length, 1, "neither a partial hand-back nor a review of what no risk rule reaches is asked");
});

test("a review that accepts a change a risk rule reaches is asked, per invariant, whether its report says it was checked by running code", async () => {
  const { asked, make } = sensor(0.1);
  const h = harness({ sensor: make });
  judgedBy("jev", KEY);
  const opened = await lane(h, "db/migrations");
  mkdirSync(join(opened.worktree!, "db", "migrations"), { recursive: true });
  h.commit(opened.worktree!, "db/migrations/001.sql", "update invoices set total = total * 100;\n");
  await h.call(h.ledger().tasks["L1-T1"]!.peer!, "peer", "done", { outcome: "complete", summary: "Moved totals to cents." });
  await h.call(opened.lead!, "lead", "start_review", { task: "L1-T1", focus: "Is the move safe?" });
  const reviewer = Object.values(h.ledger().tasks).find((task) => task.kind === "review")!.peer!;
  const rounds = { answers: ["Guarded by a version row; a backup table keeps the old totals."], ran: ["npm run migrate twice"] };
  const before = asked.length;
  await h.call(reviewer, "reviewer", "done", { verdict: "changes", answer: "Not yet.", findings: [{ severity: "P1", where: "db/migrations/001.sql:1", failure: "no guard", fix: "add one" }], ...rounds });
  await settled();
  await h.call(opened.lead!, "lead", "start_review", { task: "L1-T1", focus: "Is it safe now?" });
  const second = Object.values(h.ledger().tasks).filter((task) => task.kind === "review").at(-1)!.peer!;
  await h.call(second, "reviewer", "done", { verdict: "accept", answer: "Safe.", ...rounds });
  await settled();
  assert.equal(asked.length, before + 1, "only the review that accepts is asked");

  const rule = h.runtime.kit.ecosystem.riskRules[0]!;
  const review = asked.at(-1)!;
  assert.match(String(review.state.report), /^Verdict: accept\n\nSafe\.[^]*Ran: npm run migrate twice$/);
  assert.deepEqual(review.questions, { review_ran_invariant__1: { type: "noul", instructions: { invariant: rule.invariant, question: "Does `report` say that `invariant` was checked by running code?" }, criteria: h.runtime.kit.checks.review_ran_invariant!.criteria } });
  assert.deepEqual(kept(h.project.state).at(-1)!.verdicts, { review_ran_invariant__1: "no" });
  const checks = new Set(kept(h.project.state).flatMap((line) => Object.values(line.checks)));
  assert.deepEqual([...checks].sort(), Object.keys(h.runtime.kit.checks).sort(), "every question the catalog holds is asked at some moment of the record");
});

test("nothing is asked with the watch off or a sensor without its key, and a sensor that fails leaves the case on record, unasked", async () => {
  const failing = sensor(new Error("503: busy"));
  const h = harness({ sensor: failing.make });
  const opened = await lane(h, "a.txt");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  const handBack = async (summary: string) => {
    await h.call(opened.lead!, "lead", "rework", { task: "L1-T1", text: "Again." });
    await h.call(peer, "peer", "done", { outcome: "complete", summary });
    await settled();
  };
  judgedBy("off", KEY);
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "first" });
  await settled();
  judgedBy("jev");
  await handBack("second");
  judgedBy("jev", KEY);
  const question = h.runtime.kit.checks.summary_admits_gap!;
  question.mode = "off";
  await handBack("off in the catalog");
  question.mode = "shadow";
  assert.deepEqual([failing.asked.length, kept(h.project.state).length], [0, 0]);

  await handBack("third");
  const [unasked] = kept(h.project.state);
  assert.deepEqual([unasked!.subject, unasked!.unasked, unasked!.answers], ["L1-T1", "503: busy", undefined]);
  assert.match(readFileSync(join(h.project.state, "events.log"), "utf-8"), /"kind":"watch\.unasked","subject":"L1-T1","by":"jev","error":"503: busy"/);
});
