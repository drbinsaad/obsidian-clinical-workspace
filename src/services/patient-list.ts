import type {
  CareSetting,
  ClinicalSnapshot,
  EpisodeRecord,
  Pathway,
  PatientRecord,
  Priority
} from "../domain/types";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES } from "../domain/types";
import {
  careSettingLabel,
  displayMrn,
  displayPhone,
  normalizeText,
  pathwayLabel,
  priorityLabel,
  taskIsOpen,
  taskIsOverdue,
  todayIso
} from "../domain/schema";

/**
 * Which episodes a patient list draws from. "open" is everything still on the
 * books (active, on hold, ready to close); "all" is every status except
 * entered-in-error, which marks a record created by mistake.
 */
export const PATIENT_LIST_SCOPES = [
  "open",
  "active",
  "on-hold",
  "ready-to-close",
  "archived",
  "cancelled",
  "all"
] as const;
export type PatientListScope = (typeof PATIENT_LIST_SCOPES)[number];

export const PATIENT_LIST_FORMATS = ["markdown", "csv"] as const;
export type PatientListFormat = (typeof PATIENT_LIST_FORMATS)[number];

export interface PatientListFilter {
  careSetting: CareSetting | "all";
  pathway: Pathway | "all";
  priority: Priority | "all";
  scope: PatientListScope;
}

export interface PatientListRequest {
  filter: PatientListFilter;
  format: PatientListFormat;
}

export const DEFAULT_PATIENT_LIST_FILTER: Readonly<PatientListFilter> = {
  careSetting: "all",
  pathway: "all",
  priority: "all",
  scope: "open"
};

export interface PatientListRow {
  episode: EpisodeRecord;
  patient: PatientRecord | undefined;
  openTasks: number;
  overdueTasks: number;
}

const OPEN_EPISODE_STATUSES: readonly string[] = ["active", "on-hold", "ready-to-close"];

export function patientListScopeLabel(scope: PatientListScope): string {
  switch (scope) {
    case "open":
      return "Open episodes (active, on hold, ready to close)";
    case "active":
      return "Active episodes";
    case "on-hold":
      return "On-hold episodes";
    case "ready-to-close":
      return "Ready-to-close episodes";
    case "archived":
      return "Archived (discharged) episodes";
    case "cancelled":
      return "Cancelled episodes";
    case "all":
      return "Every status except entered in error";
  }
}

export function patientListFormatLabel(format: PatientListFormat): string {
  return format === "csv" ? "Spreadsheet file (.csv)" : "Note in this vault (.md)";
}

function episodeInScope(status: string, scope: PatientListScope): boolean {
  if (scope === "open") return OPEN_EPISODE_STATUSES.includes(status);
  if (scope === "all") return status !== "entered-in-error";
  return status === scope;
}

/**
 * Folds anything a caller or an older saved state might hand in back to a
 * valid filter, so an unexpected value narrows to "all" rather than silently
 * matching nothing.
 */
export function normalizePatientListFilter(value: Partial<PatientListFilter> | undefined): PatientListFilter {
  const pick = <T extends string>(candidate: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly unknown[]).includes(candidate) ? (candidate as T) : fallback;
  return {
    careSetting: pick(value?.careSetting, ["all", ...CARE_SETTINGS] as const, "all"),
    pathway: pick(value?.pathway, ["all", ...PATHWAYS] as const, "all"),
    priority: pick(value?.priority, ["all", ...PRIORITIES] as const, "all"),
    scope: pick(value?.scope, PATIENT_LIST_SCOPES, "open")
  };
}

/**
 * One row per matching episode. A patient with two matching episodes appears
 * twice, because the episode — not the patient — carries the care setting,
 * pathway, and priority a list is filtered on.
 */
