import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { renderPrompt } from "../catalog/content.ts";
import { type Kit, type RoleSpec, TEAM_SERVER, can, seatOf } from "../catalog/kit.ts";
import { type Listed, type ModelCache, applyModels, fetchModels, listingProviders } from "../catalog/models.ts";
import { type AgentConfig, type SessionOpen, applyRole, seatEnv } from "../catalog/launch.ts";
import { applyReconcile, reloadDaemon } from "../catalog/providers.ts";
import { placeProjectFiles } from "../catalog/project-files.ts";
import { placeGuides, seatDir, seedRecords, sweepSnapshots } from "../catalog/seats.ts";
import { stampKit } from "../upkeep/migrate.ts";
import { type IndexedProxy, type Team, indexedProxies } from "../catalog/team.ts";
import { guidesDir, home, nodeBin, outboxPath, spoolDir, stateRoot } from "../core/paths.ts";
import { seatsOn, workspacesOn } from "../core/paseo-adapter.ts";
import type { PaseoApi } from "../core/paseo.ts";
import type { Seats, Workspaces } from "../core/ports.ts";
import type { CodeIndex } from "../desk/context.ts";
import { Desk } from "../desk/desk.ts";
import { type Ledger, laneOfLead, loadLedger, openAsksTo, taskOfPeer } from "../desk/ledger.ts";
import { letters } from "../desk/letters.ts";
import { appendRecord } from "../desk/records.ts";
import { type Project, gateCommands, loadConfig, projectOf } from "../desk/project.ts";
import { SettingsControl } from "./control.ts";
import { codeIndex } from "./code-index.ts";
import { type Letter, Outbox } from "./outbox.ts";
import { Patrol } from "./patrol.ts";
import { Relink, reloadPlugin } from "./relink.ts";
import { registerRpc } from "./rpc.ts";
import { Seating } from "./seating.ts";
import { replyFile, spoolDirs, takeRequests, writeReply } from "./spool.ts";
import { TeamSource } from "./team-source.ts";
import { TurnRules } from "./turns.ts";
import { type Fact, callsTo, factTitle } from "./watch/facts.ts";
import { type Finding, decide } from "./watch/findings.ts";
import { type SeatContext, type SeatWatch, type WatchedSeat, Watches } from "./watch/watches.ts";
import { malformed } from "./timeline.ts";
import { loadIncidents } from "../desk/incidents.ts";
import type { WatchView } from "../../shared/views.ts";
import { errorText } from "../core/errors.ts";

type EventName = keyof PluginLifecycleEvents;

const TROUBLES = 10;

const INCIDENTS_SHOWN = 200;

type RuntimeOptions = { outboxFile?: string; paseo?: PaseoApi; codeIndex?: (proxy: IndexedProxy) => CodeIndex; reloadDaemon?: () => Promise<boolean> };

export class Runtime {
  readonly kit: Kit;
  readonly outbox: Outbox;
  readonly desk: Desk;
  readonly control: SettingsControl;
  private readonly spool = spoolDir();
  private readonly calls = new Map<string, { id: string; replied: boolean }[]>();
  private readonly seats: Seats;
  private readonly workspaces: Workspaces;
  private readonly source: TeamSource;
  private readonly seating: Seating;
  private readonly turns: TurnRules;
  private readonly patrol: Patrol;
  private readonly watches: Watches;
  private readonly troubles = new Map<string, { kind: string; at: number; detail: string }[]>();
  private readonly offline = new Set<string>();
  private readonly relink = new Relink(reloadPlugin);
  private readonly makeIndex: (proxy: IndexedProxy) => CodeIndex;
  private readonly reload: () => Promise<boolean>;
  private api: PaseoApi | undefined;
  private modelsAsked = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private tick: ReturnType<typeof setTimeout> | undefined;

