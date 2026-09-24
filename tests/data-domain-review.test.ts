/**
 * Data-layer and domain fixes from the comprehensive review: index
 * freshness under concurrent vault events, numeric YAML in text fields,
 * matching keys, local timestamps, versioned Bases, task-bundle
 * diagnostics, and the integrity rules that make those states visible.
 * Synthetic data only; MRNs use the 9000 series.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { App, type TFile } from "obsidian";
import { parse } from "yaml";
import ClinicalWorkspacePlugin from "../src/main";
import {
  baseFiles,
  baseFolderFilter,
  baseSourceFolders,
  generatedBaseVersions,
  homeNote,
  LEGACY_HOME_OPEN_LINE
} from "../src/data/bases";
import { parseClinicalRecord, storedValueKindsOf } from "../src/data/markdown";
import { clinicalRootFolder, setClinicalRoot, wikilink } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import { baseQueriesOtherRoot, isUntouchedBase, isUntouchedHome } from "../src/data/scaffold";
import { parseTaskBundle } from "../src/data/templates";
import {
  createId,
  formatLocalDateTime,
  normalizeComparable,
  normalizeText,
  searchKey
} from "../src/domain/schema";
import { validateRootFolder } from "../src/domain/settings";
import type {
  EpisodeRecord,
  PatientRecord,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import { validateRecord } from "../src/domain/validate";
import { MigrationService } from "../src/services/migration";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness, type Harness } from "./support/harness";

type ReadableVault = {
  cachedRead(file: TFile): Promise<string>;
  writeRaw(path: string, content: string): void;
  deleteRaw(path: string): void;
  renameRaw(from: string, to: string): void;
  files: Map<string, string>;
};

function vaultOf(h: Harness): ReadableVault {
  return h.app.vault as unknown as ReadableVault;
}

/** Holds the first cachedRead of `target` until `release()` is called. */
function holdFirstRead(h: Harness, target: string): {
  held: () => boolean;
  release: () => void;
  restore: () => void;
} {
  const vault = vaultOf(h);
  const original = vault.cachedRead.bind(vault);
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vault.cachedRead = async (file: TFile) => {
    const content = await original(file);
    if (file.path === target && !held) {
      held = true;
      await gate;
    }
    return content;
  };
  return { held: () => held, release, restore: () => (vault.cachedRead = original) };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "condition was never reached");
}

async function withRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const original = clinicalRootFolder();
  setClinicalRoot(root);
  try {
    return await fn();
  } finally {
    setClinicalRoot(original);
  }
}

/* ---------------------------------------------- Index freshness ----- */

test("a change delivered while a list read is in flight is re-read, not served stale", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000000401", nextAction: "Review result", dueDate: "2026-09-01" })
  );
  const task = created.task!;
  h.repository.invalidatePath(task.path);
  const gate = holdFirstRead(h, task.path);
  const listing = h.repository.list<TaskRecord>("task");
  await until(gate.held);

  // Sync delivers the desktop's completion while the phone's read is suspended.
  const vault = vaultOf(h);
  vault.writeRaw(task.path, vault.files.get(task.path)!.replace("status: open", "status: completed"));
  h.repository.invalidatePath(task.path);
  gate.release();
  await listing;
  gate.restore();

  const after = await h.repository.list<TaskRecord>("task");
  assert.equal(
    after.find((item) => item.record.id === task.record.id)?.record.status,
    "completed",
    "the in-flight read must not repopulate the index after its invalidation"
  );
});

test("an unreadable-note scan racing a repair does not hide the repaired note", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000000402", nextAction: "Review result", dueDate: "2026-09-01" })
  );
  const task = created.task!;
  const vault = vaultOf(h);
  const healthy = vault.files.get(task.path)!;
  vault.writeRaw(task.path, healthy.replace(/^task: .*$/m, 'task: "unterminated'));
  h.repository.invalidatePath(task.path);

  const gate = holdFirstRead(h, task.path);
  const scan = h.repository.unreadablePaths("task");
  await until(gate.held);
  vault.writeRaw(task.path, healthy);
  h.repository.invalidatePath(task.path);
  gate.release();
  await scan;
  gate.restore();

  const listed = await h.repository.list<TaskRecord>("task");
  assert.ok(
    listed.some((item) => item.record.id === task.record.id),
    "a stale 'unreadable' entry would make the open task invisible"
  );
  assert.deepEqual(await h.repository.unreadablePaths("task"), []);
});

