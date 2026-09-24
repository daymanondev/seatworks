import { randomUUID } from "node:crypto";

/** The start of every message id the desk sends, which no person's client uses. */
const DESK_MARK = "sw2-";

export const deskId = (kinds: string[]) => `${DESK_MARK}${kinds.join(".")}-${randomUUID()}`;

/** Who a user message came from, by the id the desk gives every letter and every prompt it starts a seat with: the kinds of letter it carries, or a person. */
export function sentBy(item: Record<string, unknown>): string[] {
  const id = item.clientMessageId;
  return typeof id === "string" && id.startsWith(DESK_MARK) ? id.slice(DESK_MARK.length).split("-")[0]!.split(".") : ["person"];
}
