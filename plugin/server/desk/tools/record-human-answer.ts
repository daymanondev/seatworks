import { z } from "zod";
import { QUESTION } from "../../domain/question.ts";
import { sentBy } from "../../core/sent-by.ts";
import { clip } from "../../core/text.ts";
import { no, ok, str } from "../context.ts";
import { loadLedger } from "../ledger.ts";
import { defineTool } from "../services.ts";

/** Words as a quote is checked: spacing, a closing stop and case do not count. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLowerCase();

/** Puts an answer the Human gave in this chat on record, once their own words are found there. */
export const recordHumanAnswer = defineTool({
  name: "record_human_answer",
  input: z.strictObject({ question: z.string(), choice: z.string(), quote: z.string(), text: z.string().optional() }),
  async handle({ ctx, roster }, caller, args) {
    const { project } = caller;
    const id = args.question.trim().toUpperCase();
    const quote = flat(args.quote);
    const said = (await roster.history(caller.id, 200)).flatMap(({ item }) => (item.type === "user_message" && sentBy(item)[0] === "person" && typeof item.text === "string" ? [flat(item.text)] : []));
    if (!quote || !said.some((text) => text.includes(quote))) {
      return no(`The Human's own words "${clip(str(args.quote), 200)}" are not in this chat as far back as the desk reads: quote what they wrote exactly, or put it to them with ask_human.`);
    }
    const choice = args.choice.trim();
    const move = choice.toLowerCase() === "decline" ? "decline" : choice.toLowerCase() === "cancel" ? "cancel" : "answer";
    const recorded = ctx.transact(project, (ledger) => {
      const question = ledger.questions[id];
      if (!question) return `There is no question ${id}.`;
      if (move === "answer" && !question.options.some((option) => option.label === choice)) return `${choice} is none of ${id}'s options: ${question.options.map((option) => option.label).join(", ")}, or decline or cancel.`;
      if (!QUESTION.move(question, move)) return `${id} is already ${question.status}.`;
      question.answer = { choice, text: str(args.text) || undefined, by: "chat", quote: str(args.quote), at: Date.now() };
      return { ...question };
    });
    if (typeof recorded === "string") return no(recorded);
    ctx.event(project, { kind: "question.answered", question: id, status: recorded.status, by: "chat" });
    const lane = recorded.parked && recorded.lane ? loadLedger(project.state).lanes[recorded.lane] : undefined;
    const held = lane?.onHold ? ` Lane ${lane.id} is still on hold for it: resume_lane it once the answer is carried into the lane.` : "";
    return ok(`${id} is ${recorded.status}: ${choice}.${held}`);
  },
});
