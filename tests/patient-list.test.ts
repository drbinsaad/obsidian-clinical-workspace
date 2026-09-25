/**
 * Patient-list export: choosing any patient type (care setting, pathway,
 * priority, episode status) and saving the matching patients to a Markdown
 * note or a CSV file inside the clinical documents folder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clinicalFolder } from "../src/data/paths";
import type { ClinicalRepository } from "../src/data/repository";
import type {
  ClinicalSnapshot,
  EpisodeRecord,
  PatientRecord,
  TaskRecord
} from "../src/domain/types";
import type { ClinicalService } from "../src/services/clinical-service";
import type { IntegrityService } from "../src/services/integrity";
import {
  DEFAULT_PATIENT_LIST_FILTER,
  buildPatientListCsv,
  buildPatientListMarkdown,
  countDistinctPatients,
  csvCell,
  describePatientListFilter,
  normalizePatientListFilter,
  patientListFileBaseName,
  selectPatientListRows,
  type PatientListFilter
} from "../src/services/patient-list";
import { ClinicalWorkspaceView } from "../src/ui/workspace-view";
import { installTestDomGlobals, TestElement } from "./support/dom-harness";
import { episodeInput, harness } from "./support/harness";

installTestDomGlobals();
// esbuild defines this flag in real builds; the More tab reads it.
(globalThis as { __DEV_TOOLS__?: boolean }).__DEV_TOOLS__ = false;

const TODAY = "2026-09-23";

function patient(id: string, overrides: Partial<PatientRecord> = {}): PatientRecord {
  return {
    schema_version: 3,
    entity: "patient",
    id,
    created_at: "2026-09-01T08:00:00.000Z",
    updated_at: "2026-09-01T08:00:00.000Z",
    tags: ["clinical/patient"],
    mrn: "9000000101",
    mrn_status: "confirmed",
    patient_name: "Synthetic Patient",
    phone: "0500000001",
    phone_status: "confirmed",
    status: "active",
    merged_into: "",
    ...overrides
  };
}

function episode(id: string, patientId: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    schema_version: 3,
    entity: "episode",
    id,
    created_at: "2026-09-01T08:00:00.000Z",
    updated_at: "2026-09-01T08:00:00.000Z",
    tags: ["clinical/episode"],
    patient_id: patientId,
    patient: "",
    case: "Synthetic case",
    care_setting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    status: "active",
    next_action: "",
    due_date: "",
    opened_at: "2026-09-01T08:00:00.000Z",
    closed_at: "",
    outcome: "",
    pathway_before_archive: "",
    status_before_archive: "",
    ...overrides
  };
}

function task(id: string, episodeId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema_version: 3,
    entity: "task",
    id,
    created_at: "2026-09-01T08:00:00.000Z",
    updated_at: "2026-09-01T08:00:00.000Z",
    tags: ["clinical/task"],
    patient_id: "",
    patient: "",
    episode_id: episodeId,
    episode: "",
    task: "Synthetic task",
    task_type: "other",
    status: "open",
    priority: "routine",
    due_date: "",
    owner: "",
    completed_at: "",
    cancelled_at: "",
    cancel_reason: "",
    idempotency_key: `key-${id}`,
    ...overrides
  };
}

/** First element of a fixture array, asserted present for strict indexing. */
function first<T>(items: readonly T[]): T {
  const item = items[0];
  assert.ok(item !== undefined);
  return item;
}

/** Two synthetic patients spread across every filter dimension. */
function mixedSnapshot(): ClinicalSnapshot {
  return {
    patients: [
      patient("PAT-alpha", { mrn: "9000000101", patient_name: "Synthetic Alpha" }),
      patient("PAT-beta", { mrn: "9000000102", patient_name: "Synthetic Beta" })
    ],
    episodes: [
      episode("EPI-ward", "PAT-alpha", {
        case: "Synthetic airway watch",
        care_setting: "inpatient",
        pathway: "assessment",
        priority: "urgent",
        next_action: "Overnight observations",
        due_date: "2026-09-22"
      }),
      episode("EPI-or", "PAT-alpha", {
        case: "Synthetic tonsillectomy",
        care_setting: "outpatient",
        pathway: "or-booking",
        priority: "routine"
      }),
      episode("EPI-opd", "PAT-beta", {
        case: "Synthetic clinic review",
        pathway: "opd-follow-up",
        priority: "emergency",
        status: "on-hold"
      }),
      episode("EPI-done", "PAT-beta", {
        case: "Synthetic discharged case",
        care_setting: "inpatient",
        status: "archived"
      }),
      episode("EPI-error", "PAT-beta", { case: "Synthetic mistake", status: "entered-in-error" })
    ],
    tasks: [
      task("TSK-late", "EPI-ward", { due_date: "2026-09-22" }),
      task("TSK-soon", "EPI-ward", { due_date: "2026-09-30" }),
      task("TSK-closed", "EPI-ward", { status: "completed", due_date: "2026-09-01" })
    ],
    procedures: []
  };
}

