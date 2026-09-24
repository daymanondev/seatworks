import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ATTENTION, type Attention } from "./attention.ts";
import { hiddenWordsIn } from "./hidden-words.ts";
import { AttentionChoice } from "./settings.ts";
import { isAbsolute, join } from "node:path";
import { errorText } from "../core/errors.ts";

type ThinkingSpec = { id: string; label: string; isDefault?: boolean };
export type ModelSpec = { id: string; label: string; isDefault?: boolean; thinkingOptions?: ThinkingSpec[] };
export type McpServers = Record<string, unknown>;
export type McpTransport = "stdio" | "http" | "sse";

export type RoleSpec = {
  role: string;
  label: string;
  description?: string;
  concern?: string;
  can?: string[];
  tools?: string;
  follows?: string;
  defaults: { harness: string; model?: string; thinking?: string };
  prompt: string;
  skills: string | null;
  extraSkills?: string[];
  paseoTools?: { enabled?: boolean; disabledTools?: string[]; allow?: string[] };
  hidesWords?: string[];
};

export type HarnessSpec = {
  id: string;
  label: string;
  baseProvider: string;
  configDirEnv: string;
  profileRoot: string;
  promptFile?: string;
  contextFile?: string;
  skillsDir: string;
  hasThinking?: boolean;
  steers?: boolean;
  systemPrompt?: "config" | "file";
  stateWrites?: { path: string; delivery: "launch" | "file" };
  projectContextOption?: string;
  exitPattern?: string;
  mcpCall?: string;
  mcpServerField?: string;
  settings: { file: string; source: string; roleSource: string; ownedPaths?: string[]; inherits?: { from: string; keys: string[] } };
  links?: { link: string; target: string; optional?: boolean }[];
  files?: Record<string, string[]>;
  modelCatalog?: { command: string[]; list: string; clear: string[]; file: string; setting: string };
  checks?: { path: string; help: string }[];
  models?: ModelSpec[];
  mcp: {
    file: string;
    delivery: "launch" | "file";
    preapprove?: boolean;
    transports: McpTransport[];
    seed?: Record<string, unknown>;
    key?: string;
    clear?: { set?: Record<string, unknown>; remove?: string[]; setInEach?: Record<string, Record<string, unknown>> };
    rule?: string;
    desk?: Record<string, unknown>;
  };
  provider: { env?: Record<string, string>; profileModeId?: string; command?: string[]; forceFlags?: Record<string, string> };
};

const HARNESS_FIELDS = new Set([
  "id",
  "label",
  "baseProvider",
  "configDirEnv",
  "profileRoot",
  "promptFile",
  "contextFile",
  "skillsDir",
  "hasThinking",
  "steers",
  "systemPrompt",
  "stateWrites",
  "projectContextOption",
  "exitPattern",
  "mcpCall",
  "mcpServerField",
  "settings",
  "links",
  "files",
  "modelCatalog",
  "checks",
  "mcp",
  "provider",
]);
const HARNESS_REQUIRED = ["id", "label", "baseProvider", "configDirEnv", "profileRoot", "skillsDir", "settings", "mcp", "provider"];

