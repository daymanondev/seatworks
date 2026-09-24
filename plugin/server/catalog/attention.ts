export type Attention = {
  tickSeconds: number;
  leadIdleMinutes: number;
  askRemindMinutes: number;
  maxReminders: number;
  watch: boolean;
  destructive: string;
  testPath: string;
  repeatsAt: number;
  reworksAt: number;
  reviewsAt: number;
  suppressed: string;
  longTurnMinutes: number;
  incidentsPerDay: number;
};

export const ATTENTION: Omit<Attention, "destructive" | "testPath" | "suppressed"> = {
  tickSeconds: 30, leadIdleMinutes: 12, askRemindMinutes: 15, maxReminders: 2,
  watch: false,
  repeatsAt: 3,
  reworksAt: 3,
  reviewsAt: 3,
  longTurnMinutes: 30,
  incidentsPerDay: 5,
};
