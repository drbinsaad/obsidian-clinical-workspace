import type { CareSetting, Pathway, Priority } from "./types";

export interface ClinicalSettings {
  /**
   * Recorded as the actor on every audit note. Without it the whole trail
   * reads `local-user`, which tells you nothing if the vault is ever opened
   * on another device or shared with a colleague.
   */
  clinicianName: string;

  /** Root folder for every managed record. Changing this requires a migration. */
  rootFolder: string;

  defaultCareSetting: CareSetting;
  defaultPathway: Pathway;
  defaultPriority: Priority;

  /** Require a typed confirmation before an episode is archived. */
  confirmBeforeDischarge: boolean;

  /** Run the integrity check once when the workspace is first opened. */
  runIntegrityOnStartup: boolean;

  /** Milliseconds to coalesce vault change events before redrawing. */
  refreshDebounceMs: number;
}

export const DEFAULT_ROOT_FOLDER = "Clinical Workspace";

export const DEFAULT_SETTINGS: ClinicalSettings = {
  clinicianName: "",
  rootFolder: DEFAULT_ROOT_FOLDER,
  defaultCareSetting: "outpatient",
  defaultPathway: "assessment",
  defaultPriority: "routine",
  confirmBeforeDischarge: false,
  runIntegrityOnStartup: false,
  refreshDebounceMs: 180
};

const MIN_DEBOUNCE = 0;
const MAX_DEBOUNCE = 2000;

/**
 * Coerces whatever is on disk into a usable settings object.
 *
 * `data.json` is user-editable and survives across versions, so every field is
 * validated rather than trusted. An unrecognised value falls back to its
 * default instead of propagating into the workflow.
 */
export function normalizeSettings(
  stored: unknown,
  allowed: {
    careSettings: readonly string[];
    pathways: readonly string[];
    priorities: readonly string[];
  }
): ClinicalSettings {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  // Folder names are NOT whitespace-collapsed: "Ward  Records" with two spaces
  // is a different folder from "Ward Records", and silently rewriting it would
  // point the plugin at somewhere the records are not.
  const folder = (value: unknown): string => {
    if (typeof value !== "string") return DEFAULT_ROOT_FOLDER;
    const candidate = normalizeFolderPath(value.trim());
    return validateRootFolder(candidate) ? DEFAULT_ROOT_FOLDER : candidate;
  };
  const pick = <T extends string>(value: unknown, options: readonly string[], fallback: T): T =>
    typeof value === "string" && options.includes(value) ? (value as T) : fallback;

  const debounce =
    typeof raw.refreshDebounceMs === "number"
      ? raw.refreshDebounceMs
      : typeof raw.refreshDebounceMs === "string" && raw.refreshDebounceMs.trim() !== ""
        ? Number(raw.refreshDebounceMs)
        : Number.NaN;

  return {
    // An empty clinician name is meaningful: it means "not set".
    clinicianName: typeof raw.clinicianName === "string" ? raw.clinicianName.replace(/\s+/g, " ").trim() : "",
    rootFolder: folder(raw.rootFolder),
    defaultCareSetting: pick(raw.defaultCareSetting, allowed.careSettings, DEFAULT_SETTINGS.defaultCareSetting),
    defaultPathway: pick(raw.defaultPathway, allowed.pathways, DEFAULT_SETTINGS.defaultPathway),
    defaultPriority: pick(raw.defaultPriority, allowed.priorities, DEFAULT_SETTINGS.defaultPriority),
    confirmBeforeDischarge: raw.confirmBeforeDischarge === true,
    runIntegrityOnStartup: raw.runIntegrityOnStartup === true,
    refreshDebounceMs: Number.isFinite(debounce)
      ? Math.min(MAX_DEBOUNCE, Math.max(MIN_DEBOUNCE, Math.round(debounce)))
      : DEFAULT_SETTINGS.refreshDebounceMs
  };
}

/** Strips leading/trailing slashes and collapses separators. */
export function normalizeFolderPath(value: string): string {
  const cleaned = value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  return cleaned || DEFAULT_ROOT_FOLDER;
}

/** Characters Obsidian rejects in a path, plus the ones that break wikilinks. */
const INVALID_FOLDER_CHARS = /[\\:*?"<>|#^[\]]/;

export function validateRootFolder(value: string): string | null {
  const folder = normalizeFolderPath(value);
  if (!folder) return "Enter a folder name.";
  if (INVALID_FOLDER_CHARS.test(folder)) {
    return 'A folder name cannot contain \\ : * ? " < > | # ^ [ or ].';
  }
  const segments = folder.split("/");
  if (segments.some((segment) => !segment.trim())) return "A folder path cannot contain an empty segment.";
  // "." and ".." are checked per segment, not just at the start: a target like
  // "Clinical/../../Documents" resolves outside the vault, and the migration
  // would move the entire patient folder there.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "A folder path cannot contain . or .. segments.";
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return "A folder name cannot start with a dot.";
  }
  return null;
}

export function auditActor(settings: ClinicalSettings): string {
  return settings.clinicianName || "local-user";
}
