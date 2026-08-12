/**
 * Regression coverage adopted from the independent 0.4.1 review. Each test
 * here encodes the FIXED behaviour of a defect that review confirmed with an
 * executable reproduction (procedure retry mixing, invalid-date partial
 * writes, silent audit gaps, content-blind recovery counts, integrity blind
 * spots, quadratic scans, and the Sync-vs-repair write race).
 *
 * Synthetic identifiers only: 9000-prefix MRNs and "Synthetic …" names.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { App, Notice, TFile } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import type {
  EpisodeRecord,
  NewEpisodeInput,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness, type Harness } from "./support/harness";
import { markdownFilesInFolder } from "../src/data/vault-scope";

const FUTURE = "2026-09-01";

/** The stub Notice records history; the real typings don't declare it. */
const noticeHistory = (): Array<{ message: string }> =>
  (Notice as unknown as { history: Array<{ message: string }> }).history;

function orBookingInput(n: number): NewEpisodeInput {
  return episodeInput({
    mrn: `90000000${n}`,
    patientName: `Synthetic Patient R${n}`,
    phone: "",
    caseName: `Synthetic booking ${n}`,
    pathway: "or-booking",
    priority: "routine",
    nextAction: "Confirm OR booking",
    dueDate: "2026-08-20"
  });
}

function procedureInput(
  patientId: string,
  episodeId: string,
  followUp: { required: boolean; date?: string; plan?: string } = { required: false }
) {
  return {
    patientId,
    episodeId,
    procedure: "Synthetic tonsillectomy",
    procedureDate: "2026-08-11",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: followUp.required,
    followUpDate: followUp.date ?? "",
    followUpPlan: followUp.plan ?? ""
  };
}

/** Makes the first frontmatter update touching Episodes/ fail once. */
function injectEpisodeWriteFailure(h: Harness): void {
  const repo = h.repository as unknown as {
    update: (path: string, changes: Record<string, unknown>) => Promise<unknown>;
  };
  const realUpdate = repo.update.bind(h.repository);
  let armed = true;
  repo.update = async (path: string, changes: Record<string, unknown>) => {
    if (armed && path.includes("/Episodes/")) {
      armed = false;
      throw new Error("Injected write failure (synthetic)");
    }
    return realUpdate(path, changes);
  };
}

async function eventActions(h: Harness): Promise<string[]> {
  const files = markdownFilesInFolder(h.app.vault as never, `${clinicalRootFolder()}/Events`);
  const bodies = await Promise.all(
    files.map((file) =>
      (h.app.vault as unknown as { cachedRead(file: TFile): Promise<string> }).cachedRead(file as TFile)
    )
  );
  return bodies
    .map((content) => /^action: (.+)$/m.exec(content)?.[1] ?? "")
    .filter((action) => action !== "");
}

/* ------------------------------------------------ procedure retry (A) ---- */

test("a procedure retry with different follow-up details is rejected, never mixed", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(orBookingInput(41));
  injectEpisodeWriteFailure(h);
  await assert.rejects(
    h.service.completeProcedure(
      procedureInput(created.patient.record.id, created.episode.record.id, {
        required: true,
        date: FUTURE,
        plan: "Synthetic wound review"
      })
    ),
    /Injected write failure/
  );

  // The retry disables follow-up: a silent mix would discharge the episode
  // while the persisted record still promises a follow-up.
  await assert.rejects(
    h.service.completeProcedure(
      procedureInput(created.patient.record.id, created.episode.record.id, { required: false })
    ),
    /already recorded with different follow-up details/
  );

  const episode = await h.repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.notEqual(episode!.record.pathway, "discharge-ready", "the rejected retry changed nothing");
  const procedures = await h.repository.list<ProcedureRecord>("procedure");
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0]!.record.follow_up_required, true);
});

test("an identical procedure retry converges and settles the audit event", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(orBookingInput(42));
  injectEpisodeWriteFailure(h);
  const input = procedureInput(created.patient.record.id, created.episode.record.id, {
    required: true,
    date: FUTURE,
    plan: "Synthetic wound review"
  });
  await assert.rejects(h.service.completeProcedure(input));
  const retried = await h.service.completeProcedure(input);

  const episode = await h.repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode!.record.pathway, "opd-follow-up");
  assert.equal(episode!.record.status, "active");
  const tasks = await h.repository.list<TaskRecord>("task");
  assert.equal(tasks.filter(({ record }) => record.task_type === "postop-follow-up").length, 1);
  const procedures = await h.repository.list<ProcedureRecord>("procedure");
  assert.equal(procedures.length, 1, "exactly one logbook entry");
  // The completion event is owed by the workflow, not by note creation, so
  // the successful retry writes it and clears the pending marker.
  assert.equal(retried.record.audit_pending, false);
  assert.ok((await eventActions(h)).includes("procedure-completed"));
});

