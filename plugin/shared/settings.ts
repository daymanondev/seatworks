import { z } from "zod";

export const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const RoleChoice = z.strictObject({
  harness: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  rules: z.string().optional(),
});

export const Connect = z.strictObject({
  type: z.enum(["stdio", "http", "sse"]),
  command: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpChoice = z.strictObject({
  enabled: z.boolean().optional(),
  removed: z.boolean().optional(),
  label: z.string().min(1).optional(),
  connect: Connect.optional(),
  roles: z.array(z.string()).optional(),
  tools: z.record(z.string(), z.array(z.string())).optional(),
  rule: z.string().optional(),
  settings: z.record(z.string(), Scalar).optional(),
});

export type Scalar = z.infer<typeof Scalar>;
export type RoleChoice = z.infer<typeof RoleChoice>;
export type Connect = z.infer<typeof Connect>;
export type McpChoice = z.infer<typeof McpChoice>;

const Pattern = z.string().min(1).refine(
  (value) => {
    try {
      new RegExp(value, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "that is not a pattern this machine can read" },
);

export const AttentionChoice = z.strictObject({
  tickSeconds: z.number().int().min(5).optional(),
  leadIdleMinutes: z.number().int().min(1).optional(),
  askRemindMinutes: z.number().int().min(1).optional(),
  maxReminders: z.number().int().min(0).optional(),
  watch: z.boolean().optional(),
  destructive: Pattern.optional(),
  testPath: Pattern.optional(),
  repeatsAt: z.number().int().min(2).optional(),
  reworksAt: z.number().int().min(2).optional(),
  reviewsAt: z.number().int().min(2).optional(),
  suppressed: Pattern.optional(),
  longTurnMinutes: z.number().int().min(1).optional(),
  incidentsPerDay: z.number().int().min(0).optional(),
});

const FlowChoice = z.strictObject({
  live: z.boolean().optional(),
  everySeconds: z.number().int().min(2).max(120).optional(),
});

export const CHECKPOINT_MODES = ["off", "shadow", "on"] as const;
const CheckpointsChoice = z.strictObject({
  risk: Pattern.optional(),
  land: z.enum(CHECKPOINT_MODES).optional(),
  landApprove: z.enum(["risky", "every"]).optional(),
  landLines: z.number().int().min(1).optional(),
});

/** One shape for both layers: the machine's, and a project's over it. */
export const LayerSchema = z.strictObject({
  checkpoints: CheckpointsChoice.optional(),
  roles: z.record(z.string(), RoleChoice).optional(),
  mcp: z.record(z.string(), McpChoice).optional(),
  rules: z.string().optional(),
  flow: FlowChoice.optional(),
  attention: AttentionChoice.optional(),
});

export type Layer = z.infer<typeof LayerSchema>;
export type AttentionChoice = z.infer<typeof AttentionChoice>;
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];
