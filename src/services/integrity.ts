import type {
  ClinicalRecord,
  EpisodeRecord,
  EventRecord,
  IntegrityIssue,
  PatientRecord,
  ProcedureRecord,
  RecordWithPath,
  TaskRecord
} from "../domain/types";
import { isIsoDate, mrnMatchKey, normalizeComparable, normalizeText, taskIsOpen } from "../domain/schema";
import { validateRecord } from "../domain/validate";
import { ClinicalRepository } from "../data/repository";

/** Families of configured checks, counted for honest result wording. */
export const INTEGRITY_CHECK_FAMILIES = [
  "missing managed folders",
  "unreadable notes",
  "duplicate MRNs",
  "unidentified patients",
  "orphaned records",
  "broken merge links",
  "half-finished merges",
  "duplicate active episodes",
  "duplicate open tasks",
  "duplicate internal ids",
  "cross-record ownership",
  "open tasks on closed episodes",
  "invalid dates and timestamps",
  "unexpected field values",
  "schema versions",
  "idempotency keys",
  "follow-up contradictions",
  "episode next-action agreement",
  "audit-trail coverage"
] as const;

export interface IntegrityReport {
  issues: IntegrityIssue[];
  /** Number of parsed records the configured checks examined. */
  scannedRecords: number;
  /** Number of configured check families that ran. */
  checkFamilies: number;
}

/**
 * Scans the clinical folders for problems.
 *
 * Messages are rendered in the interface and may reach the developer console,
 * so they must never contain a patient identifier — no MRN, name or phone.
 * Callers locate the affected note through `recordId` and `path`.
 *
 * The result reports what the CONFIGURED checks found. It is deliberately not
 * described as a full validation anywhere in the interface.
 */
export class IntegrityService {
  constructor(private readonly repository: ClinicalRepository) {}

  async scan(): Promise<IntegrityIssue[]> {
    return (await this.report()).issues;
  }

  async report(): Promise<IntegrityReport> {
    const [patients, episodes, tasks, procedures, events] = await Promise.all([
      this.repository.list<PatientRecord>("patient"),
      this.repository.list<EpisodeRecord>("episode"),
      this.repository.list<TaskRecord>("task"),
      this.repository.list<ProcedureRecord>("procedure"),
      this.repository.list<EventRecord>("event")
    ]);
    const issues: IntegrityIssue[] = [];
    const patientIds = new Set(patients.map((item) => item.record.id));
    const episodeIds = new Set(episodes.map((item) => item.record.id));
    // Maps, not repeated Array.find: the scan must stay linear so it remains
    // usable on phone-class hardware at multi-thousand-record scale.
    const episodeById = new Map(episodes.map((item) => [item.record.id, item] as const));
    const eventTargets = new Set(events.map((item) => item.record.target_id));

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

    // --- Field-level validation (shared central validators) -----------------
    for (const list of [patients, episodes, tasks, procedures] as const) {
      for (const item of list) {
        for (const problem of validateRecord(item.record)) {
          issues.push({
            ...problem,
            recordId: item.record.id,
            path: item.path
          });
        }
      }
    }

    // --- Duplicate internal ids --------------------------------------------
    // Two notes carrying the same id make every id-based lookup ambiguous;
    // findById silently prefers the conventional path, hiding the other note.
    this.reportDuplicateIds(patients, "patient", issues);
    this.reportDuplicateIds(episodes, "episode", issues);
    this.reportDuplicateIds(tasks, "task", issues);
    this.reportDuplicateIds(procedures, "procedure", issues);

    const activePatients = patients.filter(
      ({ record }) => record.status !== "entered-in-error" && !record.merged_into
    );

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
      if (patient.record.merge_in_progress && !patient.record.merged_into) {
        issues.push({
          code: "half-merged-patient",
          severity: "error",
          message: "Patient merge stopped before every linked record was moved. Retry the same merge.",
          recordId: patient.record.id,
          path: patient.path
        });
      }
    }

    // --- Episodes -----------------------------------------------------------
    const openTasksByEpisode = new Map<string, TaskRecord[]>();
    for (const task of tasks) {
      if (!taskIsOpen(task.record)) continue;
      const current = openTasksByEpisode.get(task.record.episode_id) ?? [];
      current.push(task.record);
      openTasksByEpisode.set(task.record.episode_id, current);
    }

