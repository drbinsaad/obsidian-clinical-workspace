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
  validateTaskInput
} from "../domain/schema";
import {
  canArchiveEpisode,
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

/** Raised when an MRN-less patient looks like one that already exists. */
export class PossibleDuplicatePatientError extends Error {
  constructor(readonly candidates: PatientRecord[]) {
    super("A patient with this name already exists.");
    this.name = "PossibleDuplicatePatientError";
  }
}

export class ClinicalService {
  constructor(private readonly repository: ClinicalRepository) {}

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
    const identityKey = mrnMatchKey(mrn) || `name:${normalizeComparable(patientName)}`;
    const resolved = await this.repository.withLock(`patient:${identityKey}`, async () => {
      if (input.existingPatientId) {
        const chosen = await this.repository.findById<PatientRecord>("patient", input.existingPatientId);
        if (!chosen) throw new Error("The selected patient was not found.");
        return { patient: chosen, reused: true };
      }

      const existingPatient = mrn ? await this.repository.findPatientByMrn(mrn) : null;
      if (existingPatient) {
        return { patient: await this.reconcilePatient(existingPatient, patientName, phone), reused: true };
      }

      // Without an MRN there is no reliable key, so surface near-matches and let
      // the caller decide rather than silently creating a second chart.
      if (!mrn && !input.forceNewPatient) {
        const candidates = await this.findPatientsByName(patientName);
        if (candidates.length) throw new PossibleDuplicatePatientError(candidates);
      }

      return { patient: await this.createPatient(mrn, patientName, phone, timestamp), reused: false };
    });

    const patient = resolved.patient;
    const reusedPatient = resolved.reused;

    const episodes = await this.repository.list<EpisodeRecord>("episode");
    const duplicate = episodes.find(
      ({ record }) =>
        record.patient_id === patient.record.id &&
        !["archived", "cancelled", "entered-in-error"].includes(record.status) &&
        normalizeComparable(record.case) === normalizeComparable(input.caseName)
    );
    if (duplicate) {
      return { patient, episode: duplicate, task: null, reusedPatient, duplicateEpisode: true };
    }

    const episodeId = createId("EPI");
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
      summary: `Episode created: ${episodeRecord.case}`,
      newState: `${episodeRecord.pathway}/${episodeRecord.status}`
    });

    let task: RecordWithPath<TaskRecord> | null = null;
    if (episodeRecord.next_action) {
      const createdTask = await this.createTask({
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
      merged_into: ""
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
    const errors = validateTaskInput(input);
    if (errors.length) throw new Error(errors.join(" "));
    const patient = await this.repository.findById<PatientRecord>("patient", input.patientId);
    const episode = await this.repository.findById<EpisodeRecord>("episode", input.episodeId);
    if (!patient || !episode) throw new Error("The linked patient or episode was not found.");
    if (["archived", "cancelled", "entered-in-error"].includes(episode.record.status)) {
      throw new Error("Tasks can only be added to an active episode.");
    }

    const idempotencyKey = taskIdempotencyKey(input);

    // Check and write together, so two concurrent submissions cannot both pass
    // the duplicate check before either has written its record.
    const result = await this.repository.withLock(`task:${idempotencyKey}`, async () => {
      const tasks = await this.repository.list<TaskRecord>("task");
      const duplicate = tasks.find(
        ({ record }) => record.idempotency_key === idempotencyKey && taskIsOpen(record)
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

    if (result.duplicate) return result;

    await this.repository.update<EpisodeRecord>(episode.path, {
      next_action: result.task.record.task,
      due_date: result.task.record.due_date,
      priority: result.task.record.priority,
      status: episode.record.status === "ready-to-close" ? "active" : episode.record.status
    });
    await this.repository.createEvent({
      action: "task-created",
      patientId: patient.record.id,
      episodeId: episode.record.id,
      targetId: result.task.record.id,
      targetEntity: "task",
      summary: `Task created: ${result.task.record.task}`,
      newState: result.task.record.status
    });
    return result;
  }

  async completeTask(taskId: string): Promise<RecordWithPath<TaskRecord>> {
    return this.repository.withLock(`task-state:${taskId}`, async () => {
      const task = await this.repository.findById<TaskRecord>("task", taskId);
      if (!task) throw new Error("Task was not found.");
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
        summary: `Task completed: ${task.record.task}`,
        previousState: task.record.status,
        newState: "completed"
      });
      return completed;
    });
  }

  /**
   * Cancels an open task. Without this an episode whose task cannot be
   * completed — because its note was renamed, or the work is no longer
   * relevant — can never be archived.
   */
  async cancelTask(taskId: string, reason: string): Promise<RecordWithPath<TaskRecord>> {
    return this.repository.withLock(`task-state:${taskId}`, async () => {
      const task = await this.repository.findById<TaskRecord>("task", taskId);
      if (!task) throw new Error("Task was not found.");
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
        summary: `Task cancelled: ${task.record.task}`,
        previousState: task.record.status,
        newState: "cancelled"
      });
      return cancelled;
    });
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
    await this.repository.update<EpisodeRecord>(episode.path, {
      status: nextStatus ?? episode.record.status,
      next_action: first?.task ?? "",
      due_date: first?.due_date ?? ""
    });
  }

  async updateEpisode(episodeId: string, input: EpisodeUpdateInput): Promise<RecordWithPath<EpisodeRecord>> {
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

    // Saving this sheet must not resurrect work that has already been dealt
    // with. Comparing against the episode's own `next_action` is not enough,
    // because completing a task clears that field — so the check is whether a
    // task with this exact identity has ever existed for the episode, in any
    // status. An explicitly added task is unaffected; this guards only the
    // task implied by editing the episode.
    let alreadyRaised = false;
    if (nextAction) {
      const key = taskIdempotencyKey({
        episodeId: episode.record.id,
        task: nextAction,
        dueDate: input.dueDate
      });
      const tasks = await this.repository.list<TaskRecord>("task");
      alreadyRaised = tasks.some(({ record }) => record.idempotency_key === key);
    }
    if (nextAction && !alreadyRaised) {
      await this.createTask({
        patientId: episode.record.patient_id,
        episodeId: episode.record.id,
        task: nextAction,
        taskType: this.defaultTaskTypeForPathway(input.pathway),
        priority: input.priority,
        dueDate: input.dueDate,
        owner: ""
      });
    }
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
    return updated;
  }

  /** Corrects a patient's recorded identity. */
  async updatePatientIdentity(
    patientId: string,
    input: PatientIdentityInput
  ): Promise<RecordWithPath<PatientRecord>> {
    const errors = validatePatientIdentityInput(input);
    if (errors.length) throw new Error(errors.join(" "));
    const patient = await this.repository.findById<PatientRecord>("patient", patientId);
    if (!patient) throw new Error("Patient was not found.");

    const mrn = normalizeMrn(input.mrn);
    const patientName = normalizeText(input.patientName);
    const phone = normalizePhone(input.phone);

    if (mrn && mrnMatchKey(mrn) !== mrnMatchKey(patient.record.mrn)) {
      const clash = await this.repository.findPatientByMrn(mrn);
      if (clash && clash.record.id !== patientId) {
        throw new Error("Another patient already has this MRN. Merge the two records instead.");
      }
    }

    const updated = await this.repository.update<PatientRecord>(patient.path, {
      mrn,
      mrn_status: mrnStatus(mrn),
      patient_name: patientName,
      phone,
      phone_status: phoneStatus(phone)
    });
    await this.repository.createEvent({
      action: "patient-identity-updated",
      patientId,
      targetId: patientId,
      targetEntity: "patient",
      summary: "Patient identity corrected",
      previousState: patient.record.mrn ? "mrn recorded" : "mrn missing",
      newState: mrn ? "mrn recorded" : "mrn missing"
    });
    return updated;
  }

  /** Counts what a merge would move, so the user can confirm before it runs. */
  async previewPatientMerge(sourceId: string, targetId: string): Promise<MergePreview> {
    if (sourceId === targetId) throw new Error("Select two different patients.");
    const source = await this.repository.findById<PatientRecord>("patient", sourceId);
    const target = await this.repository.findById<PatientRecord>("patient", targetId);
    if (!source || !target) throw new Error("One of the selected patients was not found.");
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
    return this.repository.withLock(`patient-merge:${sourceId}`, async () => {
      const source = await this.repository.findById<PatientRecord>("patient", sourceId);
      const target = await this.repository.findById<PatientRecord>("patient", targetId);
      if (!source || !target) throw new Error("One of the selected patients was not found.");
      if (source.record.merged_into) throw new Error("This patient has already been merged.");

      const label = this.patientLinkLabel(target.record);
      const link = wikilink(target.path, label);

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

      await this.repository.update<PatientRecord>(source.path, {
        status: "entered-in-error",
        merged_into: targetId
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
    const episode = await this.repository.findById<EpisodeRecord>("episode", episodeId);
    if (!episode) throw new Error("Episode was not found.");
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
      summary: `Episode archived: ${normalizeText(outcome) || "Episode closed"}`,
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
    const episode = await this.repository.findById<EpisodeRecord>("episode", input.episodeId);
    const patient = await this.repository.findById<PatientRecord>("patient", input.patientId);
    if (!episode || !patient) throw new Error("The linked patient or episode was not found.");
    if (!normalizeText(input.procedure)) throw new Error("Procedure is required.");
    if (!input.procedureDate) throw new Error("Procedure date is required.");
    if (input.followUpRequired && (!input.followUpDate || !normalizeText(input.followUpPlan))) {
      throw new Error("Follow-up date and plan are required when follow-up is needed.");
    }

    const key = procedureIdempotencyKey(input.episodeId, input.procedure, input.procedureDate);

    const outcome = await this.repository.withLock(`procedure:${key}`, async () => {
      const existing = (await this.repository.list<ProcedureRecord>("procedure")).find(
        ({ record }) => record.idempotency_key === key && record.status === "completed"
      );
      if (existing) return { procedure: existing, alreadyLogged: true };

      const timestamp = nowIso();
      const record: ProcedureRecord = {
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
        follow_up_required: input.followUpRequired,
        follow_up_date: input.followUpRequired ? input.followUpDate : "",
        follow_up_plan: input.followUpRequired ? normalizeText(input.followUpPlan) : "",
        idempotency_key: key
      };
      return { procedure: await this.repository.create(record), alreadyLogged: false };
    });

    if (outcome.alreadyLogged) return outcome.procedure;

    const tasks = await this.repository.list<TaskRecord>("task");
    for (const task of tasks) {
      if (
        task.record.episode_id === episode.record.id &&
        task.record.task_type === "book-or" &&
        taskIsOpen(task.record)
      ) {
        await this.completeTask(task.record.id);
      }
    }

    // Care setting is the clinician's to decide. A post-operative inpatient is
    // still an inpatient, so it is left exactly as recorded.
    await this.repository.update<EpisodeRecord>(episode.path, {
      pathway: pathwayAfterProcedure(input.followUpRequired),
      status: input.followUpRequired ? "active" : "ready-to-close",
      next_action: input.followUpRequired ? normalizeText(input.followUpPlan) : "",
      due_date: input.followUpRequired ? input.followUpDate : ""
    });
    if (input.followUpRequired) {
      await this.createTask({
        patientId: patient.record.id,
        episodeId: episode.record.id,
        task: input.followUpPlan,
        taskType: "postop-follow-up",
        priority: episode.record.priority,
        dueDate: input.followUpDate,
        owner: ""
      });
    }
    await this.repository.createEvent({
      action: "procedure-completed",
      patientId: patient.record.id,
      episodeId: episode.record.id,
      targetId: outcome.procedure.record.id,
      targetEntity: "procedure",
      summary: `Procedure completed: ${outcome.procedure.record.procedure}`,
      newState: input.followUpRequired ? "postoperative follow-up" : "ready to close"
    });
    return outcome.procedure;
  }

  private patientLinkLabel(patient: PatientRecord): string {
    return patient.patient_name || patient.mrn || "Patient";
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
