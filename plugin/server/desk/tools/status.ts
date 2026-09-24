import { z } from "zod";
import { can } from "../../catalog/kit.ts";
import { uncommittedWork } from "../../catalog/project-files.ts";
import { currentBranch, headSha } from "../../core/git.ts";
import { ok } from "../context.ts";
import { laneOfLead, loadLedger } from "../ledger.ts";
import { loadConfig } from "../project.ts";
import { defineTool } from "../services.ts";
import { type OwnCopy, statusText } from "../status.ts";

async function ownCopy(root: string): Promise<OwnCopy> {
  const branch = await currentBranch(root);
  return { branch, head: branch ? undefined : (await headSha(root))?.slice(0, 7), work: await uncommittedWork(root) };
}

/** A supervisor also sees the Human's own checkout, read from git only here, when it asks. */
export const status = defineTool({
  name: "status",
  input: z.strictObject({}),
  async handle({ ctx, roster }, caller) {
    const ledger = loadLedger(caller.project.state);
    const seats = new Map((await roster.open()).map((seat) => [seat.id, seat]));
    const lane = can(caller.role, "lead") ? laneOfLead(ledger, caller.id)?.id : undefined;
    const copy = can(caller.role, "supervise") ? await ownCopy(caller.project.root) : undefined;
    return ok(statusText(caller.project, ledger, loadConfig(caller.project.state), seats, Date.now(), { laneId: lane, copy, checks: copy && ctx.team(caller.project).checkpoints }));
  },
});
