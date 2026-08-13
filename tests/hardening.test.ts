import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES } from "../src/domain/types";
import { normalizeSettings, validateRootFolder } from "../src/domain/settings";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { MigrationService } from "../src/services/migration";
import { episodeInput, harness } from "./support/harness";

const ALLOWED = { careSettings: CARE_SETTINGS, pathways: PATHWAYS, priorities: PRIORITIES };

const corrupt = (content: string) =>
  // An unterminated quote makes the whole frontmatter block unparseable.
  content.replace(/^task: .*$/m, 'task: "unterminated');

// --- Unreadable notes must never be treated as absent ------------------------

test("an unreadable task note blocks discharge instead of silently vanishing", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Chase histopathology", dueDate: "2026-08-10" })
  );
  app.vault.writeRaw(created.task!.path, corrupt(app.vault.files.get(created.task!.path)!));
  // Mirrors the vault modify event Obsidian fires for every external edit,
  // which the plugin routes to invalidatePath.
  repository.invalidatePath(created.task!.path);

  // The record is now invisible to list(), which is exactly the danger.
  assert.equal((await repository.list<TaskRecord>("task")).length, 0);
  assert.equal((await repository.unreadablePaths("task")).length, 1);

  await assert.rejects(
    () => service.archiveEpisode(created.episode.record.id, "Discharged"),
    /could not be read/,
    "discharge must not proceed while outstanding work cannot be confirmed"
  );
});

test("integrity reports an unreadable note", async () => {
  const { service, integrity, repository, app } = await harness();
  const created = await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));
  app.vault.writeRaw(created.task!.path, corrupt(app.vault.files.get(created.task!.path)!));
  // Mirrors the vault modify event for the external edit.
  repository.invalidatePath(created.task!.path);

  const issues = await integrity.scan();
  const unreadable = issues.filter((issue) => issue.code === "unreadable-record");
  assert.equal(unreadable.length, 1);
  assert.doesNotMatch(unreadable[0]!.message, /\d{5,}/, "no identifier in the message");
});

// --- Episode task supersession ----------------------------------------------

test("changing the next action cancels the task it replaces", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "opd-follow-up", nextAction: "Call family", dueDate: "2026-08-20" })
  );
  const result = await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "routine",
    nextAction: "Book audiology",
    dueDate: "2026-08-25"
  });

  assert.equal(result.task.kind, "created");
  const tasks = await repository.list<TaskRecord>("task");
  const open = tasks.filter((t) => t.record.status === "open");
  assert.equal(open.length, 1, "exactly one live task, not an accumulating pile");
  assert.equal(open[0]!.record.task, "Book audiology");
  const cancelled = tasks.find((t) => t.record.task === "Call family")!;
  assert.equal(cancelled.record.status, "cancelled");
  assert.match(cancelled.record.cancel_reason, /Superseded by/);
});

test("re-saving an unchanged episode still creates nothing", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "opd-follow-up", nextAction: "Call family", dueDate: "2026-08-20" })
  );
  await service.completeTask(created.task!.record.id);
  const result = await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "urgent",
    nextAction: "Call family",
    dueDate: "2026-08-20"
  });
  // Reported rather than silently dropped, so the interface can say so.
  assert.equal(result.task.kind, "already-closed");
  assert.equal((await repository.list<TaskRecord>("task")).length, 1);
});

// --- Archive guards ----------------------------------------------------------

test("archiving an already-archived episode does not destroy the restore data", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "result-review", nextAction: "Review CT", dueDate: "2026-08-04" })
  );
  await service.completeTask(created.task!.record.id);
  await service.archiveEpisode(created.episode.record.id, "Discharged home");
  await service.archiveEpisode(created.episode.record.id, "");

  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.pathway_before_archive, "result-review");
  assert.equal(episode.outcome, "Discharged home");

  await service.restoreEpisode(created.episode.record.id);
  const restored = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(restored.pathway, "result-review");
});

// --- Procedure and episode retry after a partial failure ---------------------

