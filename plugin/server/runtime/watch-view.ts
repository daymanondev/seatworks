import type { WatchView } from "../../shared/views.ts";
import { loadIncidents } from "../desk/incidents.ts";
import { type Ledger, laneOfLead, loadLedger, taskOfPeer } from "../desk/ledger.ts";
import type { Project } from "../desk/project.ts";
import { factTitle } from "./watch/facts.ts";

const INCIDENTS_SHOWN = 200;

export type Trouble = { kind: string; at: number; detail: string };

/** What the panel shows of a project's watch: open incidents, pages first, each named by its seat's place, and trouble nobody is mailed about. */
export function watchView(project: Project, troubles: Trouble[], now = Date.now()): WatchView {
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
  return { incidents, trouble: troubles.map((entry) => ({ kind: entry.kind, minutes: ago(entry.at), detail: entry.detail })).reverse() };
}
