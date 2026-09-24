const COMMAND_START = "(?:^|[;&|(`{\\n]|\\$\\(|\\b(?:sudo|xargs|exec|env|nohup|time|command|then|do|else)\\s+|-exec(?:dir)?\\s+|\\b(?:ba|z)?sh\\s+-l?c\\s+)\\s*['\"]?";

const DESTRUCTIVE =
  `${COMMAND_START}(?:rm\\s+(?:-\\S+\\s+)*(?:-[a-z]*[rf][a-z]*|--(?:recursive|force)\\b)|git\\s+(?:-C\\s+\\S+\\s+)?(?:reset\\s+--hard|clean\\s+-[a-z]*f|push\\s+[^|;&]*(?:--force|-f)\\b|branch\\s+(?:-\\S+\\s+)*(?-i:-D)\\b|branch\\b(?=[^|;&]*\\s(?:-[a-z]*d|--delete))[^|;&]*\\s(?:-[a-z]*f|--force)\\b))` +
  "|--force-with-lease|\\bdrop\\s+(?:table|database)\\b|\\btruncate\\s+table\\b";

const TEST_PATH = "(^|/)(tests?|specs?|__tests__)/|[._-](test|spec)\\.[a-z]+$|(^|/)test_[^/]*\\.[a-z]+$";

const SUPPRESSED = "@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|#\\s*type:\\s*ignore|#\\s*noqa|\\bas\\s+any\\b(?![ \\t]+(?!as\\b)[a-z])";

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

export const ATTENTION: Attention = {
  tickSeconds: 30, leadIdleMinutes: 12, askRemindMinutes: 15, maxReminders: 2,
  watch: false,
  destructive: DESTRUCTIVE,
  testPath: TEST_PATH,
  repeatsAt: 3,
  reworksAt: 3,
  reviewsAt: 3,
  suppressed: SUPPRESSED,
  longTurnMinutes: 30,
  incidentsPerDay: 5,
};