export function harnessProblems(id: string, raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(raw)) if (!HARNESS_FIELDS.has(key)) problems.push(`names ${key}, which is no harness field`);
  for (const key of HARNESS_REQUIRED) if (raw[key] === undefined) problems.push(`has no ${key}`);
  if (raw.id !== undefined && raw.id !== id) problems.push(`calls itself ${String(raw.id)} but sits in harness/${id}`);
  const settings = raw.settings as Record<string, unknown> | undefined;
  if (settings) for (const key of ["file", "source", "roleSource"]) if (settings[key] === undefined) problems.push(`has no settings.${key}`);
  const inherits = settings?.inherits as { from?: unknown; keys?: unknown } | undefined;
  if (inherits && (typeof inherits.from !== "string" || !Array.isArray(inherits.keys) || !inherits.keys.every((key) => typeof key === "string"))) {
    problems.push("settings.inherits needs a from path and a list of keys");
  }
  const mcp = raw.mcp as Record<string, unknown> | undefined;
  if (mcp) {
    for (const key of ["file", "delivery", "transports"]) if (mcp[key] === undefined) problems.push(`has no mcp.${key}`);
    if (mcp.delivery !== undefined && mcp.delivery !== "launch" && mcp.delivery !== "file") problems.push(`delivers MCP servers as ${String(mcp.delivery)}, which is neither launch nor file`);
    if (mcp.delivery === "file" && !mcp.key) problems.push("delivers MCP servers in a file but names no mcp.key");
    if (Array.isArray(mcp.transports) && mcp.transports.length === 0) problems.push("lists no mcp.transports");
    if (mcp.desk !== undefined && (typeof mcp.desk !== "object" || mcp.desk === null || Array.isArray(mcp.desk))) problems.push("gives mcp.desk fields that are not an object");
  }
  if (raw.steers !== undefined && typeof raw.steers !== "boolean") problems.push(`says steers is ${String(raw.steers)}, which is neither true nor false`);
  const writes = raw.stateWrites as Record<string, unknown> | undefined;
  if (writes !== undefined && (typeof writes?.path !== "string" || (writes.delivery !== "launch" && writes.delivery !== "file"))) {
    problems.push("gives stateWrites without a path and a delivery of launch or file");
  }
  if (raw.projectContextOption !== undefined && (typeof raw.projectContextOption !== "string" || raw.projectContextOption === "")) {
    problems.push("gives projectContextOption without an option path");
  }
  const files = raw.files as Record<string, unknown> | undefined;
  if (files !== undefined) {
    for (const [path, sources] of Object.entries(files ?? {})) {
      if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => typeof source !== "string")) problems.push(`lays down ${path} from no list of sources`);
    }
  }
  const catalog = raw.modelCatalog as Record<string, unknown> | undefined;
  if (catalog !== undefined) {
    const command = catalog?.command;
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) problems.push("takes its model catalog from no command");
    for (const key of ["list", "file", "setting"]) if (typeof catalog?.[key] !== "string") problems.push(`has no modelCatalog.${key}`);
    if (!Array.isArray(catalog?.clear)) problems.push("has no modelCatalog.clear");
  }
  const checks = raw.checks as unknown;
  if (checks !== undefined && (!Array.isArray(checks) || checks.some((check) => typeof check?.path !== "string" || typeof check?.help !== "string"))) {
    problems.push("lists checks without a path and a help each");
  }
  if (raw.exitPattern !== undefined) {
    let groups = -1;
    try {
      groups = new RegExp(`${String(raw.exitPattern)}|`).exec("")!.length - 1;
    } catch {}
    if (typeof raw.exitPattern !== "string" || groups < 1) problems.push("gives an exitPattern that is not a pattern capturing the exit code");
  }
  if (raw.mcpCall !== undefined && (typeof raw.mcpCall !== "string" || !raw.mcpCall.includes("{server}"))) problems.push("gives an mcpCall that does not say where the server's name goes");
  if (raw.mcpServerField !== undefined && typeof raw.mcpServerField !== "string") problems.push("gives an mcpServerField that is not a path");
  if (raw.systemPrompt !== undefined && raw.systemPrompt !== "config" && raw.systemPrompt !== "file") problems.push(`takes its prompt as ${String(raw.systemPrompt)}, which is neither config nor file`);
  if (raw.systemPrompt === "file" && !raw.promptFile) problems.push("takes its prompt as a file but names no promptFile");
  return problems;
}

type ProxyBackend = { type: "http"; url: string } | { type: "stdio"; command: string[] };
type ProxyHook = { tool: string; args?: Record<string, unknown>; when?: string; timeoutSeconds?: number };

export type ProxySpec = {
  backend: ProxyBackend;
  pin?: string;
  gitExclude?: string[];
  open?: ProxyHook & { route?: { when: string; from: string; field: string } };
  close?: ProxyHook;
  wait?: ProxyHook & { busy?: string; seconds?: number; pollSeconds?: number };
  sync?: { tool: string; paths?: string; maxPaths?: number };
  errors?: { when: string; reply: string }[];
  descriptions?: Record<string, string>;
  timeoutSeconds?: number;
};

type McpSetting = { type: "number" | "string" | "boolean"; label: string; default?: string | number | boolean };

export type McpEntry = {
  id: string;
  label: string;
  description?: string;
  order?: number;
  dir: string;
  kind: "proxy" | "server";
  proxy?: ProxySpec;
  instructions?: string;
  server?: Record<string, unknown> & { type: McpTransport };
  settings: Record<string, McpSetting>;
  defaults: { enabled: boolean };
  tools?: Record<string, string[]>;
  roles?: string[];
  rule?: string;
  roleNotes?: Record<string, string>;
  skills?: string[];
  help?: string;
  requires?: string[];
};