test("the parse memo drops deleted notes and the old side of a rename", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000000403", nextAction: "Review result", dueDate: "2026-09-01" })
  );
  const memo = (h.repository as unknown as { parsedRecords: Map<string, unknown> }).parsedRecords;
  const vault = vaultOf(h);
  await h.repository.snapshot();
  const taskPath = created.task!.path;
  const episodePath = created.episode.path;
  assert.ok(memo.has(taskPath) && memo.has(episodePath));

  vault.deleteRaw(taskPath);
  h.repository.invalidatePath(taskPath);
  assert.equal(memo.has(taskPath), false, "a deleted note keeps no content in memory");

  const renamed = episodePath.replace(/EPI-[^/]+\.md$/, "EPI-renamed.md");
  vault.renameRaw(episodePath, renamed);
  h.repository.invalidatePath(renamed);
  h.repository.invalidatePath(episodePath);
  assert.equal(memo.has(episodePath), false, "the old path of a rename is forgotten");

  // A modify keeps the memo: an unchanged re-read skips the YAML parse.
  const patientPath = created.patient.path;
  const before = memo.get(patientPath);
  h.repository.invalidatePath(patientPath);
  await h.repository.list("patient");
  assert.equal(memo.get(patientPath), before);
});

test("parseManagedContent reuses the content-keyed memo", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000000404" }));
  const content = vaultOf(h).files.get(created.patient.path)!;
  const first = h.repository.parseManagedContent(created.patient.path, content);
  assert.ok(first);
  assert.equal(h.repository.parseManagedContent(created.patient.path, content), first);
  const changed = content.replace("status: active", "status: archived");
  const reparsed = h.repository.parseManagedContent(created.patient.path, changed);
  assert.notEqual(reparsed, first);
  assert.equal((reparsed as PatientRecord).status, "archived");
});

test("the trusted inventory parses through the repository memo", async () => {
  const h = await harness();
  await h.service.createEpisode(episodeInput({ mrn: "9000000405", nextAction: "Review", dueDate: "2026-09-01" }));
  const plugin = new ClinicalWorkspacePlugin(h.app as unknown as App, {} as never) as unknown as {
    app: StubApp;
    repository: ClinicalRepository;
    parsedRecordInventory(root: string): Promise<{ total: number; digest: string }>;
  };
  plugin.app = h.app;
  plugin.repository = h.repository;
  const parsed: unknown[] = [];
  const memoized = h.repository.parseManagedContent.bind(h.repository);
  h.repository.parseManagedContent = (filePath, content) => {
    const record = memoized(filePath, content);
    parsed.push(record);
    return record;
  };
  const first = await plugin.parsedRecordInventory(clinicalRootFolder());
  const firstRecords = parsed.splice(0);
  const second = await plugin.parsedRecordInventory(clinicalRootFolder());
  assert.equal(first.total, 3);
  assert.equal(second.digest, first.digest);
  assert.equal(firstRecords.length, 3);
  assert.deepEqual(parsed, firstRecords, "unchanged notes return the memoized records");
  assert.ok(parsed.every((record, index) => record === firstRecords[index]));
});

/* ------------------------------------- Numeric YAML in text fields ----- */

