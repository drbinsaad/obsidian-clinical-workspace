/**
 * Pre-release fixes for the patient-list export and two lifecycle paths:
 * the export selects exactly what the Patients tab shows, keeps identifiers
 * exact in spreadsheets and clinical text literal in Obsidian, and lists a
 * merged patient's leftover episodes under the surviving record. The
 * generated-body rewrite stops when Sync closes writes mid-batch, and a
 * record edited during the automatic recovery's final scan keeps writes
 * paused.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import type { ClinicalRepository } from "../src/data/repository";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import type { ClinicalSnapshot, EpisodeRecord, PatientRecord } from "../src/domain/types";
import { ClinicalService } from "../src/services/clinical-service";
import { buildHandoverNote } from "../src/services/handover";
import { IntegrityService } from "../src/services/integrity";
import { MigrationService } from "../src/services/migration";
import {
  DEFAULT_PATIENT_LIST_FILTER,
  buildPatientListCsv,
  buildPatientListMarkdown,
  countDistinctPatients,
  selectPatientListRows,
  type PatientListFilter
} from "../src/services/patient-list";
import { ConfirmMaintenanceModal } from "../src/ui/modals";
import { hideClinicalRecoveryNotice } from "../src/ui/notices";
import { episodeInput, harness } from "./support/harness";
import { Notice as StubNotice, TFile as StubTFile, type App as StubApp } from "./support/obsidian-stub";

const TODAY = "2026-09-24";
const ROOT = DEFAULT_SETTINGS.rootFolder;

beforeEach(() => {
  hideClinicalRecoveryNotice();
  StubNotice.history.length = 0;
});
afterEach(() => hideClinicalRecoveryNotice());

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
    phone: "",
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

const filter = (overrides: Partial<PatientListFilter> = {}): PatientListFilter => ({
  ...DEFAULT_PATIENT_LIST_FILTER,
  ...overrides
});

const snapshotOf = (patients: PatientRecord[], episodes: EpisodeRecord[]): ClinicalSnapshot => ({
  patients,
  episodes,
  tasks: [],
  procedures: []
});

/** Same rule as the Patients tab (isActiveEpisode and its Inpatients group). */
const tabShows = (item: EpisodeRecord, inpatient: boolean): boolean =>
  !["archived", "cancelled", "entered-in-error"].includes(item.status) &&
  (item.care_setting === "inpatient") === inpatient;

test("the open export and its care-setting filter select what the Patients tab shows", () => {
  const snapshot = snapshotOf(
    [patient("PAT-a")],
    [
      episode("EPI-capital", "PAT-a", { status: "Active" as never, care_setting: "inpatient" }),
      episode("EPI-blank-status", "PAT-a", { status: "" as never, care_setting: "inpatient" }),
      episode("EPI-blank-setting", "PAT-a", { care_setting: "" as never }),
      episode("EPI-odd-setting", "PAT-a", { care_setting: "Inpatient" as never }),
      episode("EPI-outpatient", "PAT-a", { status: "on-hold" }),
      episode("EPI-hold-capital", "PAT-a", { status: "On-hold" as never }),
      episode("EPI-archived", "PAT-a", { status: "archived", care_setting: "inpatient" }),
      episode("EPI-cancelled", "PAT-a", { status: "cancelled" }),
      episode("EPI-error", "PAT-a", { status: "entered-in-error" })
    ]
  );
  const ids = (overrides: Partial<PatientListFilter>): string[] =>
    selectPatientListRows(snapshot, filter(overrides), TODAY)
      .map((row) => row.episode.id)
      .sort();
  const tab = (inpatient: boolean): string[] =>
    snapshot.episodes.filter((item) => tabShows(item, inpatient)).map((item) => item.id).sort();

  assert.deepEqual(ids({}), [...tab(true), ...tab(false)].sort(), "default open export equals the tab");
  assert.deepEqual(ids({ careSetting: "inpatient" }), tab(true));
  assert.deepEqual(ids({ careSetting: "inpatient" }), ["EPI-blank-status", "EPI-capital"]);
  assert.deepEqual(ids({ careSetting: "outpatient" }), tab(false));
  assert.ok(ids({ careSetting: "outpatient" }).includes("EPI-blank-setting"));
  assert.ok(ids({ careSetting: "outpatient" }).includes("EPI-odd-setting"));
  // A single-status scope still matches exactly.
  assert.deepEqual(ids({ scope: "on-hold" }), ["EPI-outpatient"]);
  assert.deepEqual(ids({ scope: "archived" }), ["EPI-archived"]);
});