export type Kit = {
  dir: string;
  prefix: string;
  roles: RoleSpec[];
  harnesses: Record<string, HarnessSpec>;
  mcp: Record<string, McpEntry>;
  toolSets: Record<string, Record<string, ArgSchema>>;
  team?: string;
  own?: string;
  attention: Attention;
};

function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export type ArgSchema = { type?: string; enum?: unknown[]; items?: ArgSchema; properties?: Record<string, ArgSchema>; required?: string[]; description?: string };

function loadToolSets(dir: string): Record<string, Record<string, ArgSchema>> {
  const file = join(dir, "mcp", "tools.json");
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { name?: string; inputSchema?: ArgSchema }[]>;
  return Object.fromEntries(Object.entries(raw).map(([set, tools]) => [set, Object.fromEntries(tools.map((tool) => [String(tool.name ?? ""), tool.inputSchema ?? {}]))]));
}

/** Where a proxy entry keeps something this kit will hand to `new RegExp`. */
function patternsOf(proxy: ProxySpec | undefined): [string, string][] {
  if (!proxy) return [];
  const found: [string, string][] = [];
  if (proxy.open?.when) found.push(["open.when", proxy.open.when]);
  if (proxy.open?.route?.when) found.push(["open.route.when", proxy.open.route.when]);
  if (proxy.wait?.when) found.push(["wait.when", proxy.wait.when]);
  if (proxy.wait?.busy) found.push(["wait.busy", proxy.wait.busy]);
  for (const [index, entry] of (proxy.errors ?? []).entries()) if (entry?.when) found.push([`errors[${index}].when`, entry.when]);
  return found;
}

function loadMcp(dir: string): Record<string, McpEntry> {
  const root = join(dir, "catalog", "mcp");
  const entries: Record<string, McpEntry> = {};
  for (const id of subdirs(root)) {
    const file = join(root, id, "mcp.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Omit<McpEntry, "dir">;
    if (raw.id !== id) throw new Error(`catalog/mcp/${id}/mcp.json names itself ${raw.id}`);
    const backend = raw.kind === "proxy" ? raw.proxy?.backend : undefined;
    if (raw.kind === "proxy" && !(backend?.type === "http" && backend.url) && !(backend?.type === "stdio" && backend.command?.length)) {
      throw new Error(`MCP ${id} is a proxy with no http url or stdio command for its backend`);
    }
    if (raw.kind === "server" && !raw.server?.type) throw new Error(`MCP ${id} is a server with no transport type`);
    // Compiled per call inside a try that reads as "not reachable", so a typo must be caught here, naming the entry.
    for (const [where, pattern] of patternsOf(raw.proxy)) {
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        throw new Error(`MCP ${id} has an unreadable pattern in ${where}: ${errorText(error)}`);
      }
    }
    if (raw.rule && !existsSync(join(root, id, raw.rule))) throw new Error(`MCP ${id} names rule ${raw.rule}, which is missing`);
    if (raw.requires !== undefined && !(Array.isArray(raw.requires) && raw.requires.every((path) => typeof path === "string" && path !== "" && !isAbsolute(path)))) {
      throw new Error(`MCP ${id} requires something that is not a list of paths inside the project`);
    }
    for (const skill of raw.skills ?? []) {
      if (!existsSync(join(root, id, "skills", skill, "SKILL.md"))) throw new Error(`MCP ${id} names skill ${skill}, but its SKILL.md is missing`);
    }
    entries[id] = { ...raw, settings: raw.settings ?? {}, defaults: { enabled: raw.defaults?.enabled ?? false }, dir: join(root, id) };
  }
  return entries;
}

/** The shipped SLP preset, unless the state root holds a file of the same name, which replaces it. */
function rolesFile(dir: string, stateDir?: string): string {
  const own = stateDir ? join(stateDir, "roles.json") : undefined;
  return own && existsSync(own) ? own : join(dir, "roles.json");
}

