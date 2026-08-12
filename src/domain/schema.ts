import type {
  CompleteProcedureInput,
  EpisodeRecord,
  MrnStatus,
  NewEpisodeInput,
  NewTaskInput,
  PatientIdentityInput,
  PhoneStatus,
  TaskRecord
} from "./types";
import { CURRENT_SCHEMA_VERSION, TASK_TYPES } from "./types";

export const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeText(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
        ? String(value)
        : "";
  return text
    // Strip only directionality controls used for visual spoofing. ZWNJ
    // (U+200C) and ZWJ (U+200D) are orthographically significant in Persian
    // and other Arabic-script languages and must be preserved.
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArabicDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const zero = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - zero);
  });
}

export function normalizeMrn(value: unknown): string {
  return normalizeArabicDigits(normalizeText(value)).replace(/[\s-]/g, "");
}

/**
 * Canonical form used only for *matching* two MRNs. Leading zeroes are dropped
 * here so that `0012345` and `12345` resolve to the same patient; the value the
 * user typed is preserved verbatim in `PatientRecord.mrn` for display.
 */
export function mrnMatchKey(value: unknown): string {
  return normalizeMrn(value).replace(/^0+(?=\d)/, "");
}

export function normalizePhone(value: unknown): string {
  return normalizeArabicDigits(normalizeText(value)).replace(/[^\d+]/g, "");
}

export function normalizeComparable(value: unknown): string {
  return normalizeText(value).toLocaleLowerCase();
}

/**
 * Accepts `YYYY-MM-DD` and tolerates a trailing time component, which is what
 * Obsidian's Properties panel writes when a field is typed as a date-time.
 * Returns "" for anything that is not a real calendar date.
 */
export function normalizeIsoDate(value: unknown): string {
  const text = normalizeText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match) return "";
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "";
  }
  return `${yearText}-${monthText}-${dayText}`;
}

export function isIsoDate(value: unknown): boolean {
  return normalizeIsoDate(value) !== "";
}

