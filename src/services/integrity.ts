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
import { PATHWAYS } from "../domain/types";
import {
  canonicalOption,
  isIsoDate,
  mrnMatchKey,
  normalizeComparable,
  normalizeText,
  procedureIdempotencyKey,
  taskIsOpen
} from "../domain/schema";
import { validateRecord } from "../domain/validate";
import { storedValueKindsOf } from "../data/markdown";
import { ClinicalRepository } from "../data/repository";

/** Separates the parts of a composite duplicate key; ordinary note text never contains it. */
const KEY_SEP = "\u0000";

/** Families of configured checks, counted for honest result wording. */
export const INTEGRITY_CHECK_FAMILIES = [
  "missing managed folders",
  "database view folders",
  "unreadable notes",
  "duplicate MRNs",
  "unidentified patients",
  "orphaned records",
  "broken merge links",
  "half-finished merges",
  "records left under merged patients",
  "open episodes under inactive patients",
  "duplicate active episodes",
  "duplicate open tasks",
  "duplicate internal ids",
  "cross-record ownership",
  "open tasks on closed episodes",
  "invalid dates and timestamps",
  "unexpected field values",
  "text stored as numbers",
  "logbook export readiness",
  "schema versions",
  "idempotency keys",
  "follow-up contradictions",
  "episode next-action agreement",
  "audit-trail coverage"
] as const;

/**
 * Why scripts/export-logbook.mjs would reject this completed procedure. The
 * exporter reads the raw YAML and is stricter than the workspace (which
 * reads an empty value as "" and a date-time as its day), so these rules
 * mirror its validateExportSchema. Keep the two in step.
 */
function exportBlockers(record: ProcedureRecord): string[] {
  const kinds = storedValueKindsOf(record);
  const values = record as unknown as Record<string, unknown>;
  const storedAsText = (field: string): boolean =>
    typeof values[field] === "string" && !["number", "boolean", "null"].includes(kinds.get(field) ?? "");
  const nonEmptyText = (field: string): boolean =>
    storedAsText(field) && String(values[field]).trim().length > 0;
  const plainDate = (field: string): boolean =>
    storedAsText(field) &&
    kinds.get(field) !== "date-time" &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(values[field])) &&
    isIsoDate(values[field]);

  const blockers: string[] = [];
  if (!nonEmptyText("procedure")) blockers.push("procedure (must not be empty)");
  if (!nonEmptyText("role")) blockers.push("role (must not be empty)");
  if (!storedAsText("outcome")) blockers.push('outcome (use "" when there is none)');
  if (!plainDate("procedure_date")) blockers.push("procedure_date (must be YYYY-MM-DD with no time)");
  if (!isExportTimestamp(record.created_at)) blockers.push("created_at (must be a UTC timestamp ending in Z)");
  if (typeof record.follow_up_required !== "boolean") blockers.push("follow_up_required (must be true or false)");
  const followUpDateValid =
    storedAsText("follow_up_date") &&
    (record.follow_up_date === "" ? record.follow_up_required !== true : plainDate("follow_up_date"));
  if (!followUpDateValid) {
    blockers.push('follow_up_date (must be YYYY-MM-DD with no time, or "" when no follow-up is required)');
  }
  return blockers;
}

/** What else is on a procedure's episode, for judging an unfinished save. */
interface EpisodeActivity {
  tasks: TaskRecord[];
  procedures: ProcedureRecord[];
  /** When each audit event about the episode record itself was written. */
  episodeEventTimes: string[];
  /** When each Update of the episode that started off OR booking was written. */
  movedOffBookingTimes: string[];
}

const UNFINISHED_PROCEDURE_COMPLETE_SURGERY =
  "This procedure is in the Surgery logbook, but saving it stopped part-way: its audit entry was never written and the episode is still on OR booking. To finish it, find the episode under Surgery → OR booking, tap Complete surgery and enter the same procedure, date and follow-up. That finishes this entry instead of adding a second one.";

/**
 * The finding for a completed procedure still marked audit_pending with no
 * completion event, or null when nothing but that audit entry can be
 * missing (it is then an ordinary missing-audit-event, which agrees with the
 * "clinical action succeeded" notice the clinician saw).
 *
 * Complete surgery is suggested only where it finishes this entry: a
 * Complete surgery form saved it (its key has no Add another procedure form
 * id, so Complete surgery finds it again), the episode is still on OR
 * booking, and nothing was logged, added or updated on the episode since. An
 * added entry's key carries its form id, so Complete surgery would write a
 * second entry and complete the episode's current booking; and an episode
 * that was moved on and then re-booked would have that new booking completed
 * before its surgery. Neither may be suggested.
 */