test("the CSV keeps MRNs and phones that start with 0 or are long as text", () => {
  const snapshot = snapshotOf(
    [
      patient("PAT-zero", { mrn: "0090000077", phone: "0500000001", patient_name: "Synthetic Zero" }),
      patient("PAT-long", { mrn: "900000000000123", phone: "+90000000001", patient_name: "Synthetic Long" }),
      patient("PAT-plain", { mrn: "9000000101", phone: "", patient_name: "Synthetic Plain" })
    ],
    [
      episode("EPI-zero", "PAT-zero", { case: "0123" }),
      episode("EPI-long", "PAT-long"),
      episode("EPI-plain", "PAT-plain")
    ]
  );
  const csv = buildPatientListCsv(selectPatientListRows(snapshot, filter(), TODAY));
  const row = (name: string): string => csv.split("\r\n").find((line) => line.includes(name)) ?? "";
  assert.match(row("Synthetic Zero"), /^"'0090000077","Synthetic Zero","'0500000001","0123",/);
  assert.match(row("Synthetic Long"), /^"'900000000000123","Synthetic Long","'\+90000000001",/);
  assert.match(row("Synthetic Plain"), /^"9000000101","Synthetic Plain","NFN",/, "an ordinary MRN is unchanged");
});

test("Obsidian syntax in list cells stays literal text", () => {
  const snapshot = snapshotOf(
    [patient("PAT-a")],
    [
      episode("EPI-one", "PAT-a", {
        case: "Bed #4B review",
        next_action: "Titrate 50%% then $x$ *now* ==mark== ~~a~~ `b` ^c _d_"
      }),
      episode("EPI-two", "PAT-a", { case: "Second case", next_action: "Recheck %%" })
    ]
  );
  const note = buildPatientListMarkdown(selectPatientListRows(snapshot, filter(), TODAY), filter(), TODAY);
  const rows = note.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, 2);
  const cells = (line: string): string[] => line.split(/(?<!\\)\|/).map((cell) => cell.trim());
  const [first = "", second = ""] = rows;
  assert.equal(cells(first)[5], "Bed \\#4B review");
  assert.equal(
    cells(first)[10],
    "Titrate 50&#37;&#37; then \\$x\\$ \\*now\\* \\=\\=mark\\=\\= \\~\\~a\\~\\~ \\`b\\` \\^c \\_d\\_"
  );
  assert.equal(cells(second)[10], "Recheck &#37;&#37;");
  assert.doesNotMatch(note.split("**Matches:**")[1] ?? "", /%%|(?<![\\&])#[A-Za-z0-9]|(?<!\\)\$/);
});

test("an episode left under a merged patient is listed and counted under the survivor", () => {
  const snapshot = snapshotOf(
    [
      patient("PAT-keep", { mrn: "9000000101", patient_name: "Synthetic Keep" }),
      patient("PAT-old", {
        mrn: "9000000999",
        patient_name: "Synthetic Old",
        status: "entered-in-error",
        merged_into: "PAT-keep"
      }),
      patient("PAT-older", { mrn: "9000000998", patient_name: "Synthetic Older", merged_into: "PAT-old" }),
      // A cycle cannot loop forever.
      patient("PAT-loop-a", { mrn: "9000000301", patient_name: "Synthetic Loop A", merged_into: "PAT-loop-b" }),
      patient("PAT-loop-b", { mrn: "9000000302", patient_name: "Synthetic Loop B", merged_into: "PAT-loop-a" })
    ],
    [
      episode("EPI-keep", "PAT-keep", { case: "Kept case" }),
      episode("EPI-old", "PAT-old", { case: "Late delivery" }),
      episode("EPI-older", "PAT-older", { case: "Two hops" }),
      episode("EPI-loop", "PAT-loop-a", { case: "Loop case" })
    ]
  );
  const rows = selectPatientListRows(snapshot, filter(), TODAY);
  const byEpisode = new Map(rows.map((row) => [row.episode.id, row.patient?.id]));
  assert.equal(byEpisode.get("EPI-old"), "PAT-keep");
  assert.equal(byEpisode.get("EPI-older"), "PAT-keep");
  assert.ok(byEpisode.has("EPI-loop"));
  const merged = rows.filter((row) => row.episode.id !== "EPI-loop");
  assert.equal(countDistinctPatients(merged), 1, "one person is one patient");
  const note = buildPatientListMarkdown(merged, filter(), TODAY);
  assert.match(note, /\*\*Matches:\*\* 3 episodes for 1 patient\b/);
  assert.doesNotMatch(note, /9000000999|Synthetic Old|9000000998/);
});

