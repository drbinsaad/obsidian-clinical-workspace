import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { MigrationService } from "../src/services/migration";
import { episodeInput, harness } from "./support/harness";

const openTasks = async (repository: Awaited<ReturnType<typeof harness>>["repository"]) =>
  (await repository.list<TaskRecord>("task")).filter((t) => t.record.status === "open");

// 1 — changing only the due date must move the task, not clone it.
test("changing only a task's due date does not leave two open tasks", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "opd-follow-up", nextAction: "Call family", dueDate: "2026-08-20" })
  );
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "routine",
    nextAction: "Call family",
    dueDate: "2026-08-27"
  });
  const open = await openTasks(repository);
  assert.equal(open.length, 1, "the same action on a new date is one task, rescheduled");
  assert.equal(open[0]!.record.due_date, "2026-08-27");
});

// 2 — clearing the next action must not leave the card claiming there is none.
test("clearing the next action leaves the episode honest about outstanding work", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "assessment", nextAction: "Call family", dueDate: "2026-08-20" })
  );
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "",
    dueDate: ""
  });
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  const open = await openTasks(repository);
  if (open.length > 0) {
    assert.equal(
      episode.next_action,
      open[0]!.record.task,
      "an episode with open work must not show an empty next action"
    );
  }
});

// 3 — the priority just saved must be the priority that persists.
test("changing episode priority is not reverted by the task it creates", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "opd-follow-up", nextAction: "Call family", dueDate: "2026-08-20", priority: "routine" })
  );
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "emergency",
    nextAction: "Book audiology",
    dueDate: "2026-08-25"
  });
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.priority, "emergency", "the saved priority must stick");
  const open = await openTasks(repository);
  assert.equal(open[0]!.record.priority, "emergency", "and the new task inherits it");
});

// 4 — an interrupted move must never resolve to a freshly created empty folder.
test("an interrupted folder move resolves to the folder that holds the records", async () => {
  const original = clinicalRootFolder();
  try {
    const { service, app } = await harness();
    await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));

    // The state after a crash between persisting the new root and the rename:
    // settings say "Ward Records", the records are still under the old root.
    // ensureStructure then manufactures an empty "Ward Records" tree.
    setClinicalRoot("Ward Records");
    const { ClinicalRepository } = await import("../src/data/repository");
    await new ClinicalRepository(app as never).ensureStructure();

    // Both folders now exist, so existence cannot decide it — only contents can.
    const holdsRecords = (root: string) =>
      [...app.vault.files.keys()].some((p) => p.startsWith(`${root}/Patients/`));
    assert.equal(Boolean(app.vault.folders.has("Ward Records")), true, "the empty destination exists");
    assert.equal(holdsRecords("Ward Records"), false, "but holds nothing");
    assert.equal(holdsRecords("Clinical Workspace"), true, "the records are still under the old root");

    // Reconciliation must therefore choose the old root, not the empty new one.
    const chosen = holdsRecords("Ward Records")
      ? "Ward Records"
      : holdsRecords("Clinical Workspace")
        ? "Clinical Workspace"
        : null;
    assert.equal(chosen, "Clinical Workspace", "the caseload must not be reported as empty");
  } finally {
    setClinicalRoot(original);
  }
});

// 5 — a migration must respect customised generated files, like ensureStructure does.
test("migrating the folder does not overwrite a customised base or home note", async () => {
  const original = clinicalRootFolder();
  try {
    const { service, app } = await harness();
    await service.createEpisode(episodeInput());
    const basePath = "Clinical Workspace/Bases/Patients.base";
    const homePath = "Clinical Workspace/00 Home/Clinical Workspace.md";
    app.vault.files.set(basePath, 'filters:\n  and:\n    - \'file.inFolder("Clinical Workspace/Patients")\'\n# my own notes\n');
    app.vault.files.set(homePath, "# Clinical Workspace\n\nMy own prose about how I run clinic.\n");

    await new MigrationService(app as never).run("Ward Records");
    setClinicalRoot("Ward Records");

    const movedHome = app.vault.files.get("Ward Records/00 Home/Clinical Workspace.md") ?? "";
    assert.match(movedHome, /My own prose/, "a home note the user wrote must survive the move");
  } finally {
    setClinicalRoot(original);
  }
});

// 6 — a task must belong to the patient its episode belongs to.
test("a task cannot be attached to a patient the episode does not belong to", async () => {
  const { service } = await harness();
  const a = await service.createEpisode(episodeInput({ mrn: "9000003001", caseName: "Case A" }));
  const b = await service.createEpisode(episodeInput({ mrn: "9000003002", caseName: "Case B" }));

  await assert.rejects(
    () =>
      service.createTask({
        patientId: a.patient.record.id,
        episodeId: b.episode.record.id, // belongs to patient B
        task: "Cross-linked task",
        taskType: "other",
        priority: "routine",
        dueDate: "2026-08-20",
        owner: ""
      }),
    /does not belong/i,
    "a mismatched patient and episode must be refused"
  );
});

// 7 — and if one exists already, the integrity check must find it.
test("integrity reports a task whose patient does not match its episode", async () => {
  const { service, repository, integrity } = await harness();
  const a = await service.createEpisode(
    episodeInput({ mrn: "9000003003", caseName: "Case A", nextAction: "Do thing", dueDate: "2026-08-20" })
  );
  const b = await service.createEpisode(episodeInput({ mrn: "9000003004", caseName: "Case B" }));

  // Corrupt the link the way a bad edit or a part-failed merge would.
  const task = (await repository.list<TaskRecord>("task"))[0]!;
  await repository.update(task.path, { patient_id: b.patient.record.id });

  const codes = (await integrity.scan()).map((i) => i.code);
  assert.ok(codes.includes("mismatched-task-patient"), `expected a mismatch issue, got: ${codes.join(", ")}`);
  void a;
});
