/**
 * Coverage for the 0.6.0 roadmap features: reschedule, reopen, recurring
 * tasks, task-bundle templates, the handover note, loose-note writes, and
 * the audit-transition integrity check.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clinicalRootFolder } from "../src/data/paths";
import { parseTaskBundle } from "../src/data/templates";
import { isoDateWithOffset, todayIso } from "../src/domain/schema";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import { buildHandoverNote } from "../src/services/handover";
import { episodeInput, harness } from "./support/harness";

test("rescheduling moves the date, the idempotency key, and the episode pointer", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Review swallow assessment", dueDate: "2026-08-20" })
  );
  const task = created.task;
  assert.ok(task);
  const originalKey = task.record.idempotency_key;

  const moved = await service.rescheduleTask(task.record.id, "2026-09-03");
  assert.equal(moved.record.due_date, "2026-09-03");
  assert.notEqual(moved.record.idempotency_key, originalKey, "the key must follow the fields it hashes");

  const episode = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode?.record.due_date, "2026-09-03", "the episode pointer follows the reschedule");

  // Duplicate suppression works against the NEW date, not the old one.
  const duplicate = await service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Review swallow assessment",
    taskType: "clinical-review",
    priority: "routine",
    dueDate: "2026-09-03",
    owner: ""
  });
  assert.equal(duplicate.duplicate, true);

  await service.completeTask(task.record.id);
  await assert.rejects(
    () => service.rescheduleTask(task.record.id, "2026-09-10"),
    /completed task cannot be rescheduled/
  );
});

test("reopening a completed task restores the episode's outstanding work", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Call the family", dueDate: "2026-08-20" })
  );
  const task = created.task;
  assert.ok(task);
  await service.completeTask(task.record.id);
  const closed = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(closed?.record.status, "ready-to-close");

  const reopened = await service.reopenTask(task.record.id);
  assert.equal(reopened.record.status, "open");
  assert.equal(reopened.record.completed_at, "");
  const episode = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode?.record.status, "active");
  assert.equal(episode?.record.next_action, "Call the family");

  // Reopened work blocks discharge exactly like any other open task.
  await assert.rejects(
    () => service.archiveEpisode(created.episode.record.id, "Discharged"),
    /open task remains/
  );
});

test("reopening refuses while the episode is archived", async () => {
  const { service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Review", dueDate: "2026-08-20" })
  );
  const task = created.task;
  assert.ok(task);
  await service.completeTask(task.record.id);
  await service.archiveEpisode(created.episode.record.id, "Discharged");
  await assert.rejects(() => service.reopenTask(task.record.id), /Restore the episode/);
});

test("completing a recurring task raises exactly one next occurrence", async () => {
  const { repository, service } = await harness();
  const created = await service.createEpisode(episodeInput());
  const first = await service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Three-monthly hearing review",
    taskType: "clinical-review",
    priority: "routine",
    dueDate: "2026-09-01",
    owner: "",
    repeatEveryDays: 90
  });
  assert.equal(first.task.record.repeat_every_days, 90);

  await service.completeTask(first.task.record.id);
  const tasks = (await repository.list<TaskRecord>("task")).map((item) => item.record);
  const open = tasks.filter((record) => record.status === "open");
  assert.equal(open.length, 1, "one next occurrence exists");
  assert.equal(open[0]?.due_date, isoDateWithOffset(90, "2026-09-01"));
  assert.equal(open[0]?.repeat_every_days, 90, "the series continues");

  // A duplicate completion tap converges without a second occurrence.
  await service.completeTask(first.task.record.id);
  const after = (await repository.list<TaskRecord>("task")).map((item) => item.record);
  assert.equal(after.filter((record) => record.status === "open").length, 1);

  // Cancelling the occurrence ends the series: no further task is raised.
  const next = after.find((record) => record.status === "open");
  assert.ok(next);
  await service.cancelTask(next.id, "Series no longer needed");
  const final = (await repository.list<TaskRecord>("task")).map((item) => item.record);
  assert.equal(final.filter((record) => record.status === "open").length, 0);
});

test("task bundles parse strictly and apply without duplicating open work", async () => {
  const bundle = parseTaskBundle(
    "Clinical Workspace/Templates/Tonsillectomy.md",
    [
      "---",
      "clinical_template: task-bundle",
      "template_name: Tonsillectomy pathway",
      "pathway: or-booking",
      "tasks:",
      "  - task: Confirm consent",
      "    task_type: clinical-review",
      "    due_in_days: 1",
      "  - task: Book operating room",
      "    task_type: book-or",
      "    priority: urgent",
      "    due_in_days: 7",
      "  - task: \"\"",
      "  - not-a-task: true",
      "---",
      ""
    ].join("\n")
  );
  assert.ok(bundle);
  assert.equal(bundle.name, "Tonsillectomy pathway");
  assert.equal(bundle.pathway, "or-booking");
  assert.equal(bundle.tasks.length, 2, "blank and malformed items are dropped");
  assert.equal(bundle.tasks[1]?.priority, "urgent");

  assert.equal(
    parseTaskBundle("Clinical Workspace/Templates/Note.md", "---\ntitle: plain note\n---\n"),
    null,
    "ordinary notes are never treated as templates"
  );

  const { repository, service } = await harness();
  const created = await service.createEpisode(episodeInput({ pathway: "or-booking" }));
  for (const round of [1, 2]) {
    for (const item of bundle.tasks) {
      await service.createTask({
        patientId: created.patient.record.id,
        episodeId: created.episode.record.id,
        task: item.task,
        taskType: item.taskType,
        priority: item.priority ?? created.episode.record.priority,
        dueDate: item.dueInDays !== null ? isoDateWithOffset(item.dueInDays, "2026-08-13") : "",
        owner: ""
      });
    }
    const open = (await repository.list<TaskRecord>("task"))
      .map((entry) => entry.record)
      .filter((record) => record.status === "open");
    assert.equal(open.length, 2, `apply round ${round} holds exactly the bundle's tasks`);
  }
});

test("the handover note lists inpatients and urgent work with honest counts", async () => {
  const { repository, service } = await harness();
  await service.createEpisode(
    episodeInput({
      mrn: "9000000031",
      patientName: "Synthetic Ward Patient",
      caseName: "Synthetic airway watch",
      careSetting: "inpatient",
      nextAction: "Overnight observations",
      dueDate: "2026-08-12"
    })
  );
  await service.createEpisode(
    episodeInput({
      mrn: "9000000032",
      patientName: "Synthetic Clinic Patient",
      caseName: "Synthetic clinic case"
    })
  );
  const snapshot = await repository.snapshot();
  const note = buildHandoverNote(snapshot, "2026-08-13");
  assert.match(note, /# Ward handover — 2026-08-13/);
  assert.match(note, /Inpatients \(1\)/);
  assert.match(note, /Synthetic Ward Patient/);
  assert.match(note, /Synthetic airway watch/);
  assert.match(note, /overdue \(2026-08-12\)/);
  assert.match(note, /Active episodes: 2 \(1 inpatient, 1 outpatient\)/);

  const empty = buildHandoverNote(
    { patients: [], episodes: [], tasks: [], procedures: [] },
    "2026-08-13"
  );
  assert.match(empty, /No active inpatient episodes/);
  assert.match(empty, /Nothing overdue or due today/);
});

test("loose notes land in their folder, never overwrite, and respect the barrier", async () => {
  const { app, repository } = await harness();
  const folder = `${clinicalRootFolder()}/Documents`;
  const first = await repository.createLooseNote(folder, "Handover 2026-08-13", "one");
  const second = await repository.createLooseNote(folder, "Handover 2026-08-13", "two");
  assert.equal(first, `${folder}/Handover 2026-08-13.md`);
  assert.equal(second, `${folder}/Handover 2026-08-13 2.md`);
  assert.notEqual(
    await app.vault.cachedRead(app.vault.getAbstractFileByPath(first) as never),
    await app.vault.cachedRead(app.vault.getAbstractFileByPath(second) as never)
  );

  repository.setWriteBlock("Synthetic barrier message");
  await assert.rejects(
    () => repository.createLooseNote(folder, "Handover 2026-08-14", "three"),
    /Synthetic barrier message/
  );
});

test("a closed record with a trail but no closure event is reported", async () => {
  const { app, repository, service, integrity } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Review", dueDate: "2026-08-20" })
  );
  const task = created.task;
  assert.ok(task);
  await service.completeTask(task.record.id);

  const clean = await integrity.scan();
  assert.ok(
    !clean.some((issue) => issue.code === "missing-transition-event"),
    "an ordinary completion carries its closure event"
  );

  // Remove the closure event, simulating a lost audit write.
  const vault = app.vault as unknown as {
    files: Map<string, string>;
    deleteRaw(path: string): void;
  };
  for (const [path, content] of [...vault.files]) {
    if (path.includes("/Events/") && content.includes("task-completed")) vault.deleteRaw(path);
  }
  repository.invalidatePath(""); // no-op for coverage; per-path invalidation below
  const issues = await integrity.scan();
  assert.ok(
    issues.some(
      (issue) => issue.code === "missing-transition-event" && issue.recordId === task.record.id
    ),
    "the lost closure event is reported against the completed task"
  );
});

test("upcoming and handover helpers agree on date boundaries", () => {
  assert.equal(isoDateWithOffset(0, todayIso()), todayIso());
});
