import type { EpisodeStatus, Pathway, TaskRecord, TaskStatus } from "./types";
import { PATHWAYS, PRIORITIES } from "./types";
import { isoDateWithOffset, taskIsOpen } from "./schema";

const ALLOWED_EPISODE_TRANSITIONS: Record<EpisodeStatus, readonly EpisodeStatus[]> = {
  active: ["on-hold", "ready-to-close", "archived", "cancelled", "entered-in-error"],
  "on-hold": ["active", "ready-to-close", "archived", "cancelled", "entered-in-error"],
  "ready-to-close": ["active", "archived", "cancelled", "entered-in-error"],
  archived: ["active", "on-hold", "ready-to-close", "entered-in-error"],
  cancelled: ["active", "entered-in-error"],
  "entered-in-error": []
};

const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in-progress", "waiting", "completed", "cancelled", "entered-in-error"],
  "in-progress": ["open", "waiting", "completed", "cancelled", "entered-in-error"],
  waiting: ["open", "in-progress", "completed", "cancelled", "entered-in-error"],
  // completed -> open exists for mis-tap recovery. The reopen is audited, so
  // the trail shows both the completion and the correction.
  completed: ["open", "entered-in-error"],
  cancelled: ["open", "entered-in-error"],
  "entered-in-error": []
};

export function canTransitionEpisode(from: EpisodeStatus, to: EpisodeStatus): boolean {
  return from === to || (ALLOWED_EPISODE_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || (ALLOWED_TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function openTaskCount(tasks: readonly TaskRecord[], episodeId: string): number {
  return tasks.filter((task) => task.episode_id === episodeId && taskIsOpen(task)).length;
}

export function canArchiveEpisode(
  status: EpisodeStatus,
  tasks: readonly TaskRecord[],
  episodeId: string
): { allowed: boolean; reason: string } {
  if (status === "archived") return { allowed: true, reason: "Already archived." };
  const remaining = openTaskCount(tasks, episodeId);
  if (remaining > 0) {
    return {
      allowed: false,
      reason: `${remaining} open task${remaining === 1 ? " remains" : "s remain"}. Complete or cancel them first.`
    };
  }
  if (!canTransitionEpisode(status, "archived")) {
    return { allowed: false, reason: `Cannot archive an episode in ${status} status.` };
  }
  return { allowed: true, reason: "Episode can be archived." };
}

export function statusAfterTaskCompletion(
  tasks: readonly TaskRecord[],
  episodeId: string,
  completedTaskId: string
): EpisodeStatus | null {
  const remaining = tasks.filter(
    (task) => task.episode_id === episodeId && task.id !== completedTaskId && taskIsOpen(task)
  );
  return remaining.length === 0 ? "ready-to-close" : null;
}

/**
 * Higher is more urgent; an unrecognised value ranks -1, below routine. That
 * is not a lower priority, only an unknown one, so escalation never moves a
 * value from or over it.
 */
export function priorityRank(priority: string): number {
  return (PRIORITIES as readonly string[]).indexOf(priority);
}

/**
 * Due date of a recurring task's next occurrence: one interval after `seed`
 * (the completed occurrence's due date), rolled forward by whole intervals
 * until it is not in the past. The cadence is kept, but completing late no
 * longer raises work that is already overdue. An occurrence due today stays.
 */
export function nextOccurrenceDate(seed: string, interval: number, today: string): string {
  const next = isoDateWithOffset(interval, seed);
  if (next >= today || interval <= 0) return next;
  const behind = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${next}T00:00:00Z`)) / (24 * 60 * 60 * 1000)
  );
  if (!Number.isFinite(behind)) return next;
  return isoDateWithOffset(Math.ceil(behind / interval) * interval, next);
}

export function pathwayAfterProcedure(followUpRequired: boolean): Pathway {
  return followUpRequired ? "opd-follow-up" : "discharge-ready";
}

/**
 * Pathway an episode should return to when it is restored from the archive.
 * Falls back to assessment only when nothing usable was recorded, which is the
 * case for records written before schema version 2.
 */
export function pathwayAfterRestore(pathwayBeforeArchive: string): Pathway {
  return (PATHWAYS as readonly string[]).includes(pathwayBeforeArchive)
    ? (pathwayBeforeArchive as Pathway)
    : "assessment";
}

export function statusAfterRestore(
  statusBeforeArchive: string,
  tasks: readonly TaskRecord[],
  episodeId: string
): EpisodeStatus {
  if (statusBeforeArchive === "on-hold") return "on-hold";
  return openTaskCount(tasks, episodeId) > 0 ? "active" : "ready-to-close";
}

/**
 * Status a ready-to-close episode returns to when one of its tasks is
 * reopened: the one the completion replaced, or active when none was recorded
 * (records written before the field existed).
 */
export function statusAfterReopen(statusBeforeReady: string | undefined): EpisodeStatus {
  return statusBeforeReady === "on-hold" ? "on-hold" : "active";
}
