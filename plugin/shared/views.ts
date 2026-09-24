/** What the panel reads over RPC, one schema per answer: the client checks every answer against it, and both sides take their types from it. */
import { z } from "zod";
import { CHECKPOINT_MODES, Connect, LayerSchema, Scalar } from "./settings.ts";

const Refused = z.object({ error: z.string() });

export const Check = z.object({ id: z.string(), ok: z.boolean(), detail: z.string() });
export type Check = z.infer<typeof Check>;

const ModelView = z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional(), thinkingOptions: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional() })).optional() });
const SettingSpec = z.object({ type: z.enum(["number", "string", "boolean"]), label: z.string(), default: Scalar.optional() });
export type SettingSpec = z.infer<typeof SettingSpec>;

export const CatalogView = z.object({
  roles: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      can: z.array(z.string()),
      concern: z.string().nullable(),
      defaults: z.object({ harness: z.string(), model: z.string().optional(), thinking: z.string().optional() }),
      follows: z.string().nullable(),
      harnesses: z.array(z.string()),
    }),
  ),
  harnesses: z.array(z.object({ id: z.string(), label: z.string(), models: z.array(ModelView), transports: z.array(z.string()) })),
  mcp: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      kind: z.string(),
      transport: z.string(),
      settings: z.record(z.string(), SettingSpec),
      defaults: z.object({ enabled: z.boolean() }),
      roles: z.array(z.string()),
    }),
  ),
});
export type CatalogView = z.infer<typeof CatalogView>;

/** The attention settings in force, every one resolved: what the watch and the round run on. */
const Attention = z.object({
  tickSeconds: z.number(),
  leadIdleMinutes: z.number(),
  askRemindMinutes: z.number(),
  maxReminders: z.number(),
  watch: z.boolean(),
  destructive: z.string(),
  testPath: z.string(),
  repeatsAt: z.number(),
  reworksAt: z.number(),
  reviewsAt: z.number(),
  suppressed: z.string(),
  longTurnMinutes: z.number(),
  incidentsPerDay: z.number(),
});
export type Attention = z.infer<typeof Attention>;

export const TeamView = z.object({
  project: z.string().nullable(),
  errors: z.array(z.string()),
  attention: Attention,
  checkpoints: z.object({ risk: z.string(), land: z.enum(CHECKPOINT_MODES), landApprove: z.enum(["risky", "every"]), landLines: z.number(), forced: z.string().nullable() }),
  rules: z.string(),
  mcp: z.record(
    z.string(),
    z.object({ label: z.string(), enabled: z.boolean(), roles: z.array(z.string()), settings: z.record(z.string(), Scalar), transport: z.string(), template: z.boolean(), connect: Connect.nullable(), rule: z.string().nullable() }),
  ),
  roles: z.record(
    z.string(),
    z.object({ harness: z.string(), provider: z.string(), model: z.string().nullable(), thinking: z.string().nullable(), mcp: z.array(z.string()), tools: z.record(z.string(), z.array(z.string())), skills: z.array(z.string()), rules: z.string() }),
  ),
});
export type TeamView = z.infer<typeof TeamView>;
export const TeamRead = z.union([TeamView, Refused]);
export type TeamRead = z.infer<typeof TeamRead>;

const LayerRead = z.union([
  z.object({ status: z.literal("ready"), revision: z.string(), values: LayerSchema }),
  z.object({ status: z.literal("invalid"), revision: z.string(), error: z.string() }),
]);
export type LayerRead = z.infer<typeof LayerRead>;
export const SettingsRead = z.intersection(LayerRead, z.object({ machine: LayerSchema }));
export type SettingsRead = z.infer<typeof SettingsRead>;

export const WriteResult = z.union([
  z.object({ status: z.literal("saved"), revision: z.string(), values: LayerSchema }),
  z.object({ status: z.enum(["conflict", "invalid"]), error: z.string() }),
]);
export type WriteResult = z.infer<typeof WriteResult>;

export const ProjectRow = z.object({ slug: z.string(), root: z.string() });
export type ProjectRow = z.infer<typeof ProjectRow>;
export const Added = z.union([ProjectRow, Refused]);
export type Added = z.infer<typeof Added>;
export const Removed = z.union([z.object({ removed: z.string() }), Refused]);
export type Removed = z.infer<typeof Removed>;
export const Parsed = z.union([z.object({ id: z.string(), label: z.string(), connect: Connect }), Refused]);
export type Parsed = z.infer<typeof Parsed>;

const Folder = z.object({ name: z.string(), path: z.string(), repository: z.boolean() });
/** `root` is the repository this folder belongs to when it is not itself that repository's top. */
export const Folders = z.object({ path: z.string(), parent: z.string().nullable(), repository: z.boolean(), root: z.string().nullable(), folders: z.array(Folder) });
export type Folders = z.infer<typeof Folders>;
export const Paths = z.union([Folders, Refused]);
export type Paths = z.infer<typeof Paths>;