/* ----------------------------------------------- date validation (B) ----- */

test("impossible procedure and follow-up dates are rejected before any write", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(orBookingInput(51));
  const filesBefore = markdownFilesInFolder(h.app.vault as never, clinicalRootFolder()).length;

  await assert.rejects(
    h.service.completeProcedure({
      ...procedureInput(created.patient.record.id, created.episode.record.id),
      procedureDate: "2026-02-31"
    }),
    /not a valid calendar date/
  );
  await assert.rejects(
    h.service.completeProcedure(
      procedureInput(created.patient.record.id, created.episode.record.id, {
        required: true,
        date: "2026-02-30",
        plan: "Synthetic review"
      })
    ),
    /not a valid calendar date/
  );
  await assert.rejects(
    h.service.completeProcedure(
      procedureInput(created.patient.record.id, created.episode.record.id, {
        required: true,
        date: "2020-01-01",
        plan: "Synthetic review"
      })
    ),
    /cannot be before the procedure date/
  );

  assert.equal(
    markdownFilesInFolder(h.app.vault as never, clinicalRootFolder()).length,
    filesBefore,
    "zero files were created by any rejected submission"
  );
  const episode = await h.repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode!.record.pathway, "or-booking", "the episode was not transitioned");
});

/* --------------------------------------------------- audit gaps (D) ------ */

test("a lost audit event is reported by integrity and announced to the user", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(orBookingInput(61));

  const vault = h.app.vault as unknown as {
    create: (path: string, content: string) => Promise<unknown>;
  };
  const realCreate = vault.create.bind(h.app.vault);
  vault.create = async (path: string, content: string) => {
    if (path.includes("/Events/")) throw new Error("Injected event write failure (synthetic)");
    return realCreate(path, content);
  };
  const noticesBefore = noticeHistory().length;

  const result = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Synthetic call family",
    taskType: "call-patient",
    priority: "routine",
    dueDate: FUTURE,
    owner: ""
  });
  assert.equal(result.duplicate, false, "the clinical action itself succeeds");

  const issues = await h.integrity.scan();
  assert.ok(
    issues.some(
      (issue) => issue.code === "missing-audit-event" && issue.recordId === result.task.record.id
    ),
    "integrity reports the audit gap for exactly the affected record"
  );
  const newNotices = noticeHistory().slice(noticesBefore).map((notice) => notice.message);
  assert.ok(
    newNotices.some((message) => message.includes("audit note could not be written")),
    "the user is warned without identifiers"
  );
});

/* ------------------------------------------- recovery inventory (F) ------ */

type InventoryPlugin = {
  app: StubApp;
  repository: ClinicalRepository;
  settings: ClinicalSettings;
  missingRootRecoveryBlocked: boolean;
  missingRootRequiresRecords: boolean;
  managedRecordsExpected: boolean;
  workspaceInitialized: boolean;
  structureReady: boolean;
  firstUseInitializationPending: boolean;
  pendingMigrationMarker: unknown;
  expectedManagedRecordCount: number;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  noteManagedRecordWrite: () => Promise<void>;
  retryPendingMigrationRecovery: () => Promise<boolean>;
};

