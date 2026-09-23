import type {
  ArchiveEpisodeOptions,
  CompleteProcedureInput,
  EpisodeRecord,
  EpisodeUpdateInput,
  MergePreview,
  NewEpisodeInput,
  NewTaskInput,
  PatientIdentityInput,
  PatientRecord,
  Priority,
  ProcedureRecord,
  RecordWithPath,
  TaskRecord
} from "../domain/types";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES, TASK_TYPES } from "../domain/types";
import {
  createId,
  formatLocalDateTime,
  isIsoDate,
  isoDateWithOffset,
  mrnMatchKey,
  normalizeIsoDate,
  todayIso,
  mrnStatus,
  normalizeComparable,
  normalizeMrn,
  normalizePhone,
  normalizeText,
  nowIso,
  phoneStatus,
  procedureIdempotencyKey,
  SCHEMA_VERSION,
  searchKey,
  taskIdempotencyKey,
  taskIsOpen,
  validateNewEpisodeInput,
  validatePatientIdentityInput,
  validateProcedureInput,
  validateTaskInput
} from "../domain/schema";
import {
  canArchiveEpisode,
  canTransitionEpisode,
  canTransitionTask,
  nextOccurrenceDate,
  pathwayAfterProcedure,
  pathwayAfterRestore,
  priorityRank,
  statusAfterRestore,
  statusAfterTaskCompletion
} from "../domain/transitions";
import { wikilink } from "../data/paths";
import { ClinicalRepository } from "../data/repository";

export interface CreateEpisodeResult {
  patient: RecordWithPath<PatientRecord>;
  episode: RecordWithPath<EpisodeRecord>;
  task: RecordWithPath<TaskRecord> | null;
  reusedPatient: boolean;
  duplicateEpisode: boolean;
}

export interface CreateTaskResult {
  task: RecordWithPath<TaskRecord>;
  duplicate: boolean;
}

export type EpisodeTaskOutcome =
  | { kind: "no-action" }
  | { kind: "unchanged"; task: RecordWithPath<TaskRecord> }
  | { kind: "already-closed"; task: RecordWithPath<TaskRecord> }
  | { kind: "created"; task: RecordWithPath<TaskRecord>; superseded: number }
  /** Only the date changed, so the existing task was moved rather than replaced. */
  | { kind: "rescheduled"; task: RecordWithPath<TaskRecord>; previousDueDate: string };

export interface UpdateEpisodeResult {
  episode: RecordWithPath<EpisodeRecord>;
  task: EpisodeTaskOutcome;
  /** Open tasks whose priority was raised to match an escalated episode. */
  tasksEscalated: number;
}

export interface ReopenTaskResult extends RecordWithPath<TaskRecord> {
  /**
   * What happened to the next occurrence the completion of a recurring task
   * raised: "cancelled" when it was withdrawn, "kept" when it was changed or
   * started after it was raised and so was left open, "none" otherwise.
   */
  nextOccurrence: "cancelled" | "kept" | "none";
}

export interface ArchiveEpisodeResult extends RecordWithPath<EpisodeRecord> {
  /** Open tasks cancelled by the discharge; always 0 without cancelOpenTasks. */
  cancelledTasks: number;
}

/** Raised when a patient looks like one that already exists. */
export class PossibleDuplicatePatientError extends Error {
  constructor(readonly candidates: PatientRecord[]) {
    super("A patient with this name already exists.");
    this.name = "PossibleDuplicatePatientError";
  }
}

/**
 * Raised when the entered MRN belongs to a patient recorded under a different
 * name. A one-digit slip lands on another person's chart, so the episode is
 * not filed until the user confirms (`confirmMrnOwner`) or corrects the MRN.
 * The message is identifier-free; the stored record is for a modal only.
 */
export class MrnIdentityConflictError extends Error {
  constructor(readonly patient: PatientRecord) {
    super("This MRN is already recorded for a patient with a different name.");
    this.name = "MrnIdentityConflictError";
  }
}

/** Both names are recorded and do not match even after spelling folding. */
function namesConflict(typed: string, stored: string): boolean {
  const typedKey = searchKey(typed);
  const storedKey = searchKey(stored);
  return Boolean(typedKey && storedKey && typedKey !== storedKey);
}

export class ClinicalService {
  constructor(private readonly repository: ClinicalRepository) {}

  /** Acquires every patient merge key once in stable order to avoid lock cycles. */
  private async withPatientMergeLocks<T>(
    patientIds: string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const ids = [...new Set(patientIds)].sort((left, right) => left.localeCompare(right));
    const acquire = (index: number): Promise<T> => {
      const patientId = ids[index];
      if (!patientId) return operation();
      return this.repository.withLock(
        `patient-merge:${patientId}`,
        () => acquire(index + 1)
      );
    };
    return acquire(0);
  }

  async createEpisode(input: NewEpisodeInput): Promise<CreateEpisodeResult> {
    const errors = validateNewEpisodeInput(input);
    if (errors.length) throw new Error(errors.join(" "));

    const mrn = normalizeMrn(input.mrn);
    const patientName = normalizeText(input.patientName);
    const phone = normalizePhone(input.phone);
    const timestamp = nowIso();

    // Patient resolution is serialised on the identity, not on a file path: the
    // record being created does not exist yet, so path-keyed locking cannot
    // make the "find or create" pair atomic.
    const submittedMrnKey = mrnMatchKey(mrn);
    // The same folding key findPatientsByName matches on, so two submissions
    // that would warn about each other are also serialised against each other.
    const identityKey = submittedMrnKey || `name:${searchKey(patientName)}`;
    const resolved = await this.repository.withLock(`patient:${identityKey}`, async () => {
      if (input.existingPatientId) {
        const chosen = await this.repository.findById<PatientRecord>("patient", input.existingPatientId);
        if (!chosen) throw new Error("The selected patient was not found.");
        return { patient: chosen, reused: true, byMrn: false };
      }

      const existingPatient = mrn ? await this.repository.findPatientByMrn(mrn) : null;
      if (existingPatient) {
        // Reuse by MRN is the documented behaviour, but a typed name that
        // plainly differs is the signature of a mistyped MRN. A blank on
        // either side is the fill-in case. Phone numbers change too often
        // to be evidence either way.
        // The confirmation names the record the user was shown; Sync can
        // hand the MRN to another chart while the question is open.
        if (
          input.confirmMrnOwner !== existingPatient.record.id &&
          namesConflict(patientName, existingPatient.record.patient_name)
        ) {
          throw new MrnIdentityConflictError(existingPatient.record);
        }
        return { patient: existingPatient, reused: true, byMrn: true };
      }

      // Without a matching MRN there is no reliable key, so surface same-name
      // charts and let the caller decide rather than silently creating a
      // second one. With an MRN, only charts that have none are candidates:
      // the usual history is a name-only ED entry whose MRN arrives later,
      // and a same-name chart holding a different MRN is a different person.
      if (!input.forceNewPatient) {
        const candidates = (await this.findPatientsByName(patientName)).filter(
          (candidate) => !mrn || !mrnMatchKey(candidate.mrn)
        );
        if (candidates.length) throw new PossibleDuplicatePatientError(candidates);
      }

      return {
        patient: await this.createPatient(mrn, patientName, phone, timestamp),
        reused: false,
        byMrn: false
      };
    });

    // Every operation that can create a patient-owned record follows one lock
    // order: patient merge -> Episode lifecycle -> task/procedure. A merge uses
    // the same patient key, so it either sees and re-points the complete new
    // Episode or finishes first and makes this stale selection fail closed.
    return this.repository.withLock(`patient-merge:${resolved.patient.record.id}`, async () => {
      const currentPatient = await this.repository.findById<PatientRecord>(
        "patient",
        resolved.patient.record.id
      );
      if (!currentPatient) throw new Error("The selected patient was not found.");
      let patient: RecordWithPath<PatientRecord> = currentPatient;
      if (patient.record.merged_into || patient.record.merge_in_progress) {
        throw new Error("The patient context changed. Choose the active patient and retry.");
      }
      // A chart picked from the duplicate prompt may have been added by name
      // alone; it takes the entered MRN. One holding a different MRN may not.
      const fillMrn = Boolean(
        submittedMrnKey && input.existingPatientId && !mrnMatchKey(patient.record.mrn)
      );
      if (submittedMrnKey && !fillMrn && mrnMatchKey(patient.record.mrn) !== submittedMrnKey) {
        throw new Error("The patient identity changed. Retry the Episode selection.");
      }
      // Re-checked on the re-read record: the name can have been corrected
      // between the identity lock and this one.
      if (
        resolved.byMrn &&
        input.confirmMrnOwner !== patient.record.id &&
        namesConflict(patientName, patient.record.patient_name)
      ) {
        throw new MrnIdentityConflictError(patient.record);
      }
      if (resolved.reused) {
        patient = fillMrn
          ? await this.fillPatientMrn(patient.record.id, mrn, patientName, phone)
          : await this.reconcilePatient(patient, patientName, phone);
      }
      if (patient.record.status !== "active") {
        throw new Error("Episodes can only be created for an active patient.");
      }

      const reusedPatient = resolved.reused;
      const episodeIdentity = `${patient.record.id}|${normalizeComparable(input.caseName)}`;
      return this.repository.withLock(`episode:${episodeIdentity}`, async () => {
        const episodes = await this.repository.list<EpisodeRecord>("episode");
        const duplicate = episodes.find(
          ({ record }) =>
            record.patient_id === patient.record.id &&
            !["archived", "cancelled", "entered-in-error"].includes(record.status) &&
            normalizeComparable(record.case) === normalizeComparable(input.caseName)
        );
        if (duplicate) {
          return this.repository.withLock(`episode-state:${duplicate.record.id}`, async () => {
            const latest = await this.repository.findById<EpisodeRecord>(
              "episode",
              duplicate.record.id
            );
            if (
              !latest ||
              latest.record.patient_id !== patient.record.id ||
              ["archived", "cancelled", "entered-in-error"].includes(latest.record.status)
            ) {
              throw new Error("The episode context changed. Retry the operation.");
            }

            // The episode already exists, but a previous attempt may have
            // failed before its first task was written. A retry repairs that
            // partial result while still holding the same lifecycle lock —
            // and ONLY that. When the episode already carries open work, a
            // duplicate submission with different wording must not supersede
            // it: the user asked to create an episode, not to replace tasks,
            // and the interface reports "the existing episode was kept".
            let existingTask: RecordWithPath<TaskRecord> | null = null;
            const openForEpisode = (await this.repository.list<TaskRecord>("task"))
              .filter(({ record }) => record.episode_id === latest.record.id && taskIsOpen(record))
              .sort((a, b) =>
                String(a.record.due_date || "9999").localeCompare(String(b.record.due_date || "9999"))
              );
            if (openForEpisode.length) {
              existingTask = openForEpisode[0] ?? null;
            } else if (normalizeText(input.nextAction)) {
              const outcome = await this.reconcileEpisodeTask(
                latest,
                normalizeText(input.nextAction),
                input.dueDate,
                latest.record.pathway,
                input.priority
              );
              existingTask = "task" in outcome ? outcome.task : null;
            }
            return {
              patient,
              episode: latest,
              task: existingTask,
              reusedPatient,
              duplicateEpisode: true
            };
          });
        }

        const episodeId = createId("EPI");
        return this.repository.withLock(`episode-state:${episodeId}`, async () => {
          const latestPatient = await this.repository.findById<PatientRecord>(
            "patient",
            patient.record.id
          );
          if (
            !latestPatient ||
            latestPatient.record.status !== "active" ||
            latestPatient.record.merged_into ||
            latestPatient.record.merge_in_progress ||
            (submittedMrnKey && mrnMatchKey(latestPatient.record.mrn) !== submittedMrnKey)
          ) {
            throw new Error("The patient context changed. Choose the active patient and retry.");
          }
          patient = latestPatient;

          const episodeRecord: EpisodeRecord = {
            schema_version: SCHEMA_VERSION,
            entity: "episode",
            id: episodeId,
            created_at: timestamp,
            updated_at: timestamp,
            tags: ["clinical/episode"],
            patient_id: patient.record.id,
            patient: wikilink(patient.path, this.patientLinkLabel(patient.record)),
            case: normalizeText(input.caseName),
            care_setting: input.careSetting,
            pathway: input.pathway,
            priority: input.priority,
            status: input.pathway === "discharge-ready" ? "ready-to-close" : "active",
            next_action: normalizeText(input.nextAction),
            // The episode's due date mirrors its tracked work. The form seeds
            // today's date so the control is visible on iOS; without a next
            // action there is no task, and persisting the seed would show a
            // phantom deadline no task tracks.
            due_date: normalizeText(input.nextAction) ? input.dueDate : "",
            opened_at: timestamp,
            closed_at: "",
            outcome: "",
            pathway_before_archive: "",
            status_before_archive: ""
          };
          const episode = await this.repository.create(episodeRecord);
          await this.repository.createEvent({
            action: "episode-created",
            patientId: patient.record.id,
            episodeId,
            targetId: episodeId,
            targetEntity: "episode",
            summary: "Episode created",
            newState: `${episodeRecord.pathway}/${episodeRecord.status}`
          });

          let task: RecordWithPath<TaskRecord> | null = null;
          if (episodeRecord.next_action) {
            const createdTask = await this.createTaskUnlocked({
              patientId: patient.record.id,
              episodeId,
              task: episodeRecord.next_action,
              taskType: this.defaultTaskTypeForPathway(episodeRecord.pathway),
              priority: episodeRecord.priority,
              dueDate: episodeRecord.due_date,
              owner: ""
            });
            task = createdTask.task;
          }

          return { patient, episode, task, reusedPatient, duplicateEpisode: false };
        });
      });
    });
  }

