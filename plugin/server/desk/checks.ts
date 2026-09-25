import { basename } from "node:path";
import type { Kit } from "../catalog/kit.ts";
import { clip } from "../core/text.ts";
import type { Case } from "./judging.ts";
import type { Task } from "./ledger.ts";
import { type Project, riskRulesOf } from "./project.ts";

const SAID = 3000;

/**
 * What a hand-back asks: of a task handed back complete, whether its summary says something asked for was not done; of a
 * review that accepts a change risk rules reach, whether its report says each rule's invariant was checked by running code.
 */
export function handbackCase(kit: Kit, project: Project, task: Task, handback: { file: string; outcome: string; summary: string; body: string }): Case | undefined {
  const episode = basename(handback.file);
  if (task.kind === "code") {
    if (handback.outcome !== "complete") return undefined;
    return { subject: task.id, episode, state: { summary: clip(handback.summary, SAID), out_of_scope: task.outOfScope }, asked: { summary_admits_gap: { check: "summary_admits_gap" } } };
  }
  if (handback.outcome !== "accept") return undefined;
  const invariants = [...new Set(riskRulesOf(project, kit).filter((rule) => task.asked?.includes(rule.reviewQuestion)).map((rule) => rule.invariant))];
  if (invariants.length === 0) return undefined;
  const asked = Object.fromEntries(invariants.map((invariant, index) => [`review_ran_invariant__${index + 1}`, { check: "review_ran_invariant", fill: { invariant } }]));
  return { subject: task.id, episode, state: { report: clip(handback.body, SAID) }, asked };
}