export function createId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${token}`;
}

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function taskIdempotencyKey(input: Pick<NewTaskInput, "episodeId" | "task" | "dueDate">): string {
  return `task-${fnv1a(
    [input.episodeId, normalizeComparable(input.task), normalizeText(input.dueDate)].join("|")
  )}`;
}

export function procedureIdempotencyKey(
  episodeId: string,
  procedure: string,
  procedureDate: string
): string {
  return `procedure-${fnv1a(
    [episodeId, normalizeComparable(procedure), normalizeText(procedureDate)].join("|")
  )}`;
}

export function mrnStatus(mrn: string): MrnStatus {
  return mrn ? "confirmed" : "missing";
}

export function phoneStatus(phone: string): PhoneStatus {
  return phone ? "confirmed" : "not-found";
}

export function displayMrn(mrn: string): string {
  return mrn || "MRN needed";
}

export function displayPhone(phone: string): string {
  return phone || "NFN";
}

export function pathwayLabel(pathway: string): string {
  const labels: Record<string, string> = {
    assessment: "Assessment",
    "or-booking": "OR Booking",
    "opd-follow-up": "OPD Follow-Up",
    "result-review": "Result / Image Review",
    consultation: "Consultation",
    "discharge-ready": "Discharge Ready"
  };
  return labels[pathway] ?? "Unknown pathway";
}

export function careSettingLabel(value: string): string {
  if (value === "inpatient") return "Inpatient";
  if (value === "outpatient") return "Outpatient";
  return "Unknown setting";
}

export function priorityLabel(value: string): string {
  const text = normalizeText(value);
  if (!text) return "Unknown";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function patientNeedsReview(mrn: string, patientName: string): boolean {
  return !mrn || !patientName;
}

export function episodeNeedsReview(episode: EpisodeRecord): boolean {
  if (!normalizeText(episode.case)) return true;
  if (
    ["opd-follow-up", "result-review", "consultation"].includes(episode.pathway) &&
    (!normalizeText(episode.next_action) || !episode.due_date)
  ) {
    return true;
  }
  return false;
}

export function taskIsOpen(task: TaskRecord): boolean {
  return ["open", "in-progress", "waiting"].includes(task.status);
}

export function taskIsDueToday(task: TaskRecord, today = todayIso()): boolean {
  return taskIsOpen(task) && normalizeIsoDate(task.due_date) === today;
}

export function taskIsOverdue(task: TaskRecord, today = todayIso()): boolean {
  const due = normalizeIsoDate(task.due_date);
  return taskIsOpen(task) && due !== "" && due < today;
}

export function taskIsUndated(task: TaskRecord): boolean {
  return taskIsOpen(task) && normalizeIsoDate(task.due_date) === "";
}

export function validateNewEpisodeInput(input: NewEpisodeInput): string[] {
  const errors: string[] = [];
  const mrn = normalizeMrn(input.mrn);
  if (mrn && !/^\d+$/.test(mrn)) errors.push("MRN must contain numbers only.");
  if (!mrn && !normalizeText(input.patientName)) {
    errors.push("Enter an MRN or patient name.");
  }
  if (!normalizeText(input.caseName)) errors.push("Case / reason is required.");
  if (input.dueDate && !isIsoDate(input.dueDate)) errors.push("Due date is invalid.");
  if (
    ["opd-follow-up", "result-review", "consultation"].includes(input.pathway) &&
    (!normalizeText(input.nextAction) || !input.dueDate)
  ) {
    errors.push("Next action and due date are required for this pathway.");
  }
  return errors;
}

export function validateTaskInput(input: NewTaskInput): string[] {
  const errors: string[] = [];
  if (!normalizeText(input.patientId)) errors.push("Patient is required.");
  if (!normalizeText(input.episodeId)) errors.push("Episode is required.");
  if (!normalizeText(input.task)) errors.push("Task is required.");
  if (!TASK_TYPES.includes(input.taskType)) errors.push("Task type is not recognised.");
  if (input.dueDate && !isIsoDate(input.dueDate)) errors.push("Due date is invalid.");
  return errors;
}

/**
 * Complete pre-write validation for a procedure submission. Nothing may be
 * written until every check here passes: a rejection after the first write
 * leaves a partial state that a clinician has no reason to suspect.
 */
export function validateProcedureInput(input: CompleteProcedureInput): string[] {
  const errors: string[] = [];
  if (!normalizeText(input.patientId)) errors.push("Patient is required.");
  if (!normalizeText(input.episodeId)) errors.push("Episode is required.");
  if (!normalizeText(input.procedure)) errors.push("Procedure is required.");
  if (!input.procedureDate) errors.push("Procedure date is required.");
  else if (!isIsoDate(input.procedureDate)) errors.push("Procedure date is not a valid calendar date.");
  if (input.followUpRequired) {
    if (!input.followUpDate || !normalizeText(input.followUpPlan)) {
      errors.push("Follow-up date and plan are required when follow-up is needed.");
    } else if (!isIsoDate(input.followUpDate)) {
      errors.push("Follow-up date is not a valid calendar date.");
    } else if (
      isIsoDate(input.procedureDate) &&
      normalizeIsoDate(input.followUpDate) < normalizeIsoDate(input.procedureDate)
    ) {
      errors.push("Follow-up date cannot be before the procedure date.");
    }
  }
  return errors;
}

export function validatePatientIdentityInput(input: PatientIdentityInput): string[] {
  const errors: string[] = [];
  const mrn = normalizeMrn(input.mrn);
  if (mrn && !/^\d+$/.test(mrn)) errors.push("MRN must contain numbers only.");
  if (!mrn && !normalizeText(input.patientName)) {
    errors.push("Enter an MRN or patient name.");
  }
  return errors;
}