export function selectPatientListRows(
  snapshot: ClinicalSnapshot,
  filter: PatientListFilter,
  today = todayIso()
): PatientListRow[] {
  const patientById = new Map(snapshot.patients.map((patient) => [patient.id, patient] as const));
  const openTasksByEpisode = new Map<string, { open: number; overdue: number }>();
  for (const task of snapshot.tasks) {
    if (!taskIsOpen(task)) continue;
    const counts = openTasksByEpisode.get(task.episode_id) ?? { open: 0, overdue: 0 };
    counts.open += 1;
    if (taskIsOverdue(task, today)) counts.overdue += 1;
    openTasksByEpisode.set(task.episode_id, counts);
  }

  const rows = snapshot.episodes
    .filter(
      (episode) =>
        episodeInScope(episode.status, filter.scope) &&
        (filter.careSetting === "all" || episode.care_setting === filter.careSetting) &&
        (filter.pathway === "all" || episode.pathway === filter.pathway) &&
        (filter.priority === "all" || episode.priority === filter.priority)
    )
    .map((episode) => {
      const counts = openTasksByEpisode.get(episode.id);
      return {
        episode,
        patient: patientById.get(episode.patient_id),
        openTasks: counts?.open ?? 0,
        overdueTasks: counts?.overdue ?? 0
      };
    });

  const settingRank = (value: string): string => (value === "inpatient" ? "0" : value === "outpatient" ? "1" : "2");
  const priorityRank = (value: string): string => ({ emergency: "0", urgent: "1", routine: "2" })[value] ?? "3";
  const sortKey = (row: PatientListRow): string =>
    [
      settingRank(row.episode.care_setting),
      priorityRank(row.episode.priority),
      normalizeText(row.episode.due_date) || "9999-99-99",
      normalizeText(row.patient?.patient_name).toLocaleLowerCase(),
      normalizeText(row.episode.case).toLocaleLowerCase(),
      row.episode.id
    ].join("|");
  return rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

export function countDistinctPatients(rows: readonly PatientListRow[]): number {
  return new Set(rows.map((row) => row.episode.patient_id)).size;
}

/** Human summary of the filter, e.g. "Inpatient · OR Booking · any priority". */
export function describePatientListFilter(filter: PatientListFilter): string {
  return [
    filter.careSetting === "all" ? "Any care setting" : careSettingLabel(filter.careSetting),
    filter.pathway === "all" ? "any pathway" : pathwayLabel(filter.pathway),
    filter.priority === "all" ? "any priority" : `${priorityLabel(filter.priority)} priority`,
    patientListScopeLabel(filter.scope).replace(/^./, (first) => first.toLocaleLowerCase())
  ].join(" · ");
}

/**
 * Note/file base name for a list. It names the filter, never a patient, and
 * keeps only characters that are safe in a vault filename on every platform.
 */
export function patientListFileBaseName(filter: PatientListFilter, today = todayIso()): string {
  const parts = [
    filter.careSetting === "all" ? "" : careSettingLabel(filter.careSetting),
    filter.pathway === "all" ? "" : pathwayLabel(filter.pathway),
    filter.priority === "all" ? "" : priorityLabel(filter.priority),
    filter.scope === "open" ? "" : filter.scope === "all" ? "All statuses" : titleCase(filter.scope)
  ].filter(Boolean);
  const descriptor = parts
    .join(" ")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return descriptor ? `Patient list ${today} ${descriptor}` : `Patient list ${today}`;
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function episodeStatusLabel(status: string): string {
  return normalizeText(status) ? titleCase(normalizeText(status)) : "Unknown";
}

interface PatientListColumn {
  heading: string;
  read: (row: PatientListRow) => string;
}

const COLUMNS: readonly PatientListColumn[] = [
  { heading: "MRN", read: (row) => (row.patient ? displayMrn(row.patient.mrn) : "Patient identity missing") },
  { heading: "Patient", read: (row) => row.patient?.patient_name || "Name not recorded" },
  { heading: "Phone", read: (row) => (row.patient ? displayPhone(row.patient.phone) : "") },
  { heading: "Case", read: (row) => row.episode.case || "Case not recorded" },
  { heading: "Setting", read: (row) => careSettingLabel(row.episode.care_setting) },
  { heading: "Pathway", read: (row) => pathwayLabel(row.episode.pathway) },
  { heading: "Priority", read: (row) => priorityLabel(row.episode.priority) },
  { heading: "Status", read: (row) => episodeStatusLabel(row.episode.status) },
  { heading: "Next action", read: (row) => row.episode.next_action },
  { heading: "Due", read: (row) => row.episode.due_date },
  { heading: "Opened", read: (row) => normalizeText(row.episode.opened_at).slice(0, 10) },
  { heading: "Open tasks", read: (row) => String(row.openTasks) },
  { heading: "Overdue tasks", read: (row) => String(row.overdueTasks) }
];

/**
 * Escapes a value for one Markdown table cell: pipes would split the cell,
 * line breaks would end the row, and brackets or angle brackets would turn
 * clinical text into links or HTML. Everything still reads the same.
 */
function markdownCell(value: string): string {
  return normalizeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "\\<")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/**
 * Builds a patient list as a Markdown note. Like the handover note, it DOES
 * contain identifiers — that is its purpose — and is written only inside the
 * configured clinical folder.
 */
export function buildPatientListMarkdown(
  rows: readonly PatientListRow[],
  filter: PatientListFilter,
  today = todayIso()
): string {
  const patients = countDistinctPatients(rows);
  const lines: string[] = [
    `# Patient list — ${today}`,
    "",
    "> Generated by Clinical Workspace from the records on this device.",
    "> Contains patient identifiers. Verify against the source records before relying on it, share it only through an approved route, and delete it after use.",
    "",
    `**Filter:** ${describePatientListFilter(filter)}`,
    "",
    `**Matches:** ${rows.length} episode${rows.length === 1 ? "" : "s"} for ${patients} patient${patients === 1 ? "" : "s"}`,
    ""
  ];
  if (!rows.length) {
    lines.push("- No episodes match this filter.", "");
    return lines.join("\n");
  }
  lines.push(
    `| # | ${COLUMNS.map((column) => column.heading).join(" | ")} |`,
    `|---|${COLUMNS.map(() => "---").join("|")}|`
  );
  rows.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${COLUMNS.map((column) => markdownCell(column.read(row))).join(" | ")} |`);
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Quotes every cell and neutralises formula-like values so Excel, Numbers,
 * Sheets, and LibreOffice cannot evaluate them. Mirrors the repository
 * logbook exporter.
 */
export function csvCell(value: string): string {
  const raw = normalizeText(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * Builds a patient list as CSV. A UTF-8 byte-order mark lets spreadsheet
 * apps show Arabic and other non-Latin names correctly, and CRLF line endings
 * follow RFC 4180.
 */
export function buildPatientListCsv(rows: readonly PatientListRow[]): string {
  const lines = [
    COLUMNS.map((column) => csvCell(column.heading)).join(","),
    ...rows.map((row) => COLUMNS.map((column) => csvCell(column.read(row))).join(","))
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
