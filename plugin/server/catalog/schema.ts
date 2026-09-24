import { isAbsolute } from "node:path";
import { z } from "zod";
import { AttentionChoice } from "./settings.ts";

const text = z.string().min(1);
const texts = z.array(z.string());
const Json = z.record(z.string(), z.unknown());

/** A pattern the kit hands to `new RegExp` later, inside a try that reads a failure as "not reachable", so a typo must be caught here. */
const pattern = z.string().refine(
  (value) => {
    try {
      new RegExp(value, "i");
      return true;
    } catch {
      return false;
    }
  },
  { error: "is not a pattern this machine can read" },
);

const McpTransport = z.enum(["stdio", "http", "sse"]);

export const HarnessFile = z
  .strictObject({
    id: text,
    label: text,
    baseProvider: text,
    configDirEnv: text,
    profileRoot: text,
    promptFile: text.optional(),
    contextFile: text.optional(),
    skillsDir: text,
    hasThinking: z.boolean().optional(),
    steers: z.boolean().optional(),
    systemPrompt: z.enum(["config", "file"]).optional(),
    stateWrites: z.strictObject({ path: text, delivery: z.enum(["launch", "file"]) }).optional(),
    projectContextOption: text.optional(),
    exitPattern: z
      .string()
      .refine((value) => {
        try {
          return new RegExp(`${value}|`).exec("")!.length > 1;
        } catch {
          return false;
        }
      }, { error: "is not a pattern capturing the exit code" })
      .optional(),
    mcpCall: z.string().includes("{server}", { error: "does not say where the server's name goes" }).optional(),
    mcpServerField: text.optional(),
    timeline: z
      .strictObject({
        writePathPrefix: text.optional(),
        pseudoCalls: z.array(z.strictObject({ name: text, detail: text })).optional(),
        unparsed: z.strictObject({ input: text, error: pattern }).optional(),
      })
      .optional(),
    settings: z.strictObject({
      file: text,
      source: text,
      roleSource: text,
      ownedPaths: texts.optional(),
      inherits: z.strictObject({ from: text, keys: texts }).optional(),
    }),
    links: z.array(z.strictObject({ link: text, target: text, optional: z.boolean().optional() })).optional(),
    files: z.record(z.string(), z.array(z.string()).min(1)).optional(),
    modelCatalog: z.strictObject({ command: z.array(z.string()).min(1), list: z.string(), clear: texts, file: z.string(), setting: z.string() }).optional(),
    checks: z.array(z.strictObject({ path: z.string(), help: z.string() })).optional(),
    mcp: z.strictObject({
      file: text,
      delivery: z.enum(["launch", "file"]),
      preapprove: z.boolean().optional(),
      transports: z.array(McpTransport).min(1),
      seed: Json.optional(),
      key: text.optional(),
      clear: z.strictObject({ set: Json.optional(), remove: texts.optional(), setInEach: z.record(z.string(), Json).optional() }).optional(),
      rule: text.optional(),
      desk: Json.optional(),
    }),
    provider: z.strictObject({
      env: z.record(z.string(), z.string()).optional(),
      profileModeId: text.optional(),
      command: texts.optional(),
      forceFlags: z.record(z.string(), z.string()).optional(),
    }),
  })
  .refine((harness) => harness.systemPrompt !== "file" || harness.promptFile, { error: "takes its prompt as a file but names no promptFile", path: ["promptFile"] })
  .refine((harness) => harness.mcp.delivery !== "file" || harness.mcp.key, { error: "delivers MCP servers in a file but names no key", path: ["mcp", "key"] });

const ProxyHook = { tool: text, args: Json.optional(), when: pattern.optional(), timeoutSeconds: z.number().positive().optional() };

const Proxy = z.strictObject({
  backend: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("http"), url: text }), z.strictObject({ type: z.literal("stdio"), command: z.array(z.string()).min(1) })]),
  pin: text.optional(),
  gitExclude: texts.optional(),
  open: z.strictObject({ ...ProxyHook, route: z.strictObject({ when: pattern, from: text, field: text }).optional() }).optional(),
  close: z.strictObject(ProxyHook).optional(),
  wait: z.strictObject({ ...ProxyHook, busy: pattern.optional(), seconds: z.number().positive().optional(), pollSeconds: z.number().positive().optional() }).optional(),
  sync: z.strictObject({ tool: text, paths: text.optional(), maxPaths: z.number().int().positive().optional() }).optional(),
  errors: z.array(z.strictObject({ when: pattern, reply: text })).optional(),
  descriptions: z.record(z.string(), z.string()).optional(),
  timeoutSeconds: z.number().positive().optional(),
});

const McpSetting = z.strictObject({ type: z.enum(["number", "string", "boolean"]), label: text, default: z.union([z.string(), z.number(), z.boolean()]).optional() });

export const McpFile = z
  .strictObject({
    id: text,
    label: text,
    description: z.string().optional(),
    order: z.number().optional(),
    kind: z.enum(["proxy", "server"]),
    proxy: Proxy.optional(),
    instructions: z.string().optional(),
    server: z.looseObject({ type: McpTransport }).optional(),
    settings: z.record(z.string(), McpSetting).default({}),
    defaults: z.strictObject({ enabled: z.boolean() }).default({ enabled: false }),
    tools: z.record(z.string(), texts).optional(),
    roles: texts.optional(),
    rule: text.optional(),
    roleNotes: z.record(z.string(), z.string()).optional(),
    skills: texts.optional(),
    help: z.string().optional(),
    requires: z.array(text.refine((path) => !isAbsolute(path), { error: "is not a path inside the project" })).optional(),
  })
  .refine((entry) => entry.kind !== "proxy" || entry.proxy, { error: "is a proxy with no proxy block", path: ["proxy"] })
  .refine((entry) => entry.kind !== "server" || entry.server, { error: "is a server with no server block", path: ["server"] });

const Role = z.strictObject({
  role: text,
  label: text,
  description: z.string().optional(),
  concern: z.string().optional(),
  can: texts.optional(),
  tools: text.optional(),
  follows: text.optional(),
  defaults: z.strictObject({ harness: text, model: text.optional(), thinking: text.optional() }).optional(),
  prompt: text,
  skills: text.nullable(),
  extraSkills: z.array(z.string().regex(/^[^:]+:[^:]+$/, { error: "is not written set:name" })).optional(),
  paseoTools: z.strictObject({ enabled: z.boolean().optional(), disabledTools: texts.optional(), allow: texts.optional() }).optional(),
  hidesWords: texts.optional(),
});

export const RolesFile = z.strictObject({
  providerPrefix: z.string().optional(),
  attention: AttentionChoice.optional(),
  roles: z.array(Role),
});

/** The tools Paseo gives every agent, as a list the plugin keeps in step with Paseo. */
export const PaseoFile = z.strictObject({ tools: z.array(text).min(1) });

const Gate = z.strictObject({
  files: z.array(text).min(1),
  script: text.optional(),
  run: text,
  lockfiles: z.record(z.string(), text).optional(),
});

export const EcosystemFile = z.strictObject({
  serialOnly: texts,
  gates: z.array(Gate),
  scriptRunners: texts,
  unsetScript: text,
  files: z.strictObject({ test: pattern, docs: pattern }),
  watch: z.strictObject({
    destructive: pattern,
    testPath: pattern,
    suppressed: pattern,
    skipped: pattern,
    assertion: pattern,
    refused: pattern,
    runners: texts,
  }),
});