test("recovery refuses a root whose parsed records differ despite an equal file count", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const h = await harness();
    await h.service.createEpisode(orBookingInput(71));
    await h.service.createEpisode(orBookingInput(72));

    const plugin = new ClinicalWorkspacePlugin(
      h.app as unknown as App,
      {} as never
    ) as unknown as InventoryPlugin;
    plugin.app = h.app;
    plugin.repository = h.repository;
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.firstUseInitializationPending = false;
    plugin.pendingMigrationMarker = null;
    plugin.workspaceInitialized = true;
    plugin.structureReady = true;
    plugin.managedRecordsExpected = true;
    plugin.loadData = async () => null;
    plugin.saveData = async () => undefined;
    plugin.refreshOpenViews = async () => undefined;

    // Commit the healthy inventory, then arm the fail-closed barrier.
    await plugin.noteManagedRecordWrite();
    plugin.missingRootRecoveryBlocked = true;
    plugin.missingRootRequiresRecords = true;

    // Replace one patient note with unparseable content. The raw file count
    // is unchanged — only the parsed inventory can tell the difference.
    const patient = (await h.repository.list("patient"))[0]!;
    const original = h.app.vault.files.get(patient.path)!;
    h.app.vault.writeRaw(patient.path, "---\nnote: synthetic sync damage\n---\n");
    h.repository.invalidatePath(patient.path);

    assert.equal(await plugin.retryPendingMigrationRecovery(), false, "count parity is not enough");
    assert.equal(plugin.missingRootRecoveryBlocked, true);

    // Restoring the record satisfies the committed inventory again.
    h.app.vault.writeRaw(patient.path, original);
    h.repository.invalidatePath(patient.path);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

/* --------------------------------------- integrity coverage matrix (G) --- */

test("the corruption classes that previously passed silently are all reported", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(orBookingInput(81));
  const episodeId = created.episode.record.id;
  const patientId = created.patient.record.id;
  const root = clinicalRootFolder();
  const vault = h.app.vault as unknown as { writeRaw(path: string, content: string): void };

  const rawTask = (id: string, fields: string, mutate: (value: string) => string = (value) => value) =>
    mutate(`---
schema_version: 3
entity: task
id: ${id}
created_at: "2026-08-11T00:00:00.000Z"
updated_at: "2026-08-11T00:00:00.000Z"
tags: []
patient_id: ${patientId}
patient: "link"
episode_id: ${episodeId}
episode: "link"
status: completed
priority: routine
due_date: "2026-09-01"
owner: ""
completed_at: "2026-08-11T00:00:00.000Z"
cancelled_at: ""
cancel_reason: ""
${fields}
---
body
`);

  vault.writeRaw(`${root}/Tasks/TSK-g1.md`, rawTask("TSK-g1", 'task: "Synthetic g1"\ntask_type: clinical-review\nidempotency_key: task-a1', (value) => value.replace("schema_version: 3", "schema_version: 99")));
  vault.writeRaw(`${root}/Tasks/TSK-g2.md`, rawTask("TSK-g2", 'task: "Synthetic g2"\ntask_type: banana\nidempotency_key: task-a2'));
  vault.writeRaw(`${root}/Tasks/TSK-g3.md`, rawTask("TSK-g3", 'task: "Synthetic g3"\ntask_type: clinical-review'));
  vault.writeRaw(`${root}/Tasks/TSK-g4.md`, rawTask("TSK-g4", 'task: "Synthetic g4"\ntask_type: clinical-review\nidempotency_key: task-a4', (value) => value.replace('created_at: "2026-08-11T00:00:00.000Z"', 'created_at: "not-a-timestamp"')));
  vault.writeRaw(`${root}/Tasks/TSK-g5.md`, rawTask("TSK-g5", 'task: "Synthetic g5"\ntask_type: clinical-review\nidempotency_key: task-a5'));
  vault.writeRaw(`${root}/Tasks/TSK-g5b.md`, rawTask("TSK-g5", 'task: "Synthetic g5 second"\ntask_type: clinical-review\nidempotency_key: task-a6'));
  vault.writeRaw(`${root}/Procedures/PRC-g6.md`, `---
schema_version: 3
entity: procedure
id: PRC-g6
created_at: "2026-08-11T00:00:00.000Z"
updated_at: "2026-08-11T00:00:00.000Z"
tags: []
patient_id: ${patientId}
patient: "link"
episode_id: ${episodeId}
episode: "link"
procedure: "Synthetic g6"
procedure_date: "2026-08-11"
role: "Primary surgeon"
status: banana
outcome: ""
follow_up_required: true
follow_up_date: ""
follow_up_plan: ""
idempotency_key: procedure-a7
---
body
`);
  vault.writeRaw(`${root}/Episodes/EPI-g8.md`, `---
schema_version: 3
entity: episode
id: EPI-g8
created_at: "2026-08-11T00:00:00.000Z"
updated_at: "2026-08-11T00:00:00.000Z"
tags: []
patient_id: ${patientId}
patient: "link"
case: "Synthetic phantom next action"
care_setting: outpatient
pathway: assessment
priority: routine
status: active
next_action: "Synthetic call that no task tracks"
due_date: "2026-09-01"
opened_at: "2026-08-11T00:00:00.000Z"
closed_at: ""
outcome: ""
pathway_before_archive: ""
status_before_archive: ""
---
body
`);

  const issues = await h.integrity.scan();
  const codesFor = (recordId: string) =>
    issues.filter((issue) => issue.recordId === recordId).map((issue) => issue.code);
  assert.ok(codesFor("TSK-g1").includes("unsupported-schema-version"));
  assert.ok(codesFor("TSK-g2").includes("invalid-value"), "task_type enum is now checked");
  assert.ok(codesFor("TSK-g3").includes("missing-idempotency-key"));
  assert.ok(codesFor("TSK-g4").includes("invalid-timestamp"));
  assert.ok(codesFor("TSK-g5").includes("duplicate-record-id"));
  assert.ok(codesFor("PRC-g6").includes("invalid-value"), "procedure status enum is now checked");
  assert.ok(codesFor("PRC-g6").includes("follow-up-contradiction"));
  assert.ok(codesFor("EPI-g8").includes("untracked-next-action"));
});