const filter = (overrides: Partial<PatientListFilter> = {}): PatientListFilter => ({
  ...DEFAULT_PATIENT_LIST_FILTER,
  ...overrides
});

test("the default list holds every open episode, inpatients first, then by priority", () => {
  const rows = selectPatientListRows(mixedSnapshot(), filter(), TODAY);
  assert.deepEqual(
    rows.map((row) => row.episode.id),
    ["EPI-ward", "EPI-opd", "EPI-or"],
    "archived and entered-in-error episodes stay out of the open list"
  );
  assert.equal(countDistinctPatients(rows), 2);
  const ward = rows[0];
  assert.ok(ward);
  assert.equal(ward.patient?.patient_name, "Synthetic Alpha");
  assert.equal(ward.openTasks, 2, "completed work is not open work");
  assert.equal(ward.overdueTasks, 1);
});

test("each patient type can be selected on its own or in combination", () => {
  const snapshot = mixedSnapshot();
  const ids = (overrides: Partial<PatientListFilter>): string[] =>
    selectPatientListRows(snapshot, filter(overrides), TODAY).map((row) => row.episode.id);

  assert.deepEqual(ids({ careSetting: "inpatient" }), ["EPI-ward"]);
  assert.deepEqual(ids({ careSetting: "outpatient" }), ["EPI-opd", "EPI-or"]);
  assert.deepEqual(ids({ pathway: "or-booking" }), ["EPI-or"]);
  assert.deepEqual(ids({ priority: "emergency" }), ["EPI-opd"]);
  assert.deepEqual(ids({ scope: "on-hold" }), ["EPI-opd"]);
  assert.deepEqual(ids({ scope: "archived" }), ["EPI-done"]);
  assert.deepEqual(ids({ scope: "archived", careSetting: "inpatient" }), ["EPI-done"]);
  assert.deepEqual(ids({ careSetting: "inpatient", priority: "routine" }), []);
  assert.deepEqual(
    ids({ scope: "all" }),
    ["EPI-ward", "EPI-done", "EPI-opd", "EPI-or"],
    "every status except entered-in-error"
  );
});

test("unrecognised filter values fall back to the widest valid choice", () => {
  assert.deepEqual(
    normalizePatientListFilter({
      careSetting: "ward" as never,
      pathway: "unknown" as never,
      priority: "stat" as never,
      scope: "deleted" as never
    }),
    DEFAULT_PATIENT_LIST_FILTER
  );
  assert.deepEqual(normalizePatientListFilter(undefined), DEFAULT_PATIENT_LIST_FILTER);
  assert.deepEqual(
    normalizePatientListFilter({ pathway: "or-booking", priority: "urgent" }),
    filter({ pathway: "or-booking", priority: "urgent" })
  );
});