test("unquoted numeric identifiers read back as text and are reported", async () => {
  const record = parseClinicalRecord(
    [
      "---",
      "schema_version: 3",
      "entity: patient",
      "id: PAT-numeric",
      "mrn: 0090000077",
      "phone: 0500000000",
      "patient_name:",
      "status: active",
      "---",
      ""
    ].join("\n")
  ) as PatientRecord;
  assert.equal(record.mrn, "90000077", "YAML already dropped the zeros; the value is now text");
  assert.equal(record.phone, "0500000000".slice(1), "the leading zero is already gone");
  assert.equal(record.patient_name, "");
  assert.equal(record.schema_version, 3, "non-text fields keep their type");
  const kinds = storedValueKindsOf(record);
  assert.equal(kinds.get("mrn"), "number");
  assert.equal(kinds.get("phone"), "number");
  assert.equal(kinds.get("patient_name"), "null");
  assert.equal(kinds.has("schema_version"), false);

  // A defensive label never throws on a non-string value.
  assert.equal(wikilink("Clinical Workspace/Patients/PAT-numeric.md", 90000077 as unknown as string),
    "[[Clinical Workspace/Patients/PAT-numeric|90000077]]");
  assert.equal(wikilink("Clinical Workspace/Patients/PAT-numeric.md"), "[[Clinical Workspace/Patients/PAT-numeric]]");
});

test("an MRN-only patient with an unquoted MRN can still be given tasks, and the check says why", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000000406", patientName: "" }));
  const vault = vaultOf(h);
  const patientPath = created.patient.path;
  vault.writeRaw(patientPath, vault.files.get(patientPath)!.replace(/^mrn: .*$/m, "mrn: 0090000077"));
  h.repository.invalidatePath(patientPath);

  const result = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Synthetic follow-up call",
    taskType: "call-patient",
    priority: "routine",
    dueDate: "2026-09-02",
    owner: ""
  });
  assert.match(result.task.record.patient, /\|90000077\]\]$/);

  const issues = await h.integrity.scan();
  const numeric = issues.filter((issue) => issue.code === "text-stored-as-number");
  assert.equal(numeric.length, 1);
  assert.equal(numeric[0]!.path, patientPath);
  assert.match(numeric[0]!.message, /"mrn".*leading zeros may have been lost.*quotes/);
  assert.doesNotMatch(numeric[0]!.message, /90000077|9000000406/);
});

test("updates still verify on a record whose YAML holds a numeric text field", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000000407" }));
  const vault = vaultOf(h);
  const patientPath = created.patient.path;
  vault.writeRaw(patientPath, vault.files.get(patientPath)!.replace(/^mrn: .*$/m, "mrn: 0090000077"));
  h.repository.invalidatePath(patientPath);

  const phone = await h.repository.update<PatientRecord>(patientPath, { phone: "0500000001" });
  assert.equal(phone.record.phone, "0500000001");
  assert.equal(phone.record.mrn, "90000077");

  const corrected = await h.repository.update<PatientRecord>(patientPath, { mrn: "0090000077" });
  assert.equal(corrected.record.mrn, "0090000077", "a quoted MRN round-trips with its zeros");
  assert.equal(storedValueKindsOf(corrected.record).has("mrn"), false);
});

test("a repeat interval that is not a whole number of days is reported", () => {
  const task = (repeat: unknown): TaskRecord =>
    ({
      schema_version: 3,
      entity: "task",
      id: "TSK-repeat",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      tags: [],
      status: "open",
      priority: "routine",
      task_type: "other",
      idempotency_key: "task-x",
      ...(repeat === undefined ? {} : { repeat_every_days: repeat })
    }) as unknown as TaskRecord;
  const flagged = (repeat: unknown): boolean =>
    validateRecord(task(repeat)).some((problem) => problem.code === "invalid-repeat-interval");
  assert.equal(flagged(undefined), false);
  assert.equal(flagged(""), false);
  assert.equal(flagged(0), false);
  assert.equal(flagged(7), false);
  assert.equal(flagged(730), false);
  assert.equal(flagged("7"), true, "a quoted number shows the badge but never recurs");
  assert.equal(flagged(1.5), true);
  assert.equal(flagged(-1), true);
  assert.equal(flagged(731), true);
});

/* -------------------------------------------------- Matching keys ----- */

