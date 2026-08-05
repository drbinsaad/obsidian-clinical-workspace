import type {
  EpisodeRecord,
  IntegrityIssue,
  PatientRecord,
  ProcedureRecord,
  TaskRecord
} from "../domain/types";
import {
  CARE_SETTINGS,
  EPISODE_STATUSES,
  PATHWAYS,
  PRIORITIES,
  TASK_STATUSES
} from "../domain/types";
import { isIsoDate, mrnMatchKey, normalizeText, taskIsOpen } from "../domain/schema";
import { ClinicalRepository } from "../data/repository";

/**
 * Scans the clinical folders for problems.
 *
 * Messages are rendered in the interface and may reach the developer console,
 * so they must never contain a patient identifier — no MRN, name or phone.
 * Callers locate the affected note through `recordId` and `path`.
 */
export class IntegrityService {
  constructor(private readonly repository: ClinicalRepository) {}

  async scan(): Promise<IntegrityIssue[]> {
    const [patients, episodes, tasks, procedures] = await Promise.all([
      this.repository.list<PatientRecord>("patient"),
      this.repository.list<EpisodeRecord>("episode"),
      this.repository.list<TaskRecord>("task"),
      this.repository.list<ProcedureRecord>("procedure")
    ]);
    const issues: IntegrityIssue[] = [];
    const patientIds = new Set(patients.map((item) => item.record.id));
    const episodeIds = new Set(episodes.map((item) => item.record.id));

    // --- Structure ----------------------------------------------------------
    // A managed folder moved in the file explorer detaches every record inside
    // it. Reporting it explicitly beats leaving the user to infer it from a
    // sudden drop in counts.
    for (const folder of this.repository.missingFolders()) {
      issues.push({
        code: "missing-folder",
        severity: "error",
        message: `A managed folder is missing: ${folder}. Records inside it will not be found.`,
        recordId: "",
        path: folder
      });
    }

    const activePatients = patients.filter(
      ({ record }) => record.status !== "entered-in-error" && !record.merged_into
    );

    // A note that cannot be parsed disappears from every list, so nothing else
    // in this scan can see it. It has to be reported here or not at all.
    for (const entity of ["patient", "episode", "task", "procedure", "event"] as const) {
      for (const path of await this.repository.unreadablePaths(entity)) {
        issues.push({
          code: "unreadable-record",
          severity: "error",
          message: `A ${entity} note could not be read and is invisible to the workspace. Repair its properties.`,
          recordId: "",
          path
        });
      }
    }

    // --- Patients -----------------------------------------------------------
    const mrnMap = new Map<string, typeof patients>();
    for (const patient of activePatients) {
      const key = mrnMatchKey(patient.record.mrn);
      if (!key) continue;
      const current = mrnMap.get(key) ?? [];
      current.push(patient);
      mrnMap.set(key, current);
    }
    for (const matches of mrnMap.values()) {
      if (matches.length < 2) continue;
      for (const match of matches) {
        issues.push({
          code: "duplicate-mrn",
          severity: "error",
          message: `This MRN is recorded on ${matches.length} patient records. Merge them from the Patients tab.`,
          recordId: match.record.id,
          path: match.path
        });
      }
    }

    const episodePatientIds = new Set(episodes.map((item) => item.record.patient_id));
    for (const patient of activePatients) {
      if (!normalizeText(patient.record.patient_name) && !normalizeText(patient.record.mrn)) {
        issues.push({
          code: "unidentified-patient",
          severity: "error",
          message: "Patient record has neither an MRN nor a name.",
          recordId: patient.record.id,
          path: patient.path
        });
      }
      if (patient.record.status === "active" && !episodePatientIds.has(patient.record.id)) {
        issues.push({
          code: "orphan-patient",
          severity: "warning",
          message: "Active patient has no care episode; a write may have failed part-way.",
          recordId: patient.record.id,
          path: patient.path
        });
      }
      if (patient.record.merged_into && !patientIds.has(patient.record.merged_into)) {
        issues.push({
          code: "broken-merge-link",
          severity: "error",
          message: "Patient was merged into a record that no longer exists.",
          recordId: patient.record.id,
          path: patient.path
        });
      }
    }

    // --- Episodes -----------------------------------------------------------
    for (const episode of episodes) {
      if (!patientIds.has(episode.record.patient_id)) {
        issues.push({
          code: "orphan-episode",
          severity: "error",
          message: "Episode links to a missing patient.",
          recordId: episode.record.id,
          path: episode.path
        });
      }
      if (episode.record.due_date && !isIsoDate(episode.record.due_date)) {
        issues.push({
          code: "invalid-episode-date",
          severity: "warning",
          message: "Episode due date is not a valid calendar date.",
          recordId: episode.record.id,
          path: episode.path
        });
      }
      if (!normalizeText(episode.record.case)) {
        issues.push({
          code: "missing-episode-case",
          severity: "error",
          message: "Episode has no case or reason recorded.",
          recordId: episode.record.id,
          path: episode.path
        });
      }
      issues.push(
        ...this.checkEnum(episode.record.pathway, PATHWAYS, "pathway", episode.record.id, episode.path),
        ...this.checkEnum(episode.record.status, EPISODE_STATUSES, "status", episode.record.id, episode.path),
        ...this.checkEnum(episode.record.priority, PRIORITIES, "priority", episode.record.id, episode.path),
        ...this.checkEnum(episode.record.care_setting, CARE_SETTINGS, "care setting", episode.record.id, episode.path)
      );
    }

    // --- Tasks --------------------------------------------------------------
    const activeTaskKeys = new Map<string, typeof tasks>();
    for (const task of tasks) {
      if (!patientIds.has(task.record.patient_id) || !episodeIds.has(task.record.episode_id)) {
        issues.push({
          code: "orphan-task",
          severity: "error",
          message: "Task links to a missing patient or episode.",
          recordId: task.record.id,
          path: task.path
        });
      }
      // The episode owns the patient relationship; a task disagreeing with it
      // is filed under the wrong chart, which no other rule here would notice.
      const taskEpisode = episodes.find((item) => item.record.id === task.record.episode_id);
      if (taskEpisode && taskEpisode.record.patient_id !== task.record.patient_id) {
        issues.push({
          code: "mismatched-task-patient",
          severity: "error",
          message: "Task is filed under a different patient from its episode.",
          recordId: task.record.id,
          path: task.path
        });
      }
      if (task.record.due_date && !isIsoDate(task.record.due_date)) {
        issues.push({
          code: "invalid-task-date",
          severity: "warning",
          message: "Task due date is not a valid calendar date.",
          recordId: task.record.id,
          path: task.path
        });
      }
      issues.push(
        ...this.checkEnum(task.record.status, TASK_STATUSES, "status", task.record.id, task.path),
        ...this.checkEnum(task.record.priority, PRIORITIES, "priority", task.record.id, task.path)
      );
      if (taskIsOpen(task.record)) {
        const current = activeTaskKeys.get(task.record.idempotency_key) ?? [];
        current.push(task);
        activeTaskKeys.set(task.record.idempotency_key, current);
      }
    }
    for (const matches of activeTaskKeys.values()) {
      if (matches.length < 2) continue;
      for (const match of matches) {
        issues.push({
          code: "duplicate-open-task",
          severity: "error",
          message: `${matches.length} open tasks are identical. Cancel the extras.`,
          recordId: match.record.id,
          path: match.path
        });
      }
    }

    // --- Procedures ---------------------------------------------------------
    for (const procedure of procedures) {
      if (!patientIds.has(procedure.record.patient_id) || !episodeIds.has(procedure.record.episode_id)) {
        issues.push({
          code: "orphan-procedure",
          severity: "error",
          message: "Procedure links to a missing patient or episode.",
          recordId: procedure.record.id,
          path: procedure.path
        });
      }
      const procedureEpisode = episodes.find((item) => item.record.id === procedure.record.episode_id);
      if (procedureEpisode && procedureEpisode.record.patient_id !== procedure.record.patient_id) {
        issues.push({
          code: "mismatched-procedure-patient",
          severity: "error",
          message: "Procedure is filed under a different patient from its episode.",
          recordId: procedure.record.id,
          path: procedure.path
        });
      }
      if (procedure.record.procedure_date && !isIsoDate(procedure.record.procedure_date)) {
        issues.push({
          code: "invalid-procedure-date",
          severity: "warning",
          message: "Procedure date is not a valid calendar date.",
          recordId: procedure.record.id,
          path: procedure.path
        });
      }
    }

    return issues;
  }

  private checkEnum(
    value: string,
    allowed: readonly string[],
    label: string,
    recordId: string,
    path: string
  ): IntegrityIssue[] {
    if (allowed.includes(value)) return [];
    return [
      {
        code: "invalid-value",
        severity: "error",
        message: `Unrecognised ${label} value; the note may have been edited by hand.`,
        recordId,
        path
      }
    ];
  }
}
