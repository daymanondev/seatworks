import { type Kit, can, seatOf } from "../catalog/kit.ts";
import { answerWith, midTurn, questionsIn } from "../core/paseo.ts";
import type { SeatLook, SeatView, Seats, StreamRow } from "../core/ports.ts";
import type { Intents } from "./intents.ts";
import { type Project, projectOf } from "./project.ts";

export class Roster {
  private readonly kit: Kit;
  private readonly seats: Seats;
  private readonly intents: Intents;

  constructor(kit: Kit, seats: Seats, intents: Intents) {
    this.kit = kit;
    this.seats = seats;
    this.intents = intents;
  }

  open(): Promise<SeatView[]> {
    return this.seats.open();
  }

  /** Whether a seat is still there to read what is sent to it. */
  async seated(agentId: string): Promise<boolean> {
    try {
      return !(await this.look(agentId)).archivedAt;
    } catch {
      return false;
    }
  }

  look(agentId: string): Promise<SeatLook> {
    return this.seats.look(agentId);
  }

  /** Sends past the outbox, cutting a running turn short; a seat that is gone is left so, since a send would start it again. */
  async interrupt(agentId: string, letter: { key: string; text: string }): Promise<boolean> {
    if (!(await this.seated(agentId))) return false;
    await this.seats.send(agentId, letter.text, [letter.key.split(":")[0]!], "interrupt");
    return true;
  }

  history(agentId: string, limit: number): Promise<StreamRow[]> {
    return this.seats.history(agentId, limit);
  }

  /** A seat stopped on a question reads nothing until it is answered, so a message answers it. `waiting`: only the Human can. */
  async answerQuestion(agentId: string, text: string): Promise<"answered" | "waiting" | undefined> {
    let pending;
    try {
      pending = (await this.seats.look(agentId)).pendingPermissions ?? [];
    } catch {
      return undefined;
    }
    const question = pending.find((request) => request.kind === "question" && request.id && questionsIn(request).length > 0);
    if (!question?.id) return pending.length > 0 ? "waiting" : undefined;
    try {
      await this.seats.respond(agentId, question.id, answerWith(question, text));
      return "answered";
    } catch {
      return undefined;
    }
  }

  async supervisorFor(project: Project, preferred?: string): Promise<string | undefined> {
    let gone = false;
    if (preferred) {
      try {
        const seat = await this.seats.look(preferred);
        if (!seat.archivedAt) return preferred;
        gone = true;
      } catch {}
    }
    const found = (await this.seats.open())
      .filter((seat) => this.holds(seat, "supervise", project))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    // Not the preferred id: it may be the seat just read as archived, and every letter to it would be held forever.
    return found[0]?.id ?? (gone ? undefined : preferred);
  }

  private holds(seat: SeatView, capability: string, project: Project): boolean {
    return can(seatOf(this.kit, seat.provider)?.role, capability) && projectOf(seat.cwd).slug === project.slug;
  }

  /** Whether the seat is archived once its turn ends. */
  archiving(agentId: string): boolean {
    return this.intents.toArchive().includes(agentId);
  }

  async archive(agentId: string | undefined, force = false): Promise<void> {
    if (!agentId) return;
    try {
      if (!force && midTurn((await this.seats.look(agentId)).status)) {
        this.intents.archiveLater(agentId);
        return;
      }
      this.intents.archived(agentId);
      await this.seats.archive(agentId);
    } catch (error) {
      console.error(`seatworks-v2: archiving ${agentId} failed:`, error);
    }
  }

  /** After a stop: a seat left to end its turn goes now if the listing shows that turn over, and is forgotten if it is gone. */
  async archiveWaiting(listed: Map<string, SeatView>): Promise<void> {
    for (const id of this.intents.toArchive()) {
      const seat = listed.get(id);
      if (!seat) this.intents.archived(id);
      else if (!midTurn(seat.status)) await this.archive(id);
    }
  }
}
