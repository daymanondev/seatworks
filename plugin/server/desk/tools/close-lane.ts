import { z } from "zod";
import { close } from "../closing.ts";
import { defineTool } from "../services.ts";

export const closeLane = defineTool({
  name: "close_lane",
  input: z.strictObject({ lane: z.string(), land: z.boolean(), reason: z.string().optional(), overGate: z.boolean().optional() }),
  handle: (desk, caller, args) => close(desk, caller.project, caller.id, args),
});