function unfinishedProcedureMessage(
  record: ProcedureRecord,
  episode: EpisodeRecord | undefined,
  activity: EpisodeActivity
): string | null {
  const savedAt = Date.parse(String(record.created_at));
  // An unreadable time counts as "since the save": the Complete surgery
  // suggestion must never rest on a guess.
  const since = (value: unknown): boolean => !(Date.parse(String(value)) < savedAt);
  const savedByCompleteSurgery =
    record.idempotency_key ===
    procedureIdempotencyKey(record.episode_id, record.procedure, record.procedure_date);
  const onBooking =
    episode?.pathway === "or-booking" &&
    !["archived", "cancelled", "entered-in-error"].includes(episode.status);
  const otherLogged = activity.procedures.filter(
    (item) => item.id !== record.id && item.status === "completed"
  );
  if (
    savedByCompleteSurgery &&
    onBooking &&
    otherLogged.length === 0 &&
    !activity.tasks.some((task) => since(task.created_at)) &&
    !activity.episodeEventTimes.some(since)
  ) {
    return UNFINISHED_PROCEDURE_COMPLETE_SURGERY;
  }

  // A Complete surgery save owes the move off OR booking and the booking
  // task's completion; one that is still on OR booking, or still has an open
  // booking task, may not have had them. An added entry owes neither. The
  // first entry on an episode can only have come from Complete surgery (Add
  // another procedure is offered once an entry exists), so it owes them even
  // when a hand correction has changed its key. An Update written since the
  // save that found the episode off OR booking proves it was moved on, so a
  // booking now is a later one; only a booking task older than the save is
  // then still owed.
  const owedTransition =
    savedByCompleteSurgery ||
    !otherLogged.some((item) => Date.parse(String(item.created_at)) < savedAt);
  const movedOnSince = activity.movedOffBookingTimes.some((time) => Date.parse(time) >= savedAt);
  const openBooking = (task: TaskRecord): boolean =>
    task.task_type === "book-or" &&
    taskIsOpen(task) &&
    (!movedOnSince || Date.parse(String(task.created_at)) < savedAt);
  const episodeUnsettled =
    owedTransition && ((onBooking && !movedOnSince) || activity.tasks.some(openBooking));
  // The follow-up is there when a task still says what the save asked for,
  // whenever it was raised (a later entry with the same follow-up reuses the
  // open task). It may since have been rescheduled or reworded, so a
  // post-operative follow-up raised since the save also counts, unless it is
  // the follow-up another entry on the episode asked for.
  const asksFor = (item: ProcedureRecord, task: TaskRecord): boolean =>
    item.follow_up_required === true &&
    normalizeComparable(task.task) === normalizeComparable(item.follow_up_plan) &&
    normalizeText(task.due_date) === normalizeText(item.follow_up_date);
  const followUpMissing =
    record.follow_up_required === true &&
    !activity.tasks.some(
      (task) =>
        asksFor(record, task) ||
        (task.task_type === "postop-follow-up" &&
          since(task.created_at) &&
          !otherLogged.some((item) => asksFor(item, task)))
    );
  // A form cancelled after an error and entered again is a second entry by
  // design; it may also be a genuine second procedure, so this only asks.
  const loggedAgain = otherLogged.some(
    (item) =>
      normalizeComparable(item.procedure) === normalizeComparable(record.procedure) &&
      normalizeText(item.procedure_date) === normalizeText(record.procedure_date) &&
      since(item.created_at)
  );
  if (!episodeUnsettled && !followUpMissing && !loggedAgain) return null;

  const parts = [
    "This procedure is in the Surgery logbook, but its audit entry was never written, so saving it may have stopped part-way."
  ];
  if (episodeUnsettled) {
    parts.push(
      "The episode may not have been moved on for it: open the episode and check its pathway, next action and tasks."
    );
  }
  if (followUpMissing) {
    parts.push(
      "No follow-up task matching the one it asked for is on the episode: add it with + Task if it is still needed."
    );
  }
  parts.push(
    loggedAgain
      ? "The same procedure on the same date was logged on this episode after it: if that entry re-entered this one after an error, set status to entered-in-error on this note so the logbook counts it once."
      : "Check the Surgery logbook before logging the procedure again: a new form adds a second entry."
  );
  return parts.join(" ");
}

