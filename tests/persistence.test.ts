import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stringifyYaml } from "obsidian";
import type { EpisodeRecord, PatientRecord, ProcedureRecord, TaskRecord } from "../src/domain/types";
import {
  coerceFrontmatterValue,
  parseClinicalRecord,
  recordMarkdown
} from "../src/data/markdown";
import { episodeInput, harness } from "./support/harness";

// --- Markdown round trip -----------------------------------------------------

test("every record type survives a markdown round trip unchanged", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ mrn: "0012345", phone: "0500000001", nextAction: "Chase result", dueDate: "2026-08-10" })
  );
  await service.completeProcedure({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    procedure: "Tonsillectomy",
    procedureDate: "2026-08-11",
    role: "Primary surgeon",
    outcome: "Uneventful",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  });

  for (const entity of ["patient", "episode", "task", "procedure", "event"] as const) {
    for (const item of await repository.list(entity)) {
      const reparsed = parseClinicalRecord(recordMarkdown(item.record));
      assert.deepEqual(reparsed, item.record, `${entity} must round trip unchanged`);
    }
  }
});

test("dates read back as strings, not Date objects", async () => {
  const { service, repository } = await harness();
  await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));
  const tasks = await repository.list<TaskRecord>("task");
  const task = tasks[0]!.record;
  assert.equal(typeof task.due_date, "string");
  assert.equal(task.due_date, "2026-08-10");
  assert.equal(typeof task.created_at, "string");
  assert.match(task.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("a YAML writer that yields Date objects is coerced back into strings", () => {
  // What js-yaml's default schema produces for an unquoted `due_date: 2026-08-03`.
  assert.equal(coerceFrontmatterValue("due_date", new Date("2026-08-03T00:00:00.000Z")), "2026-08-03");
  assert.equal(
    coerceFrontmatterValue("created_at", new Date("2026-08-03T13:15:30.951Z")),
    "2026-08-03T13:15:30.951Z"
  );
  assert.equal(coerceFrontmatterValue("procedure_date", new Date("2026-08-11T00:00:00.000Z")), "2026-08-11");
  // A date-time written by Obsidian's Properties panel becomes a calendar day.
  assert.equal(coerceFrontmatterValue("due_date", "2026-08-03T09:30:00"), "2026-08-03");
  // Nulls become empty strings so sorting and comparison never throw.
  assert.equal(coerceFrontmatterValue("case", null), "");
  assert.equal(coerceFrontmatterValue("follow_up_required", false), false);
});

test("an MRN with leading zeroes is not mangled into a number by YAML", () => {
  const yaml = stringifyYaml({ mrn: "0012345", phone: "0500000001" });
  assert.match(yaml, /mrn: ['"]0012345['"]/);
  assert.match(yaml, /phone: ['"]0500000001['"]/);
});

// --- Write verification ------------------------------------------------------

test("update verifies what it wrote", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(episodeInput());
  const updated = await repository.update<EpisodeRecord>(created.episode.path, { priority: "emergency" });
  assert.equal(updated.record.priority, "emergency");
  // Not asserting inequality: create and update can land in the same millisecond.
  assert.match(updated.record.updated_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(updated.record.updated_at >= created.episode.record.updated_at);
});

test("update on a missing record fails loudly", async () => {
  const { repository } = await harness();
  await assert.rejects(
    () => repository.update("Clinical Workspace/Episodes/EPI-nope.md", { priority: "urgent" }),
    /not found/
  );
});

// --- Malformed records -------------------------------------------------------

test("a hand-edited record does not take down the whole snapshot", async () => {
  const { service, repository, app } = await harness();
  const good = await service.createEpisode(episodeInput({ mrn: "111", caseName: "Good case" }));
  const bad = await service.createEpisode(episodeInput({ mrn: "222", caseName: "Bad case" }));

  const raw = app.vault.files.get(bad.episode.path)!;
  app.vault.files.set(
    bad.episode.path,
    raw.replace(/^case: Bad case$/m, "case:").replace(/^priority: routine$/m, "priority: Routine")
  );

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.episodes.length, 2, "both episodes still load");
  const broken = snapshot.episodes.find((e) => e.id === bad.episode.record.id)!;
  assert.equal(broken.case, "", "a null value is coerced to an empty string");

  // The sort keys the interface uses must tolerate it rather than throwing.
  assert.doesNotThrow(() => {
    [...snapshot.episodes].sort((a, b) => String(a.case ?? "").localeCompare(String(b.case ?? "")));
  });
  void good;
});

test("integrity reports the corrupt record rather than passing silently", async () => {
  const { service, integrity, app } = await harness();
  const bad = await service.createEpisode(episodeInput({ caseName: "Bad case" }));
  const raw = app.vault.files.get(bad.episode.path)!;
  app.vault.files.set(
    bad.episode.path,
    raw.replace(/^case: Bad case$/m, "case:").replace(/^priority: routine$/m, "priority: Routine")
  );

  const issues = await integrity.scan();
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("missing-episode-case"), "missing case must be reported");
  assert.ok(codes.includes("invalid-value"), "an unrecognised enum value must be reported");
});

// --- Integrity content -------------------------------------------------------

test("integrity messages never contain a patient identifier", async () => {
  const { service, repository, integrity } = await harness();
  const first = await service.createEpisode(episodeInput({ mrn: "9000000000001", patientName: "Test Name" }));
  // Recreate the duplicate an out-of-band sync conflict would leave behind.
  await repository.create({ ...first.patient.record, id: "PAT-duplicateaaaaaaaaaa" });

  const issues = await integrity.scan();
  const duplicates = issues.filter((issue) => issue.code === "duplicate-mrn");
  assert.ok(duplicates.length >= 2);
  for (const issue of issues) {
    assert.doesNotMatch(issue.message, /9000000000001/, "MRN must not appear in a message");
    assert.doesNotMatch(issue.message, /Test Name/, "patient name must not appear in a message");
    assert.doesNotMatch(issue.message, /\d{5,}/, "no identifier-shaped digit run in a message");
  }
});

test("integrity finds an orphan patient left by a partial write", async () => {
  const { service, repository, integrity, app } = await harness();
  const created = await service.createEpisode(episodeInput());
  app.vault.files.delete(created.episode.path);
  const codes = (await integrity.scan()).map((issue) => issue.code);
  assert.ok(codes.includes("orphan-patient"));
  void repository;
});

test("integrity finds an orphan task when its episode is moved out of the folder", async () => {
  const { service, integrity, app } = await harness();
  const created = await service.createEpisode(episodeInput({ nextAction: "Do thing", dueDate: "2026-08-10" }));
  app.vault.files.set("Archive/moved.md", app.vault.files.get(created.episode.path)!);
  app.vault.files.delete(created.episode.path);
  const codes = (await integrity.scan()).map((issue) => issue.code);
  assert.ok(codes.includes("orphan-task"));
});

// --- Partial failure ---------------------------------------------------------

test("a failed audit write does not fail or roll back the clinical action", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));

  const realCreate = app.vault.create.bind(app.vault);
  app.vault.create = (async (path: string, content: string) => {
    if (path.includes("/Events/")) throw new Error("EIO: simulated write failure");
    return realCreate(path, content);
  }) as typeof app.vault.create;

  await service.completeTask(created.task!.record.id);
  app.vault.create = realCreate;

  const task = (await repository.findById<TaskRecord>("task", created.task!.record.id))!.record;
  assert.equal(task.status, "completed", "the clinical action still commits");
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.status, "ready-to-close");
});

