import type { Ask } from "./ledger.ts";
import { type Letter, firstLine, mail } from "./letters.ts";

const theirDefault = (ask: Ask): string[] => (ask.default ? ["", `Their default: ${ask.default}`] : []);

/** The letters an ask sends: to whoever it is put to, the answer back, and the reminders while it waits. */
export const askLetters = {
  askTo(ask: Ask, from: string): Letter {
    return mail("ask", [ask.id], [`ASK ${ask.id} (${ask.kind}) from ${from}`, "", ask.text, ...theirDefault(ask), "", `Reply with answer, ask ${ask.id}.`].join("\n"));
  },

  answered(ask: Ask): Letter {
    return mail("answer", [ask.id], [`ANSWER to your ask ${ask.id}`, "", ask.answer ?? ""].join("\n"));
  },

  /** The Lead an ask was put to, told what its Peer was told and by whom: the owner may answer a Lead's ask, never out of its sight. */
  answeredFor(ask: Ask, by: string, leads = true): Letter {
    const text = [
      `ANSWERED FOR YOU: ${ask.id} (${ask.kind}) from ${ask.from}, which was waiting on you, was answered by ${by}.`,
      "",
      "The question:",
      ask.text,
      "",
      "The answer it was given:",
      ask.answer ?? "",
      "",
      // Only an ask with a task has a Peer to speak of, and acceptance is only a Lead's to judge.
      ask.task && leads ? `Nothing else moved: ${ask.task} is still owned by the same Peer, on the same branch, and accepting it is still yours to judge.` : "Nothing else moved.",
      "If this changes what you were going to do, say so in your next report.",
    ].join("\n");
    return mail("answeredFor", [ask.id], text);
  },

  reminder(ask: Ask, minutes: number): Letter {
    return mail("remind", [ask.id, ask.reminders], `STILL OPEN after ${minutes} minutes: ask ${ask.id} (${ask.kind}): ${firstLine(ask.text)}`);
  },

  escalated(ask: Ask, minutes: number, lane: string): Letter {
    return mail("escalate", [ask.id], [`UNANSWERED ${ask.id} in ${lane}: a Peer has waited ${minutes} minutes on its Lead.`, "", ask.text, ...theirDefault(ask)].join("\n"));
  },
};
