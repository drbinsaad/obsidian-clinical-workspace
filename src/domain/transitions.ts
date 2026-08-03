import type { EpisodeStatus, Pathway, TaskRecord, TaskStatus } from "./types";
import { PATHWAYS } from "./types";
import { taskIsOpen } from "./schema";

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
  completed: ["entered-in-error"],
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
