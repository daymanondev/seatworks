import { findings } from "../critique.ts";
import type { ToolDef } from "../services.ts";
import { accept } from "./accept.ts";
import { markIncident } from "./mark-incident.ts";
import { addTasks } from "./add-tasks.ts";
import { amendLane } from "./amend-lane.ts";
import { amendTask } from "./amend-task.ts";
import { answer } from "./answer.ts";
import { askLead, askOwner } from "./ask.ts";
import { dropLane } from "./drop-lane.ts";
import { cut } from "./cut.ts";
import { done, doneReview } from "./done.ts";
import { incidents } from "./incidents.ts";
import { message } from "./message.ts";
import { landLane } from "./land-lane.ts";
import { openLane } from "./open-lane.ts";
import { record } from "./record.ts";
import { replaceLead } from "./replace-lead.ts";
import { report } from "./report.ts";
import { rework } from "./rework.ts";
import { setProject } from "./set-project.ts";
import { startReview } from "./start-review.ts";
import { status } from "./status.ts";

export const TOOLS: ToolDef[] = [
  openLane,
  landLane,
  dropLane,
  amendLane,
  replaceLead,
  setProject,
  addTasks,
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
  record,
  findings,
];
