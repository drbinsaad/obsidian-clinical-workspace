import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { coerceFrontmatter, coerceFrontmatterValue } from "../src/data/markdown";
import { clinicalRootFolder, setClinicalRoot, wikilink } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import {
  createId,
  normalizeMrn,
  normalizeText,
  procedureIdempotencyKey,
  taskIdempotencyKey
} from "../src/domain/schema";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import type {
  EpisodeRecord,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import { MigrationService, type MigrationResult } from "../src/services/migration";
import { ClinicalSettingTab } from "../src/ui/settings-tab";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness, withLatency } from "./support/harness";

test("a failed root rename rolls back the active root and preserves its recovery marker", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());

    let saved: Record<string, unknown> = {};
    const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as {
      app: StubApp;
      settings: ClinicalSettings;
      repository: ClinicalRepository;
      migration: MigrationService;
      pendingMigrationMarker: unknown;
      refreshOpenViews: () => Promise<void>;
      saveData: (data: unknown) => Promise<void>;
      migrateRootFolder: (target: string) => Promise<MigrationResult>;
      updateSettings: (patch: Partial<ClinicalSettings>) => Promise<void>;
    };
    plugin.app = app;
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.repository = repository;
    plugin.migration = new MigrationService(app as unknown as App);
    plugin.pendingMigrationMarker = null;
    plugin.refreshOpenViews = async () => undefined;
    plugin.saveData = async (data) => {
      saved = structuredClone(data) as Record<string, unknown>;
    };

    const fileManager = app.fileManager as unknown as {
      renameFile: (file: unknown, path: string) => Promise<void>;
    };
    fileManager.renameFile = async () => {
      throw new Error("EIO: simulated rename failure");
    };

    await assert.rejects(() => plugin.migrateRootFolder("Ward Records"), /simulated rename failure/);
    assert.equal(plugin.settings.rootFolder, "Clinical Workspace");
    assert.equal(clinicalRootFolder(), "Clinical Workspace");
    assert.deepEqual(saved.migrationInProgress, { from: "Clinical Workspace", to: "Ward Records" });

    await plugin.updateSettings({ confirmBeforeDischarge: true });
    assert.deepEqual(saved.migrationInProgress, { from: "Clinical Workspace", to: "Ward Records" });
    assert.equal(saved.rootFolder, "Clinical Workspace");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a post-rename link-audit failure cannot roll the plugin back to the old folder", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    const { app, service, repository } = await harness();
    await service.createEpisode(episodeInput());
    const migration = new MigrationService(app as unknown as App);
    (migration as unknown as { countDanglingLinks: () => Promise<number> }).countDanglingLinks = async () => {
      throw new Error("EIO: simulated audit failure");
    };
    const result = await migration.run("Ward Records");
    assert.equal(result.linkVerificationFailed, true);
    setClinicalRoot("Ward Records");
    assert.equal((await repository.list<EpisodeRecord>("episode")).length, 1);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("externally synced settings are applied without restarting Obsidian", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    const { app, repository } = await harness();
    let refreshed = 0;
    const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as {
      app: StubApp;
      repository: ClinicalRepository;
      loadData: () => Promise<unknown>;
      refreshOpenViews: () => Promise<void>;
      onExternalSettingsChange: () => Promise<void>;
      settings: ClinicalSettings;
    };
    plugin.app = app;
    plugin.repository = repository;
    plugin.loadData = async () => ({ ...DEFAULT_SETTINGS, rootFolder: "Synced Clinical Records" });
    plugin.refreshOpenViews = async () => {
      refreshed += 1;
    };
    await plugin.onExternalSettingsChange();
    assert.equal(plugin.settings.rootFolder, "Synced Clinical Records");
    assert.equal(clinicalRootFolder(), "Synced Clinical Records");
    assert.equal(refreshed, 1);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("closing settings flushes rather than discards pending text-field writes", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
  try {
    const app = new App();
    const tab = new ClinicalSettingTab(
      app,
      {} as never,
      new MigrationService(app)
    ) as unknown as {
      debounced: (key: string, run: () => void, delay: number) => void;
      hide: () => void;
    };
    let writes = 0;
    tab.debounced("clinicianName", () => {
      writes += 1;
    }, 60000);
    tab.hide();
    assert.equal(writes, 1);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
  }
});

