import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeRecord, PatientRecord, ProcedureRecord, TaskRecord } from "../src/domain/types";
import { PossibleDuplicatePatientError } from "../src/services/clinical-service";
import { episodeInput, harness, withLatency } from "./support/harness";

const procedureInput = (patientId: string, episodeId: string, overrides = {}) => ({
  patientId,
  episodeId,
  procedure: "Tonsillectomy",
  procedureDate: "2026-08-11",
  role: "Primary surgeon",
  outcome: "",
  followUpRequired: false,
  followUpDate: "",
  followUpPlan: "",
  ...overrides
});

// --- P0-1: identity survives a renamed note ---------------------------------

test("a renamed note stays reachable, completable and dischargeable", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Chase histopathology", dueDate: "2026-08-10" })
  );
  const taskId = created.task!.record.id;
  const episodeId = created.episode.record.id;

  app.vault.renameRaw(created.task!.path, "Clinical Workspace/Tasks/Chase histopathology.md");

  const found = await repository.findById<TaskRecord>("task", taskId);
  assert.ok(found, "renamed task must still resolve by id");
  assert.equal(found.record.id, taskId);

  await service.completeTask(taskId);
  const episode = await repository.findById<EpisodeRecord>("episode", episodeId);
  assert.equal(episode!.record.status, "ready-to-close");

  await service.archiveEpisode(episodeId, "Discharged");
  const archived = await repository.findById<EpisodeRecord>("episode", episodeId);
  assert.equal(archived!.record.status, "archived");
});

test("a renamed episode note can still be updated and archived", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(episodeInput());
  const episodeId = created.episode.record.id;
  app.vault.renameRaw(created.episode.path, "Clinical Workspace/Episodes/Renamed case.md");

  await service.updateEpisode(episodeId, {
    careSetting: "inpatient",
    pathway: "assessment",
    priority: "urgent",
    nextAction: "",
    dueDate: ""
  });
  const updated = await repository.findById<EpisodeRecord>("episode", episodeId);
  assert.equal(updated!.record.care_setting, "inpatient");
  assert.equal(updated!.record.priority, "urgent");
});

// --- P0-2: editing an episode must not resurrect completed work -------------

test("re-saving an episode without changing the next action creates no task", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "opd-follow-up", nextAction: "Call family", dueDate: "2026-08-20" })
  );
  await service.completeTask(created.task!.record.id);

  // The user reopens the sheet only to raise the priority.
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "urgent",
    nextAction: "Call family",
    dueDate: "2026-08-20"
  });

  const tasks = await repository.list<TaskRecord>("task");
  assert.equal(tasks.length, 1, "no duplicate task may be created");
  assert.equal(tasks[0]!.record.status, "completed", "the completed task stays completed");
});

test("changing the next action does create a new task", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "opd-follow-up", nextAction: "Call family", dueDate: "2026-08-20" })
  );
  await service.completeTask(created.task!.record.id);
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "routine",
    nextAction: "Book audiology",
    dueDate: "2026-08-25"
  });
  const tasks = await repository.list<TaskRecord>("task");
  assert.equal(tasks.length, 2);
  assert.equal(tasks.filter((t) => t.record.status === "open").length, 1);
});

// --- P0-3: archive and restore are non-destructive ---------------------------

test("restore returns the pathway and keeps the discharge outcome", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({
      careSetting: "inpatient",
      pathway: "result-review",
      priority: "emergency",
      nextAction: "Review CT",
      dueDate: "2026-08-04"
    })
  );
  const episodeId = created.episode.record.id;
  await service.completeTask(created.task!.record.id);
  await service.archiveEpisode(episodeId, "Discharged home");
  await service.restoreEpisode(episodeId);

  const restored = (await repository.findById<EpisodeRecord>("episode", episodeId))!.record;
  assert.equal(restored.pathway, "result-review", "pathway must survive the round trip");
  assert.equal(restored.outcome, "Discharged home", "the discharge outcome is history, not scratch space");
  assert.equal(restored.care_setting, "inpatient");
  assert.equal(restored.priority, "emergency");
  assert.equal(restored.status, "ready-to-close");
});

// --- P1-2: surgery must not reclassify an inpatient --------------------------

test("completing surgery leaves the care setting alone", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({
      careSetting: "inpatient",
      pathway: "or-booking",
      nextAction: "Book OR",
      dueDate: "2026-08-09"
    })
  );
  await service.completeProcedure(procedureInput(created.patient.record.id, created.episode.record.id));
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.care_setting, "inpatient", "a post-operative inpatient is still an inpatient");
  assert.equal(episode.status, "ready-to-close");
  assert.equal(episode.pathway, "discharge-ready");
});