// ---------------------------------------------------------------------------
// Lifecycle: a small trusted workspace with the real plugin.

type Inventory = { total: number; digest: string };

type TestPlugin = {
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  integrity: IntegrityService;
  migration: MigrationService;
  settings: typeof DEFAULT_SETTINGS;
  pendingMigrationMarker: unknown;
  pendingMigrationConfiguredRoot: string | null;
  migrationRecoveryBlocked: boolean;
  missingRootRecoveryBlocked: boolean;
  missingRootRequiresRecords: boolean;
  firstUseInitializationPending: boolean;
  workspaceInitialized: boolean;
  managedRecordsExpected: boolean;
  expectedManagedRecordCount: number;
  expectedEntityCounts: unknown;
  expectedRecordDigest: string | null;
  workspaceSafetyNeedsPersistence: boolean;
  structureReady: boolean;
  whatsNewShownThisSession: boolean;
  markerFreeRecoveryOperations: number;
  externalSettingsApplyOperations: number;
  pluginDataWriteQueue: Promise<unknown>;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  registerEvent: (event: unknown) => void;
  registerVaultEvents: () => void;
  parsedRecordInventory: (root: string) => Promise<Inventory>;
  observeManagedRecordDelivery: (path: string) => void;
  noteManagedRecordWrite: (paths?: readonly string[]) => Promise<boolean>;
  migrateGeneratedBodies: () => Promise<void>;
};

function managedRecordPaths(app: StubApp): string[] {
  return [...app.vault.files.keys()]
    .filter((path) => ["Patients", "Episodes", "Tasks", "Procedures"].some((folder) => path.startsWith(`${ROOT}/${folder}/`)))
    .sort();
}

/** A trusted, writable workspace holding the given synthetic episodes. */
async function trustedWorkspace(mrns: string[]): Promise<{
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  plugin: TestPlugin;
}> {
  const { app, repository, service } = await harness();
  for (const [index, mrn] of mrns.entries()) {
    await service.createEpisode(
      episodeInput({ mrn, patientName: `Synthetic Lifecycle ${index + 1}`, caseName: `Synthetic case ${index + 1}` })
    );
  }
  let stored: unknown = { ...DEFAULT_SETTINGS };
  const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as TestPlugin;
  Object.assign(plugin, {
    app,
    repository,
    service: new ClinicalService(repository),
    integrity: new IntegrityService(repository),
    migration: new MigrationService(app as unknown as App),
    settings: { ...DEFAULT_SETTINGS },
    pendingMigrationMarker: null,
    pendingMigrationConfiguredRoot: null,
    migrationRecoveryBlocked: false,
    missingRootRecoveryBlocked: false,
    missingRootRequiresRecords: false,
    firstUseInitializationPending: false,
    workspaceInitialized: true,
    expectedManagedRecordCount: managedRecordPaths(app).length,
    managedRecordsExpected: true,
    expectedEntityCounts: null,
    expectedRecordDigest: null,
    workspaceSafetyNeedsPersistence: false,
    structureReady: true,
    whatsNewShownThisSession: true,
    loadData: async () => structuredClone(stored),
    saveData: async (data: unknown) => {
      stored = structuredClone(data);
    },
    refreshOpenViews: async () => undefined
  });
  repository.setManagedRecordWriteObserver((paths) => plugin.noteManagedRecordWrite(paths));
  await plugin.noteManagedRecordWrite();
  assert.equal(plugin.migrationRecoveryBlocked, false);
  assert.ok(plugin.expectedRecordDigest);
  return { app, repository, service: plugin.service, plugin };
}