test("searchKey folds Arabic digits, hamza, ta marbuta, alef maqsura, tashkeel and tatweel", () => {
  assert.equal(searchKey("٩٠٠٠٤٠٨"), "9000408");
  assert.equal(searchKey("۹۰۰۰۴۰۸"), "9000408");
  assert.equal(searchKey("أمل"), searchKey("امل"));
  assert.equal(searchKey("إيمان"), searchKey("ايمان"));
  assert.equal(searchKey("آمنة"), searchKey("امنه"));
  assert.equal(searchKey("ٱلنور"), searchKey("النور"));
  assert.equal(searchKey("هدى"), searchKey("هدي"));
  assert.equal(searchKey("مُحَمَّد"), searchKey("محمد"));
  assert.equal(searchKey("محـــمد"), searchKey("محمد"));
  assert.equal(searchKey("مؤمن"), searchKey("مومن"));
  assert.equal(searchKey("هيئة"), searchKey("هييه"));
  assert.equal(searchKey("  Synthetic   PATIENT "), "synthetic patient");
  assert.equal(searchKey("a؜b"), "ab");
  assert.equal(searchKey(null), "");
  // Matching only: the stored/display normalisation is unchanged.
  assert.equal(normalizeText("أمل"), "أمل");
  assert.equal(normalizeComparable("هدى"), "هدى");
  // The Arabic Letter Mark is a bidi control, stripped like LRM/RLM.
  assert.equal(normalizeText("x؜y"), "xy");
});

/* ----------------------------------------------- Local timestamps ----- */

test("formatLocalDateTime shows stored UTC timestamps in local time", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Asia/Riyadh";
    assert.equal(formatLocalDateTime("2026-08-03T22:30:00.000Z"), "2026-08-04 01:30");
    assert.equal(formatLocalDateTime("2026-08-03T08:05:00Z"), "2026-08-03 11:05");
    process.env.TZ = "UTC";
    assert.equal(formatLocalDateTime("2026-08-03T22:30:00.000Z"), "2026-08-03 22:30");
    assert.equal(formatLocalDateTime("hand-edited text"), "hand-edited text");
    assert.equal(formatLocalDateTime("2026-08-03"), "2026-08-03", "a bare date is not shifted");
    assert.equal(formatLocalDateTime(""), "");
    assert.equal(formatLocalDateTime(undefined), "");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

/* ------------------------------------------------ Generated Bases ----- */

const SAMPLE_ROOTS = [
  "Clinical Workspace",
  "Dr O'Brien Ward",
  "St John's/Men's Surgery",
  "عيادة الجراحة",
  "Hospital/Surgery/Ward 3"
];

test("every generated base parses as YAML and queries its folder, whatever the root", () => {
  for (const root of SAMPLE_ROOTS) {
    assert.equal(validateRootFolder(root), null, `${root} is an accepted root`);
    const folders = baseSourceFolders(root);
    for (const [basePath, content] of Object.entries(baseFiles(root))) {
      const parsed = parse(content) as { filters: { and: string[] } };
      assert.equal(parsed.filters.and[0], `file.inFolder("${folders[basePath]}")`, basePath);
      assert.ok(content.includes(baseFolderFilter(folders[basePath]!)));
      assert.equal(isUntouchedBase(basePath, content), true, basePath);
      assert.equal(baseQueriesOtherRoot(content, root), false, basePath);
    }
  }
});

test("bases broken by an apostrophe in the root are recognised and repaired", async () => {
  const root = "Dr O'Brien Ward";
  const broken = generatedBaseVersions(root)[1]!;
  for (const [basePath, content] of Object.entries(broken)) {
    // 0.6.9 wrote invalid YAML for this root, and it must still count as untouched.
    assert.throws(() => parse(content));
    assert.equal(isUntouchedBase(basePath, content), true, basePath);
  }
  await withRoot(root, async () => {
    const h = await harness();
    const vault = vaultOf(h);
    for (const [basePath, content] of Object.entries(broken)) vault.writeRaw(basePath, content);
    await h.repository.ensureStructure();
    for (const [basePath, content] of Object.entries(baseFiles(root))) {
      assert.equal(vault.files.get(basePath), content);
      assert.doesNotThrow(() => parse(vault.files.get(basePath)!));
    }
  });
});

test("the surgery logbook base lists completed procedures only, with retracted ones apart", () => {
  const logbook = baseFiles("Clinical Workspace")["Clinical Workspace/Bases/Surgery Logbook.base"]!;
  const parsed = parse(logbook) as {
    views: { name: string; filters?: { and?: string[]; or?: string[] } }[];
  };
  const main = parsed.views.find((view) => view.name === "Surgery logbook");
  assert.deepEqual(main?.filters?.and, ['status == "completed"']);
  const retracted = parsed.views.find((view) => view.name === "Retracted");
  assert.deepEqual(retracted?.filters?.or, ['status == "cancelled"', 'status == "entered-in-error"']);
});

test("an untouched older base is upgraded; a customised one is left alone", async () => {
  const h = await harness();
  const vault = vaultOf(h);
  const root = clinicalRootFolder();
  const logbookPath = `${root}/Bases/Surgery Logbook.base`;
  const tasksPath = `${root}/Bases/Tasks.base`;
  const v1 = generatedBaseVersions(root)[1]!;
  vault.writeRaw(logbookPath, v1[logbookPath]!);
  const customised = `${v1[tasksPath]!}# my own view notes\n`;
  vault.writeRaw(tasksPath, customised);

  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await h.repository.ensureStructure();
  } finally {
    console.warn = warn;
  }
  assert.equal(vault.files.get(logbookPath), baseFiles(root)[logbookPath]);
  assert.equal(vault.files.get(tasksPath), customised);
  assert.equal(warnings.length, 0, "a customised base on the right folder is not a problem");
});