test("concurrent identical episode submissions create one episode and one initial task", async () => {
  const { app, service, repository } = await harness();
  const input = episodeInput({
    caseName: "Concurrent case",
    nextAction: "Review result",
    dueDate: "2026-08-12"
  });
  await withLatency(app, 2, () => Promise.all([service.createEpisode(input), service.createEpisode(input)]));
  assert.equal((await repository.list<EpisodeRecord>("episode")).length, 1);
  assert.equal((await repository.list<TaskRecord>("task")).length, 1);
});

test("identity correction re-points every linked patient label", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ patientName: "Old Name", nextAction: "Review result", dueDate: "2026-08-12" })
  );
  await service.completeProcedure({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    procedure: "Tonsillectomy",
    procedureDate: "2026-08-11",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  });
  await service.updatePatientIdentity(created.patient.record.id, {
    mrn: created.patient.record.mrn,
    patientName: "Corrected Name",
    phone: ""
  });

  const links = [
    ...(await repository.list<EpisodeRecord>("episode")),
    ...(await repository.list<TaskRecord>("task")),
    ...(await repository.list<ProcedureRecord>("procedure"))
  ].map(({ record }) => record.patient);
  assert.ok(links.length > 0);
  assert.ok(links.every((link) => link.includes("|Corrected Name]]")));
});

