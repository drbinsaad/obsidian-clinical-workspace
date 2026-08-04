import type { EntityType } from "../domain/types";
import { DEFAULT_ROOT_FOLDER, normalizeFolderPath } from "../domain/settings";

/**
 * The vault folder every managed record lives under.
 *
 * Held as module state rather than threaded through every call site: the root
 * is set once from settings during plugin load, and changing it afterwards is
 * a migration, not a routine operation.
 */
let clinicalRoot = DEFAULT_ROOT_FOLDER;

export function setClinicalRoot(root: string): void {
  clinicalRoot = normalizeFolderPath(root);
}

export function clinicalRootFolder(): string {
  return clinicalRoot;
}

export type ClinicalFolderKey =
  | "home"
  | "inbox"
  | "patients"
  | "episodes"
  | "tasks"
  | "procedures"
  | "documents"
  | "events"
  | "medications"
  | "attachments"
  | "bases"
  | "templates";

const FOLDER_SUFFIXES: Record<ClinicalFolderKey, string> = {
  home: "00 Home",
  inbox: "Inbox",
  patients: "Patients",
  episodes: "Episodes",
  tasks: "Tasks",
  procedures: "Procedures",
  documents: "Documents",
  events: "Events",
  medications: "Medication Library",
  attachments: "Attachments",
  bases: "Bases",
  templates: "Templates"
};

export function clinicalFolder(key: ClinicalFolderKey, root = clinicalRoot): string {
  return `${root}/${FOLDER_SUFFIXES[key]}`;
}

export function clinicalFolders(root = clinicalRoot): Record<ClinicalFolderKey, string> {
  const folders = {} as Record<ClinicalFolderKey, string>;
  for (const key of Object.keys(FOLDER_SUFFIXES) as ClinicalFolderKey[]) {
    folders[key] = clinicalFolder(key, root);
  }
  return folders;
}

export function allClinicalFolders(root = clinicalRoot): string[] {
  return Object.values(clinicalFolders(root));
}

export function folderForEntity(entity: EntityType, root = clinicalRoot): string {
  switch (entity) {
    case "patient":
      return clinicalFolder("patients", root);
    case "episode":
      return clinicalFolder("episodes", root);
    case "task":
      return clinicalFolder("tasks", root);
    case "procedure":
      return clinicalFolder("procedures", root);
    case "document":
      return clinicalFolder("documents", root);
    case "event":
      return clinicalFolder("events", root);
    case "medication-reference":
      return clinicalFolder("medications", root);
  }
}

export function pathForRecord(entity: EntityType, id: string, root = clinicalRoot): string {
  return `${folderForEntity(entity, root)}/${id}.md`;
}

export function wikilink(path: string, label?: string): string {
  const extensionless = path.replace(/\.md$/i, "");
  return label ? `[[${extensionless}|${label}]]` : `[[${extensionless}]]`;
}