  /**
   * Active patients whose recorded name matches, used to warn before
   * duplicating. Matched on the spelling-folded key, so a variant spelling
   * still warns; a folded match is only ever a prompt, never an automatic reuse.
   */
  async findPatientsByName(patientName: string): Promise<PatientRecord[]> {
    const name = searchKey(patientName);
    if (!name) return [];
    const patients = await this.repository.list<PatientRecord>("patient");
    return patients
      .filter(
        ({ record }) =>
          record.status !== "entered-in-error" &&
          !record.merged_into &&
          searchKey(record.patient_name) === name
      )
      .map(({ record }) => record);
  }

  private async createPatient(
    mrn: string,
    patientName: string,
    phone: string,
    timestamp: string
  ): Promise<RecordWithPath<PatientRecord>> {
    const id = createId("PAT");
    const record: PatientRecord = {
      schema_version: SCHEMA_VERSION,
      entity: "patient",
      id,
      created_at: timestamp,
      updated_at: timestamp,
      tags: ["clinical/patient"],
      mrn,
      mrn_status: mrnStatus(mrn),
      patient_name: patientName,
      phone,
      phone_status: phoneStatus(phone),
      status: "active",
      merged_into: "",
      merge_in_progress: ""
    };
    const patient = await this.repository.create(record);
    await this.repository.createEvent({
      action: "patient-created",
      patientId: id,
      targetId: id,
      targetEntity: "patient",
      summary: "Patient identity created",
      newState: "active"
    });
    return patient;
  }

  private async reconcilePatient(
    patient: RecordWithPath<PatientRecord>,
    patientName: string,
    phone: string
  ): Promise<RecordWithPath<PatientRecord>> {
    const changes: Record<string, string> = {};
    if (patientName && !patient.record.patient_name) changes.patient_name = patientName;
    if (phone && !patient.record.phone) {
      changes.phone = phone;
      changes.phone_status = "confirmed";
    }
    if (patient.record.status === "archived") changes.status = "active";
    if (!Object.keys(changes).length) return patient;
    const updated = await this.repository.update<PatientRecord>(patient.path, changes);
    if (changes.status === "active") {
      await this.repository.createEvent({
        action: "patient-reactivated",
        patientId: patient.record.id,
        targetId: patient.record.id,
        targetEntity: "patient",
        summary: "Patient reactivated by a new episode",
        previousState: "archived",
        newState: "active"
      });
    }
    return updated;
  }

  /**
   * Records the entered MRN on a chart first added without one, then
   * reconciles it like any reused patient. Caller must hold the patient-merge
   * lock; the identity and MRN locks follow in updatePatientIdentity's order,
   * so two concurrent submissions cannot give two charts the same MRN.
   */
  private async fillPatientMrn(
    patientId: string,
    mrn: string,
    patientName: string,
    phone: string
  ): Promise<RecordWithPath<PatientRecord>> {
    return this.repository.withLock(`patient-identity:${patientId}`, () =>
      this.repository.withLock(`patient:${mrnMatchKey(mrn)}`, async () => {
        const latest = await this.repository.findById<PatientRecord>("patient", patientId);
        if (
          !latest ||
          latest.record.status === "entered-in-error" ||
          Boolean(latest.record.merged_into) ||
          Boolean(latest.record.merge_in_progress)
        ) {
          throw new Error("The patient context changed. Choose the active patient and retry.");
        }
        // A retry, or another device, may already have recorded it.
        if (mrnMatchKey(latest.record.mrn)) {
          if (mrnMatchKey(latest.record.mrn) !== mrnMatchKey(mrn)) {
            throw new Error("The patient identity changed. Retry the Episode selection.");
          }
          return this.reconcilePatient(latest, patientName, phone);
        }
        const clash = await this.repository.findPatientByMrn(mrn);
        if (clash && clash.record.id !== patientId) {
          throw new Error("Another patient already has this MRN. Merge the two records instead.");
        }
        const filled = await this.repository.update<PatientRecord>(latest.path, {
          mrn,
          mrn_status: mrnStatus(mrn)
        });
        await this.repository.createEvent({
          action: "patient-identity-updated",
          patientId,
          targetId: patientId,
          targetEntity: "patient",
          summary: "MRN recorded for a patient first added without one",
          previousState: "mrn missing",
          newState: "mrn recorded"
        });
        return this.reconcilePatient(filled, patientName, phone);
      })
    );
  }

  async createTask(input: NewTaskInput): Promise<CreateTaskResult> {
    return this.repository.withLock(`patient-merge:${input.patientId}`, () =>
      this.repository.withLock(
        `episode-state:${input.episodeId}`,
        () => this.createTaskUnlocked(input)
      )
    );
  }