test("the Markdown list names its filter, counts matches, and keeps each row intact", () => {
  const snapshot = mixedSnapshot();
  first(snapshot.patients).patient_name = "Synthetic | Pipe [[Link]] <b>";
  first(snapshot.episodes).next_action = "Line one\nline two";
  const note = buildPatientListMarkdown(
    selectPatientListRows(snapshot, filter({ careSetting: "inpatient" }), TODAY),
    filter({ careSetting: "inpatient" }),
    TODAY
  );
  assert.match(note, /^# Patient list — 2026-09-23/);
  assert.match(note, /Contains patient identifiers/);
  assert.match(note, /\*\*Filter:\*\* Inpatient · any pathway · any priority · open episodes/);
  assert.match(note, /\*\*Matches:\*\* 1 episode for 1 patient/);
  assert.match(note, /\| # \| MRN \| Patient \| Phone \| Case \|/);
  assert.match(note, /Synthetic \\\| Pipe \\\[\\\[Link\\\]\\\] \\<b>/, "cell text cannot split the table or become a link");
  assert.match(note, /Line one line two/, "a line break cannot end the table row early");
  const tableRows = note.split("\n").filter((line) => line.startsWith("| 1 |"));
  assert.equal(tableRows.length, 1);

  const empty = buildPatientListMarkdown([], filter({ pathway: "consultation" }), TODAY);
  assert.match(empty, /No episodes match this filter/);
  assert.doesNotMatch(empty, /\| # \|/);
});

test("the CSV list opens cleanly in spreadsheets and cannot run formulas", () => {
  const snapshot = mixedSnapshot();
  first(snapshot.patients).patient_name = "مريض تجريبي";
  first(snapshot.episodes).case = '=HYPERLINK("synthetic")';
  first(snapshot.episodes).next_action = "@SUM(1)";
  const csv = buildPatientListCsv(selectPatientListRows(snapshot, filter({ careSetting: "inpatient" }), TODAY));
  assert.ok(csv.startsWith("\uFEFF"), "a byte-order mark lets Excel show Arabic names");
  const [header = "", row = "", ...rest] = csv.slice(1).split("\r\n");
  assert.deepEqual(rest, [""], "one header, one data row, and a final line break");
  assert.match(header, /^"MRN","Patient","Phone","Case","Setting","Pathway","Priority","Status",/);
  assert.match(row, /"مريض تجريبي"/);
  assert.match(row, /"'=HYPERLINK\(""synthetic""\)"/);
  assert.match(row, /"'@SUM\(1\)"/);
  assert.equal(csvCell("+966"), `"'+966"`);
  assert.equal(csvCell("-1"), `"'-1"`);
  assert.equal(csvCell('He said "hi"'), `"He said ""hi"""`);
});

test("the Status column uses the patient sheet's words, and a hand-edited status stays readable", () => {
  const snapshot = mixedSnapshot();
  snapshot.episodes.push(
    episode("EPI-ready", "PAT-alpha", { case: "Synthetic ready case", status: "ready-to-close" }),
    episode("EPI-hand", "PAT-alpha", { case: "Synthetic hand-edited case", status: "awaiting-bed" as never })
  );
  const csv = buildPatientListCsv(selectPatientListRows(snapshot, filter({ scope: "all" }), TODAY));
  // Status is the eighth column.
  const statusOf = (caseName: string): string | undefined =>
    csv
      .split("\r\n")
      .find((line) => line.includes(`"${caseName}"`))
      ?.split('","')[7];
  assert.equal(statusOf("Synthetic airway watch"), "Active");
  assert.equal(statusOf("Synthetic clinic review"), "On Hold");
  assert.equal(statusOf("Synthetic ready case"), "Ready to Close");
  assert.equal(statusOf("Synthetic discharged case"), "Archived");
  assert.equal(statusOf("Synthetic hand-edited case"), "Awaiting Bed");
});

test("list names describe the filter, never a patient, and are safe filenames", () => {
  assert.equal(patientListFileBaseName(filter(), TODAY), "Patient list 2026-09-23");
  assert.equal(
    patientListFileBaseName(filter({ careSetting: "inpatient", pathway: "result-review", priority: "urgent" }), TODAY),
    "Patient list 2026-09-23 Inpatient Result Image Review Urgent"
  );
  assert.equal(
    patientListFileBaseName(filter({ scope: "archived" }), TODAY),
    "Patient list 2026-09-23 Archived"
  );
  assert.equal(
    describePatientListFilter(filter({ pathway: "or-booking", priority: "emergency", scope: "all" })),
    "Any care setting · OR Booking · Emergency priority · every status except entered in error"
  );
});

test("generated CSV files land in their folder, never overwrite, and respect the barrier", async () => {
  const { app, repository } = await harness();
  const folder = clinicalFolder("documents");
  const first = await repository.createLooseFile(folder, "Patient list 2026-09-23", "csv", "one");
  const second = await repository.createLooseFile(folder, "Patient list 2026-09-23", "csv", "two");
  const note = await repository.createLooseFile(folder, "Patient list 2026-09-23", "md", "three");
  assert.equal(first, `${folder}/Patient list 2026-09-23.csv`);
  assert.equal(second, `${folder}/Patient list 2026-09-23 2.csv`);
  assert.equal(note, `${folder}/Patient list 2026-09-23.md`, "a note and a CSV of the same list do not collide");
  assert.equal(await app.vault.cachedRead(app.vault.getAbstractFileByPath(first) as never), "one");

  await assert.rejects(
    () => repository.createLooseFile(folder, "Synthetic", "js" as never, "alert(1)"),
    /cannot be written/
  );
  repository.setWriteBlock("Synthetic barrier message");
  await assert.rejects(
    () => repository.createLooseFile(folder, "Patient list 2026-09-24", "csv", "four"),
    /Synthetic barrier message/
  );
  repository.setWriteBlock(null);
});

test("a list built from real service records matches what the Patients tab shows", async () => {
  const { repository, service } = await harness();
  await service.createEpisode(
    episodeInput({
      mrn: "9000000111",
      patientName: "Synthetic Ward Patient",
      caseName: "Synthetic airway watch",
      careSetting: "inpatient",
      pathway: "or-booking",
      nextAction: "Book theatre",
      dueDate: "2026-09-25"
    })
  );
  await service.createEpisode(
    episodeInput({ mrn: "9000000112", patientName: "Synthetic Clinic Patient", caseName: "Synthetic clinic case" })
  );
  const snapshot = await repository.snapshot();
  const rows = selectPatientListRows(snapshot, filter({ pathway: "or-booking" }), TODAY);
  assert.equal(rows.length, 1);
  assert.equal(first(rows).patient?.mrn, "9000000111");
  assert.equal(first(rows).openTasks, 1);
  const note = buildPatientListMarkdown(rows, filter({ pathway: "or-booking" }), TODAY);
  assert.match(note, /\| 1 \| 9000000111 \| Synthetic Ward Patient \| NFN \| Synthetic airway watch \| Inpatient \| OR Booking \| Routine \| Active \| Book theatre \| 2026-09-25 \|/);
});

type RenderablePatientsView = {
  activeTab: "today" | "patients" | "tasks" | "surgery" | "more";
  contentEl: HTMLElement;
  render: (snapshot: ClinicalSnapshot) => void;
  patientPathwayFilter: string;
  patientPriorityFilter: string;
};

function renderView(tab: RenderablePatientsView["activeTab"], snapshot: ClinicalSnapshot, setup?: (view: RenderablePatientsView) => void): TestElement {
  const root = new TestElement();
  const view = new ClinicalWorkspaceView(
    {} as never,
    { snapshot: async () => snapshot } as unknown as ClinicalRepository,
    {} as ClinicalService,
    {} as IntegrityService
  ) as unknown as RenderablePatientsView;
  view.activeTab = tab;
  view.contentEl = root as unknown as HTMLElement;
  setup?.(view);
  view.render(snapshot);
  return root;
}

test("the Patients tab filters by pathway and priority and offers to export the list", () => {
  const snapshot = mixedSnapshot();
  const root = renderView("patients", snapshot);
  const chipLabels = root.findAll(".clinical-chip").map((chip) => chip.textContent);
  for (const label of ["All pathways", "Assessment", "OR Booking", "OPD Follow-Up", "All", "Emergency", "Urgent", "Routine"]) {
    assert.ok(chipLabels.includes(label), `expected a ${label} chip`);
  }
  const exportButton = root
    .findAll("button")
    .find((button) => button.textContent === "Export list");
  assert.ok(exportButton, "the Patients tab offers an export of what it shows");
  assert.match(exportButton.attributes.get("aria-label") ?? "", /^Export list — /);

  const filtered = renderView("patients", snapshot, (view) => {
    view.patientPathwayFilter = "or-booking";
  });
  const notes = filtered.findAll(".clinical-section-note").map((note) => note.textContent);
  assert.ok(notes.includes("0 of 1 shown"), "the inpatient count says a filter is hiding records");
  assert.ok(notes.includes("1 of 2 shown"));
  const active = filtered.findAll(".clinical-chip.is-active").map((chip) => chip.textContent);
  assert.deepEqual(active, ["OR Booking", "All"]);
});

test("a pathway filter keeps its chip after the last matching episode closes", () => {
  const snapshot = mixedSnapshot();
  snapshot.episodes = snapshot.episodes.filter((item) => item.pathway !== "consultation");
  const root = renderView("patients", snapshot, (view) => {
    view.patientPathwayFilter = "consultation";
  });
  const active = root.findAll(".clinical-chip.is-active").map((chip) => chip.textContent);
  assert.ok(active.includes("Consultation"), "the active filter stays visible so it can be cleared");
});

test("the More tab explains and offers patient-list export", () => {
  const root = renderView("more", mixedSnapshot());
  const headings = root.findAll("h4").map((heading) => heading.textContent);
  assert.ok(headings.includes("Export a patient list"));
  assert.ok(
    root.findAll("button").some((button) => button.textContent === "Export patient list"),
    "the More tab has a direct export action"
  );
});

test("the export form is not offered while the repository cannot save", async () => {
  let snapshotReads = 0;
  const view = new ClinicalWorkspaceView(
    {} as never,
    {
      getWriteBlockReason: () => "Synthetic recovery barrier",
      snapshot: async () => {
        snapshotReads += 1;
        return mixedSnapshot();
      }
    } as unknown as ClinicalRepository,
    {} as ClinicalService,
    {} as IntegrityService
  );
  await view.openPatientListExport();
  assert.equal(snapshotReads, 0, "a blocked export must not read records or open the form");
});