  constructor(kit: Kit, options: RuntimeOptions = {}) {
    this.kit = kit;
    this.api = options.paseo;
    this.makeIndex = options.codeIndex ?? codeIndex;
    this.reload = options.reloadDaemon ?? reloadDaemon;
    this.seats = seatsOn(() => this.api);
    this.workspaces = workspacesOn(() => this.api);
    this.source = new TeamSource(kit);
    this.seating = new Seating(kit, this.source, { node: nodeBin(), spool: this.spool });
    this.outbox = new Outbox(
      options.outboxFile ?? outboxPath(),
      (to, list) => this.compose(to, list),
      this.seats,
      (letter, at) =>
        console.error(`seatworks-v2: a letter for ${letter.to} (${letter.key}) was never taken and has been given up on after ${Math.round((at - letter.at) / 3_600_000)} hours`),
      (seat) => seatOf(kit, seat.provider)?.harness.steers === true,
      (agentId) => this.waitedOn(agentId).length > 0,
    );
    const log = (project: Project, line: string) => this.log(project, line);
    const remember = (project: Project) => this.remember(project);
    this.desk = new Desk({
      kit,
      outbox: this.outbox,
      seats: this.seats,
      workspaces: this.workspaces,
      log,
      teamFor: (project) => this.source.teamFor(project),
      indexesFor: (project) => this.indexesFor(project),
    });
    this.turns = new TurnRules({ kit, desk: this.desk, remember });
    this.watches = new Watches({
      kit,
      seats: this.seats,
      context: (seat) => this.watchContext(seat),
      found: (watch, facts) => this.watchFound(watch, facts),
    });
    this.patrol = new Patrol({ kit, source: this.source, desk: this.desk, seats: this.seats, outbox: this.outbox, turns: this.turns, watches: this.watches, remember });
    this.control = new SettingsControl({
      kit,
      source: this.source,
      seating: this.seating,
      reconcile: (team) => this.reconcileProviders(team),
      models: () => this.refreshModels(),
      seats: this.seats,
      held: () => this.outbox.letters(),
      watch: (project) => this.watchView(project),
      decideLand: (project, lane, approve, note) => this.desk.decideLand(project, lane, approve, note),
    });
  }

  private watchContext(seat: WatchedSeat): SeatContext | undefined {
    const found = seatOf(this.kit, seat.provider);
    if (!found) return undefined;
    const project = projectOf(seat.cwd);
    const attention = this.source.teamFor(project).attention;
    let owned: string[] | undefined;
    let placed = false;
    try {
      const ledger = loadLedger(project.state);
      const task = taskOfPeer(ledger, seat.id);
      owned = task?.owned;
      placed = Boolean(task ?? laneOfLead(ledger, seat.id));
    } catch (error) {
      this.desk.event(project, { kind: "watch.unbriefed", agent: seat.id, error: errorText(error) });
    }
    return {
      placed,
      rules: {
        destructive: new RegExp(attention.destructive, "i"),
        testPath: new RegExp(attention.testPath, "i"),
        suppressed: new RegExp(attention.suppressed, "i"),
        exit: found.harness.exitPattern ? new RegExp(found.harness.exitPattern) : undefined,
        desk: callsTo(found.harness.mcpCall, found.harness.mcpServerField, TEAM_SERVER),
        gates: gateCommands(seat.cwd, loadConfig(project.state).gate),
        cwd: seat.cwd,
        temp: tmpdir(),
        owned,
        repeatsAt: attention.repeatsAt,
        recoverWithin: 10,
      },
      handedBack: (at) => {
        try {
          const handback = taskOfPeer(loadLedger(project.state), seat.id)?.handback;
          return handback && handback.at >= at && !handback.gate ? handback.outcome : undefined;
        } catch {
          return undefined;
        }
      },
    };
  }

  private noticed(watch: SeatWatch, findings: Finding[]): void {
    if (findings.length === 0 || this.watches.get(watch.seat.id) !== watch) return;
    const project = projectOf(watch.seat.cwd);
    this.desk.notice(project, watch.seat, findings).catch((error) => console.error("seatworks-v2: what the watch noticed could not be recorded:", error));
  }

  /** Trouble nobody is mailed about, kept where a screen can show it rather than only in the log. */
  private troubled(project: Project, kind: string, detail: string): void {
    const list = this.troubles.get(project.slug) ?? [];
    list.push({ kind, at: Date.now(), detail });
    if (list.length > TROUBLES) list.splice(0, list.length - TROUBLES);
    this.troubles.set(project.slug, list);
  }

