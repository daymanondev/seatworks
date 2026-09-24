import { Lifecycle } from "./lifecycle.ts";

export type Held = "shadow" | "budget" | "nobody";

/** What a watch saw that the desk books as an incident. */
export type Finding = { kind: string; level: "page" | "attend"; quote: string; facts: string[] };

type Delivery = "unsent" | "held" | "told";

type Delivered = { told?: number; held?: Held };

const DELIVERY = new Lifecycle<Delivery, "hold" | "tell" | "unheard">({
  hold: { from: ["unsent", "held"], to: "held" },
  tell: { from: ["unsent", "held"], to: "told" },
  unheard: { from: ["told"], to: "held" },
});

/** Where an incident stands on being told, read from what it keeps: when it was told, and why it was not. */
export const deliveryOf = (incident: Delivered): Delivery => (incident.told !== undefined ? "told" : incident.held ? "held" : "unsent");

export function hold(incident: Delivered, why: Held): boolean {
  if (!DELIVERY.may(deliveryOf(incident), "hold")) return false;
  incident.held = why;
  return true;
}

export function tell(incident: Delivered, at: number): boolean {
  if (!DELIVERY.may(deliveryOf(incident), "tell")) return false;
  delete incident.held;
  incident.told = at;
  return true;
}

/** A letter that found nobody to read it: the incident waits for somebody to be seated instead. */
export function unheard(incident: Delivered): boolean {
  if (!DELIVERY.may(deliveryOf(incident), "unheard")) return false;
  delete incident.told;
  incident.held = "nobody";
  return true;
}

/** Closing is apart from being told: a closed incident keeps whether it was told, and why not. */
export function close(incident: { open: boolean; closed?: number }, at: number): boolean {
  if (!incident.open) return false;
  incident.open = false;
  incident.closed = at;
  return true;
}
