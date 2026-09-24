/** Types only: the RPC contracts carry `z.json()`, so hand-copied shapes on each side never met the compiler. */

export type FlowSeat = { id: string; role: string; status: string; minutes: number; waiting: string[] };
export type FlowTask = { id: string; title: string; status: string; kind: string; peer: FlowSeat | null; minutes: number; handback: number | null };
export type FlowLane = { id: string; title: string; status: string; branch: string; base?: string; lead: FlowSeat | null; tasks: FlowTask[]; taskCount: number; running: number; open: boolean; after?: string[]; held?: string; landApproval?: { minutes: number; approved: boolean; signals: string[]; evidence: string[] } };
export type FlowAsk = { id: string; kind: string; fromRole: string; to: string; minutes: number; text: string };
export type WatchIncident = {
  id: string;
  title: string;
  level: "page" | "attend";
  name: string;
  minutes: number;
  quote: string;
  told: "lead" | "supervisor" | null;
  lane: string | null;
  held: string | null;
};
/** What the code noticed about the seats and nobody has marked yet, and the trouble nobody is mailed about. */
export type WatchView = { incidents: WatchIncident[]; trouble: { kind: string; minutes: number; detail: string }[] };
/** A Critic reading one lane, for the few minutes it lives. */
export type FlowCritic = { lane: string; title: string; seat: FlowSeat };
export type FlowView = { project: string; at: number; revision: string; supervisors: FlowSeat[]; critics: FlowCritic[]; lanes: FlowLane[]; moreLanes: number; asks: FlowAsk[]; watch: WatchView };
export type Check = { id: string; ok: boolean; detail: string };

export type CleanItem = {
  path: string;
  kind: "seat" | "copy" | "records" | "snapshot" | "backup";
  why: string;
  bytes: number;
  careful: boolean;
  held: string | null;
};
export type CleanView = { items: CleanItem[]; removed: string[]; failed: { path: string; error: string }[] };

type UpdateCommit = { sha: string; subject: string };
export type UpdateView = {
  dir: string;
  version: string;
  next: string | null;
  head: string;
  date: string | null;
  fetched: boolean;
  branch: string | null;
  upstream: string | null;
  behind: number;
  ahead: number;
  commits: UpdateCommit[];
  installs: boolean;
  paseo: string | null;
  blocked: string | null;
  busy: string[];
  updated: { from: string; to: string } | null;
};

export type MigrateStep = {
  kind: "settings" | "block" | "seat";
  where: string;
  what: string;
  detail: string[];
  auto: boolean;
};
/** Guides and records are only told about, never replaced. */
export type ContentChange = {
  unit: string;
  kind: "guide" | "record" | "prompt" | "skill" | "team";
  change: "added" | "changed" | "removed";
  kept: boolean;
  keepable: boolean;
};
export type MigrateView = {
  stamp: string;
  since: string;
  steps: MigrateStep[];
  done: string[];
  content: ContentChange[];
};