  /** A call the harness refused because its input was not JSON; it never reaches the desk, so only this reports it. */
  private malformedCalls(event: PluginLifecycleEvents["agent.turn_ended"]): void {
    const role = seatOf(this.kit, event.agent.provider)?.role;
    if (!role?.tools) return;
    const project = projectOf(event.agent.cwd);
    for (const call of malformed(event.timeline)) {
      this.desk.event(project, { kind: "call.malformed", agent: event.agent.id, role: role.role, tool: call.tool, error: call.quote });
      this.troubled(project, "call.malformed", `the ${role.label}'s ${call.tool} was written with an input that is not JSON, and never reached the desk`);
    }
  }

  private watchView(project: Project): WatchView {
    const now = Date.now();
    const ago = (at: number) => Math.max(0, Math.round((now - at) / 60_000));
    let ledger: Ledger | undefined;
    try {
      ledger = loadLedger(project.state);
    } catch {}
    const nameOf = (id: string, fallback: string) => {
      const task = ledger ? taskOfPeer(ledger, id) : undefined;
      if (task) return `${task.kind === "review" ? "Reviewer" : "Peer"} · ${task.id} ${task.title}`;
      const lane = ledger ? laneOfLead(ledger, id) : undefined;
      return lane ? `Lead · ${lane.id} ${lane.title}` : fallback;
    };
    const incidents = Object.values(loadIncidents(project.state).items)
      .filter((item) => item.open)
      .sort((a, b) => (a.level === b.level ? b.last - a.last : a.level === "page" ? -1 : 1))
      .slice(0, INCIDENTS_SHOWN)
      .map((item) => ({
        id: item.id,
        title: factTitle(item.kind) ?? item.kind.replace(/[-_]/g, " "),
        level: item.level,
        name: nameOf(item.seat, item.where),
        minutes: ago(item.last),
        quote: item.quote.replace(/\s+/g, " ").slice(0, 300),
        told: item.told !== undefined ? (item.toldTo ?? null) : null,
        lane: item.lane ?? null,
        held: item.told === undefined ? (item.held ?? null) : null,
      }));
    const troubles = this.troubles.get(project.slug) ?? [];
    return { incidents, trouble: troubles.map((entry) => ({ kind: entry.kind, minutes: ago(entry.at), detail: entry.detail })).reverse() };
  }

  private watchFound(watch: SeatWatch, facts: Fact[]): void {
    const project = projectOf(watch.seat.cwd);
    for (const fact of facts) this.desk.event(project, { kind: "watch.fact", agent: watch.seat.id, fact: fact.kind, level: fact.level, quote: fact.quote });
    this.noticed(watch, decide(facts));
  }

  prepare(): void {
    try {
      mkdirSync(stateRoot(), { recursive: true });
      spoolDirs(this.spool);
      placeGuides(this.kit);
      sweepSnapshots();
      stampKit(this.kit, home());
    } catch (error) {
      console.error("seatworks-v2: could not prepare the state directory:", error);
    }
    const team = this.source.teamFor();
    for (const problem of team.errors) console.error(`seatworks-v2: settings: ${problem}`);
    this.reconcileProviders(team);
  }

  register(server: PluginServerContext): void {
    registerRpc(server, this.control, (paseo) => {
      this.api = paseo;
      if (!this.modelsAsked) {
        this.modelsAsked = true;
        this.refreshModels().catch((error) => console.error("seatworks-v2: could not list the agents' models:", error));
      }
    });
    server.before("agent.create", ({ request }, context) => {
      this.api = context.paseo;
      return { ...request, config: this.launchConfig(request.config) };
    });
    server.before("agent.session_open", ({ request }, context) => {
      this.api = context.paseo;
      return this.openSession(request);
    });
    this.on(server, "agent.turn_started", async ({ agent }) => this.turnStarted(agent.id));
    this.on(server, "agent.turn_ended", (event) => this.turnEnded(event));
    this.on(server, "agent.permission_requested", (event) => this.permissionRequested(event));
    this.on(server, "agent.created", async ({ agent }) => this.watches.follow(agent));
    this.on(server, "agent.archived", async ({ agent }) => {
      this.outbox.archived(agent.id);
      this.turns.forget(agent.id);
      this.watches.drop(agent.id);
      if (this.watches.watched(agent.provider)) await this.desk.closeIncidents(projectOf(agent.cwd), agent.id);
    });
    this.timers.push(setInterval(() => this.serveSpool(), 500));
    // The cadence is read every time round, so changing it in settings takes hold without a reload.
    const patrol = () => {
      if (this.api) this.patrol.tick().then(() => this.offline.clear(), (error) => this.tickFailed(error));
      this.tick = setTimeout(patrol, Math.max(5, this.source.teamFor().attention.tickSeconds) * 1000);
    };
    this.tick = setTimeout(patrol, this.source.teamFor().attention.tickSeconds * 1000);
  }

