import { clinicalFolder, clinicalRootFolder } from "./paths";

/**
 * Native Obsidian Bases definitions, created once in the vault.
 *
 * Each base is named for the entity it actually queries, and every folder
 * reference is derived from the configured root so a migration can regenerate
 * them. Obsidian does not rewrite folder strings inside a base when a folder is
 * renamed, so these must be regenerated explicitly.
 *
 * Generated content is versioned. A base still byte-identical to any version
 * this plugin shipped counts as untouched and is upgraded to the latest, so a
 * released version must never be edited: add a new one instead.
 */
type FolderQuote = (folder: string) => string;

/**
 * The folder sits inside a YAML single-quoted scalar, where an apostrophe must
 * be doubled. Versions up to 0.6.9 wrote it raw, which made every base
 * unparseable for a root such as "St John's Ward".
 */
export function quoteBaseFolder(folder: string): string {
  return folder.replaceAll("'", "''");
}

const unquotedFolder: FolderQuote = (folder) => folder;

/** The folder filter expression a generated base uses for `folder`. */
export function baseFolderFilter(folder: string): string {
  return `file.inFolder("${quoteBaseFolder(folder)}")`;
}

function baseFor(quote: FolderQuote, sourceFolder: string, entity: string, body: string[]): string {
  return [
    "filters:",
    "  and:",
    `    - 'file.inFolder("${quote(sourceFolder)}")'`,
    `    - 'file.ext == "md"'`,
    `    - 'entity == "${entity}"'`,
    ...body,
    ""
  ].join("\n");
}

/** The latest generated bases for `root`. */
export function baseFiles(root = clinicalRootFolder()): Record<string, string> {
  return baseFilesV2(root, quoteBaseFolder);
}

/**
 * Every set of bases this plugin has written for `root`, newest first, each
 * exactly as it shipped. Used only to recognise untouched files.
 */
export function generatedBaseVersions(root: string): Record<string, string>[] {
  return [baseFiles(root), baseFilesV1(root, unquotedFolder)];
}

/**
 * Version 2: the Surgery logbook view lists completed procedures only, as the
 * in-app counts and the CSV exporter do. Cancelled and entered-in-error
 * entries move to their own view instead of silently inflating the logbook.
 */
function baseFilesV2(root: string, quote: FolderQuote): Record<string, string> {
  const files = baseFilesV1(root, quote);
  files[`${clinicalFolder("bases", root)}/Surgery Logbook.base`] = baseFor(
    quote,
    clinicalFolder("procedures", root),
    "procedure",
    [
      "properties:",
      "  patient:",
      "    displayName: Patient",
      "  procedure:",
      "    displayName: Procedure",
      "  procedure_date:",
      "    displayName: Date",
      "  role:",
      "    displayName: Role",
      "  status:",
      "    displayName: Status",
      "  follow_up_required:",
      "    displayName: Follow-up required",
      "  follow_up_date:",
      "    displayName: Follow-up date",
      "views:",
      "  - type: table",
      "    name: Surgery logbook",
      "    filters:",
      "      and:",
      `        - 'status == "completed"'`,
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
      "        direction: DESC",
      "  - type: table",
      "    name: Retracted",
      "    filters:",
      "      or:",
      `        - 'status == "cancelled"'`,
      `        - 'status == "entered-in-error"'`,
      "    order:",
      "      - patient",
      "      - procedure",
      "      - procedure_date",
      "      - status",
      "    sort:",
      "      - property: procedure_date",
      "        direction: DESC"
    ]
  );
  return files;
}

/** Version 1: shipped from 0.2.0 through 0.6.9. Frozen. */
function baseFilesV1(root: string, quote: FolderQuote): Record<string, string> {
  const bases = clinicalFolder("bases", root);
  const baseFor1 = (sourceFolder: string, entity: string, body: string[]): string =>
    baseFor(quote, sourceFolder, entity, body);
  return {
    [`${bases}/Patients.base`]: baseFor1(clinicalFolder("patients", root), "patient", [
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

    [`${bases}/Episodes.base`]: baseFor1(clinicalFolder("episodes", root), "episode", [
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

    [`${bases}/Tasks.base`]: baseFor1(clinicalFolder("tasks", root), "task", [
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

    [`${bases}/Surgery Logbook.base`]: baseFor1(clinicalFolder("procedures", root), "procedure", [
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

const HOME_OPEN_LINE =
  "Run **Clinical Workspace: Open workspace** (or tap the stethoscope ribbon icon) for the mobile patient, task and surgery interface.";

/**
 * The opening line shipped up to 0.6.9. It named a command that does not
 * exist; kept only so untouched home notes are still recognised and upgraded.
 */
export const LEGACY_HOME_OPEN_LINE =
  "Use the **Open Clinical Workspace** command for the mobile patient, task and surgery interface.";

export function homeNote(root = clinicalRootFolder(), openLine = HOME_OPEN_LINE): string {
  const bases = clinicalFolder("bases", root);
  return [
    "# Clinical Workspace",
    "",
    openLine,
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