// --- Build output ------------------------------------------------------------

test("the release bundle contains no synthetic fixtures", async () => {
  let bundle: string;
  try {
    bundle = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  } catch {
    // dist/ is produced by `npm run build`; `npm run check` builds after testing.
    return;
  }
  assert.doesNotMatch(bundle, /Synthetic Patient/, "synthetic fixtures must be compiled out");
  assert.doesNotMatch(bundle, /seed-synthetic-demo-data/, "the dev command must be compiled out");
});

test("no source file writes an identifier to the console", async () => {
  const files = [
    "../src/main.ts",
    "../src/ui/workspace-view.ts",
    "../src/services/integrity.ts",
    "../src/services/clinical-service.ts"
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/console\.\w+\(([^\n]*)/g)) {
      const call = match[1] ?? "";
      assert.doesNotMatch(call, /\bissues\b|\brecord\b|\bpatient\b|\bmrn\b/i, `${file}: ${call.trim()}`);
    }
  }
});

test("patients, episodes, tasks and procedures are linked both ways", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
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

  const patients = await repository.list<PatientRecord>("patient");
  const episodes = await repository.list<EpisodeRecord>("episode");
  const tasks = await repository.list<TaskRecord>("task");
  const procedures = await repository.list<ProcedureRecord>("procedure");
  const patientIds = new Set(patients.map((p) => p.record.id));
  const episodeIds = new Set(episodes.map((e) => e.record.id));

  for (const episode of episodes) {
    assert.ok(patientIds.has(episode.record.patient_id));
    assert.match(episode.record.patient, /^\[\[Clinical Workspace\/Patients\//);
  }
  for (const task of tasks) {
    assert.ok(patientIds.has(task.record.patient_id));
    assert.ok(episodeIds.has(task.record.episode_id));
  }
  for (const procedure of procedures) {
    assert.ok(patientIds.has(procedure.record.patient_id));
    assert.ok(episodeIds.has(procedure.record.episode_id));
  }
});

// --- Displaced managed folders ----------------------------------------------

test("a record can still be written after its folder is moved away", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));

  // Reproduces dragging Clinical Workspace/Events into another folder.
  app.vault.folders.delete("Clinical Workspace/Events");
  for (const path of [...app.vault.files.keys()]) {
    if (path.startsWith("Clinical Workspace/Events/")) {
      app.vault.renameRaw(path, path.replace("Clinical Workspace/Events/", "Clinical Workspace/Inbox/Events/"));
    }
  }

  const before = (await repository.list("event")).length;
  await service.completeTask(created.task!.record.id);
  const after = (await repository.list("event")).length;
  assert.ok(after > before, "the audit note must still be written, not silently dropped");
});

test("integrity reports a managed folder that has gone missing", async () => {
  const { integrity, app } = await harness();
  app.vault.folders.delete("Clinical Workspace/Events");
  const issues = await integrity.scan();
  const missing = issues.filter((issue) => issue.code === "missing-folder");
  assert.equal(missing.length, 1);
  assert.match(missing[0]!.path, /Events$/);
  assert.doesNotMatch(missing[0]!.message, /\d{5,}/, "no identifier in the message");
});