  /** Caller must hold the patient-merge lock, then the Episode lifecycle lock. */
  private async createTaskUnlocked(input: NewTaskInput): Promise<CreateTaskResult> {
    const errors = validateTaskInput(input);
    if (errors.length) throw new Error(errors.join(" "));
    const patient = await this.repository.findById<PatientRecord>("patient", input.patientId);
    const episode = await this.repository.findById<EpisodeRecord>("episode", input.episodeId);
    if (!patient || !episode) throw new Error("The linked patient or episode was not found.");
    if (
      patient.record.status !== "active" ||
      Boolean(patient.record.merged_into) ||
      Boolean(patient.record.merge_in_progress)
    ) {
      throw new Error("Tasks can only be added to an active patient.");
    }
    if (["archived", "cancelled", "entered-in-error"].includes(episode.record.status)) {
      throw new Error("Tasks can only be added to an active episode.");
    }
    // The episode owns the patient relationship. Accepting a mismatched pair
    // would file work under one patient while it belongs to another.
    if (episode.record.patient_id !== patient.record.id) {
      throw new Error("That episode does not belong to the selected patient.");
    }

    const idempotencyKey = taskIdempotencyKey(input);

    // Check and write together, so two concurrent submissions cannot both pass
    // the duplicate check before either has written its record.
    const normalizedTask = normalizeComparable(input.task);
    const normalizedDueDate = normalizeText(input.dueDate);
    const result = await this.repository.withLock(`task:${input.episodeId}:${idempotencyKey}`, async () => {
      const tasks = await this.repository.list<TaskRecord>("task");
      const duplicate = tasks.find(
        ({ record }) =>
          record.episode_id === input.episodeId &&
          record.idempotency_key === idempotencyKey &&
          normalizeComparable(record.task) === normalizedTask &&
          normalizeText(record.due_date) === normalizedDueDate &&
          taskIsOpen(record)
      );
      if (duplicate) return { task: duplicate, duplicate: true };

      const timestamp = nowIso();
      const record: TaskRecord = {
        schema_version: SCHEMA_VERSION,
        entity: "task",
        id: createId("TSK"),
        created_at: timestamp,
        updated_at: timestamp,
        tags: ["clinical/task"],
        patient_id: patient.record.id,
        patient: wikilink(patient.path, this.patientLinkLabel(patient.record)),
        episode_id: episode.record.id,
        episode: wikilink(episode.path, episode.record.case),
        task: normalizeText(input.task),
        task_type: input.taskType,
        status: "open",
        priority: input.priority,
        due_date: input.dueDate,
        owner: normalizeText(input.owner),
        completed_at: "",
        cancelled_at: "",
        cancel_reason: "",
        repeat_every_days: input.repeatEveryDays ?? 0,
        idempotency_key: idempotencyKey
      };
      return { task: await this.repository.create(record), duplicate: false };
    });

    // The episode points at its most imminent outstanding task, not at whichever
    // was added last. Tracking the last one made "the task this episode raised"
    // ambiguous, so rescheduling could cancel a repeat the clinician had
    // deliberately scheduled for later. Priority is left alone entirely: it is a
    // judgement about the patient, not a property of the newest task.
    //
    // This block also runs for a duplicate: an earlier attempt can have
    // created the task and then failed before this pointer was written, and
    // the retry is the only chance to repair it. The update is idempotent.
    const imminent = (await this.imminentOpenTask(episode.record.id)) ?? result.task;
    await this.repository.update<EpisodeRecord>(episode.path, {
      next_action: imminent.record.task,
      due_date: imminent.record.due_date,
      status: episode.record.status === "ready-to-close" ? "active" : episode.record.status
    });
    if (result.duplicate) return result;
    await this.repository.createEvent({
      action: "task-created",
      patientId: patient.record.id,
      episodeId: episode.record.id,
      targetId: result.task.record.id,
      targetEntity: "task",
      summary: "Task created",
      newState: result.task.record.status
    });
    return result;
  }

  /**
   * The open task an episode's next action and due date mirror: soonest due
   * first, undated last. One definition, so every writer agrees on it.
   */
  private async imminentOpenTask(episodeId: string): Promise<RecordWithPath<TaskRecord> | undefined> {
    return (await this.repository.list<TaskRecord>("task"))
      .filter(({ record }) => record.episode_id === episodeId && taskIsOpen(record))
      .sort((a, b) => String(a.record.due_date || "9999").localeCompare(String(b.record.due_date || "9999")))[0];
  }

  async completeTask(taskId: string): Promise<RecordWithPath<TaskRecord>> {
    return this.withTaskTransitionLocks(
      taskId,
      (task) => this.completeTaskUnlocked(task)
    );
  }

  /** Caller must hold patient, Episode, and task-state locks in that order. */
  private async completeTaskUnlocked(
    task: RecordWithPath<TaskRecord>
  ): Promise<RecordWithPath<TaskRecord>> {
    if (!taskIsOpen(task.record)) {
      // An earlier attempt may have closed the task and then failed before
      // the episode was reconciled. This retry is the only chance to repair
      // that pointer; the reconcile is idempotent when nothing is owed.
      await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, task.record.id);
      return task;
    }

    // A recurring task raises its next occurrence BEFORE this one closes.
    // A crash between the two writes leaves both visible; the retry then
    // converges through the duplicate check instead of losing the repeat.
    // Cancelling deliberately breaks the chain — only completion recurs.
    // The next date keeps the series' cadence but is never in the past, so
    // a late completion does not raise an occurrence that is already
    // overdue. A retry on the same day computes the same date.
    const interval = task.record.repeat_every_days ?? 0;
    if (Number.isInteger(interval) && interval > 0 && interval <= 730) {
      const today = todayIso();
      const seed = normalizeIsoDate(task.record.due_date) || today;
      const nextInput = {
        patientId: task.record.patient_id,
        episodeId: task.record.episode_id,
        task: task.record.task,
        taskType: task.record.task_type,
        priority: task.record.priority,
        dueDate: nextOccurrenceDate(seed, interval, today),
        owner: task.record.owner,
        repeatEveryDays: interval
      };
      // A hand-edited record can carry values the validators reject; the
      // completion must still succeed, and the integrity check already
      // reports the underlying field problem.
      if (!validateTaskInput(nextInput).length) {
        await this.createTaskUnlocked(nextInput);
      }
    }