export function loadKit(dir: string, stateDir?: string): Kit {
  const raw = JSON.parse(readFileSync(rolesFile(dir, stateDir), "utf-8"));
  const harnesses: Record<string, HarnessSpec> = {};
  for (const id of subdirs(join(dir, "harness"))) {
    const file = join(dir, "harness", id, "harness.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const problems = harnessProblems(id, raw);
    if (problems.length > 0) throw new Error(`harness ${id} ${problems.join("; ")}`);
    harnesses[id] = raw as unknown as HarnessSpec;
  }
  const roles = (raw.roles ?? []) as RoleSpec[];
  for (const role of roles) {
    if (role.follows === undefined) continue;
    const followed = roles.find((other) => other.role === role.follows);
    if (role.defaults) throw new Error(`role ${role.role} follows ${role.follows} and names defaults of its own; it takes one or the other`);
    if (!followed || followed === role) throw new Error(`role ${role.role} follows ${role.follows}, which is no other role in roles.json`);
    if (followed.follows !== undefined) throw new Error(`role ${role.role} follows ${role.follows}, which follows ${followed.follows} in turn; a role follows one that chooses for itself`);
    role.defaults = { ...followed.defaults };
  }
  for (const role of roles) {
    if (!role.defaults?.harness) throw new Error(`role ${role.role} has no default harness`);
    if (!harnesses[role.defaults.harness]) throw new Error(`role ${role.role} defaults to harness ${role.defaults.harness}, which has no harness/${role.defaults.harness}/harness.json`);
  }
  const own = stateDir ? join(stateDir, "own") : undefined;
  return {
    dir,
    prefix: typeof raw.providerPrefix === "string" ? raw.providerPrefix : "",
    roles,
    harnesses,
    mcp: loadMcp(dir),
    toolSets: loadToolSets(dir),
    team: loadTeam(dir, roles, own),
    own,
    attention: { ...ATTENTION, ...presetAttention(raw.attention) },
  };
}

function shippedOrOwn(dir: string, own: string | undefined, path: string): string {
  const mine = own ? join(own, path) : undefined;
  return mine && existsSync(mine) ? mine : join(dir, "content", path);
}

export function ownOr(kit: Kit, path: string): string {
  return shippedOrOwn(kit.dir, kit.own, path);
}

/** The team block again, after the owner chose whose copy of it to keep. */
export function reloadTeam(kit: Kit): void {
  kit.team = loadTeam(kit.dir, kit.roles, kit.own);
}

/** Every seat reads AGENTS.md, so the block is held to every role's hidden words at once. */
function loadTeam(dir: string, roles: RoleSpec[], own?: string): string | undefined {
  const file = shippedOrOwn(dir, own, "project/AGENTS.md");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf-8");
  const hidden = hiddenWordsIn(text, [...new Set(roles.flatMap((role) => role.hidesWords ?? []))]);
  if (hidden.length > 0) throw new Error(`content/project/AGENTS.md is read by every role and shows words some must not see: ${hidden.join(", ")}`);
  return text;
}

/** Held to a settings layer's rules: merged unchecked, a bad pattern threw on every turn end, inside the step that sends mail. */
function presetAttention(raw: unknown): Partial<Attention> {
  if (raw === undefined) return {};
  const parsed = AttentionChoice.safeParse(raw);
  if (!parsed.success) throw new Error(`roles.json has an attention block the desk cannot use: ${z.prettifyError(parsed.error)}`);
  return parsed.data as Partial<Attention>;
}

/** Another role's preset for this agent, else Paseo's first: Paseo's own default cannot be read back, since the plugin sets it. */
export function agentDefault(roles: RoleSpec[], harness: HarnessSpec): ModelSpec | undefined {
  const models = harness.models ?? [];
  const preset = roles.map((role) => role.defaults).find((defaults) => defaults.harness === harness.id && defaults.model && models.some((entry) => entry.id === defaults.model));
  return models.find((entry) => entry.id === preset?.model) ?? models[0];
}

export function providerId(kit: Kit, role: string, harness: string): string {
  return `${kit.prefix}${role}-${harness}`;
}

export function seatOf(kit: Kit, provider: string | null | undefined): { role: RoleSpec; harness: HarnessSpec } | undefined {
  if (!provider) return undefined;
  const id = provider.split("/")[0] ?? "";
  if (!id.startsWith(kit.prefix)) return undefined;
  for (const role of kit.roles) {
    for (const harness of Object.values(kit.harnesses)) {
      if (id === providerId(kit, role.role, harness.id)) return { role, harness };
    }
  }
  return undefined;
}

export function hookTools(proxy: ProxySpec | undefined): string[] {
  return [proxy?.open?.tool, proxy?.close?.tool, proxy?.wait?.tool, proxy?.sync?.tool].filter((name): name is string => Boolean(name));
}

export function can(role: RoleSpec | undefined, capability: string): boolean {
  return role?.can?.includes(capability) ?? false;
}

/** `start_task` seats `write` roles and `start_review` `review` ones, so a role seated by either works a task without `work`. */
export function worksTasks(role: RoleSpec | undefined): boolean {
  return ["work", "write", "review"].some((capability) => can(role, capability));
}

export function roleNamed(kit: Kit, name: string | undefined): RoleSpec | undefined {
  return name ? kit.roles.find((role) => role.role === name) : undefined;
}

export function rolesThatCan(kit: Kit, capability: string): RoleSpec[] {
  return kit.roles.filter((role) => can(role, capability));
}

/** Several roles may hold one capability on purpose (two review lenses, best-of-n Peers), so the caller may name which. */
export function roleThatCan(kit: Kit, capability: string, named?: string): RoleSpec | undefined {
  const holders = rolesThatCan(kit, capability);
  return named ? holders.find((role) => role.role === named) : holders[0];
}

/** Names the roles that do hold the capability, since the kit is data and only the desk has read it. */
export function namedOrNot(kit: Kit, capability: string, named: string, doing: string): string {
  const holders = rolesThatCan(kit, capability).map((role) => role.role);
  if (holders.length === 0) return `No role in this kit can ${doing}.`;
  return `This kit has no ${named} that can ${doing}. These can: ${holders.sort().join(", ")}.`;
}

export function toolsOf(kit: Kit, role: RoleSpec | undefined): string[] {
  return role?.tools ? Object.keys(kit.toolSets[role.tools] ?? {}) : [];
}

export function schemaOf(kit: Kit, role: RoleSpec, tool: string): ArgSchema | undefined {
  return role.tools ? kit.toolSets[role.tools]?.[tool] : undefined;
}

export function roleSettingsFile(kit: Kit, harness: HarnessSpec, role: RoleSpec): string {
  return join(kit.dir, "harness", harness.id, harness.settings.roleSource.replace("ROLE", role.role));
}

export function harnessFileSources(kit: Kit, harness: HarnessSpec, role: RoleSpec): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(harness.files ?? {}).map(([path, sources]) => [path, sources.map((source) => join(kit.dir, "harness", harness.id, source.replaceAll("ROLE", role.role)))]),
  );
}

