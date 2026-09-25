import type { Lane } from "./ledger.ts";
import { type Letter, ended, fyi, mail } from "./letters.ts";

/** The letters a landing sends: that it may go ahead, that it waits on the Human, and what the Human decided. */
export const landLetters = {
  canLand(lane: Lane): Letter {
    return mail("canland", [lane.id, Date.now()], `CAN LAND ${lane.id} (${lane.title}): the turn that was in the way has ended. land_lane it again.`);
  },

  /** The way back out of a DETOUR: the lane that waited is told, since it cannot see the other one. */
  detourLanded(detour: Lane, waiting: Lane, landing: string): Letter {
    const text = [
      `CLEARED ${detour.id} (${detour.title}), the detour your lane ${waiting.id} was waiting on: ${landing}.`,
      "",
      `Read what it did before you go on. Your lane branch ${waiting.branch} does not have it yet — ask if your work needs it there.`,
    ].join("\n");
    return mail("detour", [detour.id, Date.now()], text);
  },

  /** `head` is the lane's tip it was held at: a hold is told once per commit. */
  landHeld(lane: Lane, reason: string, head: string): Letter {
    return mail("landheld", [lane.id, head], `LAND HELD ${lane.id} (${lane.title}): the Human looks at it before it lands. ${reason} Commit nothing more on the lane until they decide: approved, it lands and the lane closes; sent back, LAND SENT BACK brings their note. A new commit means it is looked at again from the start.`);
  },

  landSentBack(lane: Lane, note: string, head: string): Letter {
    return mail("landback", [lane.id, head], `LAND SENT BACK ${lane.id} (${lane.title}): ${ended(note || "the Human gave no reason; ask what to change")} The lane stays open; report it ready again once that is dealt with.`);
  },

  landDecided(lane: Lane, how: "landed" | "blocked" | "again" | "changed" | "sent back", text: string): Letter {
    const told = (said: string) => {
      const letter = mail("land", [lane.id, how, Date.now()], said);
      // Landed or sent back asks nothing more of whoever supervises; the rest ask it to land again.
      return how === "landed" || how === "sent back" ? fyi(letter) : letter;
    };
    if (how === "landed") return told(`LANDED ${lane.id} (${lane.title}) after the Human approved it: ${text}`);
    if (how === "again") return told(`HELD AGAIN ${lane.id} (${lane.title}): the Human approved it, but landing it turned up more. ${text}`);
    if (how === "changed") return told(`CHANGED ${lane.id} (${lane.title}) after its landing was held, so the Human's approval did not count. land_lane it to have it checked as it is now.`);
    if (how === "blocked") return told(`APPROVED ${lane.id} (${lane.title}) for landing by the Human, but it could not land yet: ${text}. The approval stands while the lane does not change: once that is cleared, land_lane lands it without asking again.`);
    return told(`SENT BACK ${lane.id} (${lane.title}) by the Human: ${ended(text || "no reason was given")} The lane stays open, and its Lead has the note.`);
  },
};