  private tickFailed(error: unknown): void {
    console.error("seatworks-v2: tick failed:", error);
    if (this.tick && this.relink.failed(errorText(error))) console.error("seatworks-v2: lost the daemon link; reloading the plugin.");
    if (!/not connected|client closed|transport/i.test(errorText(error))) return;
    for (const project of this.desk.projects.values()) {
      if (this.offline.has(project.slug)) continue;
      this.offline.add(project.slug);
      this.desk.event(project, { kind: "watch.offline", error: errorText(error) });
    }
  }

  dispose(): void {
    this.watches.dispose();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.tick) clearTimeout(this.tick);
    this.tick = undefined;
  }

  private launchConfig(config: AgentConfig): AgentConfig {
    const seat = seatOf(this.kit, config.provider);
    if (!seat) return config;
    const project = projectOf(config.cwd);
    this.remember(project);
    const team = this.seating.ensure(seat.role.role, seat.harness, project);
    const render = (role: Parameters<typeof renderPrompt>[1]) => renderPrompt(this.kit, role, { guides: guidesDir(), state: project.state });
    return applyRole(this.kit, team, config, render, project.state, this.seating.servers(team, seat.role.role));
  }

  private openSession(request: SessionOpen): SessionOpen {
    const seat = seatOf(this.kit, request.provider);
    if (!seat) return request;
    const project = projectOf(request.cwd);
    this.remember(project);
    try {
      seedRecords(this.kit, project.state);
    } catch (error) {
      console.error("seatworks-v2: could not seed project records:", error);
    }
    try {
      if (this.kit.team) placeProjectFiles(project.root, this.kit.team);
    } catch (error) {
      console.error("seatworks-v2: could not write the team's block into the project's AGENTS.md:", error);
    }
    this.seating.ensure(seat.role.role, seat.harness, project);
    return seatEnv(this.kit, request, seatDir(this.kit, seat.role, seat.harness, home(), project), project);
  }

  private turnStarted(agentId: string): void {
    this.turns.started(agentId);
    this.outbox.turnStarted(agentId);
  }

  private async turnEnded(event: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
    this.outbox.turnEnded(event.agent.id);
    this.malformedCalls(event);
    // Wrapped: a throw here left the seat's mail waiting until some unrelated event pumped it.
    try {
      // A Critic is one look: it goes when its turn ends, whether or not it handed its findings in.
      const archiving = this.desk.pendingArchive.has(event.agent.id) || can(seatOf(this.kit, event.agent.provider)?.role, "critique");
      if (archiving) await this.desk.archive(event.agent.id, true);
      await this.desk.stopped(event.agent.id);
      if (archiving) return;
      await this.turns.ended(event);
    } finally {
      await this.outbox.pump(event.agent.id);
    }
  }

  private async permissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"]): Promise<void> {
    const role = seatOf(this.kit, agent.provider)?.role;
    if (!role?.tools) return;
    const project = projectOf(agent.cwd);
    const what = request.title ?? request.name ?? request.kind;
    if (can(role, "supervise")) {
      this.log(project, `waiting on the Human: ${agent.id} ${what}`);
      return;
    }
    const owner = await this.turns.ownerOf(project, agent.id, role);
    await this.desk.post(owner, `permission:${agent.id}:${request.id}`, letters.permission(`${role.label} ${agent.title ?? agent.id}`, request, this.addressOf(project, agent.id, role)));
  }

  private addressOf(project: Project, agentId: string, role: RoleSpec): string | undefined {
    try {
      const ledger = loadLedger(project.state);
      return can(role, "lead") ? laneOfLead(ledger, agentId)?.id : taskOfPeer(ledger, agentId)?.id;
    } catch {
      return undefined;
    }
  }

  private remember(project: Project): void {
    this.desk.projects.set(project.slug, project);
    this.source.record(project);
  }

  private indexesFor(project: Project): CodeIndex[] {
    return indexedProxies(this.source.teamFor(project)).map((proxy) => this.makeIndex(proxy));
  }

  /** Asked once per load and on demand: Paseo keeps a catalog until told to refresh it. */
  async refreshModels(): Promise<ModelCache> {
    const paseo = this.api;
    if (!paseo) throw new Error("Paseo is not connected, so it cannot list the agents' models");
    // Scoped to one directory: unscoped, Paseo probes the agent for every workspace it has ever opened.
    const cwd = stateRoot();
    await Promise.all([...listingProviders(this.kit).values()].map((provider) => paseo.providers.refresh({ cwd, providers: [provider] })));
    const { cache, changed } = await fetchModels(this.kit, (provider) => paseo.providers.listModels(provider, { cwd }) as Promise<Listed>, stateRoot());
    applyModels(this.kit, cache);
    if (changed) {
      this.seating.forget();
      this.reconcileProviders(this.source.teamFor());
    }
    return cache;
  }

  private reconcileProviders(team: Team): void {
    try {
      const changed = applyReconcile(this.kit, team);
      if (changed.length === 0) return;
      console.log(`seatworks-v2: config updated (${changed.join(", ")}); reloading the daemon`);
      void this.reload();
    } catch (error) {
      console.error("seatworks-v2: could not reconcile role providers:", error);
    }
  }

  private log(project: Project, line: string): void {
    try {
      appendRecord(project.state, "attention", `${new Date().toISOString()}  ${line}\n`);
    } catch (error) {
      console.error("seatworks-v2: attention log write failed:", error);
    }
  }

  private async compose(to: string, list: Letter[]): Promise<string> {
    const items = list.map((letter) => letter.text);
    try {
      const seat = await this.seats.look(to);
      if (!seat.cwd) return letters.mailbox(items, []);
      return letters.mailbox(items, openAsksTo(loadLedger(projectOf(seat.cwd).state), to));
    } catch {
      return letters.mailbox(items, []);
    }
  }

  private on<N extends EventName>(server: PluginServerContext, name: N, handler: (event: PluginLifecycleEvents[N], context: PluginHookContext) => Promise<void>): void {
    server.on(name, async (event, context) => {
      this.api = context.paseo;
      try {
        await handler(event, context);
      } catch (error) {
        console.error(`seatworks-v2: ${name} handler failed:`, error);
      }
    });
  }

  /** A call is waited on until the seat's bridge has taken its answer, which it deletes as it reads it. */
  private waitedOn(agentId: string): { id: string; replied: boolean }[] {
    const live = (this.calls.get(agentId) ?? []).filter((call) => !call.replied || existsSync(replyFile(this.spool, call.id)));
    if (live.length > 0) this.calls.set(agentId, live);
    else this.calls.delete(agentId);
    return live;
  }

  private serveSpool(): void {
    if (!this.api) return;
    let requests;
    try {
      requests = takeRequests(this.spool);
    } catch (error) {
      console.error("seatworks-v2: spool read failed:", error);
      return;
    }
    for (const request of requests) {
      const call = { id: request.id, replied: false };
      this.calls.set(request.agent, [...this.waitedOn(request.agent), call]);
      this.desk
        .answer(request)
        .catch((error) => ({ ok: false, text: `The desk failed: ${errorText(error)}` }))
        .then((reply) => writeReply(this.spool, request.id, reply))
        .catch((error) => console.error("seatworks-v2: spool reply failed:", error))
        .finally(() => {
          call.replied = true;
        });
    }
  }
}
