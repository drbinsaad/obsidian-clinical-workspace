import type { EntityType } from "../domain/types";

export const CLINICAL_ROOT = "Clinical Workspace";

export const CLINICAL_FOLDERS = {
  home: `${CLINICAL_ROOT}/00 Home`,
  inbox: `${CLINICAL_ROOT}/Inbox`,
  patients: `${CLINICAL_ROOT}/Patients`,
  episodes: `${CLINICAL_ROOT}/Episodes`,
  tasks: `${CLINICAL_ROOT}/Tasks`,
  procedures: `${CLINICAL_ROOT}/Procedures`,
  documents: `${CLINICAL_ROOT}/Documents`,
  events: `${CLINICAL_ROOT}/Events`,
  medications: `${CLINICAL_ROOT}/Medication Library`,
  attachments: `${CLINICAL_ROOT}/Attachments`,
  bases: `${CLINICAL_ROOT}/Bases`,
  templates: `${CLINICAL_ROOT}/Templates`
} as const;

export const ALL_CLINICAL_FOLDERS = Object.values(CLINICAL_FOLDERS);

export function folderForEntity(entity: EntityType): string {
  switch (entity) {
    case "patient":
      return CLINICAL_FOLDERS.patients;
    case "episode":
      return CLINICAL_FOLDERS.episodes;
    case "task":
      return CLINICAL_FOLDERS.tasks;
    case "procedure":
      return CLINICAL_FOLDERS.procedures;
    case "document":
      return CLINICAL_FOLDERS.documents;
    case "event":
      return CLINICAL_FOLDERS.events;
    case "medication-reference":
      return CLINICAL_FOLDERS.medications;
  }
}

export function pathForRecord(entity: EntityType, id: string): string {
  return `${folderForEntity(entity)}/${id}.md`;
}

export function wikilink(path: string, label?: string): string {
  const extensionless = path.replace(/\.md$/i, "");
  return label ? `[[${extensionless}|${label}]]` : `[[${extensionless}]]`;
}