/** Deterministic stand-in for Obsidian's window timers. */
function installFakeTimers(): { flush: (delay: number) => void; restore: () => void } {
  let nextId = 1;
  const pending = new Map<number, { run: () => void; delay: number }>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (run: () => void, delay = 0) => {
        const id = nextId++;
        pending.set(id, { run, delay });
        return id;
      },
      clearTimeout: (id: number) => {
        pending.delete(id);
      }
    }
  });
  return {
    flush: (delay) => {
      for (const [id, timer] of [...pending]) {
        if (timer.delay !== delay) continue;
        pending.delete(id);
        timer.run();
      }
    },
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else delete (globalThis as { window?: unknown }).window;
    }
  };
}

async function settle(plugin: TestPlugin): Promise<void> {
  const deadline = Date.now() + 20_000;
  let quietPolls = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await plugin.pluginDataWriteQueue.catch(() => undefined);
    const idle = plugin.markerFreeRecoveryOperations === 0 && plugin.externalSettingsApplyOperations === 0;
    quietPolls = idle ? quietPolls + 1 : 0;
    if (quietPolls >= 3) return;
  }
  assert.fail("plugin did not settle");
}

test("a generated-body rewrite stops when Sync closes writes after the first note", async () => {
  const originalRoot = clinicalRootFolder();
  const prototype = ConfirmMaintenanceModal.prototype as unknown as { open?: () => void };
  const originalOpen = Object.getOwnPropertyDescriptor(prototype, "open");
  const opened: Array<{ options: { onDecide: (confirmed: boolean) => void } }> = [];
  prototype.open = function (this: (typeof opened)[number]) {
    opened.push(this);
  };
  try {
    setClinicalRoot(ROOT);
    const { app, repository, plugin } = await trustedWorkspace(["9000009101", "9000009102", "9000009103"]);
    const patients = managedRecordPaths(app).filter((path) => path.includes("/Patients/"));
    assert.equal(patients.length, 3);
    for (const [index, path] of patients.entries()) {
      const content = app.vault.files.get(path) ?? "";
      const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(content)?.[0];
      const mrn = /mrn: "?(\d+)/.exec(content)?.[1];
      assert.ok(frontmatter && mrn);
      app.vault.writeRaw(
        path,
        `${frontmatter}# Synthetic Lifecycle ${index + 1}\n\n> Managed by Clinical Workspace. Structured properties above are the source of truth.\n\n## Patient summary\n\n- MRN: ${mrn}\n- Phone: not recorded\n`
      );
    }
    let refreshed = 0;
    plugin.refreshOpenViews = async () => {
      refreshed += 1;
    };

    await plugin.migrateGeneratedBodies();
    assert.equal(opened.length, 1);
    const vault = app.vault as unknown as { process: (file: unknown, fn: (text: string) => string) => Promise<string> };
    const originalProcess = vault.process.bind(vault);
    let processed = 0;
    vault.process = async (file, fn) => {
      const result = await originalProcess(file, fn);
      processed += 1;
      // Sync delivers an unrelated record after the first rewrite.
      if (processed === 1) plugin.observeManagedRecordDelivery(`${ROOT}/Tasks/sync-delivered.md`);
      return result;
    };
    StubNotice.history.length = 0;
    opened[0]?.options.onDecide(true);
    for (let attempt = 0; attempt < 400 && refreshed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(refreshed, 1);
    assert.ok(repository.getWriteBlockReason(), "the barrier is armed");
    assert.equal(processed, 1, "no note is written after the barrier closes");
    const rewritten = patients.filter((path) => !(app.vault.files.get(path) ?? "").includes("- MRN: "));
    assert.equal(rewritten.length, 1);
    const messages = StubNotice.history.map((notice) => notice.message);
    assert.ok(messages.some((message) => message.startsWith("The rewrite stopped after 1 generated body.")));
    assert.ok(!messages.some((message) => /generated bod(y|ies) rewritten without identifiers/.test(message)));
    for (const message of messages) assert.doesNotMatch(message, /Synthetic Lifecycle|900000910\d|\.md/);
  } finally {
    if (originalOpen) Object.defineProperty(prototype, "open", originalOpen);
    else delete prototype.open;
    setClinicalRoot(originalRoot);
  }
});

test("a record edited during the automatic recovery's final scan keeps writes paused", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = installFakeTimers();
  try {
    setClinicalRoot(ROOT);
    const { app, service, plugin } = await trustedWorkspace(["9000009201"]);
    const handlers = new Map<string, (file: StubTFile) => void>();
    (app.vault as unknown as { on: unknown }).on = (name: string, handler: (file: StubTFile) => void) => {
      handlers.set(name, handler);
      return { id: name };
    };
    plugin.registerEvent = () => undefined;
    plugin.registerVaultEvents();
    const modify = handlers.get("modify");
    assert.ok(modify);

    const episodePath = managedRecordPaths(app).find((path) => path.includes("/Episodes/"));
    assert.ok(episodePath);
    const original = app.vault.files.get(episodePath) ?? "";
    const scan = plugin.parsedRecordInventory.bind(plugin);
    let scans = 0;
    plugin.parsedRecordInventory = async (root) => {
      scans += 1;
      const result = await scan(root);
      if (scans === 2) {
        // The final scan has read the note; Sync now replaces it.
        app.vault.writeRaw(episodePath, "---\nid: [unterminated\n---\n");
        modify(new StubTFile(episodePath));
      }
      return result;
    };

    app.vault.writeRaw(episodePath, `${original}\nA hand edit.\n`);
    modify(new StubTFile(episodePath));
    assert.equal(plugin.migrationRecoveryBlocked, true);
    timers.flush(1500);
    await settle(plugin);
    assert.ok(scans >= 2, "the recovery reached its final scan");
    assert.equal(plugin.migrationRecoveryBlocked, true, "writes stay paused after the recheck");
    timers.flush(1500);
    await settle(plugin);
    assert.equal(plugin.migrationRecoveryBlocked, true, "writes stay paused after the follow-up recheck");

    const before = app.vault.files.size;
    await assert.rejects(() =>
      service.createEpisode(episodeInput({ mrn: "9000009202", patientName: "Synthetic Blocked", caseName: "Blocked" }))
    );
    assert.equal(app.vault.files.size, before, "nothing reached the vault");
  } finally {
    timers.restore();
    setClinicalRoot(originalRoot);
  }
});

