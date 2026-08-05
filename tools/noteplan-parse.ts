import path from "node:path";
import { normalizeMrn, normalizePhone, normalizeText } from "../src/domain/schema";
import type { CareSetting, Priority } from "../src/domain/types";
import { allMatches, firstMatch, type ImportRules } from "./noteplan-rules";

export interface ParsedTask {
  text: string;
  due: string;
}

export interface ParsedNote {
  file: string;
  mrn: string;
  patientName: string;
  phone: string;
  caseName: string;
  careSetting: CareSetting;
  priority: Priority;
  openTasks: ParsedTask[];
  doneTasks: number;
  cancelledTasks: number;
  /** Things the rules could not work out; shown in the dry-run report. */
  problems: string[];
}

/** Calendar notes are dated filenames, never patients. */
export function isCalendarNote(file: string): boolean {
  const name = path.basename(file);
  return /^\d{8}\.(?:md|txt)$/.test(name) || /^\d{4}-W\d+\.(?:md|txt)$/.test(name);
}

export function isExcluded(file: string, rules: ImportRules): boolean {
  if (isCalendarNote(file)) return true;
  const normalized = file.split(path.sep).join("/");
  return rules.exclude.some((pattern) => path.matchesGlob(normalized, pattern));
}

/**
 * Reads one NotePlan note into an import intent.
 *
 * Returns null when the note is not recognisably a patient — a template, a
 * meeting, or anything with neither an MRN nor a name. Being conservative here
 * matters: a false positive becomes a fabricated patient record.
 */
export function parseNote(file: string, content: string, rules: ImportRules): ParsedNote | null {
  if (rules.notAPatientMarkers.some((marker) => content.includes(marker))) return null;

  const problems: string[] = [];
  const title = content.split("\n").find((line) => line.startsWith("# ")) ?? path.basename(file, ".md");
  const searchable = `${title}\n${content}`;

  const mrn = normalizeMrn(firstMatch(rules.mrnPatterns, searchable) ?? "");
  const patientName = normalizeText(firstMatch(rules.namePatterns, searchable) ?? "");
  const phone = normalizePhone(firstMatch(rules.phonePatterns, searchable) ?? "");
  let caseName = normalizeText(firstMatch(rules.casePatterns, content) ?? "");

  // A heading alone is not a patient. Without an MRN there must be some other
  // clinical signal — a phone number or a stated reason — or every scratch note
  // with a title becomes a fabricated patient record. Under-importing is
  // recoverable; inventing patients is not.
  if (!mrn && !(patientName && (phone || caseName))) return null;
  if (!mrn) problems.push("no MRN found");
  if (!patientName) problems.push("no patient name found");
  if (!caseName) {
    // Note titles in the source are commonly patient names. Reusing that as a
    // clinical case silently turns identity into diagnosis, so keep the gap
    // explicit and send it to review instead.
    caseName = "Imported patient follow-up";
    problems.push("no case/reason found — used a review placeholder");
  }

  const dateOf = (line: string): string => firstMatch(rules.taskDatePatterns, line) ?? "";
  const strip = (line: string): string =>
    normalizeText(
      rules.taskDatePatterns
        .reduce((acc, pattern) => acc.replace(new RegExp(pattern, "g"), ""), line)
        .replace(/#[\w/-]+/g, "")
    );

  const seen = new Set<string>();
  const openTasks: ParsedTask[] = [];
  for (const line of allMatches(rules.openTaskPatterns, content)) {
    const text = strip(line);
    const due = dateOf(line);
    // The same line can match more than one open-task pattern.
    const key = `${text}\u0000${due}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    openTasks.push({ text, due });
  }

  const careSetting: CareSetting = rules.inpatientMarkers.some((m) => content.includes(m))
    ? "inpatient"
    : "outpatient";
  const priority: Priority = rules.emergencyMarkers.some((m) => content.includes(m))
    ? "emergency"
    : rules.urgentMarkers.some((m) => content.includes(m))
      ? "urgent"
      : "routine";

  return {
    file,
    mrn,
    patientName,
    phone,
    caseName,
    careSetting,
    priority,
    openTasks,
    doneTasks: allMatches(rules.doneTaskPatterns, content).length,
    cancelledTasks: allMatches(rules.cancelledTaskPatterns, content).length,
    problems
  };
}