test("a folder move regenerates untouched older bases at the latest version", async () => {
  const h = await harness();
  const vault = vaultOf(h);
  const root = clinicalRootFolder();
  await h.service.createEpisode(episodeInput({ mrn: "9000000409" }));
  for (const [basePath, content] of Object.entries(generatedBaseVersions(root)[1]!)) {
    vault.writeRaw(basePath, content);
  }
  vault.writeRaw(`${root}/00 Home/Clinical Workspace.md`, homeNote(root, LEGACY_HOME_OPEN_LINE));

  await new MigrationService(h.app as never).run("Ward Records");
  for (const [basePath, content] of Object.entries(baseFiles("Ward Records"))) {
    assert.equal(vault.files.get(basePath), content, basePath);
  }
  assert.equal(vault.files.get("Ward Records/00 Home/Clinical Workspace.md"), homeNote("Ward Records"));
});

test("the home note names the real command and untouched older homes are upgraded", async () => {
  const h = await harness();
  const vault = vaultOf(h);
  const root = clinicalRootFolder();
  const homePath = `${root}/00 Home/Clinical Workspace.md`;
  assert.match(homeNote(root), /\*\*Clinical Workspace: Open workspace\*\*/);
  assert.match(homeNote(root), /stethoscope ribbon icon/);

  const legacy = homeNote(root, LEGACY_HOME_OPEN_LINE);
  assert.equal(isUntouchedHome(legacy), true);
  vault.writeRaw(homePath, legacy);
  await h.repository.ensureStructure();
  assert.equal(vault.files.get(homePath), homeNote(root));

  const edited = `${legacy}\nMy own clinic notes.\n`;
  vault.writeRaw(homePath, edited);
  await h.repository.ensureStructure();
  assert.equal(vault.files.get(homePath), edited, "a home note the user wrote in is theirs");
});