/* ------------------------------------------------ scan performance (H) --- */

test("the integrity scan stays linear on a large balanced synthetic caseload", async () => {
  const h = await harness();
  const root = clinicalRootFolder();
  const vault = h.app.vault as unknown as { writeRaw(path: string, content: string): void };

  const seed = (from: number, to: number): void => {
  for (let index = from; index < to; index += 1) {
    const patientId = `PAT-h${index}`;
    const episodeId = `EPI-h${index}`;
    vault.writeRaw(`${root}/Patients/${patientId}.md`, `---\nschema_version: 3\nentity: patient\nid: ${patientId}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\nmrn: "90001${String(index).padStart(5, "0")}"\nmrn_status: confirmed\npatient_name: "Synthetic H ${index}"\nphone: ""\nphone_status: not-found\nstatus: active\nmerged_into: ""\n---\n`);
    vault.writeRaw(`${root}/Events/EVT-p${index}.md`, `---\nschema_version: 3\nentity: event\nid: EVT-p${index}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\naction: patient-created\nactor: local-user\npatient_id: ${patientId}\nepisode_id: ""\ntarget_id: ${patientId}\ntarget_entity: patient\nsummary: "Patient identity created"\nprevious_state: ""\nnew_state: active\n---\n`);
    vault.writeRaw(`${root}/Episodes/${episodeId}.md`, `---\nschema_version: 3\nentity: episode\nid: ${episodeId}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\npatient_id: ${patientId}\npatient: "link"\ncase: "Synthetic case ${index}"\ncare_setting: outpatient\npathway: assessment\npriority: routine\nstatus: active\nnext_action: ""\ndue_date: ""\nopened_at: "2026-08-11T00:00:00.000Z"\nclosed_at: ""\noutcome: ""\npathway_before_archive: ""\nstatus_before_archive: ""\n---\n`);
    vault.writeRaw(`${root}/Events/EVT-e${index}.md`, `---\nschema_version: 3\nentity: event\nid: EVT-e${index}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\naction: episode-created\nactor: local-user\npatient_id: ${patientId}\nepisode_id: ${episodeId}\ntarget_id: ${episodeId}\ntarget_entity: episode\nsummary: "Episode created"\nprevious_state: ""\nnew_state: assessment/active\n---\n`);
    for (let t = 0; t < 5; t += 1) {
      const taskId = `TSK-h${index}-${t}`;
      vault.writeRaw(`${root}/Tasks/${taskId}.md`, `---\nschema_version: 3\nentity: task\nid: ${taskId}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\npatient_id: ${patientId}\npatient: "link"\nepisode_id: ${episodeId}\nepisode: "link"\ntask: "Synthetic task ${index}-${t}"\ntask_type: clinical-review\nstatus: completed\npriority: routine\ndue_date: "2026-09-01"\nowner: ""\ncompleted_at: "2026-08-11T00:00:00.000Z"\ncancelled_at: ""\ncancel_reason: ""\nidempotency_key: task-h${index}${t}\n---\n`);
      vault.writeRaw(`${root}/Events/EVT-t${index}-${t}.md`, `---\nschema_version: 3\nentity: event\nid: EVT-t${index}-${t}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\naction: task-created\nactor: local-user\npatient_id: ${patientId}\nepisode_id: ${episodeId}\ntarget_id: ${taskId}\ntarget_entity: task\nsummary: "Task created"\nprevious_state: ""\nnew_state: open\n---\n`);
    }
    for (let p = 0; p < 2; p += 1) {
      const procedureId = `PRC-h${index}-${p}`;
      vault.writeRaw(`${root}/Procedures/${procedureId}.md`, `---\nschema_version: 3\nentity: procedure\nid: ${procedureId}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\npatient_id: ${patientId}\npatient: "link"\nepisode_id: ${episodeId}\nepisode: "link"\nprocedure: "Synthetic procedure ${index}-${p}"\nprocedure_date: "2026-08-01"\nrole: "Primary surgeon"\nstatus: completed\noutcome: ""\nfollow_up_required: false\nfollow_up_date: ""\nfollow_up_plan: ""\naudit_pending: false\nidempotency_key: procedure-h${index}${p}\n---\n`);
      vault.writeRaw(`${root}/Events/EVT-c${index}-${p}.md`, `---\nschema_version: 3\nentity: event\nid: EVT-c${index}-${p}\ncreated_at: "2026-08-11T00:00:00.000Z"\nupdated_at: "2026-08-11T00:00:00.000Z"\ntags: []\naction: procedure-completed\nactor: local-user\npatient_id: ${patientId}\nepisode_id: ${episodeId}\ntarget_id: ${procedureId}\ntarget_entity: procedure\nsummary: "Procedure completed"\nprevious_state: ""\nnew_state: ready to close\n---\n`);
    }
  }
  };

  // Absolute times vary wildly across CI machines, so the regression signal
  // is the GROWTH RATE for a 4x caseload: linear ≈ 4x, the old
  // episodes.find-per-task scan ≈ 16x. Best-of-two warm scans each.
  const time = async (): Promise<number> => {
    await h.integrity.scan(); // warm the parse cache; measure algorithmic cost
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 2; run += 1) {
      const start = performance.now();
      const issues = await h.integrity.scan();
      best = Math.min(best, performance.now() - start);
      assert.deepEqual(issues, []);
    }
    return best;
  };

  seed(0, 400); // 400 patients+episodes, 2000 tasks, 800 procedures + events
  const small = await time();
  seed(400, 1600); // grow 4x: 14,400 records + 14,400 events
  const large = await time();
  const ratio = large / Math.max(small, 1);
  assert.ok(
    ratio < 9,
    `4x caseload took ${ratio.toFixed(1)}x as long (${small.toFixed(0)}ms -> ${large.toFixed(0)}ms); expected near-linear growth`
  );
});