    const completed = await this.repository.update<TaskRecord>(task.path, {
      status: "completed",
      completed_at: nowIso()
    });
    await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, task.record.id);
    await this.repository.createEvent({
      action: "task-completed",
      patientId: task.record.patient_id,
      episodeId: task.record.episode_id,
      targetId: task.record.id,
      targetEntity: "task",
      summary: "Task completed",
      previousState: task.record.status,
      newState: "completed"
    });
    return completed;
  }

  /**
   * Cancels an open task. Without this an episode whose task cannot be
   * completed — because its note was renamed, or the work is no longer
   * relevant — can never be archived.
   */
  async cancelTask(taskId: string, reason: string): Promise<RecordWithPath<TaskRecord>> {
    return this.withTaskTransitionLocks(
      taskId,
      (task) => this.cancelTaskUnlocked(task, reason)
    );
  }

  /**
   * Caller must hold patient, Episode, and task-state locks in that order.
   * `reconcile: false` is for a caller that closes several tasks and then
   * reconciles the episode once itself.
   */
  private async cancelTaskUnlocked(
    task: RecordWithPath<TaskRecord>,
    reason: string,
    reconcile = true
  ): Promise<RecordWithPath<TaskRecord>> {
    if (!taskIsOpen(task.record)) {
      // Same partial-failure repair as completion: a closed task whose
      // episode still points at it is reconciled on retry.
      if (reconcile) await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, task.record.id);
      return task;
    }
    if (!canTransitionTask(task.record.status, "cancelled")) {
      throw new Error(`A ${task.record.status} task cannot be cancelled.`);
    }

    const cancelled = await this.repository.update<TaskRecord>(task.path, {
      status: "cancelled",
      cancelled_at: nowIso(),
      cancel_reason: normalizeText(reason) || "Cancelled by user"
    });
    if (reconcile) await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, task.record.id);
    await this.repository.createEvent({
      action: "task-cancelled",
      patientId: task.record.patient_id,
      episodeId: task.record.episode_id,
      targetId: task.record.id,
      targetEntity: "task",
      summary: "Task cancelled",
      previousState: task.record.status,
      newState: "cancelled"
    });
    return cancelled;
  }

  /**
   * Moves an open task to a new date. The idempotency key names (episode,
   * task, due date), so it moves with the date — duplicate suppression must
   * keep matching the fields it hashes. The episode pointer follows.
   */
  async rescheduleTask(taskId: string, dueDate: string): Promise<RecordWithPath<TaskRecord>> {
    return this.withTaskTransitionLocks(taskId, (task) => this.rescheduleTaskUnlocked(task, dueDate));
  }

  /** Caller must hold patient, Episode, and task-state locks in that order. */
  private async rescheduleTaskUnlocked(
    task: RecordWithPath<TaskRecord>,
    dueDate: string
  ): Promise<RecordWithPath<TaskRecord>> {
    if (!taskIsOpen(task.record)) {
      throw new Error(`A ${task.record.status} task cannot be rescheduled.`);
    }
    const normalized = normalizeIsoDate(dueDate);
    if (!normalized) throw new Error("Due date is invalid.");
    if (normalizeText(task.record.due_date) === normalized) return task;
    const previousDueDate = task.record.due_date;
    const updated = await this.repository.update<TaskRecord>(task.path, {
      due_date: normalized,
      idempotency_key: taskIdempotencyKey({
        episodeId: task.record.episode_id,
        task: task.record.task,
        dueDate: normalized
      })
    });
    await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, "");
    await this.repository.createEvent({
      action: "task-rescheduled",
      patientId: task.record.patient_id,
      episodeId: task.record.episode_id,
      targetId: task.record.id,
      targetEntity: "task",
      summary: "Task rescheduled",
      previousState: previousDueDate || "no date",
      newState: normalized
    });
    return updated;
  }

  /**
   * Returns a closed task to the open list. Completion can be a mis-tap;
   * without this the only correction was raising a duplicate. The reopen is
   * audited, so the trail shows both the closure and the correction.
   */
  async reopenTask(taskId: string): Promise<ReopenTaskResult> {
    return this.withTaskTransitionLocks(taskId, async (task) => {
      if (taskIsOpen(task.record)) return { ...task, nextOccurrence: "none" };
      if (!canTransitionTask(task.record.status, "open")) {
        throw new Error(`A ${task.record.status} task cannot be reopened.`);
      }
      const episode = await this.repository.findById<EpisodeRecord>(
        "episode",
        task.record.episode_id
      );
      if (!episode || ["archived", "cancelled", "entered-in-error"].includes(episode.record.status)) {
        throw new Error("Restore the episode before reopening its tasks.");
      }
      // Withdrawn before the reopen, so a retry after a failure in between
      // still finds the task closed and converges instead of skipping this.
      const nextOccurrence =
        task.record.status === "completed" ? await this.withdrawNextOccurrence(task) : "none";
      const reopened = await this.repository.update<TaskRecord>(task.path, {
        status: "open",
        completed_at: "",
        cancelled_at: "",
        cancel_reason: ""
      });
      await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, "");
      // Newly outstanding work reactivates a ready-to-close episode; the
      // reconcile alone leaves the status where it was.
      const latestEpisode = await this.repository.findById<EpisodeRecord>(
        "episode",
        task.record.episode_id
      );
      if (latestEpisode && latestEpisode.record.status === "ready-to-close") {
        await this.repository.update<EpisodeRecord>(latestEpisode.path, { status: "active" });
      }
      await this.repository.createEvent({
        action: "task-reopened",
        patientId: task.record.patient_id,
        episodeId: task.record.episode_id,
        targetId: task.record.id,
        targetEntity: "task",
        summary: "Task reopened",
        previousState: task.record.status,
        newState: "open"
      });
      return { ...reopened, nextOccurrence };
    });
  }

  /**
   * Completing a recurring task raised its next occurrence; undoing the
   * completion withdraws it, or the series would run twice. The occurrence is
   * found by its idempotency key (episode, wording, next date) and cancelled
   * only while nobody has touched it: one that was changed or started is the
   * clinician's work, so it stays open and the caller is told.
   *
   * Caller must hold patient, Episode, and task-state locks in that order.
   */
  private async withdrawNextOccurrence(
    task: RecordWithPath<TaskRecord>
  ): Promise<ReopenTaskResult["nextOccurrence"]> {
    const interval = task.record.repeat_every_days ?? 0;
    if (!Number.isInteger(interval) || interval <= 0 || interval > 730) return "none";
    // The date the completion used as "today", in the device's local time
    // exactly as todayIso() had it; the stored timestamp is UTC.
    const completedDay = normalizeIsoDate(formatLocalDateTime(task.record.completed_at).slice(0, 10));
    const seed = normalizeIsoDate(task.record.due_date) || completedDay || todayIso();
    const candidates = [
      ...new Set([
        nextOccurrenceDate(seed, interval, completedDay || todayIso()),
        // Completions recorded before the roll-forward raised this date.
        isoDateWithOffset(interval, seed)
      ])
    ];
    const tasks = await this.repository.list<TaskRecord>("task");
    const wording = normalizeComparable(task.record.task);
    const untouched = (record: TaskRecord): boolean =>
      record.status === "open" &&
      record.updated_at === record.created_at &&
      record.patient_id === task.record.patient_id &&
      record.task_type === task.record.task_type &&
      record.priority === task.record.priority &&
      normalizeText(record.owner) === normalizeText(task.record.owner) &&
      (record.repeat_every_days ?? 0) === interval;
    for (const dueDate of candidates) {
      const key = taskIdempotencyKey({ episodeId: task.record.episode_id, task: task.record.task, dueDate });
      const successor = tasks.find(
        ({ record }) =>
          record.id !== task.record.id &&
          record.episode_id === task.record.episode_id &&
          record.idempotency_key === key &&
          normalizeComparable(record.task) === wording &&
          normalizeText(record.due_date) === dueDate &&
          taskIsOpen(record)
      );
      if (!successor) continue;
      if (!untouched(successor.record)) return "kept";
      const id = successor.record.id;
      return this.repository.withLock(`task-state:${id}`, async (): Promise<ReopenTaskResult["nextOccurrence"]> => {
        const latest = await this.repository.findById<TaskRecord>("task", id);
        if (!latest || !taskIsOpen(latest.record)) return "none";
        if (latest.record.episode_id !== task.record.episode_id || !untouched(latest.record)) {
          return "kept";
        }
        // No reconcile here: the task being reopened is still completed, so
        // the episode would briefly look finished (ready to close, losing an
        // on-hold status). reopenTask reconciles once it is open again.
        await this.cancelTaskUnlocked(latest, "Completion undone", false);
        return "cancelled";
      });
    }
    return "none";
  }

  /** Serializes public task transitions with every competing Episode write. */
  private async withTaskTransitionLocks<T>(
    taskId: string,
    operation: (task: RecordWithPath<TaskRecord>) => Promise<T>
  ): Promise<T> {
    const observed = await this.repository.findById<TaskRecord>("task", taskId);
    if (!observed) throw new Error("Task was not found.");
    const expectedPatientId = observed.record.patient_id;
    const expectedEpisodeId = observed.record.episode_id;
    return this.repository.withLock(`patient-merge:${expectedPatientId}`, () =>
      this.repository.withLock(`episode-state:${expectedEpisodeId}`, () =>
        this.repository.withLock(`task-state:${taskId}`, async () => {
          const [task, episode, patient] = await Promise.all([
            this.repository.findById<TaskRecord>("task", taskId),
            this.repository.findById<EpisodeRecord>("episode", expectedEpisodeId),
            this.repository.findById<PatientRecord>("patient", expectedPatientId)
          ]);
          if (
            !task ||
            !episode ||
            task.record.patient_id !== expectedPatientId ||
            task.record.episode_id !== expectedEpisodeId ||
            episode.record.patient_id !== expectedPatientId
          ) {
            throw new Error("The task context changed. Retry the operation.");
          }
          if (
            !patient ||
            patient.record.status === "entered-in-error" ||
            Boolean(patient.record.merged_into) ||
            Boolean(patient.record.merge_in_progress)
          ) {
            throw new Error("Tasks cannot be changed while the patient is involved in a merge.");
          }
          return operation(task);
        })
      )
    );
  }

  /** Points the episode at its next outstanding task, or marks it ready to close. */
  private async reconcileEpisodeAfterTaskChange(episodeId: string, closedTaskId: string): Promise<void> {
    const tasks = (await this.repository.list<TaskRecord>("task")).map((item) => item.record);
    const nextStatus = statusAfterTaskCompletion(tasks, episodeId, closedTaskId);
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) return;
    const remaining = tasks
      .filter((item) => item.episode_id === episodeId && item.id !== closedTaskId && taskIsOpen(item))
      .sort((a, b) => String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")));
    const first = remaining[0];
    const proposedStatus = nextStatus ?? episode.record.status;
    const terminal = ["archived", "cancelled", "entered-in-error"].includes(episode.record.status);
    const status =
      !terminal && canTransitionEpisode(episode.record.status, proposedStatus)
        ? proposedStatus
        : episode.record.status;
    await this.repository.update<EpisodeRecord>(episode.path, {
      status,
      next_action: first?.task ?? "",
      due_date: first?.due_date ?? ""
    });
  }

  async updateEpisode(episodeId: string, input: EpisodeUpdateInput): Promise<UpdateEpisodeResult> {
    const observed = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!observed) throw new Error("Episode was not found.");
    const expectedPatientId = observed.record.patient_id;
    return this.repository.withLock(`patient-merge:${expectedPatientId}`, () =>
      this.repository.withLock(`episode-state:${episodeId}`, async () => {
        const [latestEpisode, latestPatient] = await Promise.all([
          this.repository.findById<EpisodeRecord>("episode", episodeId),
          this.repository.findById<PatientRecord>("patient", expectedPatientId)
        ]);
        if (!latestEpisode || latestEpisode.record.patient_id !== expectedPatientId) {
          throw new Error("The patient context changed. Retry the operation.");
        }
        if (
          !latestPatient ||
          latestPatient.record.status !== "active" ||
          Boolean(latestPatient.record.merged_into) ||
          Boolean(latestPatient.record.merge_in_progress)
        ) {
          throw new Error("Episodes can only be updated for an active patient.");
        }
        return this.updateEpisodeUnlocked(episodeId, input);
      })
    );
  }

  /** Caller must hold the patient-merge lock, then the Episode lifecycle lock. */
  private async updateEpisodeUnlocked(
    episodeId: string,
    input: EpisodeUpdateInput
  ): Promise<UpdateEpisodeResult> {
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) throw new Error("Episode was not found.");
    if (["archived", "cancelled", "entered-in-error"].includes(episode.record.status)) {
      throw new Error("Restore this episode before changing its pathway.");
    }
    // The form was seeded from a snapshot. If the record changed since —
    // another device, Sync, a hand edit — saving would silently revert
    // fields the user never touched. Refuse and let them re-open the form.
    if (input.expectedUpdatedAt && episode.record.updated_at !== input.expectedUpdatedAt) {
      throw new Error(
        "This episode changed after the form was opened. Close the form, review the current values, and retry."
      );
    }
    // Every check precedes the first write: rejecting the task after the
    // episode has been updated would leave a half-applied plan.
    const nextAction = normalizeText(input.nextAction);
    if (input.dueDate && !isIsoDate(input.dueDate)) throw new Error("Due date is invalid.");
    if (!CARE_SETTINGS.includes(input.careSetting)) throw new Error("Care setting is not recognised.");
    if (!PATHWAYS.includes(input.pathway)) throw new Error("Pathway is not recognised.");
    if (!PRIORITIES.includes(input.priority)) throw new Error("Priority is not recognised.");
    if (
      ["opd-follow-up", "result-review", "consultation"].includes(input.pathway) &&
      (!nextAction || !input.dueDate)
    ) {
      throw new Error("Next action and due date are required for this pathway.");
    }

    // Only the discharge-ready pathway implies a status change. Anything else
    // leaves the status alone, so an on-hold episode is not silently reactivated.
    const status =
      input.pathway === "discharge-ready"
        ? "ready-to-close"
        : episode.record.status === "ready-to-close" && nextAction
          ? "active"
          : episode.record.status;

    // Priority, next action and due date are written last. The next action and
    // due date mirror whatever tasks reconciliation leaves open, not the form;
    // and while the episode still carries its old priority, repeating an
    // interrupted save repeats the task escalation below instead of skipping it.
    await this.repository.update<EpisodeRecord>(episode.path, {
      care_setting: input.careSetting,
      pathway: input.pathway,
      status
    });

    // Task handling here has to satisfy three things at once: re-saving the
    // sheet unchanged must not resurrect completed work; changing the plan must
    // not leave the superseded task open; and a request that cannot produce a
    // task must say so rather than vanish.
    const outcome = await this.reconcileEpisodeTask(
      episode,
      nextAction,
      input.dueDate,
      input.pathway,
      input.priority
    );
    // Escalating the patient must reach the work: a routine task on an
    // emergency episode is missed by the priority filter and sorts last.
    // Only raised, never lowered — a task may carry its own higher priority.
    const tasksEscalated =
      priorityRank(input.priority) > priorityRank(episode.record.priority)
        ? await this.raiseOpenTaskPriorities(episode, input.priority)
        : 0;
    // `discharge-ready` is only a proposed pathway. Reconciliation can keep
    // an existing task open (including one that was not raised by this form)
    // or create a new one. In either case the episode is still active work,
    // so it must not remain ready-to-close. Re-read after reconciliation both
    // to enforce that invariant and to return the record that actually won the
    // nested task update rather than the stale pre-reconcile snapshot. With
    // nothing open, next action and due date are cleared: a date no task
    // tracks is a phantom deadline, and a closed task is not a next step.
    const imminent = await this.imminentOpenTask(episodeId);
    const current = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!current) throw new Error("Episode was not found after updating its tasks.");
    const finalEpisode = await this.repository.update<EpisodeRecord>(current.path, {
      priority: input.priority,
      next_action: imminent?.record.task ?? "",
      due_date: imminent?.record.due_date ?? "",
      status: current.record.status === "ready-to-close" && imminent ? "active" : current.record.status
    });
    await this.repository.createEvent({
      action: "episode-updated",
      patientId: episode.record.patient_id,
      episodeId,
      targetId: episodeId,
      targetEntity: "episode",
      summary: "Care setting, pathway or priority updated",
      previousState: `${episode.record.care_setting}/${episode.record.pathway}/${episode.record.priority}`,
      newState: `${input.careSetting}/${input.pathway}/${input.priority}`
    });
    return { episode: finalEpisode, task: outcome, tasksEscalated };
  }

  /**
   * Raises every open task on the episode that ranks below `priority` to it,
   * one audited change per task. Returns how many were raised.
   *
   * Caller must hold the patient-merge lock, then the Episode lifecycle lock.
   */
  private async raiseOpenTaskPriorities(
    episode: RecordWithPath<EpisodeRecord>,
    priority: Priority
  ): Promise<number> {
    const target = priorityRank(priority);
    const lower = (await this.repository.list<TaskRecord>("task")).filter(
      ({ record }) =>
        record.episode_id === episode.record.id &&
        taskIsOpen(record) &&
        priorityRank(record.priority) < target
    );
    let raised = 0;
    for (const item of lower) {
      const changed = await this.repository.withLock(`task-state:${item.record.id}`, async () => {
        const latest = await this.repository.findById<TaskRecord>("task", item.record.id);
        // A task filed under another chart is reported by the integrity
        // check; changing it here would act on the wrong patient's work.
        if (
          !latest ||
          !taskIsOpen(latest.record) ||
          latest.record.episode_id !== episode.record.id ||
          latest.record.patient_id !== episode.record.patient_id ||
          priorityRank(latest.record.priority) >= target
        ) {
          return false;
        }
        await this.repository.update<TaskRecord>(latest.path, { priority });
        await this.repository.createEvent({
          action: "task-priority-raised",
          patientId: latest.record.patient_id,
          episodeId: episode.record.id,
          targetId: latest.record.id,
          targetEntity: "task",
          summary: "Task priority raised with its episode",
          previousState: latest.record.priority,
          newState: priority
        });
        return true;
      });
      if (changed) raised += 1;
    }
    return raised;
  }

  /**
   * Brings the episode's open task into line with its next action.
   *
   * Returns what happened so the interface can say so. Silently doing nothing
   * is the one option not available: a clinician who types a next action and
   * sees no task has been misled.
   */
  private async reconcileEpisodeTask(
    episode: RecordWithPath<EpisodeRecord>,
    nextAction: string,
    dueDate: string,
    pathway: EpisodeRecord["pathway"],
    // Passed explicitly: the episode record in hand predates this save, so
    // reading priority from it would write the previous value back.
    priority: EpisodeRecord["priority"]
  ): Promise<EpisodeTaskOutcome> {
    if (!nextAction) {
      // Clearing the field must not leave the card claiming there is nothing to
      // do while a task is still open. Point it at the work that remains.
      const remaining = (await this.repository.list<TaskRecord>("task"))
        .filter(({ record }) => record.episode_id === episode.record.id && taskIsOpen(record))
        .sort((a, b) =>
          String(a.record.due_date || "9999").localeCompare(String(b.record.due_date || "9999"))
        );
      const first = remaining[0];
      if (first) {
        await this.repository.update<EpisodeRecord>(episode.path, {
          next_action: first.record.task,
          due_date: first.record.due_date
        });
        return { kind: "unchanged", task: first };
      }
      return { kind: "no-action" };
    }

    const key = taskIdempotencyKey({ episodeId: episode.record.id, task: nextAction, dueDate });
    const tasks = await this.repository.list<TaskRecord>("task");
    const forEpisode = tasks.filter(({ record }) => record.episode_id === episode.record.id);

    // The key is a 32-bit hash and the note is user-editable, so a stored key
    // can name fields the note no longer carries. Every key match here also
    // compares the underlying fields — the same predicate createTaskUnlocked
    // uses — so a hand-edited or colliding task is never mistaken for the one
    // the plan raised.
    const requestedTask = normalizeComparable(nextAction);
    const requestedDueDate = normalizeText(dueDate);
    const matchesRequested = (record: TaskRecord): boolean =>
      record.idempotency_key === key &&
      normalizeComparable(record.task) === requestedTask &&
      normalizeText(record.due_date) === requestedDueDate;

    const openMatch = forEpisode.find(({ record }) => matchesRequested(record) && taskIsOpen(record));
    if (openMatch) return { kind: "unchanged", task: openMatch };

    const closedMatch = forEpisode.find(({ record }) => matchesRequested(record));
    if (closedMatch) {
      // The identical task was already completed or cancelled. Recreating it is
      // what the earlier duplicate bug did; pretending nothing was asked for is
      // what the fix did. Neither is right, so report it and let the user
      // decide whether to re-raise it explicitly.
      return { kind: "already-closed", task: closedMatch };
    }

    // The plan changed: close the task the previous next action named, so the
    // episode carries one live task rather than an accumulating pile.
    // Identified by idempotency key, not by wording. The key folds in the due
    // date, so it names exactly the task the episode's previous next action
    // mirrored — and leaves alone a repeat of the same wording on another
    // date, which the clinician scheduled deliberately with "+ Task".
    const previousAction = normalizeComparable(episode.record.next_action);
    const previousDueDate = normalizeText(episode.record.due_date);
    const previousKey = normalizeText(episode.record.next_action)
      ? taskIdempotencyKey({
          episodeId: episode.record.id,
          task: episode.record.next_action,
          dueDate: episode.record.due_date
        })
      : null;
    // Field equality again: a task whose note was re-worded after creation
    // still carries the old key, and cancelling it here would destroy work
    // the clinician deliberately kept.
    const superseded = previousKey
      ? forEpisode.filter(
          ({ record }) =>
            taskIsOpen(record) &&
            record.idempotency_key === previousKey &&
            normalizeComparable(record.task) === previousAction &&
            normalizeText(record.due_date) === previousDueDate
        )
      : [];
    const replaced = superseded[0];

    // The previous next action mirrors the soonest open task of any origin,
    // including a repeating or owned one added with "+ Task". When only its
    // date changed, move that task: replacing it would end its series and
    // drop its type and owner. Clearing the date still replaces it, because a
    // repeating task needs a date to schedule from.
    if (superseded.length === 1 && replaced && requestedTask === previousAction && normalizeIsoDate(dueDate)) {
      const previousDueDate = replaced.record.due_date;
      const moved = await this.repository.withLock(`task-state:${replaced.record.id}`, async () => {
        const latest = await this.repository.findById<TaskRecord>("task", replaced.record.id);
        if (!latest) throw new Error("The task being rescheduled was not found.");
        if (
          latest.record.patient_id !== episode.record.patient_id ||
          latest.record.episode_id !== episode.record.id
        ) {
          throw new Error("The task context changed. Retry the operation.");
        }
        return this.rescheduleTaskUnlocked(latest, dueDate);
      });
      return { kind: "rescheduled", task: moved, previousDueDate };
    }

    // The wording changed, but the replacement is the same piece of work:
    // it keeps the type, the owner and the repeat series, unless the pathway
    // changed too. Then it is new work: a stale "book-or" type would be
    // auto-completed by the next procedure, and a carried repeat would raise
    // that pathway's default task again straight after. A repeat needs a
    // date to schedule from.
    const sameWork = replaced && pathway === episode.record.pathway ? replaced : undefined;
    const carriedType =
      sameWork && TASK_TYPES.includes(sameWork.record.task_type)
        ? sameWork.record.task_type
        : this.defaultTaskTypeForPathway(pathway);
    const carriedRepeat = sameWork?.record.repeat_every_days ?? 0;
    // Create first, cancel second. Cancelling first meant any failure in
    // createTask destroyed the outstanding work and left nothing in its place.
    const created = await this.createTaskUnlocked({
      patientId: episode.record.patient_id,
      episodeId: episode.record.id,
      task: nextAction,
      taskType: carriedType,
      priority,
      dueDate,
      owner: normalizeText(sameWork?.record.owner),
      repeatEveryDays:
        dueDate && Number.isInteger(carriedRepeat) && carriedRepeat > 0 && carriedRepeat <= 730
          ? carriedRepeat
          : 0
    });
    for (const item of superseded) {
      if (item.record.id === created.task.record.id) continue;
      await this.repository.withLock(`task-state:${item.record.id}`, async () => {
        const latest = await this.repository.findById<TaskRecord>("task", item.record.id);
        if (!latest) throw new Error("The task being replaced was not found.");
        if (
          latest.record.patient_id !== episode.record.patient_id ||
          latest.record.episode_id !== episode.record.id
        ) {
          throw new Error("The task context changed. Retry the operation.");
        }
        await this.cancelTaskUnlocked(latest, `Superseded by: ${nextAction}`);
      });
    }
    return { kind: "created", task: created.task, superseded: superseded.length };
  }

  /** Corrects a patient's recorded identity. */
  async updatePatientIdentity(
    patientId: string,
    input: PatientIdentityInput
  ): Promise<RecordWithPath<PatientRecord>> {
    const errors = validatePatientIdentityInput(input);
    if (errors.length) throw new Error(errors.join(" "));
    const mrn = normalizeMrn(input.mrn);
    const patientName = normalizeText(input.patientName);
    const phone = normalizePhone(input.phone);
    const identityKey = mrnMatchKey(mrn);

    return this.repository.withLock(`patient-merge:${patientId}`, () =>
      this.repository.withLock(`patient-identity:${patientId}`, async () => {
        const patient = await this.repository.findById<PatientRecord>("patient", patientId);
        if (!patient) throw new Error("Patient was not found.");
        if (
          patient.record.status === "entered-in-error" ||
          Boolean(patient.record.merged_into) ||
          Boolean(patient.record.merge_in_progress)
        ) {
          throw new Error("Identity can only be corrected on an unmerged patient.");
        }

        const persist = async (): Promise<RecordWithPath<PatientRecord>> => {
          const latest = await this.repository.findById<PatientRecord>("patient", patientId);
          if (!latest) throw new Error("Patient was not found.");
          if (
            latest.record.status === "entered-in-error" ||
            Boolean(latest.record.merged_into) ||
            Boolean(latest.record.merge_in_progress)
          ) {
            throw new Error("Identity can only be corrected on an unmerged patient.");
          }
          // The form carries a full identity snapshot; saving over a record
          // that changed since it opened would revert the other device's
          // correction without anyone noticing.
          if (input.expectedUpdatedAt && latest.record.updated_at !== input.expectedUpdatedAt) {
            throw new Error(
              "This patient record changed after the form was opened. Close the form, review the current values, and retry."
            );
          }

          if (mrn && identityKey !== mrnMatchKey(latest.record.mrn)) {
            const clash = await this.repository.findPatientByMrn(mrn);
            if (clash && clash.record.id !== patientId) {
              throw new Error("Another patient already has this MRN. Merge the two records instead.");
            }
          }

          const updated = await this.repository.update<PatientRecord>(latest.path, {
            mrn,
            mrn_status: mrnStatus(mrn),
            patient_name: patientName,
            phone,
            phone_status: phoneStatus(phone)
          });
          await this.repointPatientLinks(patientId, updated);
          await this.repository.createEvent({
            action: "patient-identity-updated",
            patientId,
            targetId: patientId,
            targetEntity: "patient",
            summary: "Patient identity corrected",
            previousState: latest.record.mrn ? "mrn recorded" : "mrn missing",
            newState: mrn ? "mrn recorded" : "mrn missing"
          });
          return updated;
        };

        // `createEpisode` uses this same normalized identity key while it
        // resolves or creates an MRN-bearing patient. It releases the key
        // before taking a patient lock, so this patient -> identity -> MRN
        // ordering cannot form a cycle with Episode creation.
        return identityKey
          ? this.repository.withLock(`patient:${identityKey}`, persist)
          : persist();
      })
    );
  }

  /** Counts what a merge would move, so the user can confirm before it runs. */
  async previewPatientMerge(sourceId: string, targetId: string): Promise<MergePreview> {
    if (sourceId === targetId) throw new Error("Select two different patients.");
    const source = await this.repository.findById<PatientRecord>("patient", sourceId);
    const target = await this.repository.findById<PatientRecord>("patient", targetId);
    if (!source || !target) throw new Error("One of the selected patients was not found.");
    if (
      target.record.status !== "active" ||
      target.record.merged_into ||
      target.record.merge_in_progress
    ) {
      throw new Error("The record selected to keep is already involved in another merge.");
    }
    const [episodes, tasks, procedures] = await Promise.all([
      this.repository.list<EpisodeRecord>("episode"),
      this.repository.list<TaskRecord>("task"),
      this.repository.list<ProcedureRecord>("procedure")
    ]);
    return {
      source: source.record,
      target: target.record,
      episodes: episodes.filter((item) => item.record.patient_id === sourceId).length,
      tasks: tasks.filter((item) => item.record.patient_id === sourceId).length,
      procedures: procedures.filter((item) => item.record.patient_id === sourceId).length
    };
  }

  /**
   * Re-points every record owned by `sourceId` at `targetId` and marks the
   * source as entered-in-error. Nothing is deleted, so a mistaken merge stays
   * auditable and the source note remains readable in the vault.
   *
   * Running it again for a merge that already finished into the same target
   * sweeps up records that still name the retired source: ones another device
   * wrote offline while the merge ran, delivered later by Sync. Such a record
   * cannot be changed or discharged until it is re-pointed, and a task left
   * naming the source disagrees with its re-pointed episode. Only records
   * still carrying the source id are touched.
   */
  async mergePatients(sourceId: string, targetId: string): Promise<RecordWithPath<PatientRecord>> {
    if (sourceId === targetId) throw new Error("Select two different patients.");
    return this.withPatientMergeLocks([sourceId, targetId], async () => {
      const source = await this.repository.findById<PatientRecord>("patient", sourceId);
      const target = await this.repository.findById<PatientRecord>("patient", targetId);
      if (!source || !target) throw new Error("One of the selected patients was not found.");
      const sweep = source.record.merged_into === targetId;
      if (source.record.merged_into && !sweep) throw new Error("This patient has already been merged.");
      if (
        target.record.status !== "active" ||
        target.record.merged_into ||
        target.record.merge_in_progress
      ) {
        throw new Error("The record selected to keep is already involved in another merge.");
      }
      if (source.record.merge_in_progress && source.record.merge_in_progress !== targetId) {
        throw new Error("This patient has an unfinished merge into a different record. Run the integrity check.");
      }

      // Persist intent before the first linked record changes. A mid-loop failure
      // is then visible to the integrity check and a retry can safely converge.
      // A sweep needs no marker: the source already names its target.
      if (!sweep && source.record.merge_in_progress !== targetId) {
        await this.repository.update<PatientRecord>(source.path, { merge_in_progress: targetId });
      }

      // Fill any identity gap in the surviving record from the one being retired.
      // A sweep skips it: the merge already filled the gaps, and the surviving
      // record may have been corrected since.
      const fill: Record<string, string> = {};
      if (!sweep && !target.record.mrn && source.record.mrn) {
        fill.mrn = source.record.mrn;
        fill.mrn_status = mrnStatus(source.record.mrn);
      }
      if (!sweep && !target.record.patient_name && source.record.patient_name) {
        fill.patient_name = source.record.patient_name;
      }
      if (!sweep && !target.record.phone && source.record.phone) {
        fill.phone = source.record.phone;
        fill.phone_status = phoneStatus(source.record.phone);
      }
      const merged = Object.keys(fill).length
        ? await this.repository.update<PatientRecord>(target.path, fill)
        : target;

      const label = this.patientLinkLabel(merged.record);
      const link = wikilink(merged.path, label);

      let repointed = 0;
      const episodes = await this.repository.list<EpisodeRecord>("episode");
      for (const episode of episodes) {
        if (episode.record.patient_id !== sourceId) continue;
        await this.repository.update<EpisodeRecord>(episode.path, { patient_id: targetId, patient: link });
        repointed += 1;
      }
      const tasks = await this.repository.list<TaskRecord>("task");
      for (const task of tasks) {
        if (task.record.patient_id !== sourceId) continue;
        await this.repository.update<TaskRecord>(task.path, { patient_id: targetId, patient: link });
        repointed += 1;
      }
      const procedures = await this.repository.list<ProcedureRecord>("procedure");
      for (const procedure of procedures) {
        if (procedure.record.patient_id !== sourceId) continue;
        await this.repository.update<ProcedureRecord>(procedure.path, { patient_id: targetId, patient: link });
        repointed += 1;
      }

      if (sweep) {
        if (repointed) {
          await this.repository.createEvent({
            action: "patient-merge-swept",
            patientId: targetId,
            targetId: sourceId,
            targetEntity: "patient",
            summary: "Records left under a merged patient re-pointed to the surviving patient",
            previousState: `merged into ${targetId}`,
            newState: `${repointed} record${repointed === 1 ? "" : "s"} re-pointed`
          });
        }
        return merged;
      }

      await this.repository.update<PatientRecord>(source.path, {
        status: "entered-in-error",
        merged_into: targetId,
        merge_in_progress: ""
      });
      await this.repository.createEvent({
        action: "patient-merged",
        patientId: targetId,
        targetId: sourceId,
        targetEntity: "patient",
        summary: "Patient record merged into another patient",
        previousState: "active",
        newState: `merged into ${targetId}`
      });
      return merged;
    });
  }

  async archiveEpisode(
    episodeId: string,
    outcome: string,
    options: ArchiveEpisodeOptions = {}
  ): Promise<ArchiveEpisodeResult> {
    const observed = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!observed) throw new Error("Episode was not found.");
    const expectedPatientId = observed.record.patient_id;
    return this.repository.withLock(`patient-merge:${expectedPatientId}`, () =>
      this.repository.withLock(`episode-state:${episodeId}`, async () => {
        const [latestEpisode, latestPatient] = await Promise.all([
          this.repository.findById<EpisodeRecord>("episode", episodeId),
          this.repository.findById<PatientRecord>("patient", expectedPatientId)
        ]);
        if (!latestEpisode || latestEpisode.record.patient_id !== expectedPatientId) {
          throw new Error("The patient context changed. Retry the operation.");
        }
        if (
          !latestPatient ||
          Boolean(latestPatient.record.merged_into) ||
          Boolean(latestPatient.record.merge_in_progress) ||
          (latestEpisode.record.status !== "archived" && latestPatient.record.status !== "active")
        ) {
          throw new Error("Episodes can only be archived for an active patient.");
        }
        return this.archiveEpisodeUnlocked(episodeId, outcome, options);
      })
    );
  }

  /** Caller must hold the patient-merge lock, then the Episode lifecycle lock. */
  private async archiveEpisodeUnlocked(
    episodeId: string,
    outcome: string,
    options: ArchiveEpisodeOptions
  ): Promise<ArchiveEpisodeResult> {
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) throw new Error("Episode was not found.");
    if (episode.record.status === "archived") return { ...episode, cancelledTasks: 0 };

    // An unreadable task note is outstanding work that `list()` cannot see.
    // Discharging past it would close an episode with live work attached, so
    // the safe default is to refuse until the note is repaired.
    const unreadable = await this.repository.unreadableRecords("task");
    const relevantUnreadable = unreadable.filter(
      ({ episodeId: unreadableEpisodeId }) =>
        unreadableEpisodeId === null || unreadableEpisodeId === episodeId
    );
    if (relevantUnreadable.length) {
      throw new Error(
        `${relevantUnreadable.length} task note${relevantUnreadable.length === 1 ? "" : "s"} could not be read and may belong to this episode, so open work cannot be confirmed. Run the clinical data integrity check and repair unreadable task notes before discharging.`
      );
    }

    const cancelledTasks = options.cancelOpenTasks
      ? await this.cancelOpenTasksForDischarge(episode)
      : 0;

    const tasks = (await this.repository.list<TaskRecord>("task")).map((item) => item.record);
    const decision = canArchiveEpisode(episode.record.status, tasks, episodeId);
    if (!decision.allowed) throw new Error(decision.reason);

    const updated = await this.repository.update<EpisodeRecord>(episode.path, {
      status: "archived",
      pathway: "discharge-ready",
      // Remember what archiving overwrote so restore can put it back.
      pathway_before_archive: episode.record.pathway,
      status_before_archive: episode.record.status,
      closed_at: nowIso(),
      outcome: normalizeText(outcome) || "Episode closed",
      next_action: "",
      due_date: ""
    });

    const otherActive = (await this.repository.list<EpisodeRecord>("episode")).some(
      ({ record }) =>
        record.patient_id === episode.record.patient_id &&
        record.id !== episodeId &&
        !["archived", "cancelled", "entered-in-error"].includes(record.status)
    );
    // An unreadable episode note is invisible to list() but may still be this
    // patient's active care. Skip the automatic patient archive until the
    // note is repaired; the episode archive itself is unaffected.
    const unreadableEpisodes = await this.repository.unreadablePaths("episode");
    if (!otherActive && unreadableEpisodes.length === 0) {
      const patient = await this.repository.findById<PatientRecord>("patient", episode.record.patient_id);
      if (patient && patient.record.status === "active") {
        await this.repository.update<PatientRecord>(patient.path, { status: "archived" });
        await this.repository.createEvent({
          action: "patient-archived",
          patientId: patient.record.id,
          targetId: patient.record.id,
          targetEntity: "patient",
          summary: "Patient archived with their last active episode",
          previousState: "active",
          newState: "archived"
        });
      }
    }
    await this.repository.createEvent({
      action: "episode-archived",
      patientId: episode.record.patient_id,
      episodeId,
      targetId: episodeId,
      targetEntity: "episode",
      summary: "Episode archived",
      previousState: episode.record.status,
      newState: "archived"
    });
    return { ...updated, cancelledTasks };
  }

  /**
   * Cancels the episode's open tasks as part of an explicitly requested
   * discharge: each through the audited cancel path, then one reconcile.
   * Nothing is archived yet, so an interruption leaves only cancelled tasks
   * and a retry converges. Returns how many tasks this call cancelled.
   *
   * Caller must hold the patient-merge lock, then the Episode lifecycle lock,
   * and must already have refused unreadable task notes.
   */
  private async cancelOpenTasksForDischarge(episode: RecordWithPath<EpisodeRecord>): Promise<number> {
    // Refuse before cancelling anything when the archive itself would be
    // refused: closing the work and then keeping the episode open helps no one.
    const transition = canArchiveEpisode(episode.record.status, [], episode.record.id);
    if (!transition.allowed) throw new Error(transition.reason);

    const open = (await this.repository.list<TaskRecord>("task")).filter(
      ({ record }) => record.episode_id === episode.record.id && taskIsOpen(record)
    );
    // Work filed under another chart is not this discharge's to close, and a
    // retry cannot change that (Sync after a merge leaves such a task). Found
    // before anything is cancelled, so the refusal leaves every task as it was.
    if (open.some(({ record }) => record.patient_id !== episode.record.patient_id)) {
      throw new Error(
        "A task on this episode is filed under a different patient, so no task was closed. Run the clinical data integrity check and repair that task, then discharge again."
      );
    }
    let cancelled = 0;
    let wrote = false;
    try {
      for (const item of open) {
        await this.repository.withLock(`task-state:${item.record.id}`, async () => {
          const latest = await this.repository.findById<TaskRecord>("task", item.record.id);
          if (!latest) throw new Error("A task being closed at discharge was not found.");
          if (
            latest.record.patient_id !== episode.record.patient_id ||
            latest.record.episode_id !== episode.record.id
          ) {
            throw new Error("The task context changed. Retry the operation.");
          }
          if (!taskIsOpen(latest.record)) return;
          wrote = true;
          await this.cancelTaskUnlocked(latest, "Closed at discharge", false);
          cancelled += 1;
        });
      }
    } finally {
      // Also when the loop stopped part-way, so the episode never keeps
      // mirroring a task this call already cancelled.
      if (wrote) await this.reconcileEpisodeAfterTaskChange(episode.record.id, "");
    }
    return cancelled;
  }

  /**
   * Returns an archived episode to service. The pathway recorded before
   * archiving is restored, and the discharge outcome is kept: it is part of the
   * episode's history, not a field to be cleared.
   */
  async restoreEpisode(episodeId: string): Promise<RecordWithPath<EpisodeRecord>> {
    const observed = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!observed) throw new Error("Episode was not found.");
    const expectedPatientId = observed.record.patient_id;
    // The same (patient, case) lock createEpisode holds while it checks for a
    // duplicate, so a restore and a new episode for that case cannot both win.
    const caseKey = normalizeComparable(observed.record.case);
    return this.repository.withLock(`patient-merge:${expectedPatientId}`, () =>
      this.repository.withLock(`episode:${expectedPatientId}|${caseKey}`, () =>
        this.repository.withLock(`episode-state:${episodeId}`, async () => {
          const [latestEpisode, latestPatient] = await Promise.all([
            this.repository.findById<EpisodeRecord>("episode", episodeId),
            this.repository.findById<PatientRecord>("patient", expectedPatientId)
          ]);
          if (!latestEpisode || latestEpisode.record.patient_id !== expectedPatientId) {
            throw new Error("The patient context changed. Retry the operation.");
          }
          if (normalizeComparable(latestEpisode.record.case) !== caseKey) {
            throw new Error("The episode context changed. Retry the operation.");
          }
          if (
            !latestPatient ||
            latestPatient.record.status === "entered-in-error" ||
            Boolean(latestPatient.record.merged_into) ||
            Boolean(latestPatient.record.merge_in_progress)
          ) {
            throw new Error("Episodes can only be restored for an unmerged patient.");
          }
          return this.restoreEpisodeUnlocked(episodeId);
        })
      )
    );
  }

  /**
   * Caller must hold the patient-merge lock, the (patient, case) episode lock,
   * then the Episode lifecycle lock.
   */
  private async restoreEpisodeUnlocked(episodeId: string): Promise<RecordWithPath<EpisodeRecord>> {
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) throw new Error("Episode was not found.");
    if (episode.record.status !== "archived") return episode;

    // createEpisode refuses a second active episode for the same case, and a
    // restore must not create one by the back door (typically after the
    // patient was readmitted under the same case).
    const caseKey = normalizeComparable(episode.record.case);
    const duplicate = (await this.repository.list<EpisodeRecord>("episode")).some(
      ({ record }) =>
        record.patient_id === episode.record.patient_id &&
        record.id !== episodeId &&
        !["archived", "cancelled", "entered-in-error"].includes(record.status) &&
        normalizeComparable(record.case) === caseKey
    );
    if (duplicate) {
      throw new Error("An active episode for this case already exists. Open it instead.");
    }

    const tasks = (await this.repository.list<TaskRecord>("task")).map((item) => item.record);
    const pathway = pathwayAfterRestore(episode.record.pathway_before_archive);
    const status = statusAfterRestore(episode.record.status_before_archive, tasks, episodeId);

    const updated = await this.repository.update<EpisodeRecord>(episode.path, {
      status,
      pathway,
      closed_at: "",
      pathway_before_archive: "",
      status_before_archive: ""
    });
    const patient = await this.repository.findById<PatientRecord>("patient", episode.record.patient_id);
    if (patient && patient.record.status === "archived") {
      await this.repository.update<PatientRecord>(patient.path, { status: "active" });
      await this.repository.createEvent({
        action: "patient-reactivated",
        patientId: patient.record.id,
        targetId: patient.record.id,
        targetEntity: "patient",
        summary: "Patient reactivated by a restored episode",
        previousState: "archived",
        newState: "active"
      });
    }
    await this.repository.createEvent({
      action: "episode-restored",
      patientId: episode.record.patient_id,
      episodeId,
      targetId: episodeId,
      targetEntity: "episode",
      summary: `Episode restored to ${pathway}`,
      previousState: "archived",
      newState: status
    });
    return updated;
  }

  async completeProcedure(input: CompleteProcedureInput): Promise<RecordWithPath<ProcedureRecord>> {
    // Every check runs before the first write. A rejection after the
    // procedure note exists leaves a partial state the clinician has no
    // reason to suspect (an impossible follow-up date used to be caught only
    // by the follow-up task validator, two writes in).
    const errors = validateProcedureInput(input);
    if (errors.length) throw new Error(errors.join(" "));

    const key = procedureIdempotencyKey(input.episodeId, input.procedure, input.procedureDate);
    const normalizedProcedure = normalizeComparable(input.procedure);
    const normalizedProcedureDate = normalizeText(input.procedureDate);

    // The modal can remain open while another local action retires its Episode.
    // Re-read and validate inside the patient -> Episode lock order that owns
    // every subsequent workflow write; the picker snapshot is never write
    // authority, and a patient merge cannot cross the linked record creation.
    // External Sync does not take these in-memory locks, so all repository
    // writes still retain their ordinary fail-closed checks.
    return this.repository.withLock(`patient-merge:${input.patientId}`, () =>
      this.repository.withLock(`episode-state:${input.episodeId}`, async () => {
      const episode = await this.repository.findById<EpisodeRecord>("episode", input.episodeId);
      const patient = await this.repository.findById<PatientRecord>("patient", input.patientId);
      if (!episode || !patient) throw new Error("The linked patient or episode was not found.");
      if (["archived", "cancelled", "entered-in-error"].includes(episode.record.status)) {
        throw new Error("Procedures can only be recorded against an active episode.");
      }
      if (
        patient.record.status !== "active" ||
        Boolean(patient.record.merged_into) ||
        Boolean(patient.record.merge_in_progress)
      ) {
        throw new Error("Procedures can only be recorded against an active patient.");
      }
      // Checked before anything is written: a logbook entry filed under the
      // wrong chart is not something a later retry can put right.
      if (episode.record.patient_id !== patient.record.id) {
        throw new Error("That episode does not belong to the selected patient.");
      }

      const procedures = await this.repository.list<ProcedureRecord>("procedure");
      const existing = procedures.find(
        ({ record }) =>
          record.episode_id === input.episodeId &&
          record.idempotency_key === key &&
          normalizeComparable(record.procedure) === normalizedProcedure &&
          normalizeText(record.procedure_date) === normalizedProcedureDate &&
          record.status === "completed"
      );
      // Another procedure from the same operation, or a return to theatre, is
      // logged on an episode whose first procedure already moved it off OR
      // booking. The logbook needs one entry per procedure, so it is accepted
      // as an addition: the pathway, status and next action the episode has
      // now stay as they are, and only a requested follow-up adds work. Also
      // decided this way on a retry, so a retry never re-runs the transition.
      const additional =
        episode.record.pathway !== "or-booking" &&
        procedures.some(
          ({ record }) =>
            record.episode_id === input.episodeId &&
            record.status === "completed" &&
            record.id !== existing?.record.id
        );
      if (!existing && !additional && episode.record.pathway !== "or-booking") {
        throw new Error("Procedures can only be recorded from an OR booking episode.");
      }
      // A retry must never silently mix persisted and retry inputs. The
      // idempotency key does not cover follow-up, so an earlier attempt may
      // have durably recorded different follow-up details than this
      // submission carries. Refuse the conflict; a matching retry resumes
      // from the persisted record below.
      if (existing) {
        const conflictingFollowUp =
          (existing.record.follow_up_required === true) !== input.followUpRequired ||
          (input.followUpRequired &&
            (normalizeText(existing.record.follow_up_date) !== normalizeText(input.followUpDate) ||
              normalizeComparable(existing.record.follow_up_plan) !== normalizeComparable(input.followUpPlan)));
        if (conflictingFollowUp) {
          throw new Error(
            "This procedure is already recorded with different follow-up details. Nothing was changed. Open the saved procedure record to review it, then either retry with the saved details or correct the saved record first."
          );
        }
      }
      // The persisted record is the write authority for every later step.
      const followUp = existing
        ? {
            required: existing.record.follow_up_required === true,
            date: existing.record.follow_up_date,
            plan: normalizeText(existing.record.follow_up_plan)
          }
        : {
            required: input.followUpRequired,
            date: input.followUpRequired ? input.followUpDate : "",
            plan: input.followUpRequired ? normalizeText(input.followUpPlan) : ""
          };
      const timestamp = nowIso();
      const outcome = existing
        ? { procedure: existing, alreadyLogged: true }
        : {
            procedure: await this.repository.create<ProcedureRecord>({
              schema_version: SCHEMA_VERSION,
              entity: "procedure",
              id: createId("PRC"),
              created_at: timestamp,
              updated_at: timestamp,
              tags: ["clinical/procedure", "clinical/surgery"],
              patient_id: patient.record.id,
              patient: wikilink(patient.path, this.patientLinkLabel(patient.record)),
              episode_id: episode.record.id,
              episode: wikilink(episode.path, episode.record.case),
              procedure: normalizeText(input.procedure),
              procedure_date: input.procedureDate,
              role: normalizeText(input.role) || "Not specified",
              status: "completed",
              outcome: normalizeText(input.outcome),
              follow_up_required: followUp.required,
              follow_up_date: followUp.date,
              follow_up_plan: followUp.plan,
              // Cleared only after the completion audit event is durably
              // written, so a retry knows the trail still owes an entry.
              audit_pending: true,
              idempotency_key: key
            }),
            alreadyLogged: false
          };

      // A previously logged procedure still runs the follow-up workflow below.
      // Returning early made a part-failed procedure permanently un-retryable:
      // the record existed, so every retry short-circuited and reported success
      // while the episode was never updated and the follow-up task never created.
      const tasks = additional ? [] : await this.repository.list<TaskRecord>("task");
      for (const task of tasks) {
        if (
          task.record.episode_id === episode.record.id &&
          task.record.task_type === "book-or" &&
          taskIsOpen(task.record)
        ) {
          await this.repository.withLock(`task-state:${task.record.id}`, async () => {
            const latest = await this.repository.findById<TaskRecord>("task", task.record.id);
            if (!latest) throw new Error("The operating-room task was not found.");
            if (
              latest.record.patient_id !== patient.record.id ||
              latest.record.episode_id !== episode.record.id
            ) {
              throw new Error("The task context changed. Retry the operation.");
            }
            await this.completeTaskUnlocked(latest);
          });
        }
      }

      // Unrelated tasks on this episode may still be open, so the episode is
      // only ready to close when nothing else is outstanding.
      const remaining = (await this.repository.list<TaskRecord>("task")).filter(
        ({ record }) => record.episode_id === episode.record.id && taskIsOpen(record)
      );
      const stillOpen = remaining.length > 0 || followUp.required;
      const nextOutstanding = remaining
        .slice()
        .sort((a, b) =>
          String(a.record.due_date || "9999").localeCompare(
            String(b.record.due_date || "9999")
          )
        )[0];

      // Sync does not participate in the in-memory lifecycle lock. Re-read
      // immediately before the final Episode transition and refuse to revive
      // a record that was retired or re-pointed after the procedure form was
      // submitted.
      const latestEpisode = await this.repository.findById<EpisodeRecord>(
        "episode",
        input.episodeId
      );
      const latestPatient = await this.repository.findById<PatientRecord>(
        "patient",
        input.patientId
      );
      if (!latestEpisode || !latestPatient) {
        throw new Error("The linked patient or episode was no longer available.");
      }
      if (["archived", "cancelled", "entered-in-error"].includes(latestEpisode.record.status)) {
        throw new Error("The episode changed while the procedure was being recorded and is no longer active.");
      }
      if (
        latestPatient.record.status !== "active" ||
        Boolean(latestPatient.record.merged_into) ||
        Boolean(latestPatient.record.merge_in_progress) ||
        latestEpisode.record.patient_id !== latestPatient.record.id
      ) {
        throw new Error("The patient context changed while the procedure was being recorded.");
      }

      // Care setting is the clinician's to decide. A post-operative inpatient
      // is still an inpatient, so it is left exactly as recorded.
      if (!additional) {
        await this.repository.update<EpisodeRecord>(latestEpisode.path, {
          pathway: pathwayAfterProcedure(followUp.required),
          status: stillOpen ? "active" : "ready-to-close",
          next_action: followUp.required
            ? followUp.plan
            : (nextOutstanding?.record.task ?? ""),
          due_date: followUp.required
            ? followUp.date
            : (nextOutstanding?.record.due_date ?? "")
        });
      }
      if (followUp.required) {
        await this.createTaskUnlocked({
          patientId: patient.record.id,
          episodeId: episode.record.id,
          task: followUp.plan,
          taskType: "postop-follow-up",
          priority: latestEpisode.record.priority,
          dueDate: followUp.date,
          owner: ""
        });
      }
      // The completion event belongs to the workflow, not to note creation.
      // A retry that finds the note but an unpaid audit debt settles it here;
      // a failed clear can at worst repeat an event, never lose one.
      const auditOwed = !outcome.alreadyLogged || outcome.procedure.record.audit_pending === true;
      if (auditOwed) {
        const event = await this.repository.createEvent({
          action: "procedure-completed",
          patientId: patient.record.id,
          episodeId: episode.record.id,
          targetId: outcome.procedure.record.id,
          targetEntity: "procedure",
          summary: "Procedure completed",
          newState: followUp.required
            ? "postoperative follow-up"
            : additional
              ? "episode unchanged"
              : "ready to close"
        });
        if (event) {
          return this.repository.update<ProcedureRecord>(outcome.procedure.path, {
            audit_pending: false
          });
        }
      }
        return outcome.procedure;
      })
    );
  }

  private patientLinkLabel(patient: PatientRecord): string {
    return patient.patient_name || patient.mrn || "Patient";
  }

  /** Keeps Bases wikilink labels aligned with a corrected patient identity. */
  private async repointPatientLinks(
    patientId: string,
    patient: RecordWithPath<PatientRecord>
  ): Promise<void> {
    const link = wikilink(patient.path, this.patientLinkLabel(patient.record));
    const [episodes, tasks, procedures] = await Promise.all([
      this.repository.list<EpisodeRecord>("episode"),
      this.repository.list<TaskRecord>("task"),
      this.repository.list<ProcedureRecord>("procedure")
    ]);
    await Promise.all([
      ...episodes
        .filter(({ record }) => record.patient_id === patientId)
        .map(({ path }) => this.repository.update<EpisodeRecord>(path, { patient: link })),
      ...tasks
        .filter(({ record }) => record.patient_id === patientId)
        .map(({ path }) => this.repository.update<TaskRecord>(path, { patient: link })),
      ...procedures
        .filter(({ record }) => record.patient_id === patientId)
        .map(({ path }) => this.repository.update<ProcedureRecord>(path, { patient: link }))
    ]);
  }

  private defaultTaskTypeForPathway(pathway: EpisodeRecord["pathway"]): TaskRecord["task_type"] {
    switch (pathway) {
      case "or-booking":
        return "book-or";
      case "opd-follow-up":
        return "clinical-review";
      case "result-review":
        return "review-result";
      case "consultation":
        return "consultation";
      default:
        return "other";
    }
  }
}