test("completing a procedure twice still finishes the workflow", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
  );
  const input = {
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    procedure: "Tonsillectomy",
    procedureDate: "2026-08-11",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  };

  // First attempt fails right after the procedure record is written.
  const realUpdate = repository.update.bind(repository);
  let fail = true;
  (repository as unknown as { update: typeof realUpdate }).update = async (path, changes) => {
    if (fail && path.includes("/Episodes/")) throw new Error("EIO: simulated failure");
    return realUpdate(path, changes);
  };
  await assert.rejects(() => service.completeProcedure(input));
  fail = false;

  // The retry must complete the workflow, not report success and stop.
  await service.completeProcedure(input);
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.pathway, "discharge-ready");
  assert.equal((await repository.list("procedure")).length, 1, "still exactly one procedure");
  void app;
});

test("a procedure leaves the episode active while unrelated tasks are open", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
  );
  await service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Chase histopathology",
    taskType: "other",
    priority: "routine",
    dueDate: "2026-08-20",
    owner: ""
  });
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
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.status, "active", "outstanding work must not be hidden by ready-to-close");
  assert.equal(episode.next_action, "Chase histopathology");
});

// --- Root folder validation --------------------------------------------------

test("path traversal is rejected anywhere in the folder path", async () => {
  assert.equal(validateRootFolder("Clinical Workspace"), null);
  assert.equal(validateRootFolder("Nested/Clinical"), null);
  for (const bad of ["../Escape", "Clinical/../../Documents", "a/../b", "ok/./x", "..", "x/.hidden"]) {
    assert.notEqual(validateRootFolder(bad), null, `${bad} must be rejected`);
  }
});

test("a folder name keeps its internal spacing", async () => {
  assert.equal(normalizeSettings({ rootFolder: "Ward  Records" }, ALLOWED).rootFolder, "Ward  Records");
  assert.equal(normalizeSettings({ rootFolder: "  Ward Records  " }, ALLOWED).rootFolder, "Ward Records");
  // An invalid stored root must not reach the workflow.
  assert.equal(normalizeSettings({ rootFolder: "../escape" }, ALLOWED).rootFolder, "Clinical Workspace");
});

test("a non-numeric refresh delay does not coerce to a number", async () => {
  assert.equal(normalizeSettings({ refreshDebounceMs: null }, ALLOWED).refreshDebounceMs, 180);
  assert.equal(normalizeSettings({ refreshDebounceMs: [] }, ALLOWED).refreshDebounceMs, 180);
  assert.equal(normalizeSettings({ refreshDebounceMs: true }, ALLOWED).refreshDebounceMs, 180);
  assert.equal(normalizeSettings({ refreshDebounceMs: "" }, ALLOWED).refreshDebounceMs, 180);
  assert.equal(normalizeSettings({ refreshDebounceMs: 250 }, ALLOWED).refreshDebounceMs, 250);
});

// --- Migration ---------------------------------------------------------------

