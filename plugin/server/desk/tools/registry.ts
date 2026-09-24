import { findings } from "../critique.ts";
import type { ToolDef } from "../services.ts";
import { accept } from "./accept.ts";
import { markIncident } from "./mark-incident.ts";
import { amendLane } from "./amend-lane.ts";
import { amendTask } from "./amend-task.ts";
import { answer } from "./answer.ts";
import { askLead, askOwner } from "./ask.ts";
import { closeLane } from "./close-lane.ts";
import { cut } from "./cut.ts";
import { done, doneReview } from "./done.ts";
import { incidents } from "./incidents.ts";
import { message } from "./message.ts";
import { openLane } from "./open-lane.ts";
import { planTasks } from "./plan-tasks.ts";
import { replaceLead } from "./replace-lead.ts";
import { report } from "./report.ts";
import { rework } from "./rework.ts";
import { setProject } from "./set-project.ts";
import { startReview } from "./start-review.ts";
import { startTask } from "./start-task.ts";
import { status } from "./status.ts";

export const TOOLS: ToolDef[] = [
  openLane,
  closeLane,
  amendLane,
  replaceLead,
  setProject,
  startTask,
  planTasks,
  startReview,
  accept,
  rework,
  amendTask,
  cut,
  report,
  askOwner,
  askLead,
  done,
  doneReview,
  message,
  answer,
  status,
  incidents,
  markIncident,
  findings,
];
