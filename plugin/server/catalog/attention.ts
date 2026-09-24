import type { Attention } from "../../shared/views.ts";

export const ATTENTION: Omit<Attention, "destructive" | "testPath" | "suppressed"> = {
  tickSeconds: 30, leadIdleMinutes: 12, askRemindMinutes: 15, maxReminders: 2,
  watch: false,
  repeatsAt: 3,
  reworksAt: 3,
  reviewsAt: 3,
  longTurnMinutes: 30,
  incidentsPerDay: 5,
  questionsPerDay: 3,
};