test("an unreadable task blocks only its own episode when attribution is recoverable", async () => {
  const { service, app } = await harness();
  const affected = await service.createEpisode(
    episodeInput({ caseName: "Affected", nextAction: "Review scan", dueDate: "2026-08-12" })
  );
  const unaffected = await service.createEpisode(
    episodeInput({ caseName: "Unaffected", nextAction: "Call family", dueDate: "2026-08-13" })
  );
  await service.completeTask(unaffected.task!.record.id);
  app.vault.files.set(
    affected.task!.path,
    `---\nentity: task\nid: [broken\nepisode_id: ${affected.episode.record.id}\n---\n`
  );

  await service.archiveEpisode(unaffected.episode.record.id, "Discharged");
  await assert.rejects(
    () => service.archiveEpisode(affected.episode.record.id, "Discharged"),
    new RegExp(affected.task!.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("a colliding task hash in another episode cannot suppress new work", async () => {
  const { service, repository } = await harness();
  const first = await service.createEpisode(
    episodeInput({ caseName: "First case", nextAction: "Review CT result", dueDate: "2026-08-12" })
  );
  const second = await service.createEpisode(episodeInput({ caseName: "Second case" }));
  const secondInput = {
    patientId: second.patient.record.id,
    episodeId: second.episode.record.id,
    task: "Chase histopathology",
    taskType: "other" as const,
    priority: "routine" as const,
    dueDate: "2026-08-15",
    owner: ""
  };
  await repository.update<TaskRecord>(first.task!.path, {
    idempotency_key: taskIdempotencyKey(secondInput)
  });
  const result = await service.createTask(secondInput);
  assert.equal(result.duplicate, false);
  assert.equal((await repository.list<TaskRecord>("task")).length, 2);
});

test("a colliding procedure hash in another episode cannot suppress a logbook entry", async () => {
  const { service, repository } = await harness();
  const first = await service.createEpisode(episodeInput({ caseName: "First operation" }));
  const second = await service.createEpisode(episodeInput({ caseName: "Second operation" }));
  const procedure = {
    procedure: "Tonsillectomy",
    procedureDate: "2026-08-11",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  };
  const firstRecord = await service.completeProcedure({
    ...procedure,
    patientId: first.patient.record.id,
    episodeId: first.episode.record.id
  });
  await repository.update<ProcedureRecord>(firstRecord.path, {
    idempotency_key: procedureIdempotencyKey(
      second.episode.record.id,
      procedure.procedure,
      procedure.procedureDate
    )
  });
  await service.completeProcedure({
    ...procedure,
    patientId: second.patient.record.id,
    episodeId: second.episode.record.id
  });
  assert.equal((await repository.list<ProcedureRecord>("procedure")).length, 2);
});

test("date-only Date values preserve the local calendar day", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Riyadh";
    assert.equal(coerceFrontmatterValue("due_date", new Date(2026, 7, 7)), "2026-08-07");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("wikilink labels cannot inject link syntax and bidi controls are stripped", () => {
  const link = wikilink("Clinical Workspace/Episodes/EPI-test.md", "Review [[Private]] | #target ^block \\alias");
  assert.equal(link, "[[Clinical Workspace/Episodes/EPI-test|Review Private target block alias]]");
  assert.equal(normalizeText("a\u202Eb"), "ab");
});

test("Arabic-Indic identifiers are normalised to ASCII without losing leading zeroes", () => {
  assert.equal(normalizeMrn("٠٠١٢٣٤٥"), "0012345");
  assert.equal(normalizeMrn("۰۰۱۲۳۴۵"), "0012345");
});

test("frontmatter coercion drops prototype-mutating keys", () => {
  const input = Object.create(null) as Record<string, unknown>;
  input.entity = "task";
  input.__proto__ = ["unexpected"];
  input["constructor"] = "unexpected";
  const coerced = coerceFrontmatter(input);
  assert.equal(Object.getPrototypeOf(coerced), null);
  assert.equal(Object.hasOwn(coerced, "__proto__"), false);
  assert.equal(Object.hasOwn(coerced, "constructor"), false);
});

test("task reconciliation cannot reopen a terminal episode", async () => {
  const { service, repository, integrity } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Review result", dueDate: "2026-08-12" })
  );
  await repository.update<EpisodeRecord>(created.episode.path, { status: "archived" });
  const before = await integrity.scan();
  assert.ok(before.some(({ code }) => code === "open-task-on-closed-episode"));
  await service.completeTask(created.task!.record.id);
  const episode = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode!.record.status, "archived");
});

test("integrity reports duplicate active episodes and interrupted patient merges", async () => {
  const { service, repository, integrity } = await harness();
  const source = await service.createEpisode(episodeInput({ caseName: "Duplicate case" }));
  const target = await service.createEpisode(
    episodeInput({ mrn: "9002", patientName: "Target", caseName: "Target case" })
  );
  const duplicate: EpisodeRecord = {
    ...source.episode.record,
    id: createId("EPI"),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await repository.create(duplicate);
  await repository.update(source.patient.path, { merge_in_progress: target.patient.record.id });
  const issues = await integrity.scan();
  assert.ok(issues.some(({ code }) => code === "duplicate-episode"));
  assert.ok(issues.some(({ code }) => code === "half-merged-patient"));
});

test("a patient already merged away cannot be selected as a merge target", async () => {
  const { service } = await harness();
  const source = await service.createEpisode(
    episodeInput({ mrn: "9003", patientName: "Source", caseName: "Source case" })
  );
  const retiredTarget = await service.createEpisode(
    episodeInput({ mrn: "9004", patientName: "Retired", caseName: "Retired case" })
  );
  const survivor = await service.createEpisode(
    episodeInput({ mrn: "9005", patientName: "Survivor", caseName: "Survivor case" })
  );
  await service.mergePatients(retiredTarget.patient.record.id, survivor.patient.record.id);
  await assert.rejects(
    () => service.mergePatients(source.patient.record.id, retiredTarget.patient.record.id),
    /already involved in another merge/
  );
});