    const activeEpisodeKeys = new Map<string, typeof episodes>();
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
      const openTasks = openTasksByEpisode.get(episode.record.id) ?? [];
      const isClosedStatus = ["archived", "cancelled", "entered-in-error"].includes(episode.record.status);
      // The episode card promises "what happens next". A next action no open
      // task tracks — or a ready-to-close status with open work — misleads
      // the clinician reading the caseload.
      if (!isClosedStatus && normalizeText(episode.record.next_action)) {
        const tracked = openTasks.some(
          (task) => normalizeComparable(task.task) === normalizeComparable(episode.record.next_action)
        );
        if (!tracked) {
          issues.push({
            code: "untracked-next-action",
            severity: "warning",
            message: "Episode names a next action that no open task tracks. The planned work may have been lost by an interrupted write.",
            recordId: episode.record.id,
            path: episode.path
          });
        }
      }
      if (episode.record.status === "ready-to-close" && openTasks.length > 0) {
        issues.push({
          code: "ready-to-close-with-open-tasks",
          severity: "error",
          message: `Episode is marked ready to close while ${openTasks.length} task${openTasks.length === 1 ? " is" : "s are"} still open.`,
          recordId: episode.record.id,
          path: episode.path
        });
      }
      if (!isClosedStatus) {
        const key = `${episode.record.patient_id} ${normalizeText(episode.record.case).toLocaleLowerCase()}`;
        const current = activeEpisodeKeys.get(key) ?? [];
        current.push(episode);
        activeEpisodeKeys.set(key, current);
      }
    }
    for (const matches of activeEpisodeKeys.values()) {
      if (matches.length < 2) continue;
      for (const match of matches) {
        issues.push({
          code: "duplicate-episode",
          severity: "error",
          message: `${matches.length} active episodes describe the same case for one patient. Reconcile the duplicate records.`,
          recordId: match.record.id,
          path: match.path
        });
      }
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
      const taskEpisode = episodeById.get(task.record.episode_id);
      if (taskEpisode && taskEpisode.record.patient_id !== task.record.patient_id) {
        issues.push({
          code: "mismatched-task-patient",
          severity: "error",
          message: "Task is filed under a different patient from its episode.",
          recordId: task.record.id,
          path: task.path
        });
      }
      if (
        taskEpisode &&
        taskIsOpen(task.record) &&
        ["archived", "cancelled", "entered-in-error"].includes(taskEpisode.record.status)
      ) {
        issues.push({
          code: "open-task-on-closed-episode",
          severity: "error",
          message: "An open task is attached to an episode that cannot accept workflow changes.",
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
      if (taskIsOpen(task.record)) {
        const identity = `${task.record.episode_id} ${normalizeText(task.record.task).toLocaleLowerCase()} ${task.record.due_date}`;
        const current = activeTaskKeys.get(identity) ?? [];
        current.push(task);
        activeTaskKeys.set(identity, current);
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
      const procedureEpisode = episodeById.get(procedure.record.episode_id);
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

    // --- Audit-trail coverage -----------------------------------------------
    // Event writes never fail the clinical action; the cost of that choice is
    // that a lost event must be found here, or it is lost silently forever.
    for (const list of [patients, episodes, tasks, procedures] as const) {
      for (const item of list) {
        if (eventTargets.has(item.record.id)) continue;
        issues.push({
          code: "missing-audit-event",
          severity: "warning",
          message: "This record has no audit trail entry. An audit note write may have failed; the record itself is intact.",
          recordId: item.record.id,
          path: item.path
        });
      }
    }

    return {
      issues,
      scannedRecords: patients.length + episodes.length + tasks.length + procedures.length + events.length,
      checkFamilies: INTEGRITY_CHECK_FAMILIES.length
    };
  }

  private reportDuplicateIds<T extends ClinicalRecord>(
    items: RecordWithPath<T>[],
    entity: string,
    issues: IntegrityIssue[]
  ): void {
    const byId = new Map<string, RecordWithPath<T>[]>();
    for (const item of items) {
      const current = byId.get(item.record.id) ?? [];
      current.push(item);
      byId.set(item.record.id, current);
    }
    for (const matches of byId.values()) {
      if (matches.length < 2) continue;
      for (const match of matches) {
        issues.push({
          code: "duplicate-record-id",
          severity: "error",
          message: `${matches.length} ${entity} notes share one internal id, so lookups cannot tell them apart. Keep one and correct the others.`,
          recordId: match.record.id,
          path: match.path
        });
      }
    }
  }
}