test("completing surgery closes the open OR booking task", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
  );
  await service.completeProcedure(procedureInput(created.patient.record.id, created.episode.record.id));
  const tasks = await repository.list<TaskRecord>("task");
  assert.equal(tasks.filter((t) => t.record.status === "completed").length, 1);
});

test("surgery with follow-up creates the follow-up task and keeps the episode active", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
  );
  await service.completeProcedure(
    procedureInput(created.patient.record.id, created.episode.record.id, {
      followUpRequired: true,
      followUpDate: "2026-09-01",
      followUpPlan: "Post-operative review"
    })
  );
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.status, "active");
  assert.equal(episode.pathway, "opd-follow-up");
  const open = (await repository.list<TaskRecord>("task")).filter((t) => t.record.status === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.record.task_type, "postop-follow-up");
});

// --- P1-1: idempotency under concurrency -------------------------------------

test("concurrent identical task submissions create exactly one task", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(episodeInput());
  const input = {
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Chase histopathology",
    taskType: "other" as const,
    priority: "routine" as const,
    dueDate: "2026-08-10",
    owner: ""
  };
  await withLatency(app, 1, () => Promise.all([service.createTask(input), service.createTask(input)]));
  const matching = (await repository.list<TaskRecord>("task")).filter(
    (t) => t.record.task === "Chase histopathology"
  );
  assert.equal(matching.length, 1);
});

test("concurrent identical procedure submissions create exactly one logbook entry", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
  );
  const input = procedureInput(created.patient.record.id, created.episode.record.id);
  await withLatency(app, 1, () =>
    Promise.allSettled([service.completeProcedure(input), service.completeProcedure(input)])
  );
  const procedures = await repository.list<ProcedureRecord>("procedure");
  assert.equal(procedures.length, 1);
});

test("double-tapping complete records the action once", async () => {
  const { service, repository, app } = await harness();
  const created = await service.createEpisode(episodeInput({ nextAction: "Chase result", dueDate: "2026-08-10" }));
  const taskId = created.task!.record.id;
  await withLatency(app, 1, () =>
    Promise.allSettled([service.completeTask(taskId), service.completeTask(taskId)])
  );
  const events = await repository.list("event");
  const completions = events.filter((e) => (e.record as { action?: string }).action === "task-completed");
  assert.equal(completions.length, 1);
});

// --- P1-5 / P1-6: patient identity ------------------------------------------

test("leading zeroes do not split one patient into two charts", async () => {
  const { service, repository } = await harness();
  await service.createEpisode(episodeInput({ mrn: "0012345", caseName: "Case one" }));
  await service.createEpisode(episodeInput({ mrn: "12345", caseName: "Case two" }));
  const patients = await repository.list<PatientRecord>("patient");
  assert.equal(patients.length, 1);
  assert.equal(patients[0]!.record.mrn, "0012345", "the value as first typed is preserved");
});

test("an MRN-less patient with a matching name raises a duplicate prompt", async () => {
  const { service, repository } = await harness();
  await service.createEpisode(episodeInput({ mrn: "", patientName: "Jane Doe", caseName: "Case one" }));
  await assert.rejects(
    () => service.createEpisode(episodeInput({ mrn: "", patientName: "Jane Doe", caseName: "Case two" })),
    PossibleDuplicatePatientError
  );
  assert.equal((await repository.list<PatientRecord>("patient")).length, 1);
});

test("the duplicate prompt can be resolved either way", async () => {
  const { service, repository } = await harness();
  const first = await service.createEpisode(
    episodeInput({ mrn: "", patientName: "Jane Doe", caseName: "Case one" })
  );

  await service.createEpisode(
    episodeInput({ mrn: "", patientName: "Jane Doe", caseName: "Case two", existingPatientId: first.patient.record.id })
  );
  assert.equal((await repository.list<PatientRecord>("patient")).length, 1);

  await service.createEpisode(
    episodeInput({ mrn: "", patientName: "Jane Doe", caseName: "Case three", forceNewPatient: true })
  );
  assert.equal((await repository.list<PatientRecord>("patient")).length, 2);
});

test("patient identity can be corrected", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(episodeInput({ mrn: "", patientName: "Unknown" }));
  await service.updatePatientIdentity(created.patient.record.id, {
    mrn: "0077",
    patientName: "Correct Name",
    phone: "0500000000"
  });
  const patient = (await repository.findById<PatientRecord>("patient", created.patient.record.id))!.record;
  assert.equal(patient.mrn, "0077");
  assert.equal(patient.mrn_status, "confirmed");
  assert.equal(patient.patient_name, "Correct Name");
  assert.equal(patient.phone_status, "confirmed");
});