test("migration moves every record and rewrites the links between them", async () => {
  const original = clinicalRootFolder();
  try {
    const { service, repository, app } = await harness();
    const created = await service.createEpisode(
      episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" })
    );
    const migration = new MigrationService(app as never);

    const plan = migration.plan("Ward Records");
    assert.equal(plan.blocked, null);
    assert.ok(plan.files > 0);

    const result = await migration.run("Ward Records");
    setClinicalRoot("Ward Records");

    assert.equal(result.danglingLinks, 0, "no link may still point at the old folder");
    const episodes = await repository.list<EpisodeRecord>("episode");
    assert.equal(episodes.length, 1);
    assert.match(episodes[0]!.path, /^Ward Records\/Episodes\//);
    assert.match(episodes[0]!.record.patient, /^\[\[Ward Records\/Patients\//);

    // The plugin must still be able to act on the moved records.
    await service.completeTask(created.task!.record.id);
    await service.archiveEpisode(created.episode.record.id, "Discharged");
    const archived = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!;
    assert.equal(archived.record.status, "archived");
  } finally {
    setClinicalRoot(original);
  }
});

test("migration regenerates the bases against the new root", async () => {
  const original = clinicalRootFolder();
  try {
    const { service, app } = await harness();
    await service.createEpisode(episodeInput());
    const migration = new MigrationService(app as never);
    await migration.run("Ward Records");
    setClinicalRoot("Ward Records");

    const base = app.vault.files.get("Ward Records/Bases/Patients.base");
    assert.ok(base, "the base moved with the folder");
    assert.match(base, /file\.inFolder\("Ward Records\/Patients"\)/);
    assert.doesNotMatch(base, /Clinical Workspace/);
  } finally {
    setClinicalRoot(original);
  }
});

test("migration refuses unsafe targets", async () => {
  const original = clinicalRootFolder();
  try {
    const { service, app } = await harness();
    await service.createEpisode(episodeInput());
    const migration = new MigrationService(app as never);
    assert.match(String(migration.plan("Clinical Workspace").blocked), /already the current folder/);
    assert.match(String(migration.plan("Clinical Workspace/Nested").blocked), /inside the current one/);
    assert.match(String(migration.plan("../Escape").blocked), /cannot/);
  } finally {
    setClinicalRoot(original);
  }
});

test("dangling links are detected if a rename fails to rewrite them", async () => {
  const original = clinicalRootFolder();
  try {
    const { service, app } = await harness();
    await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));
    const migration = new MigrationService(app as never);

    // Model an Obsidian that moves files but does NOT rewrite frontmatter links,
    // which is the assumption the migration rests on and cannot verify offline.
    const fm = app.fileManager as unknown as { renameFile: (f: unknown, p: string) => Promise<void> };
    fm.renameFile = async (file, newPath) => {
      const from = (file as { path: string }).path;
      for (const path of [...app.vault.files.keys()]) {
        if (path === from || path.startsWith(`${from}/`)) {
          app.vault.writeRaw(`${newPath}${path.slice(from.length)}`, app.vault.files.get(path)!);
          app.vault.deleteRaw(path);
        }
      }
      app.vault.folders.add(newPath);
    };

    const result = await migration.run("Ward Records");
    setClinicalRoot("Ward Records");
    assert.ok(result.danglingLinks > 0, "a broken rewrite must be detected, not assumed away");
  } finally {
    setClinicalRoot(original);
  }
});

// --- Generated scaffolding must not clobber user edits -----------------------

test("a user-edited home note is left alone", async () => {
  const { repository, app } = await harness();
  const homePath = "Clinical Workspace/00 Home/Clinical Workspace.md";
  const edited = "# Clinical Workspace\n\nMy own notes about how I run clinic.\n\n## Database views\n\n- ![[Clinical Workspace/Bases/Patients.base#Active patients]]\n";
  app.vault.writeRaw(homePath, edited);

  await repository.ensureStructure();
  assert.equal(app.vault.files.get(homePath), edited, "the plugin must not overwrite prose the user wrote");
});

test("untouched scaffolding is still repaired", async () => {
  const { repository, app } = await harness();
  const homePath = "Clinical Workspace/00 Home/Clinical Workspace.md";
  // The exact scaffold 0.1.0 wrote — anything else counts as the user's work.
  app.vault.writeRaw(
    homePath,
    [
      "# Clinical Workspace",
      "",
      "Use the **Open Clinical Workspace** command for the mobile patient, task and surgery interface.",
      "",
      "## Database views",
      "",
      "- ![[Clinical Workspace/Bases/Patients.base#Active patients]]",
      "- ![[Clinical Workspace/Bases/Tasks.base#Open tasks]]",
      "- ![[Clinical Workspace/Bases/Surgery Logbook.base#Surgery logbook]]",
      ""
    ].join("\n")
  );
  await repository.ensureStructure();
  assert.match(app.vault.files.get(homePath)!, /Patients\.base#All patients/);
});