test("the integrity check names a customised base left pointing at another root", async () => {
  const h = await harness();
  const vault = vaultOf(h);
  const root = clinicalRootFolder();
  const patientsBase = `${root}/Bases/Patients.base`;
  const tasksBase = `${root}/Bases/Tasks.base`;
  assert.equal((await h.integrity.scan()).some((issue) => issue.code === "stale-base-folder"), false);

  vault.writeRaw(patientsBase, `${baseFiles("Old Synthetic Root")["Old Synthetic Root/Bases/Patients.base"]!}# customised\n`);
  vault.writeRaw(tasksBase, `${baseFiles(root)[tasksBase]!}# customised on the right root\n`);
  const stale = (await h.integrity.scan()).filter((issue) => issue.code === "stale-base-folder");
  assert.deepEqual(stale.map((issue) => issue.path), [patientsBase]);
  assert.match(stale[0]!.message, /file\.inFolder/);
  assert.doesNotMatch(stale[0]!.message, /Old Synthetic Root/);
});

/* --------------------------------------------------- Task bundles ----- */

test("task bundles tolerate hand-typed values and explain what they changed", () => {
  const bundle = parseTaskBundle(
    "Clinical Workspace/Templates/Synthetic.md",
    [
      "---",
      "clinical_template: Task-Bundle ",
      "pathway: or-bookin",
      "tasks:",
      "  - task: Confirm consent",
      "    task_type: Clinical-Review",
      "    priority: ' Urgent '",
      "    due_in_days: \"3\"",
      "  - task: Arabic digits",
      "    due_in_days: \"٧\"",
      "  - task: Bad values",
      "    task_type: book-theatre",
      "    priority: soon",
      "    due_in_days: next week",
      "  - task: \"\"",
      "  - just text",
      "---",
      ""
    ].join("\n")
  );
  assert.ok(bundle);
  assert.equal(bundle.pathway, null);
  assert.deepEqual(bundle.tasks[0], {
    task: "Confirm consent",
    taskType: "clinical-review",
    priority: "urgent",
    dueInDays: 3
  });
  assert.equal(bundle.tasks[1]?.dueInDays, 7);
  assert.deepEqual(bundle.tasks[2], { task: "Bad values", taskType: "other", priority: null, dueInDays: null });
  assert.deepEqual(bundle.warnings, [
    'Item 3: task type not recognised, so it will be created as "other".',
    "Item 3: priority not recognised, so the episode's priority will be used.",
    "Item 3: due_in_days is not a whole number from 0 to 730, so the task will be undated.",
    "Item 4 has no task text and was skipped.",
    "Item 5 is not a task entry and was skipped.",
    "The pathway is not recognised, so this template is offered for every episode."
  ]);

  const clean = parseTaskBundle(
    "Clinical Workspace/Templates/Clean.md",
    "---\nclinical_template: task-bundle\npathway: or-booking\ntasks:\n  - task: Book theatre\n    task_type: book-or\n---\n"
  );
  assert.deepEqual(clean?.warnings, []);
  assert.equal(clean?.pathway, "or-booking");
});

/* ------------------------------------------ Retired-patient records ----- */

test("a record synced under a merged patient is reported with a repair path", async () => {
  const h = await harness();
  const source = await h.service.createEpisode(episodeInput({ mrn: "9000000410", caseName: "Case A" }));
  const target = await h.service.createEpisode(episodeInput({ mrn: "9000000411", caseName: "Case B" }));
  await h.service.mergePatients(source.patient.record.id, target.patient.record.id);
  assert.equal(
    (await h.integrity.scan()).some((issue) => issue.code === "record-linked-to-merged-patient"),
    false
  );

  // Device B wrote this episode offline before it saw the merge.
  const straggler = await h.repository.create<EpisodeRecord>({
    ...target.episode.record,
    id: createId("EPI"),
    patient_id: source.patient.record.id,
    case: "Case written offline"
  });
  const issues = (await h.integrity.scan()).filter(
    (issue) => issue.code === "record-linked-to-merged-patient"
  );
  assert.deepEqual(issues.map((issue) => issue.recordId), [straggler.record.id]);
  assert.equal(issues[0]!.severity, "error");
  assert.match(issues[0]!.message, /merged_into/);
  assert.doesNotMatch(issues[0]!.message, /9000000410|Case written offline/);
});