test("the handover note keeps clinical text literal and hands merged work to the surviving patient", () => {
  const survivor = patient("PAT-survivor", { mrn: "9000000102", patient_name: "Synthetic Survivor" });
  const retired = patient("PAT-retired", {
    mrn: "9000000103",
    patient_name: "Synthetic Retired",
    merged_into: "PAT-survivor"
  });
  const leftover = episode("EPI-leftover", "PAT-retired", {
    care_setting: "inpatient",
    case: "Bed #4B [[Other note]]",
    next_action: "Titrate 50%% then recheck $x$"
  });
  const note = buildHandoverNote(
    {
      patients: [survivor, retired],
      episodes: [leftover],
      tasks: [
        {
          schema_version: 3,
          entity: "task",
          id: "TSK-leftover",
          created_at: "2026-09-01T08:00:00.000Z",
          updated_at: "2026-09-01T08:00:00.000Z",
          tags: ["clinical/task"],
          patient_id: "PAT-retired",
          episode_id: "EPI-leftover",
          patient: "",
          episode: "",
          task: "Chase #histology %% result",
          task_type: "review-result",
          priority: "routine",
          status: "open",
          due_date: TODAY,
          owner: "",
          completed_at: "",
          cancelled_at: "",
          cancel_reason: "",
          idempotency_key: "synthetic-leftover-task"
        }
      ],
      procedures: []
    },
    TODAY
  );

  assert.match(note, /MRN 9000000102 · Synthetic Survivor/, "leftover work is handed over under the surviving patient");
  assert.doesNotMatch(note, /9000000103|Synthetic Retired/, "the retired identity is not handed over");
  assert.doesNotMatch(note, /%%/, "no %% remains to open a comment that hides the rest of the note");
  assert.doesNotMatch(note, /(^|[^\\&])#[A-Za-z0-9]/m, "no bare # remains to become a tag (&#37; is the escaped %)");
  assert.doesNotMatch(note, /(^|[^\\])\[\[/m, "no bare [[ remains to become a link");
  assert.match(note, /Bed \\#4B \\\[\\\[Other note\\\]\\\]/);
  assert.match(note, /Titrate 50&#37;&#37; then recheck \\\$x\\\$/);
  assert.match(note, /Chase \\#histology &#37;&#37; result/);
});