/* ----------------------------------------------- what's-new window ------- */

test("the what's-new window shows once per update and never on a fresh install", async () => {
  const { shouldShowWhatsNew } = await import("../src/main");
  // Fresh install: no stored version, workspace never initialized.
  assert.equal(shouldShowWhatsNew(null, "0.5.0", false), false);
  // Update from a version that predates the record, on a used workspace.
  assert.equal(shouldShowWhatsNew(null, "0.5.0", true), true);
  // Ordinary update.
  assert.equal(shouldShowWhatsNew("0.5.0", "0.6.0", true), true);
  // Already seen for this version.
  assert.equal(shouldShowWhatsNew("0.5.0", "0.5.0", true), false);
});

/* --------------------------------------------- Sync-safe repairs (J) ----- */

test("a Sync delivery landing during a scaffold repair is never overwritten", async () => {
  const h = await harness();
  const root = clinicalRootFolder();
  const basePath = `${root}/Bases/Patients.base`;
  const { baseFiles } = await import("../src/data/bases");
  const vault = h.app.vault as unknown as {
    writeRaw(path: string, content: string): void;
    files: Map<string, string>;
    latency: number;
  };

  // A stale-but-untouched base generated for a previous root: eligible for
  // repair, exactly the state the old read-then-modify would rewrite.
  const stale = baseFiles("Old Synthetic Root")["Old Synthetic Root/Bases/Patients.base"]!;
  vault.writeRaw(basePath, stale);

  vault.latency = 25; // widen the repair window
  const repair = h.repository.ensureStructure();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const userContent = "filters: user-customised synthetic base delivered by Sync\n";
  vault.writeRaw(basePath, userContent);
  await repair;
  vault.latency = 0;

  assert.equal(
    vault.files.get(basePath),
    userContent,
    "the repair re-checked inside Vault.process and left the synced content alone"
  );
});
