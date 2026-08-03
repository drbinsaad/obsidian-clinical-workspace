export const ENTITY_TYPES = [
  "patient",
  "episode",
  "task",
  "procedure",
  "document",
  "event",
  "medication-reference"
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const CARE_SETTINGS = ["inpatient", "outpatient"] as const;
export type CareSetting = (typeof CARE_SETTINGS)[number];

export const PATHWAYS = [
  "assessment",
  "or-booking",
  "opd-follow-up",
  "result-review",
  "consultation",
  "discharge-ready"
] as const;
export type Pathway = (typeof PATHWAYS)[number];

export const PRIORITIES = ["routine", "urgent", "emergency"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EPISODE_STATUSES = [
  "active",
  "on-hold",
  "ready-to-close",
  "archived",
  "cancelled",
  "entered-in-error"
] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

export const TASK_STATUSES = [
  "open",
  "in-progress",
  "waiting",
  "completed",
  "cancelled",
  "entered-in-error"
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TYPES = [
  "clinical-review",
  "call-patient",
  "review-result",
  "book-or",
  "postop-follow-up",
  "consultation",
  "wound-care",
  "medication",
  "other"
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const MRN_STATUSES = ["confirmed", "missing", "unconfirmed"] as const;
export type MrnStatus = (typeof MRN_STATUSES)[number];

export const PHONE_STATUSES = ["confirmed", "not-found", "unconfirmed"] as const;
export type PhoneStatus = (typeof PHONE_STATUSES)[number];

export const PATIENT_STATUSES = ["active", "archived", "entered-in-error"] as const;
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

/**
 * 1 — initial release.
 * 2 — episodes remember the pathway they held before archiving so restore is
 *     non-destructive; patients carry `merged_into` for the merge workflow.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface BaseRecord {
  schema_version: number;
  entity: EntityType;
  id: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface PatientRecord extends BaseRecord {
  entity: "patient";
  mrn: string;
  mrn_status: MrnStatus;
  patient_name: string;
  phone: string;
  phone_status: PhoneStatus;
  status: PatientStatus;
  /** Set when this record was merged into another patient; never deleted. */
  merged_into: string;
}

export interface EpisodeRecord extends BaseRecord {
  entity: "episode";
  patient_id: string;
  patient: string;
  case: string;
  care_setting: CareSetting;
  pathway: Pathway;
  priority: Priority;
  status: EpisodeStatus;
  next_action: string;
  due_date: string;
  opened_at: string;
  closed_at: string;
  outcome: string;
  /** Pathway held immediately before archiving, so restore can put it back. */
  pathway_before_archive: string;
  /** Status held immediately before archiving. */
  status_before_archive: string;
}

export interface TaskRecord extends BaseRecord {
  entity: "task";
  patient_id: string;
  patient: string;
  episode_id: string;
  episode: string;
  task: string;
  task_type: TaskType;
  status: TaskStatus;
  priority: Priority;
  due_date: string;
  owner: string;
  completed_at: string;
  cancelled_at: string;
  cancel_reason: string;
  idempotency_key: string;
}

export interface ProcedureRecord extends BaseRecord {
  entity: "procedure";
  patient_id: string;
  patient: string;
  episode_id: string;
  episode: string;
  procedure: string;
  procedure_date: string;
  role: string;
  status: "completed" | "cancelled" | "entered-in-error";
  outcome: string;
  follow_up_required: boolean;
  follow_up_date: string;
  follow_up_plan: string;
  idempotency_key: string;
}

export interface EventRecord extends BaseRecord {
  entity: "event";
  action: string;
  actor: string;
  patient_id: string;
  episode_id: string;
  target_id: string;
  target_entity: EntityType;
  summary: string;
  previous_state: string;
  new_state: string;
}

export type ClinicalRecord =
  | PatientRecord
  | EpisodeRecord
  | TaskRecord
  | ProcedureRecord
  | EventRecord;

export interface NewEpisodeInput {
  mrn: string;
  patientName: string;
  phone: string;
  caseName: string;
  careSetting: CareSetting;
  pathway: Pathway;
  priority: Priority;
  nextAction: string;
  dueDate: string;
  /**
   * Set by the UI after the user has been shown possible duplicates for an
   * MRN-less patient and has chosen to create a new record anyway.
   */
  forceNewPatient?: boolean;
  /** Set by the UI when the user picked an existing patient from that prompt. */
  existingPatientId?: string;
}

export interface NewTaskInput {
  patientId: string;
  episodeId: string;
  task: string;
  taskType: TaskType;
  priority: Priority;
  dueDate: string;
  owner: string;
}

export interface EpisodeUpdateInput {
  careSetting: CareSetting;
  pathway: Pathway;
  priority: Priority;
  nextAction: string;
  dueDate: string;
}

export interface PatientIdentityInput {
  mrn: string;
  patientName: string;
  phone: string;
}

export interface CompleteProcedureInput {
  patientId: string;
  episodeId: string;
  procedure: string;
  procedureDate: string;
  role: string;
  outcome: string;
  followUpRequired: boolean;
  followUpDate: string;
  followUpPlan: string;
}

export interface IntegrityIssue {
  code: string;
  severity: "warning" | "error";
  /** Must never contain a patient identifier — rendered and logged. */
  message: string;
  recordId: string;
  path: string;
}

export interface ClinicalSnapshot {
  patients: PatientRecord[];
  episodes: EpisodeRecord[];
  tasks: TaskRecord[];
  procedures: ProcedureRecord[];
}

export interface RecordWithPath<T extends ClinicalRecord> {
  record: T;
  path: string;
}

export interface MergePreview {
  source: PatientRecord;
  target: PatientRecord;
  episodes: number;
  tasks: number;
  procedures: number;
}
