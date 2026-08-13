/**
 * Regression tests for the 2026-08 A-to-Z review remediation.
 *
 * Each test pins one verified finding: idempotency-key matches that must also
 * compare fields, partial-failure retries that must repair the episode
 * pointer, duplicate submissions that must not supersede live work,
 * validation that must precede the first write, stale form snapshots that
 * must be refused, and recovery state that must fail closed at load.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { coerceFrontmatterValue } from "../src/data/markdown";
import { clinicalRootFolder, pathForRecord, setClinicalRoot } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import {
  isoDateWithOffset,
  normalizePhone,
  normalizeText,
  nowIso,
  taskIsUpcoming
} from "../src/domain/schema";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import { validateRecord } from "../src/domain/validate";
import {
  CURRENT_SCHEMA_VERSION,
  type EpisodeRecord,
  type PatientRecord,
  type ProcedureRecord,
  type TaskRecord
} from "../src/domain/types";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness } from "./support/harness";

test("a hand-edited task with a stale idempotency key is never cancelled as superseded", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Review MRI results", dueDate: "2026-08-20" })
  );
  const original = created.task;
  assert.ok(original, "the episode should raise its first task");

  // The note IS the record: re-word the task by hand. The stored idempotency
  // key still encodes the original wording.
  await repository.update<TaskRecord>(original.path, { task: "Keep this repeat review" });

  const result = await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "routine",
    nextAction: "Book audiology",
    dueDate: "2026-08-20"
  });

  assert.equal(result.task.kind, "created");
  if (result.task.kind === "created") {
    assert.equal(result.task.superseded, 0, "the re-worded task must not be superseded");
  }
  const edited = await repository.findById<TaskRecord>("task", original.record.id);
  assert.equal(edited?.record.status, "open", "the hand-edited task must stay open");
});

test("retrying a completion that crashed before reconcile repairs the episode pointer", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Call the family", dueDate: "2026-08-20" })
  );
  const task = created.task;
  assert.ok(task);

  // Simulate the crash window: the task note was closed durably, but the
  // process died before the episode was reconciled.
  await repository.update<TaskRecord>(task.path, {
    status: "completed",
    completed_at: nowIso()
  });
  const before = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(before?.record.next_action, "Call the family");

  await service.completeTask(task.record.id);

  const after = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(after?.record.status, "ready-to-close");
  assert.equal(after?.record.next_action, "");
  assert.equal(after?.record.due_date, "");
});

test("a duplicate episode submission never supersedes the episode's open task", async () => {
  const { repository, service } = await harness();
  const first = await service.createEpisode(
    episodeInput({ nextAction: "Original plan", dueDate: "2026-08-20" })
  );
  assert.ok(first.task);

  const second = await service.createEpisode(
    episodeInput({ nextAction: "A different plan typed by mistake", dueDate: "2026-08-25" })
  );

  assert.equal(second.duplicateEpisode, true);
  const original = await repository.findById<TaskRecord>("task", first.task.record.id);
  assert.equal(original?.record.status, "open", "the original task must stay open");
  const tasks = await repository.list<TaskRecord>("task");
  assert.equal(
    tasks.filter(({ record }) => record.episode_id === first.episode.record.id).length,
    1,
    "no second task may be created by the duplicate submission"
  );
});

test("an invalid due date rejects the episode update before anything is written", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(episodeInput());

  await assert.rejects(
    () =>
      service.updateEpisode(created.episode.record.id, {
        careSetting: "inpatient",
        pathway: "assessment",
        priority: "urgent",
        nextAction: "Review",
        dueDate: "2026-13-45"
      }),
    /Due date is invalid/
  );

  const untouched = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(untouched?.record.care_setting, "outpatient");
  assert.equal(untouched?.record.priority, "routine");
});

test("a stale form snapshot is refused instead of reverting concurrent changes", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(episodeInput());
  const staleUpdatedAt = created.episode.record.updated_at;

  // Another device changes the episode after the form opened.
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "inpatient",
    pathway: "assessment",
    priority: "urgent",
    nextAction: "",
    dueDate: ""
  });

  await assert.rejects(
    () =>
      service.updateEpisode(created.episode.record.id, {
        careSetting: "outpatient",
        pathway: "assessment",
        priority: "routine",
        nextAction: "",
        dueDate: "",
        expectedUpdatedAt: staleUpdatedAt
      }),
    /changed after the form was opened/
  );
  const kept = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(kept?.record.priority, "urgent", "the concurrent change must survive");

  const patient = created.patient;
  await service.updatePatientIdentity(patient.record.id, {
    mrn: "5001",
    patientName: "Corrected Elsewhere",
    phone: ""
  });
  await assert.rejects(
    () =>
      service.updatePatientIdentity(patient.record.id, {
        mrn: "5001",
        patientName: "Stale Form Value",
        phone: "",
        expectedUpdatedAt: patient.record.updated_at
      }),
    /changed after the form was opened/
  );
});

test("an episode created without a next action stores no phantom due date", async () => {
  const { service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "", dueDate: "2026-08-13" })
  );
  assert.equal(created.episode.record.due_date, "");
  assert.equal(created.task, null);
});

test("an unreadable episode note blocks the automatic patient archive", async () => {
  const { app, repository, service } = await harness();
  const created = await service.createEpisode(episodeInput());
  await app.vault.create(
    `${clinicalRootFolder()}/Episodes/damaged-by-sync.md`,
    "---\nentity: episode\nid: [broken\n---\nUnparseable frontmatter.\n"
  );

  const archived = await service.archiveEpisode(created.episode.record.id, "Discharged");
  assert.equal(archived.record.status, "archived", "the episode archive itself proceeds");

  const patient = await repository.findById<PatientRecord>("patient", created.patient.record.id);
  assert.equal(
    patient?.record.status,
    "active",
    "the patient must not be auto-archived while an episode note is unreadable"
  );
});

test("create() refuses to adopt a different record occupying the managed path", async () => {
  const { app, repository } = await harness();
  const id = "TSK-occupied";
  await app.vault.create(
    pathForRecord("task", id),
    "---\nentity: task\nid: TSK-someone-else\n---\n"
  );
  const timestamp = nowIso();
  await assert.rejects(
    () =>
      repository.create<TaskRecord>({
        schema_version: CURRENT_SCHEMA_VERSION,
        entity: "task",
        id,
        created_at: timestamp,
        updated_at: timestamp,
        tags: ["clinical/task"],
        patient_id: "PAT-x",
        patient: "",
        episode_id: "EPI-x",
        episode: "",
        task: "Check",
        task_type: "other",
        status: "open",
        priority: "routine",
        due_date: "",
        owner: "",
        completed_at: "",
        cancelled_at: "",
        cancel_reason: "",
        idempotency_key: "task-00000000"
      }),
    /different note already occupies/
  );
});

test("invisible characters cannot split identities and a plus stays international-only", () => {
  assert.equal(normalizeText("Test​Patient"), "TestPatient");
  assert.equal(normalizeText("﻿Test Patient⁠"), "Test Patient");
  // Orthographically significant joiners are preserved.
  assert.equal(normalizeText("می‌رود"), "می‌رود");
  assert.equal(normalizePhone("+966 50 000 0001"), "+966500000001");
  assert.equal(normalizePhone("050+000+0001"), "0500000001");
});

test("validateRecord reports corrupted MRNs and non-boolean follow-up flags", () => {
  const timestamp = nowIso();
  const patient: PatientRecord = {
    schema_version: CURRENT_SCHEMA_VERSION,
    entity: "patient",
    id: "PAT-test",
    created_at: timestamp,
    updated_at: timestamp,
    tags: [],
    mrn: "12A45",
    mrn_status: "confirmed",
    patient_name: "Synthetic Patient",
    phone: "",
    phone_status: "not-found",
    status: "active",
    merged_into: ""
  };
  assert.ok(
    validateRecord(patient).some((problem) => problem.code === "invalid-mrn"),
    "a non-numeric MRN must be reported"
  );

  const procedure = {
    schema_version: CURRENT_SCHEMA_VERSION,
    entity: "procedure",
    id: "PRC-test",
    created_at: timestamp,
    updated_at: timestamp,
    tags: [],
    patient_id: "PAT-test",
    patient: "",
    episode_id: "EPI-test",
    episode: "",
    procedure: "Synthetic procedure",
    procedure_date: "2026-08-01",
    role: "Primary surgeon",
    status: "completed",
    outcome: "",
    follow_up_required: "yes" as unknown as boolean,
    follow_up_date: "",
    follow_up_plan: "",
    idempotency_key: "procedure-00000000"
  } satisfies ProcedureRecord;
  assert.ok(
    validateRecord(procedure).some(
      (problem) => problem.code === "invalid-value" && /follow-up required/i.test(problem.message)
    ),
    "a non-boolean follow_up_required must be reported"
  );
});

test("YAML 1.1 UTC-midnight dates keep their calendar day west of Greenwich", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    // What a YAML 1.1 writer produces for a bare `2026-08-03`.
    assert.equal(
      coerceFrontmatterValue("due_date", new Date("2026-08-03T00:00:00.000Z")),
      "2026-08-03"
    );
    // A local-midnight Date still reads as the local calendar day.
    assert.equal(coerceFrontmatterValue("due_date", new Date(2026, 7, 3)), "2026-08-03");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("the Next 7 days window includes tomorrow through day seven and nothing else", () => {
  const today = "2026-08-13";
  const task = (dueDate: string, status = "open"): TaskRecord => ({
    schema_version: CURRENT_SCHEMA_VERSION,
    entity: "task",
    id: "TSK-window",
    created_at: nowIso(),
    updated_at: nowIso(),
    tags: [],
    patient_id: "PAT-x",
    patient: "",
    episode_id: "EPI-x",
    episode: "",
    task: "Scheduled work",
    task_type: "other",
    status: status as TaskRecord["status"],
    priority: "routine",
    due_date: dueDate,
    owner: "",
    completed_at: "",
    cancelled_at: "",
    cancel_reason: "",
    idempotency_key: "task-00000000"
  });

  assert.equal(isoDateWithOffset(7, today), "2026-08-20");
  assert.equal(taskIsUpcoming(task("2026-08-13"), 7, today), false, "today belongs to Today");
  assert.equal(taskIsUpcoming(task("2026-08-14"), 7, today), true, "tomorrow is upcoming");
  assert.equal(taskIsUpcoming(task("2026-08-20"), 7, today), true, "day seven is included");
  assert.equal(taskIsUpcoming(task("2026-08-21"), 7, today), false, "day eight is excluded");
  assert.equal(taskIsUpcoming(task(""), 7, today), false, "undated work is not upcoming");
  assert.equal(taskIsUpcoming(task("2026-08-12"), 7, today), false, "overdue work is not upcoming");
  assert.equal(
    taskIsUpcoming(task("2026-08-14", "completed"), 7, today),
    false,
    "closed work is not upcoming"
  );
});

test("records missing while Obsidian was closed fail closed at load", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, service } = await harness();
    await service.createEpisode(episodeInput({ nextAction: "Review", dueDate: "2026-08-20" }));
    const recordPaths = [...app.vault.files.keys()].filter((path) =>
      ["Patients", "Episodes", "Tasks", "Procedures"].some((folder) =>
        path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`)
      )
    );
    assert.ok(recordPaths.length >= 3);

    // A trusted baseline that has completed initialization.
    const stored: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      workspaceSafety: {
        version: 1,
        initialized: true,
        initializationApproved: false,
        managedRecordsExpected: true,
        expectedManagedRecordCount: recordPaths.length,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true
      }
    };

    // One record note disappears while the app is closed; the folder remains.
    const lost = recordPaths.find((path) => path.includes("/Episodes/"));
    assert.ok(lost);
    app.vault.deleteRaw(lost);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = new ClinicalWorkspacePlugin(
      app as unknown as App,
      {} as never
    ) as unknown as {
      app: StubApp;
      settings: ClinicalSettings;
      repository: ClinicalRepository;
      migrationRecoveryBlocked: boolean;
      missingRootRecoveryBlocked: boolean;
      loadData: () => Promise<unknown>;
      saveData: (data: unknown) => Promise<void>;
      loadSettings: () => Promise<void>;
    };
    restarted.app = app;
    restarted.repository = restartedRepository;
    restarted.settings = { ...DEFAULT_SETTINGS };
    restarted.loadData = async () => structuredClone(stored);
    restarted.saveData = async () => undefined;

    await restarted.loadSettings();

    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a record-free synced move in transit stays pending until the folder arrives", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app } = await harness();
    const marker = { from: DEFAULT_SETTINGS.rootFolder, to: "Ward Records" };
    let saved: Record<string, unknown> = {};
    const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as {
      app: StubApp;
      settings: ClinicalSettings;
      pendingMigrationMarker: unknown;
      pendingMigrationConfiguredRoot: string | null;
      migrationRecoveryBlocked: boolean;
      saveData: (data: unknown) => Promise<void>;
      refreshOpenViews: () => Promise<void>;
      reconcileMigration: (stored: unknown) => Promise<boolean>;
      retryPendingMigrationRecovery: () => Promise<boolean>;
    };
    plugin.app = app;
    plugin.settings = { ...DEFAULT_SETTINGS, rootFolder: marker.to };
    plugin.pendingMigrationMarker = { migrationInProgress: marker };
    plugin.pendingMigrationConfiguredRoot = marker.to;
    plugin.refreshOpenViews = async () => undefined;
    plugin.saveData = async (data) => {
      saved = structuredClone(data) as Record<string, unknown>;
    };
    setClinicalRoot(marker.to);

    // data.json named the destination but the folder rename has not synced
    // in yet: the source folder exists, the destination does not.
    const settled = await plugin.reconcileMigration({
      ...DEFAULT_SETTINGS,
      rootFolder: marker.to,
      migrationInProgress: marker
    });

    assert.equal(settled, false, "an in-transit synced move must stay pending");
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.notEqual(plugin.pendingMigrationMarker, null);
    assert.equal(Object.hasOwn(saved, "rootFolder"), false, "nothing may be persisted yet");

    // The explicit user retry — after confirming Sync has settled — may
    // still roll a record-free workspace back to its source.
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    assert.equal(plugin.settings.rootFolder, marker.from);
    assert.equal(plugin.pendingMigrationMarker, null);
  } finally {
    setClinicalRoot(originalRoot);
  }
});