export function supportsRole(kit: Kit, harness: HarnessSpec, role: RoleSpec): boolean {
  return existsSync(roleSettingsFile(kit, harness, role)) && Object.values(harnessFileSources(kit, harness, role)).every((sources) => sources.every((source) => existsSync(source)));
}

export const PASEO_TOOLS = [
  "create_workspace", "list_workspaces", "archive_workspace", "create_agent", "send_agent_prompt", "get_agent_status",
  "list_agents", "cancel_agent", "archive_agent", "kill_agent", "update_agent", "rename_workspace", "list_workspace_scripts",
  "start_workspace_script", "stop_workspace_script", "list_terminals", "create_terminal", "kill_terminal", "capture_terminal",
  "send_terminal_keys", "create_schedule", "create_heartbeat", "delete_heartbeat", "list_schedules", "inspect_schedule",
  "pause_schedule", "resume_schedule", "delete_schedule", "update_schedule", "schedule_logs", "run_schedule_once",
  "list_providers", "list_models", "list_profiles", "inspect_provider", "get_agent_activity", "set_agent_mode",
  "list_pending_permissions", "respond_to_permission",
];

/** `allow` disables each PASEO_TOOLS name it omits, so a tool Paseo adds that the list lacks stays on: keep the list in step with Paseo. */
export function paseoToolsPolicy(role: RoleSpec): { enabled?: boolean; disabledTools?: string[] } | undefined {
  const policy = role.paseoTools;
  if (!policy) return undefined;
  if (policy.allow) return { disabledTools: PASEO_TOOLS.filter((tool) => !policy.allow!.includes(tool)) };
  const { allow: _allow, ...rest } = policy;
  return rest;
}

export const TEAM_SERVER = "team";
export const PASEO_SERVER = "paseo";

export function teamServer(kit: Kit, role: RoleSpec, spool: string, node: string): McpServers {
  if (!role.tools) return {};
  return { [TEAM_SERVER]: { type: "stdio", command: node, args: [join(kit.dir, "mcp", "team.mjs"), role.role, role.tools, spool] } };
}