test("identity edits cannot create an MRN collision", async () => {
  const { service } = await harness();
  await service.createEpisode(episodeInput({ mrn: "111", caseName: "A" }));
  const second = await service.createEpisode(episodeInput({ mrn: "222", caseName: "B" }));
  await assert.rejects(
    () => service.updatePatientIdentity(second.patient.record.id, { mrn: "111", patientName: "X", phone: "" }),
    /Merge the two records instead/
  );
});

test("merging moves every linked record and retires the source without deleting it", async () => {
  const { service, repository } = await harness();
  const a = await service.createEpisode(
    episodeInput({ mrn: "", patientName: "Jane Doe", caseName: "Case A", nextAction: "Do thing", dueDate: "2026-08-10" })
  );
  const b = await service.createEpisode(
    episodeInput({ mrn: "9001", patientName: "Jane Doe", caseName: "Case B", forceNewPatient: true })
  );

  const preview = await service.previewPatientMerge(a.patient.record.id, b.patient.record.id);
  assert.equal(preview.episodes, 1);
  assert.equal(preview.tasks, 1);

  await service.mergePatients(a.patient.record.id, b.patient.record.id);

  const episodes = await repository.list<EpisodeRecord>("episode");
  assert.ok(episodes.every((e) => e.record.patient_id === b.patient.record.id));
  const tasks = await repository.list<TaskRecord>("task");
  assert.ok(tasks.every((t) => t.record.patient_id === b.patient.record.id));

  const source = (await repository.findById<PatientRecord>("patient", a.patient.record.id))!.record;
  assert.equal(source.status, "entered-in-error", "the source is retired, never deleted");
  assert.equal(source.merged_into, b.patient.record.id);
});

test("a merged-away patient is no longer matched by MRN", async () => {
  const { service, repository } = await harness();
  const a = await service.createEpisode(episodeInput({ mrn: "4321", patientName: "A", caseName: "A" }));
  const b = await service.createEpisode(episodeInput({ mrn: "8765", patientName: "B", caseName: "B" }));
  await service.mergePatients(a.patient.record.id, b.patient.record.id);
  assert.equal(await repository.findPatientByMrn("4321"), null);
});

// --- P0-1 follow-up: cancellation unblocks a stuck episode -------------------

test("cancelling a task unblocks discharge", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(episodeInput({ nextAction: "Obsolete step", dueDate: "2026-08-10" }));
  await assert.rejects(() => service.archiveEpisode(created.episode.record.id, "Done"), /open task remains/);

  await service.cancelTask(created.task!.record.id, "No longer required");
  const cancelled = (await repository.findById<TaskRecord>("task", created.task!.record.id))!.record;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancel_reason, "No longer required");

  await service.archiveEpisode(created.episode.record.id, "Done");
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.status, "archived");
});

// --- P2-8: status is not clobbered ------------------------------------------

test("updating an episode does not silently reactivate an on-hold episode", async () => {
  const { service, repository } = await harness();
  const created = await service.createEpisode(episodeInput());
  await repository.update<EpisodeRecord>(created.episode.path, { status: "on-hold" });
  await service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "urgent",
    nextAction: "",
    dueDate: ""
  });
  const episode = (await repository.findById<EpisodeRecord>("episode", created.episode.record.id))!.record;
  assert.equal(episode.status, "on-hold");
});

// --- Referential integrity across the whole lifecycle ------------------------

test("a full lifecycle keeps every link intact", async () => {
  const { service, repository, integrity } = await harness();
  const created = await service.createEpisode(
    episodeInput({ pathway: "or-booking", nextAction: "Book OR", dueDate: "2026-08-09" })
  );
  await service.completeProcedure(
    procedureInput(created.patient.record.id, created.episode.record.id, {
      followUpRequired: true,
      followUpDate: "2026-09-01",
      followUpPlan: "Post-operative review"
    })
  );
  const open = (await repository.list<TaskRecord>("task")).filter((t) => t.record.status === "open");
  for (const item of open) await service.completeTask(item.record.id);
  await service.archiveEpisode(created.episode.record.id, "Discharged");
  await service.restoreEpisode(created.episode.record.id);

  const issues = await integrity.scan();
  assert.deepEqual(issues, [], "a clean lifecycle must produce no integrity issues");
});