export const StatusView = z.object({ text: z.string(), error: z.string().optional() });
export type StatusView = z.infer<typeof StatusView>;
export const LandDecided = z.union([z.object({ decided: z.string() }), Refused]);
export type LandDecided = z.infer<typeof LandDecided>;
export const ModelsRefreshed = z.record(z.string(), z.object({ at: z.string(), error: z.string().nullable(), count: z.number() }));
export type ModelsRefreshed = z.infer<typeof ModelsRefreshed>;

const FlowSeat = z.object({ id: z.string(), role: z.string(), status: z.string(), minutes: z.number(), waiting: z.array(z.string()) });
export type FlowSeat = z.infer<typeof FlowSeat>;
const FlowTask = z.object({ id: z.string(), title: z.string(), status: z.string(), kind: z.string(), peer: FlowSeat.nullable(), minutes: z.number(), handback: z.number().nullable() });
export type FlowTask = z.infer<typeof FlowTask>;
const FlowLane = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  branch: z.string(),
  base: z.string().optional(),
  lead: FlowSeat.nullable(),
  tasks: z.array(FlowTask),
  taskCount: z.number(),
  running: z.number(),
  open: z.boolean(),
  after: z.array(z.string()).optional(),
  held: z.string().optional(),
  landApproval: z.object({ minutes: z.number(), approved: z.boolean(), signals: z.array(z.string()), evidence: z.array(z.string()) }).optional(),
});
export type FlowLane = z.infer<typeof FlowLane>;
const FlowAsk = z.object({ id: z.string(), kind: z.string(), fromRole: z.string(), to: z.string(), minutes: z.number(), text: z.string() });
export type FlowAsk = z.infer<typeof FlowAsk>;
const WatchIncident = z.object({
  id: z.string(),
  title: z.string(),
  level: z.enum(["page", "attend"]),
  name: z.string(),
  minutes: z.number(),
  quote: z.string(),
  told: z.enum(["lead", "supervisor"]).nullable(),
  lane: z.string().nullable(),
  held: z.string().nullable(),
});
export type WatchIncident = z.infer<typeof WatchIncident>;
/** What the code noticed about the seats and nobody has marked yet, and the trouble nobody is mailed about. */
const WatchView = z.object({ incidents: z.array(WatchIncident), trouble: z.array(z.object({ kind: z.string(), minutes: z.number(), detail: z.string() })) });
export type WatchView = z.infer<typeof WatchView>;
const FlowView = z.object({ project: z.string(), at: z.number(), revision: z.string(), supervisors: z.array(FlowSeat), lanes: z.array(FlowLane), moreLanes: z.number(), asks: z.array(FlowAsk), watch: WatchView });
export type FlowView = z.infer<typeof FlowView>;
export const FlowRead = z.union([FlowView, z.object({ unchanged: z.literal(true), revision: z.string() }), Refused]);
export type FlowRead = z.infer<typeof FlowRead>;

const CleanItem = z.object({ path: z.string(), kind: z.enum(["seat", "copy", "records", "snapshot", "backup"]), why: z.string(), bytes: z.number(), careful: z.boolean(), held: z.string().nullable() });
export type CleanItem = z.infer<typeof CleanItem>;
export const CleanView = z.object({ items: z.array(CleanItem), removed: z.array(z.string()), failed: z.array(z.object({ path: z.string(), error: z.string() })) });
export type CleanView = z.infer<typeof CleanView>;

export const UpdateView = z.object({
  dir: z.string(),
  version: z.string(),
  next: z.string().nullable(),
  head: z.string(),
  date: z.string().nullable(),
  fetched: z.boolean(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  behind: z.number(),
  ahead: z.number(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  installs: z.boolean(),
  paseo: z.string().nullable(),
  blocked: z.string().nullable(),
  busy: z.array(z.string()),
  updated: z.object({ from: z.string(), to: z.string() }).nullable(),
});
export type UpdateView = z.infer<typeof UpdateView>;

const MigrateStep = z.object({ kind: z.enum(["settings", "block", "seat"]), where: z.string(), what: z.string(), detail: z.array(z.string()), auto: z.boolean() });
export type MigrateStep = z.infer<typeof MigrateStep>;
/** Guides and records are only told about, never replaced. */
const ContentChange = z.object({ unit: z.string(), kind: z.enum(["guide", "record", "prompt", "skill", "team"]), change: z.enum(["added", "changed", "removed"]), kept: z.boolean(), keepable: z.boolean() });
export type ContentChange = z.infer<typeof ContentChange>;
export const MigrateView = z.object({ stamp: z.string(), since: z.string(), steps: z.array(MigrateStep), done: z.array(z.string()), content: z.array(ContentChange) });
export type MigrateView = z.infer<typeof MigrateView>;