test("an open episode under an archived or entered-in-error patient is reported", async () => {
  const h = await harness();
  const archived = await h.service.createEpisode(episodeInput({ mrn: "9000000412" }));
  const retracted = await h.service.createEpisode(episodeInput({ mrn: "9000000413" }));
  const closed = await h.service.createEpisode(episodeInput({ mrn: "9000000414" }));
  await h.repository.update<PatientRecord>(archived.patient.path, { status: "archived" });
  await h.repository.update<PatientRecord>(retracted.patient.path, { status: "entered-in-error" });
  await h.service.archiveEpisode(closed.episode.record.id, "Discharged");

  const issues = (await h.integrity.scan()).filter(
    (issue) => issue.code === "active-episode-under-inactive-patient"
  );
  assert.deepEqual(
    issues.map((issue) => issue.recordId).sort(),
    [archived.episode.record.id, retracted.episode.record.id].sort(),
    "a patient archived with their last episode is expected, not a problem"
  );
  assert.match(issues.find((issue) => issue.recordId === archived.episode.record.id)!.message, /status back to active/);
});

/* ---------------------------------------------- Export readiness ----- */

test("the integrity check flags completed procedures the logbook exporter would reject", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000000415", pathway: "or-booking" }));
  const procedure = await h.service.completeProcedure({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    procedure: "Synthetic procedure",
    procedureDate: "2026-08-08",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  });
  const notExportable = async () =>
    (await h.integrity.scan()).filter((issue) => issue.code === "not-exportable");
  assert.deepEqual(await notExportable(), [], "plugin-written procedures export cleanly");

  const vault = vaultOf(h);
  vault.writeRaw(
    procedure.path,
    vault.files
      .get(procedure.path)!
      .replace(/^outcome: .*$/m, "outcome:")
      .replace(/^created_at: .*$/m, "created_at: 2026-08-08T08:00:00+00:00")
      .replace(/^procedure_date: .*$/m, "procedure_date: 2026-08-08T09:30:00")
  );
  h.repository.invalidatePath(procedure.path);
  const [issue, ...rest] = await notExportable();
  assert.equal(rest.length, 0);
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.path, procedure.path);
  assert.match(issue!.message, /outcome .*procedure_date .*created_at/);
  assert.doesNotMatch(issue!.message, /Synthetic procedure|Primary surgeon/);

  // A retracted procedure never reaches the CSV, so it is not flagged.
  await h.repository.update<ProcedureRecord>(procedure.path, { status: "entered-in-error" });
  assert.deepEqual(await notExportable(), []);
});

/* -------------------------------------------------- Source hygiene ----- */

function sourceFilesWithNulByte(folders: string[]): string[] {
  const offenders: string[] = [];
  const visit = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const target = path.join(folder, name);
      if (statSync(target).isDirectory()) visit(target);
      else if (!name.startsWith("._") && /\.(ts|mjs|md)$/.test(name) && readFileSync(target).includes(0)) offenders.push(target);
    }
  };
  for (const folder of folders) visit(folder);
  return offenders;
}

test("no tracked source file contains a literal NUL byte", () => {
  assert.deepEqual(sourceFilesWithNulByte(["src", "scripts", "tests"]), []);
});

test("the NUL-byte scan skips macOS AppleDouble sidecars like the other source gates", () => {
  // A checkout on an exFAT or network volume gets a binary ._name sidecar
  // beside any file with extended attributes. It is git-ignored, never
  // tracked, and always starts with NUL bytes.
  const root = mkdtempSync(path.join(os.tmpdir(), "clinical-nul-scan-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "._quick-entry.ts"), Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02]));
    writeFileSync(path.join(root, "src", "quick-entry.ts"), "export const clean = true;\n");
    writeFileSync(path.join(root, "src", "broken.ts"), "export const broken = 1;\u0000\n");
    assert.deepEqual(sourceFilesWithNulByte([path.join(root, "src")]), [path.join(root, "src", "broken.ts")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
