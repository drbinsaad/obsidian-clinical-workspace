import { clinicalFolder, clinicalRootFolder } from "./paths";

/**
 * Native Obsidian Bases definitions, created once in the vault.
 *
 * Each base is named for the entity it actually queries, and every folder
 * reference is derived from the configured root so a migration can regenerate
 * them. Obsidian does not rewrite folder strings inside a base when a folder is
 * renamed, so these must be regenerated explicitly.
 */
function baseFor(sourceFolder: string, entity: string, body: string[]): string {
  return [
    "filters:",
    "  and:",
    `    - 'file.inFolder("${sourceFolder}")'`,
    `    - 'file.ext == "md"'`,
    `    - 'entity == "${entity}"'`,
    ...body,
    ""
  ].join("\n");
}

export function baseFiles(root = clinicalRootFolder()): Record<string, string> {
  const bases = clinicalFolder("bases", root);
  return {
    [`${bases}/Patients.base`]: baseFor(clinicalFolder("patients", root), "patient", [
      "properties:",
      "  patient_name:",
      "    displayName: Patient",
      "  mrn:",
      "    displayName: MRN",
      "  mrn_status:",
      "    displayName: MRN status",
      "  phone:",
      "    displayName: Phone",
      "  status:",
      "    displayName: Status",
      "views:",
      "  - type: table",
      "    name: All patients",
      "    filters:",
      "      and:",
      `        - 'status != "entered-in-error"'`,
      "    order:",
      "      - patient_name",
      "      - mrn",
      "      - phone",
      "      - status",
      "    sort:",
      "      - property: patient_name",
      "        direction: ASC",
      "  - type: table",
      "    name: Needs identity review",
      "    filters:",
      "      or:",
      `        - 'mrn_status == "missing"'`,
      `        - 'patient_name == ""'`,
      "    order:",
      "      - patient_name",
      "      - mrn",
      "      - phone",
      "    sort:",
      "      - property: patient_name",
      "        direction: ASC"
    ]),

    [`${bases}/Episodes.base`]: baseFor(clinicalFolder("episodes", root), "episode", [
      "properties:",
      "  patient:",
      "    displayName: Patient",
      "  case:",
      "    displayName: Case",
      "  care_setting:",
      "    displayName: Care setting",
      "  pathway:",
      "    displayName: Pathway",
      "  priority:",
      "    displayName: Priority",
      "  next_action:",
      "    displayName: Next action",
      "  due_date:",
      "    displayName: Due date",
      "views:",
      "  - type: table",
      "    name: Active episodes",
      "    filters:",
      "      and:",
      `        - 'status != "archived"'`,
      `        - 'status != "cancelled"'`,
      `        - 'status != "entered-in-error"'`,
      "    groupBy:",
      "      property: pathway",
      "      direction: ASC",
      "    order:",
      "      - patient",
      "      - case",
      "      - care_setting",
      "      - pathway",
      "      - priority",
      "      - next_action",
      "      - due_date",
      "    sort:",
      "      - property: due_date",
      "        direction: ASC",
      "  - type: table",
      "    name: Archive",
      "    filters:",
      "      and:",
      `        - 'status == "archived"'`,
      "    order:",
      "      - patient",
      "      - case",
      "      - outcome",
      "      - closed_at",
      "    sort:",
      "      - property: closed_at",
      "        direction: DESC"
    ]),

    [`${bases}/Tasks.base`]: baseFor(clinicalFolder("tasks", root), "task", [
      "properties:",
      "  patient:",
      "    displayName: Patient",
      "  task:",
      "    displayName: Task",
      "  due_date:",
      "    displayName: Due date",
      "  priority:",
      "    displayName: Priority",
      "  owner:",
      "    displayName: Owner",
      "views:",
      "  - type: table",
      "    name: Open tasks",
      "    filters:",
      "      and:",
      `        - 'status != "completed"'`,
      `        - 'status != "cancelled"'`,
      `        - 'status != "entered-in-error"'`,
      "    groupBy:",
      "      property: due_date",
      "      direction: ASC",
      "    order:",
      "      - patient",
      "      - task",
      "      - task_type",
      "      - due_date",
      "      - priority",
      "      - owner",
      "    sort:",
      "      - property: due_date",
      "        direction: ASC",
      "  - type: table",
      "    name: Completed",
      "    filters:",
      "      and:",
      `        - 'status == "completed"'`,
      "    order:",
      "      - patient",
      "      - task",
      "      - completed_at",
      "    sort:",
      "      - property: completed_at",
      "        direction: DESC"
    ]),

    [`${bases}/Surgery Logbook.base`]: baseFor(clinicalFolder("procedures", root), "procedure", [
      "properties:",
      "  patient:",
      "    displayName: Patient",
      "  procedure:",
      "    displayName: Procedure",
      "  procedure_date:",
      "    displayName: Date",
      "  role:",
      "    displayName: Role",
      "  follow_up_required:",
      "    displayName: Follow-up required",
      "  follow_up_date:",
      "    displayName: Follow-up date",
      "views:",
      "  - type: table",
      "    name: Surgery logbook",
      "    order:",
      "      - patient",
      "      - procedure",
      "      - procedure_date",
      "      - role",
      "      - outcome",
      "      - follow_up_required",
      "      - follow_up_date",
      "    sort:",
      "      - property: procedure_date",
      "        direction: DESC"
    ])
  };
}

/** Folder each base must query, used to detect one whose content is stale. */
export function baseSourceFolders(root = clinicalRootFolder()): Record<string, string> {
  const bases = clinicalFolder("bases", root);
  return {
    [`${bases}/Patients.base`]: clinicalFolder("patients", root),
    [`${bases}/Episodes.base`]: clinicalFolder("episodes", root),
    [`${bases}/Tasks.base`]: clinicalFolder("tasks", root),
    [`${bases}/Surgery Logbook.base`]: clinicalFolder("procedures", root)
  };
}

export function homeNote(root = clinicalRootFolder()): string {
  const bases = clinicalFolder("bases", root);
  return [
    "# Clinical Workspace",
    "",
    "Use the **Open Clinical Workspace** command for the mobile patient, task and surgery interface.",
    "",
    "## Database views",
    "",
    `- ![[${bases}/Patients.base#All patients]]`,
    `- ![[${bases}/Episodes.base#Active episodes]]`,
    `- ![[${bases}/Tasks.base#Open tasks]]`,
    `- ![[${bases}/Surgery Logbook.base#Surgery logbook]]`,
    ""
  ].join("\n");
}
