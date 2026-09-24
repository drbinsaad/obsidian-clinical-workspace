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
    // Strip directionality controls used for visual spoofing, plus the
    // invisible characters that make two visually identical values compare
    // unequal: zero-width space, word joiner, and the BOM/ZWNBSP. ZWNJ
    // (U+200C) and ZWJ (U+200D) are orthographically significant in Persian
    // and other Arabic-script languages and must be preserved. The Arabic
    // Letter Mark (U+061C) is a bidi control like LRM/RLM, not a letter.
    .replace(/[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeArabicDigits(value: string): string {
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
  // A "+" is meaningful only as the international prefix. Keeping interior
  // pluses would let "05x +05y" collapse into one confirmed-looking number.
  return normalizeArabicDigits(normalizeText(value))
    .replace(/[^\d+]/g, "")
    .replace(/(?!^)\+/g, "");
}

export function normalizeComparable(value: unknown): string {
  return normalizeText(value).toLocaleLowerCase();
}

/**
 * Folding key for MATCHING only: search filters and possible-duplicate
 * warnings. Never store it or use it to reuse a record automatically — it
 * deliberately conflates spellings that can belong to different people.
 *
 * The iPhone Arabic keyboard types Arabic-Indic digits by default, and the
 * same Arabic name is routinely written with or without hamza, diacritics or
 * tatweel, and with ta marbuta/ha or alef maqsura/ya used interchangeably.
 */
export function searchKey(value: unknown): string {
  return normalizeArabicDigits(normalizeText(value))
    // Tashkeel (including the superscript alef) and tatweel.
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    // Hamza-bearing and wasla alef forms fold to bare alef.
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .toLocaleLowerCase();
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

/**
 * Shows a stored timestamp as `YYYY-MM-DD HH:mm` in the device's local time.
 * Timestamps are stored in UTC; cutting the stored text down instead reads
 * hours off, and near midnight shows the wrong day. Display only: storage
 * stays UTC. A hand-edited value that does not parse is shown as written,
 * and a bare date is not shifted into a time it never had.
 */
export function formatLocalDateTime(iso: unknown): string {
  const text = normalizeText(iso);
  if (!text || /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const time = Date.parse(text);
  if (Number.isNaN(time)) return text;
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

/**
 * Without `additionalEntryId` the key is unchanged from earlier releases, so
 * a retry still finds a record written by them.
 */
export function procedureIdempotencyKey(
  episodeId: string,
  procedure: string,
  procedureDate: string,
  additionalEntryId = ""
): string {
  const parts = [episodeId, normalizeComparable(procedure), normalizeText(procedureDate)];
  if (additionalEntryId) parts.push(additionalEntryId);
  return `procedure-${fnv1a(parts.join("|"))}`;
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

/**
 * Task-type labels are spelled out: title-casing each hyphenated part showed
 * "book-or" as "Book Or", which reads as the English word. A value outside
 * the list keeps the title-case rule so a hand-edited type stays readable.
 */
export function taskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "clinical-review": "Clinical Review",
    "call-patient": "Call Patient",
    "review-result": "Review Result",
    "book-or": "Book OR",
    "postop-follow-up": "Post-op Follow-Up",
    consultation: "Consultation",
    "wound-care": "Wound Care",
    medication: "Medication",
    other: "Other"
  };
  return (
    labels[type] ??
    type
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/**
 * Reads a stored choice the way a clinician meant it: a value typed by hand
 * in the Properties panel ("Emergency", "OR booking") matches its option
 * ignoring case and spacing. Returns undefined when nothing matches.
 */
export function canonicalOption<T extends string>(
  value: string | undefined,
  allowed: readonly T[]
): T | undefined {
  const key = normalizeText(value).toLowerCase().replace(/[\s_]+/g, "-");
  return allowed.find((option) => option === key);
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

/** Whole days a task is overdue by; 0 when it is not overdue at all. */
export function daysOverdue(task: TaskRecord, today = todayIso()): number {
  if (!taskIsOverdue(task, today)) return 0;
  const due = normalizeIsoDate(task.due_date);
  const difference = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`);
  // One day in milliseconds, written as arithmetic: bare long digit literals
  // trip the CI identifier guard, which deliberately treats them as suspect.
  return Math.max(1, Math.round(difference / (24 * 60 * 60 * 1000)));
}

/** Local calendar day `days` from `today`; noon-anchored to sidestep DST edges. */
export function isoDateWithOffset(days: number, today = todayIso()): string {
  const date = new Date(`${today}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Open work due after today but within the coming `days` days. */
export function taskIsUpcoming(task: TaskRecord, days = 7, today = todayIso()): boolean {
  const due = normalizeIsoDate(task.due_date);
  return taskIsOpen(task) && due !== "" && due > today && due <= isoDateWithOffset(days, today);
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
  const repeat = input.repeatEveryDays ?? 0;
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > 730) {
    errors.push("Repeat interval must be a whole number of days up to 730.");
  }
  if (repeat > 0 && !input.dueDate) {
    errors.push("A repeating task needs a due date to schedule the next occurrence from.");
  }
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
