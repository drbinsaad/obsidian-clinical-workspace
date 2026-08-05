/**
 * How a NotePlan note is read.
 *
 * Every rule is overridable from a JSON file so the importer can be tuned
 * without editing code — the source layout is the one thing that cannot be
 * known in advance, and getting it wrong must be cheap to correct.
 */
export interface ImportRules {
  /** Only files matching this are considered patient notes. */
  includeGlob: string;
  /** Files matching any of these are skipped entirely (daily notes, templates). */
  exclude: string[];

  /** First capture group is the MRN. Tried in order against title, then body. */
  mrnPatterns: string[];
  /** First capture group is the patient name. */
  namePatterns: string[];
  /** First capture group is the phone number. */
  phonePatterns: string[];
  /** First capture group is the case / reason for the episode. */
  casePatterns: string[];

  /** An open to-do. First capture group is the task text. */
  openTaskPatterns: string[];
  /** A completed to-do. */
  doneTaskPatterns: string[];
  /** A cancelled to-do. */
  cancelledTaskPatterns: string[];

  /** A date attached to a task, e.g. NotePlan's `>2026-08-10`. */
  taskDatePatterns: string[];

  /** Markers that classify the episode; first match wins. */
  inpatientMarkers: string[];
  urgentMarkers: string[];
  emergencyMarkers: string[];

  /** Applied to the whole note; a match means "skip, this is not a patient". */
  notAPatientMarkers: string[];
}

/**
 * Defaults reflect NotePlan's documented syntax: `*` bullets for to-dos,
 * `[ ]`/`[x]`/`[-]` for open/done/cancelled, and `>YYYY-MM-DD` for scheduling.
 * Common alternatives are accepted too, because a real vault is never uniform.
 */
export const DEFAULT_RULES: ImportRules = {
  // NotePlan stores ordinary notes as either .txt or .md depending on the
  // app/version that created them. Both contain Markdown-compatible text.
  includeGlob: "**/*.{md,txt}",
  exclude: [
    "**/@Templates/**",
    "**/@Archive/**",
    "**/@Trash/**",
    // NotePlan calendar notes are dated filenames, not patients.
    "**/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].md",
    "**/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].txt",
    "**/[0-9][0-9][0-9][0-9]-W[0-9]*.md",
    "**/[0-9][0-9][0-9][0-9]-W[0-9]*.txt"
  ],

  mrnPatterns: [
    "(?:MRN|mrn|Medical Record(?: Number)?|File No\\.?|Chart)\\s*[:#-]?\\s*([0-9][0-9 -]*[0-9])",
    "^#\\s*([0-9]{4,})\\b",
    "^([0-9]{4,})\\s*[-–—]\\s*"
  ],
  namePatterns: [
    "(?:Name|Patient)\\s*[:-]\\s*(.+)$",
    "^#\\s*[0-9]{4,}\\s*[-–—]\\s*(.+)$",
    "^#\\s+(?![0-9])(.+)$"
  ],
  phonePatterns: [
    "(?:Phone|Tel|Mobile|Contact)\\s*[:-]\\s*([+0-9][0-9 ()-]{6,})"
  ],
  casePatterns: [
    "(?:Case|Reason|Diagnosis|Dx|Problem|Complaint)\\s*[:-]\\s*(.+)$",
    "^##\\s+(?:Plan|Problem|Diagnosis)\\s*$\\n+\\s*[-*]\\s*(.+)$"
  ],

  openTaskPatterns: ["^\\s*[*+-]\\s*\\[ \\]\\s*(.+)$", "^\\s*\\*\\s+(?!\\[)(.+)$"],
  doneTaskPatterns: ["^\\s*[*+-]\\s*\\[[xX]\\]\\s*(.+)$"],
  cancelledTaskPatterns: ["^\\s*[*+-]\\s*\\[-\\]\\s*(.+)$"],
  taskDatePatterns: [">(\\d{4}-\\d{2}-\\d{2})", "@due\\((\\d{4}-\\d{2}-\\d{2})\\)", "\\((\\d{4}-\\d{2}-\\d{2})\\)"],

  inpatientMarkers: ["#inpatient", "#ward", "#admitted", "Inpatient"],
  urgentMarkers: ["#urgent", "#soon", "Urgent"],
  emergencyMarkers: ["#emergency", "#stat", "#critical", "Emergency"],

  notAPatientMarkers: ["#template", "#meeting", "#teaching", "#admin", "#reference"]
};

export function mergeRules(overrides: Partial<ImportRules> | null | undefined): ImportRules {
  if (!overrides) return DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...overrides };
}

/** Applies each pattern in turn, returning the first capture that matches. */
export function firstMatch(patterns: string[], text: string): string | null {
  for (const pattern of patterns) {
    const match = new RegExp(pattern, "m").exec(text);
    const captured = match?.[1]?.trim();
    if (captured) return captured;
  }
  return null;
}

export function allMatches(patterns: string[], text: string): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern, "gm"))) {
      const captured = match[1]?.trim();
      if (captured) found.push(captured);
    }
  }
  return found;
}
