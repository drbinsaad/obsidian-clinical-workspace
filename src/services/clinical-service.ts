import type {
  CompleteProcedureInput,
  EpisodeRecord,
  EpisodeUpdateInput,
  MergePreview,
  NewEpisodeInput,
  NewTaskInput,
  PatientIdentityInput,
  PatientRecord,
  ProcedureRecord,
  RecordWithPath,
  TaskRecord
} from "../domain/types";
import {
  createId,
  mrnMatchKey,
  mrnStatus,
  normalizeComparable,
  normalizeMrn,
  normalizePhone,
  normalizeText,
  nowIso,
  phoneStatus,
  procedureIdempotencyKey,
  SCHEMA_VERSION,
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
  pathwayAfterProcedure,
  pathwayAfterRestore,
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
  | { kind: "created"; task: RecordWithPath<TaskRecord>; superseded: number };

export interface UpdateEpisodeResult {
  episode: RecordWithPath<EpisodeRecord>;
  task: EpisodeTaskOutcome;
}

/** Raised when an MRN-less patient looks like one that already exists. */
export class PossibleDuplicatePatientError extends Error {
  constructor(readonly candidates: PatientRecord[]) {
    super("A patient with this name already exists.");
    this.name = "PossibleDuplicatePatientError";
  }
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
    const identityKey = submittedMrnKey || `name:${normalizeComparable(patientName)}`;
    const resolved = await this.repository.withLock(`patient:${identityKey}`, async () => {
      if (input.existingPatientId) {
        const chosen = await this.repository.findById<PatientRecord>("patient", input.existingPatientId);
        if (!chosen) throw new Error("The selected patient was not found.");
        return { patient: chosen, reused: true };
      }

      const existingPatient = mrn ? await this.repository.findPatientByMrn(mrn) : null;
      if (existingPatient) {
        return { patient: existingPatient, reused: true };
      }

      // Without an MRN there is no reliable key, so surface near-matches and let
      // the caller decide rather than silently creating a second chart.
      if (!mrn && !input.forceNewPatient) {
        const candidates = await this.findPatientsByName(patientName);
        if (candidates.length) throw new PossibleDuplicatePatientError(candidates);
      }

      return { patient: await this.createPatient(mrn, patientName, phone, timestamp), reused: false };
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
      if (submittedMrnKey && mrnMatchKey(patient.record.mrn) !== submittedMrnKey) {
        throw new Error("The patient identity changed. Retry the Episode selection.");
      }
      if (resolved.reused) {
        patient = await this.reconcilePatient(patient, patientName, phone);
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
            // partial result while still holding the same lifecycle lock.
            let existingTask: RecordWithPath<TaskRecord> | null = null;
            if (normalizeText(input.nextAction)) {
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
            due_date: input.dueDate,
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

  /** Active patients whose recorded name matches, used to warn before duplicating. */
  async findPatientsByName(patientName: string): Promise<PatientRecord[]> {
    const name = normalizeComparable(patientName);
    if (!name) return [];
    const patients = await this.repository.list<PatientRecord>("patient");
    return patients
      .filter(
        ({ record }) =>
          record.status !== "entered-in-error" &&
          !record.merged_into &&
          normalizeComparable(record.patient_name) === name
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
    const outstanding = (await this.repository.list<TaskRecord>("task"))
      .filter(({ record }) => record.episode_id === episode.record.id && taskIsOpen(record))
      .sort((a, b) => String(a.record.due_date || "9999").localeCompare(String(b.record.due_date || "9999")));
    const imminent = outstanding[0] ?? result.task;
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
    if (!taskIsOpen(task.record)) return task;

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

  /** Caller must hold patient, Episode, and task-state locks in that order. */
  private async cancelTaskUnlocked(
    task: RecordWithPath<TaskRecord>,
    reason: string
  ): Promise<RecordWithPath<TaskRecord>> {
    if (!taskIsOpen(task.record)) return task;
    if (!canTransitionTask(task.record.status, "cancelled")) {
      throw new Error(`A ${task.record.status} task cannot be cancelled.`);
    }

    const cancelled = await this.repository.update<TaskRecord>(task.path, {
      status: "cancelled",
      cancelled_at: nowIso(),
      cancel_reason: normalizeText(reason) || "Cancelled by user"
    });
    await this.reconcileEpisodeAfterTaskChange(task.record.episode_id, task.record.id);
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
    const nextAction = normalizeText(input.nextAction);
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

    const updated = await this.repository.update<EpisodeRecord>(episode.path, {
      care_setting: input.careSetting,
      pathway: input.pathway,
      priority: input.priority,
      status,
      next_action: nextAction,
      due_date: input.dueDate
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
    return { episode: updated, task: outcome };
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

    const openMatch = forEpisode.find(({ record }) => record.idempotency_key === key && taskIsOpen(record));
    if (openMatch) return { kind: "unchanged", task: openMatch };

    const closedMatch = forEpisode.find(({ record }) => record.idempotency_key === key);
    if (closedMatch) {
      // The identical task was already completed or cancelled. Recreating it is
      // what the earlier duplicate bug did; pretending nothing was asked for is
      // what the fix did. Neither is right, so report it and let the user
      // decide whether to re-raise it explicitly.
      return { kind: "already-closed", task: closedMatch };
    }

    // The plan changed: close the task the previous next action raised, so the
    // episode carries one live task rather than an accumulating pile.
    // Identified by idempotency key, not by wording. The key folds in the due
    // date, so it names exactly the task the episode's previous next action
    // raised — and leaves alone a repeat of the same wording on another date,
    // which the clinician scheduled deliberately with "+ Task".
    const previousKey = normalizeText(episode.record.next_action)
      ? taskIdempotencyKey({
          episodeId: episode.record.id,
          task: episode.record.next_action,
          dueDate: episode.record.due_date
        })
      : null;
    const superseded = previousKey
      ? forEpisode.filter(({ record }) => taskIsOpen(record) && record.idempotency_key === previousKey)
      : [];
    // Create first, cancel second. Cancelling first meant any failure in
    // createTask destroyed the outstanding work and left nothing in its place.
    const created = await this.createTaskUnlocked({
      patientId: episode.record.patient_id,
      episodeId: episode.record.id,
      task: nextAction,
      taskType: this.defaultTaskTypeForPathway(pathway),
      priority,
      dueDate,
      owner: ""
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
   */
  async mergePatients(sourceId: string, targetId: string): Promise<RecordWithPath<PatientRecord>> {
    if (sourceId === targetId) throw new Error("Select two different patients.");
    return this.withPatientMergeLocks([sourceId, targetId], async () => {
      const source = await this.repository.findById<PatientRecord>("patient", sourceId);
      const target = await this.repository.findById<PatientRecord>("patient", targetId);
      if (!source || !target) throw new Error("One of the selected patients was not found.");
      if (source.record.merged_into) throw new Error("This patient has already been merged.");
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
      if (source.record.merge_in_progress !== targetId) {
        await this.repository.update<PatientRecord>(source.path, { merge_in_progress: targetId });
      }

      // Fill any identity gap in the surviving record from the one being retired.
      const fill: Record<string, string> = {};
      if (!target.record.mrn && source.record.mrn) {
        fill.mrn = source.record.mrn;
        fill.mrn_status = mrnStatus(source.record.mrn);
      }
      if (!target.record.patient_name && source.record.patient_name) {
        fill.patient_name = source.record.patient_name;
      }
      if (!target.record.phone && source.record.phone) {
        fill.phone = source.record.phone;
        fill.phone_status = phoneStatus(source.record.phone);
      }
      const merged = Object.keys(fill).length
        ? await this.repository.update<PatientRecord>(target.path, fill)
        : target;

      const label = this.patientLinkLabel(merged.record);
      const link = wikilink(merged.path, label);

      const episodes = await this.repository.list<EpisodeRecord>("episode");
      for (const episode of episodes) {
        if (episode.record.patient_id !== sourceId) continue;
        await this.repository.update<EpisodeRecord>(episode.path, { patient_id: targetId, patient: link });
      }
      const tasks = await this.repository.list<TaskRecord>("task");
      for (const task of tasks) {
        if (task.record.patient_id !== sourceId) continue;
        await this.repository.update<TaskRecord>(task.path, { patient_id: targetId, patient: link });
      }
      const procedures = await this.repository.list<ProcedureRecord>("procedure");
      for (const procedure of procedures) {
        if (procedure.record.patient_id !== sourceId) continue;
        await this.repository.update<ProcedureRecord>(procedure.path, { patient_id: targetId, patient: link });
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

  async archiveEpisode(episodeId: string, outcome: string): Promise<RecordWithPath<EpisodeRecord>> {
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
        return this.archiveEpisodeUnlocked(episodeId, outcome);
      })
    );
  }

  /** Caller must hold the patient-merge lock, then the Episode lifecycle lock. */
  private async archiveEpisodeUnlocked(
    episodeId: string,
    outcome: string
  ): Promise<RecordWithPath<EpisodeRecord>> {
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) throw new Error("Episode was not found.");
    if (episode.record.status === "archived") return episode;

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
    if (!otherActive) {
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
    return updated;
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
          latestPatient.record.status === "entered-in-error" ||
          Boolean(latestPatient.record.merged_into) ||
          Boolean(latestPatient.record.merge_in_progress)
        ) {
          throw new Error("Episodes can only be restored for an unmerged patient.");
        }
        return this.restoreEpisodeUnlocked(episodeId);
      })
    );
  }

  /** Caller must hold the patient-merge lock, then the Episode lifecycle lock. */
  private async restoreEpisodeUnlocked(episodeId: string): Promise<RecordWithPath<EpisodeRecord>> {
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) throw new Error("Episode was not found.");
    if (episode.record.status !== "archived") return episode;

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

      const existing = (await this.repository.list<ProcedureRecord>("procedure")).find(
        ({ record }) =>
          record.episode_id === input.episodeId &&
          record.idempotency_key === key &&
          normalizeComparable(record.procedure) === normalizedProcedure &&
          normalizeText(record.procedure_date) === normalizedProcedureDate &&
          record.status === "completed"
      );
      if (!existing && episode.record.pathway !== "or-booking") {
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
      const tasks = await this.repository.list<TaskRecord>("task");
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
          newState: followUp.required ? "postoperative follow-up" : "ready to close"
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
