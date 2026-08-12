import type { ClinicalRecord, EpisodeRecord, PatientRecord, ProcedureRecord, TaskRecord } from "./types";
import {
  CARE_SETTINGS,
  CURRENT_SCHEMA_VERSION,
  EPISODE_STATUSES,
  MRN_STATUSES,
  PATHWAYS,
  PATIENT_STATUSES,
  PHONE_STATUSES,
  PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES
} from "./types";
import { isIsoDate, normalizeText } from "./schema";

/**
 * One field-level problem found in a persisted record.
 *
 * Messages must never contain patient text: they are rendered in the
 * integrity report and can reach the developer console. Callers attach the
 * record id and path.
 */
export interface RecordProblem {
  code: string;
  severity: "warning" | "error";
  message: string;
}

const PROCEDURE_STATUSES = ["completed", "cancelled", "entered-in-error"] as const;

/** Timestamp fields that must parse as a real instant when present. */
const RECORD_TIMESTAMPS: Record<string, readonly string[]> = {
  patient: ["created_at", "updated_at"],
  episode: ["created_at", "updated_at", "opened_at", "closed_at"],
  task: ["created_at", "updated_at", "completed_at", "cancelled_at"],
  procedure: ["created_at", "updated_at"],
  event: ["created_at", "updated_at"]
};

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
  problems: RecordProblem[]
): void {
  if (allowed.includes(String(value))) return;
  problems.push({
    code: "invalid-value",
    severity: "error",
    message: `Unrecognised ${label} value; the note may have been edited by hand.`
  });
}

/**
 * Central runtime validation for one persisted record. Shared by the
 * integrity scan and any caller that needs to trust a parsed record beyond
 * "it has an entity and an id".
 */
export function validateRecord(record: ClinicalRecord): RecordProblem[] {
  const problems: RecordProblem[] = [];

  const version = record.schema_version;
  if (!Number.isInteger(version) || version < 1 || version > CURRENT_SCHEMA_VERSION) {
    problems.push({
      code: "unsupported-schema-version",
      severity: "error",
      message: `Record declares schema version ${String(version)}, outside the supported range 1–${CURRENT_SCHEMA_VERSION}. It may come from a newer plugin version or a hand edit.`
    });
  }

  for (const field of RECORD_TIMESTAMPS[record.entity] ?? []) {
    const value = (record as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string" || value === "") continue;
    if (Number.isNaN(Date.parse(value))) {
      problems.push({
        code: "invalid-timestamp",
        severity: "warning",
        message: `The ${field.replace(/_/g, " ")} timestamp is not a valid date-time.`
      });
    }
  }

  switch (record.entity) {
    case "patient":
      return [...problems, ...validatePatientRecord(record)];
    case "episode":
      return [...problems, ...validateEpisodeRecord(record)];
    case "task":
      return [...problems, ...validateTaskRecord(record)];
    case "procedure":
      return [...problems, ...validateProcedureRecord(record)];
    default:
      return problems;
  }
}

function validatePatientRecord(record: PatientRecord): RecordProblem[] {
  const problems: RecordProblem[] = [];
  checkEnum(record.status, PATIENT_STATUSES, "patient status", problems);
  checkEnum(record.mrn_status, MRN_STATUSES, "MRN status", problems);
  checkEnum(record.phone_status, PHONE_STATUSES, "phone status", problems);
  return problems;
}

function validateEpisodeRecord(record: EpisodeRecord): RecordProblem[] {
  const problems: RecordProblem[] = [];
  checkEnum(record.pathway, PATHWAYS, "pathway", problems);
  checkEnum(record.status, EPISODE_STATUSES, "status", problems);
  checkEnum(record.priority, PRIORITIES, "priority", problems);
  checkEnum(record.care_setting, CARE_SETTINGS, "care setting", problems);
  return problems;
}

function validateTaskRecord(record: TaskRecord): RecordProblem[] {
  const problems: RecordProblem[] = [];
  checkEnum(record.status, TASK_STATUSES, "status", problems);
  checkEnum(record.priority, PRIORITIES, "priority", problems);
  checkEnum(record.task_type, TASK_TYPES, "task type", problems);
  if (!normalizeText(record.idempotency_key)) {
    problems.push({
      code: "missing-idempotency-key",
      severity: "warning",
      message: "Task has no idempotency key, so duplicate protection cannot recognise it."
    });
  }
  return problems;
}

function validateProcedureRecord(record: ProcedureRecord): RecordProblem[] {
  const problems: RecordProblem[] = [];
  checkEnum(record.status, PROCEDURE_STATUSES, "procedure status", problems);
  if (!normalizeText(record.idempotency_key)) {
    problems.push({
      code: "missing-idempotency-key",
      severity: "warning",
      message: "Procedure has no idempotency key, so duplicate protection cannot recognise it."
    });
  }
  if (record.follow_up_date && !isIsoDate(record.follow_up_date)) {
    problems.push({
      code: "invalid-follow-up-date",
      severity: "warning",
      message: "Procedure follow-up date is not a valid calendar date."
    });
  }
  if (record.follow_up_required === true) {
    if (!record.follow_up_date || !normalizeText(record.follow_up_plan)) {
      problems.push({
        code: "follow-up-contradiction",
        severity: "error",
        message: "Procedure requires follow-up but has no follow-up date or plan. The follow-up may have been lost by an interrupted write."
      });
    }
  } else if (record.follow_up_date || normalizeText(record.follow_up_plan)) {
    problems.push({
      code: "follow-up-contradiction",
      severity: "warning",
      message: "Procedure records follow-up details but is marked as not requiring follow-up."
    });
  }
  return problems;
}
