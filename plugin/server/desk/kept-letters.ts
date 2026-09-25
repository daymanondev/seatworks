import { taskBrief } from "./briefs.ts";
import type { Lane, Task } from "./ledger.ts";
import { type Letter, mail } from "./letters.ts";

/** What the desk mails a seat kept on after its work: a Peer's next task. */
export const keptLetters = {
  /** A task handed to the Peer kept in the lane's copy: its brief, as a new Peer gets it for its first prompt. */
  brief(task: Task, lane: Lane): Letter {
    return mail("brief", [task.id], taskBrief(task, lane), "This is your next task, in the same working copy: what you learned on the last one still holds where this brief does not say otherwise.");
  },
};