/** The exporter's timestamp rule: strict UTC, and a real instant. */
function isExportTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/.exec(value);
  if (!match) return false;
  const canonical = `${match[1]}.${match[2] ?? "000"}Z`;
  const parsed = new Date(canonical);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === canonical;
}

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
    const actionsByTarget = new Map<string, Set<string>>();
    for (const event of events) {
      const actions = actionsByTarget.get(event.record.target_id) ?? new Set<string>();
      actions.add(event.record.action);
      actionsByTarget.set(event.record.target_id, actions);
    }

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
    // A customised database view is kept as-is through a folder move, so its
    // filters go on naming the old folders and it silently lists nothing —
    // which can pass for "no such patients".
    for (const path of await this.repository.misdirectedBasePaths()) {
      issues.push({
        code: "stale-base-folder",
        severity: "warning",
        message: "This database view filters on a clinical folder outside the configured folder, so it shows no records. A customised view is never rewritten automatically: edit its file.inFolder(...) lines to name the current folder.",
        recordId: "",
        path
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
    // Events are included: their declared timestamp checks were unreachable
    // when only the four workflow entities passed through validateRecord.
    for (const list of [patients, episodes, tasks, procedures, events] as const) {
      for (const item of list) {
        for (const problem of validateRecord(item.record)) {
          issues.push({
            ...problem,
            recordId: item.record.id,
            path: item.path
          });
        }
        // Parsing turns an unquoted `mrn: 0012345` into text so the workflow
        // keeps working, but the digits YAML already dropped are gone.
        for (const [field, kind] of storedValueKindsOf(item.record)) {
          if (kind !== "number" && kind !== "boolean") continue;
          issues.push({
            code: "text-stored-as-number",
            severity: "warning",
            message: `The "${field}" property is stored as a number or true/false rather than text, so leading zeros may have been lost. Check the value and put it in quotes.`,
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

    // --- Records under retired patients -------------------------------------
    // A merge moves every linked record, and archiving a last episode archives
    // its patient, but Sync can deliver a record written offline on another
    // device afterwards. The workspace refuses to change records of a merged
    // or inactive patient, so these would otherwise sit stuck — and an open
    // task among them blocks discharging the surviving patient's episode.
    const patientById = new Map(patients.map((item) => [item.record.id, item.record] as const));
    for (const list of [episodes, tasks, procedures] as const) {
      for (const item of list) {
        if (!patientById.get(item.record.patient_id)?.merged_into) continue;
        issues.push({
          code: "record-linked-to-merged-patient",
          severity: "error",
          message: `This ${item.record.entity} is still filed under a patient that was merged into another record, so the workspace cannot change it. Set its patient_id to the merged_into value shown on that patient's note, and its patient link to the same patient.`,
          recordId: item.record.id,
          path: item.path
        });
      }
    }
    for (const episode of episodes) {
      if (["archived", "cancelled", "entered-in-error"].includes(episode.record.status)) continue;
      const patient = patientById.get(episode.record.patient_id);
      if (!patient || patient.merged_into) continue;
      if (patient.status !== "archived" && patient.status !== "entered-in-error") continue;
      issues.push({
        code: "active-episode-under-inactive-patient",
        severity: "error",
        message:
          patient.status === "archived"
            ? "This episode is still open, but its patient is archived, so the episode cannot be updated, given tasks or discharged. Set the patient note's status back to active, then continue or discharge the episode as usual."
            : "This episode is still open, but its patient is marked entered in error, so the episode cannot be updated or discharged. If the patient is real, set the patient note's status back to active; otherwise set this episode's status to entered-in-error too.",
        recordId: episode.record.id,
        path: episode.path
      });
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
        const key = `${episode.record.patient_id}${KEY_SEP}${normalizeText(episode.record.case).toLocaleLowerCase()}`;
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
        const identity = `${task.record.episode_id}${KEY_SEP}${normalizeText(task.record.task).toLocaleLowerCase()}${KEY_SEP}${task.record.due_date}`;
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
      // The CSV exporter only reports aggregate counts, by design, so this is
      // where a clinician can find the note that would block the export.
      const blockers = procedure.record.status === "completed" ? exportBlockers(procedure.record) : [];
      if (blockers.length > 0) {
        issues.push({
          code: "not-exportable",
          severity: "warning",
          message: `The logbook CSV export will refuse this completed procedure until these properties are fixed: ${blockers.join("; ")}.`,
          recordId: procedure.record.id,
          path: procedure.path
        });
      }
    }

    // --- Audit-trail coverage -----------------------------------------------
    // A completed procedure still marked audit_pending with no completion
    // event did not finish saving. Retrying the form that saved it finishes
    // it; once that form is gone, a new Add another procedure form is a
    // separate entry by design, and Complete surgery finishes it only in the
    // narrow case unfinishedProcedureMessage checks for. So the finding says
    // what to check, or is left to missing-audit-event below when nothing but
    // the audit entry can be missing. A pending flag beside a written
    // completion event only means clearing the flag failed after the workflow
    // ran to its end, so that is not reported.
    const unfinished = procedures.filter(
      ({ record }) =>
        record.status === "completed" &&
        record.audit_pending === true &&
        !actionsByTarget.get(record.id)?.has("procedure-completed")
    );
    const unfinishedProcedurePaths = new Set<string>();
    if (unfinished.length > 0) {
      const activityByEpisode = new Map<string, EpisodeActivity>();
      const activityOf = (episodeId: string): EpisodeActivity => {
        let activity = activityByEpisode.get(episodeId);
        if (!activity) {
          activity = { tasks: [], procedures: [], episodeEventTimes: [], movedOffBookingTimes: [] };
          activityByEpisode.set(episodeId, activity);
        }
        return activity;
      };
      for (const task of tasks) activityOf(task.record.episode_id).tasks.push(task.record);
      for (const procedure of procedures) {
        activityOf(procedure.record.episode_id).procedures.push(procedure.record);
      }
      for (const event of events) {
        if (event.record.target_entity !== "episode") continue;
        const activity = activityOf(event.record.target_id);
        activity.episodeEventTimes.push(event.record.created_at);
        // Updates record the state they started from as "care setting/pathway/priority".
        const stateBefore = String(event.record.previous_state ?? "").split("/");
        const pathwayBefore = canonicalOption(stateBefore[1], PATHWAYS);
        if (
          event.record.action === "episode-updated" &&
          stateBefore.length === 3 &&
          pathwayBefore &&
          pathwayBefore !== "or-booking"
        ) {
          activity.movedOffBookingTimes.push(event.record.created_at);
        }
      }
      for (const procedure of unfinished) {
        const message = unfinishedProcedureMessage(
          procedure.record,
          episodeById.get(procedure.record.episode_id)?.record,
          activityOf(procedure.record.episode_id)
        );
        if (!message) continue;
        unfinishedProcedurePaths.add(procedure.path);
        issues.push({
          code: "unfinished-procedure",
          severity: "warning",
          message,
          recordId: procedure.record.id,
          path: procedure.path
        });
      }
    }
    // Event writes never fail the clinical action; the cost of that choice is
    // that a lost event must be found here, or it is lost silently forever.
    for (const list of [patients, episodes, tasks, procedures] as const) {
      for (const item of list) {
        if (eventTargets.has(item.record.id) || unfinishedProcedurePaths.has(item.path)) continue;
        issues.push({
          code: "missing-audit-event",
          severity: "warning",
          message: "This record has no audit trail entry. An audit note write may have failed; the record itself is intact.",
          recordId: item.record.id,
          path: item.path
        });
      }
    }
    // Zero events is one failure mode; a lost transition event is another. A
    // closed record whose trail exists but lacks its closure entry means an
    // audit write failed mid-workflow — found here while still traceable.
    const expectClosure = (
      id: string,
      path: string,
      closed: boolean,
      action: string,
      description: string
    ): void => {
      const actions = actionsByTarget.get(id);
      if (!closed || !actions || actions.has(action)) return;
      issues.push({
        code: "missing-transition-event",
        severity: "warning",
        message: `This record is ${description} but its audit trail has no matching entry. An audit note write may have failed; the record itself is intact.`,
        recordId: id,
        path
      });
    };
    for (const task of tasks) {
      expectClosure(task.record.id, task.path, task.record.status === "completed", "task-completed", "completed");
      expectClosure(task.record.id, task.path, task.record.status === "cancelled", "task-cancelled", "cancelled");
    }
    for (const episode of episodes) {
      expectClosure(episode.record.id, episode.path, episode.record.status === "archived", "episode-archived", "archived");
    }
    for (const patient of patients) {
      expectClosure(patient.record.id, patient.path, Boolean(patient.record.merged_into), "patient-merged", "merged");
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
