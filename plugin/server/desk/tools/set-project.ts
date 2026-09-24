import { z } from "zod";
import { configFault } from "../../core/config-file.ts";
import { branchExists, LAND_AS } from "../../core/git.ts";
import { no, ok, str, strs } from "../context.ts";
import { type ProjectConfig, configFile, loadConfig, saveConfig } from "../project.ts";
import { defineTool } from "../services.ts";

export const setProject = defineTool({
  name: "set_project",
  input: z.strictObject({ base: z.string().optional(), gate: z.string().optional(), gateTimeoutMinutes: z.number().optional(), gateOn: z.enum(["lane", "task"]).optional(), serialOnly: z.array(z.string()).optional(), landAs: z.enum(["squash", "merge", "ff"]).optional() }),
  async handle(_desk, caller, args) {
    // Refused as open_lane refuses: read as all defaults, an unreadable file was saved over with them.
    const unreadable = configFault(configFile(caller.project.state));
    if (unreadable) return no(`${unreadable}\nOnly the Human can repair it or move it aside; nothing was saved over it.`);
    const config = loadConfig(caller.project.state);
    const base = str(args.base);
    if (base && !(await branchExists(caller.project.root, base))) return no(`The branch ${base} does not exist.`);
    const minutes = Number(args.gateTimeoutMinutes);
    const next: ProjectConfig = {
      ...config,
      base: base || config.base,
      gate: typeof args.gate === "string" ? args.gate.trim() : config.gate,
      gateTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : config.gateTimeoutMinutes,
      gateOn: args.gateOn === "task" ? "task" : args.gateOn === "lane" ? "lane" : config.gateOn,
      serialOnly: Array.isArray(args.serialOnly) ? strs(args.serialOnly) : config.serialOnly,
      landAs: LAND_AS.find((as) => as === args.landAs) ?? config.landAs,
    };
    saveConfig(caller.project.state, next);
    return ok(`Base ${next.base ?? "unset"}; gate ${next.gate || "none"}, run per ${next.gateOn}; gate timeout ${next.gateTimeoutMinutes} minutes; lanes land as ${next.landAs}.`);
  },
});
