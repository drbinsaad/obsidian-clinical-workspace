/**
 * Clinical workflow service fixes from the comprehensive review: MRN identity
 * checks, name-only charts, Update-sheet task handling, recurring tasks,
 * discharge, restore, extra procedures, priority escalation, merge sweeps and
 * the handover note. Synthetic data only; MRNs are 9000-series.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  EpisodeRecord,
  EventRecord,
  PatientRecord,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import { CURRENT_SCHEMA_VERSION } from "../src/domain/types";
import { isoDateWithOffset, nowIso, todayIso } from "../src/domain/schema";
import { nextOccurrenceDate, priorityRank } from "../src/domain/transitions";
import {
  MrnIdentityConflictError,
  PossibleDuplicatePatientError
} from "../src/services/clinical-service";
import { buildHandoverNote, compareTasksByPriority } from "../src/services/handover";
import { episodeInput, harness, type Harness } from "./support/harness";

const events = async (h: Harness, action: string, targetId?: string): Promise<EventRecord[]> =>
  (await h.repository.list<EventRecord>("event"))
    .map((item) => item.record)
    .filter((event) => event.action === action && (targetId === undefined || event.target_id === targetId));

const tasksOf = async (h: Harness, episodeId: string): Promise<TaskRecord[]> =>
  (await h.repository.list<TaskRecord>("task"))
    .map((item) => item.record)
    .filter((task) => task.episode_id === episodeId);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000));

// --- MRN reuse with a conflicting name ---------------------------------------

test("an MRN typed with a different name is refused before any write until the owner is confirmed", async () => {
  const h = await harness();
  const first = await h.service.createEpisode(
    episodeInput({ mrn: "9000000101", patientName: "Synthetic Alpha", caseName: "Case A" })
  );

  await assert.rejects(
    () =>
      h.service.createEpisode(
        episodeInput({
          mrn: "9000000101",
          patientName: "Synthetic Bravo",
          caseName: "Case B",
          nextAction: "Review",
          dueDate: "2026-09-30"
        })
      ),
    (error: unknown) => {
      assert.ok(error instanceof MrnIdentityConflictError);
      assert.equal(error.patient.id, first.patient.record.id, "the stored record is carried for the modal");
      assert.equal(error.patient.patient_name, "Synthetic Alpha");
      assert.doesNotMatch(error.message, /Synthetic|\d{4,}/, "the message is identifier-free");
      return true;
    }
  );
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 1, "no episode was filed");
  assert.equal((await h.repository.list<TaskRecord>("task")).length, 0, "no task was filed");

  const confirmed = await h.service.createEpisode(
    episodeInput({
      mrn: "9000000101",
      patientName: "Synthetic Bravo",
      caseName: "Case B",
      confirmMrnOwner: first.patient.record.id
    })
  );
  assert.equal(confirmed.reusedPatient, true);
  assert.equal(confirmed.patient.record.id, first.patient.record.id);
  assert.equal(confirmed.patient.record.patient_name, "Synthetic Alpha", "the stored name is kept");
  assert.equal((await h.repository.list<PatientRecord>("patient")).length, 1);
});

test("a blank name on either side, a spelling variant or a new phone still reuses the MRN owner", async () => {
  const h = await harness();
  const nameless = await h.service.createEpisode(
    episodeInput({ mrn: "9000000102", patientName: "", caseName: "Case A" })
  );
  const filled = await h.service.createEpisode(
    episodeInput({ mrn: "9000000102", patientName: "Synthetic Charlie", caseName: "Case B" })
  );
  assert.equal(filled.patient.record.id, nameless.patient.record.id);
  assert.equal(filled.patient.record.patient_name, "Synthetic Charlie", "a blank stored name is filled in");

  const blankTyped = await h.service.createEpisode(
    episodeInput({ mrn: "9000000102", patientName: "", caseName: "Case C" })
  );
  assert.equal(blankTyped.patient.record.id, nameless.patient.record.id);

  const arabic = await h.service.createEpisode(
    episodeInput({ mrn: "9000000103", patientName: "أحمد سالم", phone: "0500000000", caseName: "Case D" })
  );
  // Typed without hamza, with Arabic-Indic digits and a different phone.
  const variant = await h.service.createEpisode(
    episodeInput({ mrn: "٩٠٠٠٠٠٠١٠٣", patientName: "احمد سالم", phone: "0500000001", caseName: "Case E" })
  );
  assert.equal(variant.reusedPatient, true);
  assert.equal(variant.patient.record.id, arabic.patient.record.id);
  assert.equal((await h.repository.list<PatientRecord>("patient")).length, 2);
});

// --- An MRN entered for a chart first added by name ---------------------------

test("an MRN entered for a name-only chart offers that chart and records the MRN on it", async () => {
  const h = await harness();
  const nameOnly = await h.service.createEpisode(
    episodeInput({ mrn: "", patientName: "Synthetic Delta", caseName: "ED consult" })
  );
  // A same-name chart with its own MRN is a different person and never offered.
  await h.service.createEpisode(
    episodeInput({
      mrn: "9000000201",
      patientName: "Synthetic Delta",
      caseName: "Other person",
      forceNewPatient: true
    })
  );

  let candidates: PatientRecord[] = [];
  await assert.rejects(
    () =>
      h.service.createEpisode(
        episodeInput({ mrn: "9000000202", patientName: "Synthetic Delta", caseName: "Ward admission" })
      ),
    (error: unknown) => {
      assert.ok(error instanceof PossibleDuplicatePatientError);
      candidates = error.candidates;
      return true;
    }
  );
  assert.deepEqual(candidates.map((candidate) => candidate.id), [nameOnly.patient.record.id]);
  assert.equal((await h.repository.list<PatientRecord>("patient")).length, 2, "nothing was created");

  const chosen = await h.service.createEpisode(
    episodeInput({
      mrn: "9000000202",
      patientName: "Synthetic Delta",
      caseName: "Ward admission",
      existingPatientId: nameOnly.patient.record.id
    })
  );
  assert.equal(chosen.patient.record.id, nameOnly.patient.record.id);
  assert.equal(chosen.patient.record.mrn, "9000000202");
  assert.equal(chosen.patient.record.mrn_status, "confirmed");
  assert.equal((await h.repository.list<PatientRecord>("patient")).length, 2);
  assert.equal((await events(h, "patient-identity-updated", nameOnly.patient.record.id)).length, 1);

  // From now on the MRN finds the chart directly.
  const again = await h.service.createEpisode(
    episodeInput({ mrn: "9000000202", patientName: "Synthetic Delta", caseName: "Clinic" })
  );
  assert.equal(again.patient.record.id, nameOnly.patient.record.id);

  // Choosing to create a new chart instead still works.
  await h.service.createEpisode(
    episodeInput({ mrn: "", patientName: "Synthetic Golf", caseName: "ED" })
  );
  const forced = await h.service.createEpisode(
    episodeInput({ mrn: "9000000204", patientName: "Synthetic Golf", caseName: "Ward", forceNewPatient: true })
  );
  assert.equal(forced.reusedPatient, false);
  assert.equal(forced.patient.record.mrn, "9000000204");
});

test("an MRN is not filled onto a name-only chart once another chart holds it", async () => {
  const h = await harness();
  const nameOnly = await h.service.createEpisode(
    episodeInput({ mrn: "", patientName: "Synthetic Echo", caseName: "ED" })
  );
  await h.service.createEpisode(
    episodeInput({ mrn: "9000000203", patientName: "Synthetic Echo", caseName: "Clinic", forceNewPatient: true })
  );
  await assert.rejects(
    () =>
      h.service.createEpisode(
        episodeInput({
          mrn: "9000000203",
          patientName: "Synthetic Echo",
          caseName: "Ward",
          existingPatientId: nameOnly.patient.record.id
        })
      ),
    /Another patient already has this MRN/
  );
  const latest = await h.repository.findById<PatientRecord>("patient", nameOnly.patient.record.id);
  assert.equal(latest?.record.mrn, "");
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 2);
});

test("an Arabic spelling variant of an MRN-less name still raises the duplicate prompt", async () => {
  const h = await harness();
  await h.service.createEpisode(
    episodeInput({ mrn: "", patientName: "فاطمة أحمد", caseName: "Case A" })
  );
  await assert.rejects(
    () =>
      h.service.createEpisode(
        episodeInput({ mrn: "", patientName: "فاطمه احمد", caseName: "Case B" })
      ),
    PossibleDuplicatePatientError
  );
  assert.equal((await h.service.findPatientsByName("فاطمه احمد")).length, 1);
  // The folded match only warns: confirming a new chart creates one.
  await h.service.createEpisode(
    episodeInput({ mrn: "", patientName: "فاطمه احمد", caseName: "Case B", forceNewPatient: true })
  );
  assert.equal((await h.repository.list<PatientRecord>("patient")).length, 2);
});

// --- Update sheet: rescheduling, rewording and the episode mirror ------------

async function woundEpisode(h: Harness) {
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000000301", patientName: "Synthetic Foxtrot", caseName: "Wound" })
  );
  const wound = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Wound check",
    taskType: "wound-care",
    priority: "urgent",
    dueDate: "2026-09-25",
    owner: "Dr Synthetic",
    repeatEveryDays: 7
  });
  return { created, wound };
}

test("moving only the date of the current task from Update reschedules it and keeps its series", async () => {
  const h = await harness();
  const { created, wound } = await woundEpisode(h);
  const result = await h.service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Wound check",
    dueDate: "2026-09-24"
  });

  assert.equal(result.task.kind, "rescheduled");
  if (result.task.kind === "rescheduled") assert.equal(result.task.previousDueDate, "2026-09-25");
  const tasks = await tasksOf(h, created.episode.record.id);
  assert.equal(tasks.length, 1, "moved in place, not replaced");
  const moved = tasks[0];
  assert.ok(moved);
  assert.equal(moved.id, wound.task.record.id);
  assert.equal(moved.status, "open");
  assert.equal(moved.due_date, "2026-09-24");
  assert.equal(moved.task_type, "wound-care");
  assert.equal(moved.owner, "Dr Synthetic");
  assert.equal(moved.priority, "urgent");
  assert.equal(moved.repeat_every_days, 7);
  assert.equal((await events(h, "task-rescheduled", moved.id)).length, 1);
  assert.equal(result.episode.record.next_action, "Wound check");
  assert.equal(result.episode.record.due_date, "2026-09-24");
});

test("rewording the current task from Update carries its owner, series and type to the replacement", async () => {
  const h = await harness();
  const { created, wound } = await woundEpisode(h);
  const result = await h.service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Wound check and dressing",
    dueDate: "2026-09-24"
  });
  assert.equal(result.task.kind, "created");
  if (result.task.kind !== "created") return;
  assert.equal(result.task.superseded, 1);
  const replacement = result.task.task.record;
  assert.equal(replacement.task_type, "wound-care");
  assert.equal(replacement.owner, "Dr Synthetic");
  assert.equal(replacement.repeat_every_days, 7, "the series continues on the replacement");
  const original = await h.repository.findById<TaskRecord>("task", wound.task.record.id);
  assert.equal(original?.record.status, "cancelled");

  // A pathway change as well makes it new work: the new pathway's type, and
  // neither the owner nor the series of the task it replaces.
  const next = await h.service.updateEpisode(created.episode.record.id, {
    careSetting: "outpatient",
    pathway: "opd-follow-up",
    priority: "routine",
    nextAction: "Clinic wound review",
    dueDate: "2026-09-28"
  });
  assert.equal(next.task.kind, "created");
  if (next.task.kind !== "created") return;
  assert.equal(next.task.task.record.task_type, "clinical-review");
  assert.equal(next.task.task.record.owner, "");
  assert.equal(next.task.task.record.repeat_every_days ?? 0, 0);
});

test("Update mirrors the soonest open task, never a closed one or a date no task tracks", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000000302",
      patientName: "Synthetic Hotel",
      caseName: "Imaging",
      nextAction: "Review CT",
      dueDate: "2026-09-20"
    })
  );
  const episodeId = created.episode.record.id;
  await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId,
    task: "Call family",
    taskType: "call-patient",
    priority: "routine",
    dueDate: "2026-09-22",
    owner: ""
  });
  assert.ok(created.task);
  await h.service.completeTask(created.task.record.id);

  const result = await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Review CT",
    dueDate: "2026-09-20"
  });
  assert.equal(result.task.kind, "already-closed");
  assert.equal(result.episode.record.next_action, "Call family", "the open task, not the completed one");
  assert.equal(result.episode.record.due_date, "2026-09-22");
  const codes = (await h.integrity.scan()).map((issue) => issue.code);
  assert.ok(!codes.includes("untracked-next-action"), codes.join(", "));

  const bare = await h.service.createEpisode(
    episodeInput({ mrn: "9000000303", patientName: "Synthetic India", caseName: "Bare" })
  );
  const cleared = await h.service.updateEpisode(bare.episode.record.id, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "",
    dueDate: "2026-09-30"
  });
  assert.equal(cleared.task.kind, "no-action");
  assert.equal(cleared.episode.record.next_action, "");
  assert.equal(cleared.episode.record.due_date, "", "no phantom deadline without a task");
});

// --- Priority escalation -----------------------------------------------------

test("escalating an episode raises its lower-priority open tasks and never lowers any", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000000401",
      patientName: "Synthetic Juliet",
      caseName: "Airway",
      nextAction: "Review bloods",
      dueDate: "2026-09-24"
    })
  );
  const episodeId = created.episode.record.id;
  for (const [task, priority] of [
    ["Urgent callback", "urgent"],
    ["Emergency check", "emergency"]
  ] as const) {
    await h.service.createTask({
      patientId: created.patient.record.id,
      episodeId,
      task,
      taskType: "other",
      priority,
      dueDate: "2026-09-25",
      owner: ""
    });
  }
  const update = (priority: "routine" | "urgent" | "emergency") =>
    h.service.updateEpisode(episodeId, {
      careSetting: "inpatient",
      pathway: "assessment",
      priority,
      nextAction: "Review bloods",
      dueDate: "2026-09-24"
    });
  const priorities = async () =>
    Object.fromEntries((await tasksOf(h, episodeId)).map((task) => [task.task, task.priority]));

  const urgent = await update("urgent");
  assert.equal(urgent.task.kind, "unchanged");
  assert.equal(urgent.tasksEscalated, 1);
  assert.deepEqual(await priorities(), {
    "Review bloods": "urgent",
    "Urgent callback": "urgent",
    "Emergency check": "emergency"
  });
  assert.equal((await events(h, "task-priority-raised")).length, 1);

  const lowered = await update("routine");
  assert.equal(lowered.tasksEscalated, 0);
  assert.equal(lowered.episode.record.priority, "routine");
  assert.equal((await priorities())["Review bloods"], "urgent", "lowering the episode lowers no task");

  const emergency = await update("emergency");
  assert.equal(emergency.tasksEscalated, 2);
  assert.ok(Object.values(await priorities()).every((priority) => priority === "emergency"));
  assert.ok(priorityRank("emergency") > priorityRank("urgent"));
  assert.ok(priorityRank("routine") > priorityRank("not-a-priority"));
});

// --- Recurring tasks ---------------------------------------------------------

test("the next occurrence keeps its cadence and is never already overdue", () => {
  assert.equal(nextOccurrenceDate("2026-08-01", 7, "2026-09-23"), "2026-09-26");
  assert.equal(nextOccurrenceDate("2026-09-22", 1, "2026-09-23"), "2026-09-23", "due today is kept");
  assert.equal(nextOccurrenceDate("2026-09-20", 7, "2026-09-23"), "2026-09-27", "on time is unchanged");
  assert.equal(nextOccurrenceDate("2026-09-16", 7, "2026-09-23"), "2026-09-23");
});

async function recurringTask(h: Harness, dueDate: string, mrn = "9000000501") {
  const created = await h.service.createEpisode(
    episodeInput({ mrn, patientName: "Synthetic Kilo", caseName: "Dressings" })
  );
  const task = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Weekly dressing",
    taskType: "wound-care",
    priority: "routine",
    dueDate,
    owner: "",
    repeatEveryDays: 7
  });
  return { created, task: task.task };
}

test("completing a recurring task late raises the next occurrence on or after today", async () => {
  const h = await harness();
  const today = todayIso();
  const due = isoDateWithOffset(-53, today);
  const { created, task } = await recurringTask(h, due);
  await h.service.completeTask(task.record.id);

  const open = (await tasksOf(h, created.episode.record.id)).filter((record) => record.status === "open");
  assert.equal(open.length, 1);
  const next = open[0]?.due_date ?? "";
  assert.ok(next >= today, `next occurrence ${next} must not be overdue`);
  assert.ok(isoDateWithOffset(-7, next) < today, "no whole interval is skipped past today");
  assert.equal(daysBetween(due, next) % 7, 0, "the weekly cadence is kept");
});

test("undoing a recurring completion withdraws the untouched next occurrence", async () => {
  const h = await harness();
  const due = isoDateWithOffset(2, todayIso());
  const { created, task } = await recurringTask(h, due);
  await h.service.completeTask(task.record.id);
  const successor = (await tasksOf(h, created.episode.record.id)).find((record) => record.status === "open");
  assert.ok(successor);
  assert.equal(successor.due_date, isoDateWithOffset(7, due));

  const reopened = await h.service.reopenTask(task.record.id);
  assert.equal(reopened.record.status, "open");
  assert.equal(reopened.nextOccurrence, "cancelled");
  const withdrawn = await h.repository.findById<TaskRecord>("task", successor.id);
  assert.equal(withdrawn?.record.status, "cancelled");
  assert.equal(withdrawn?.record.cancel_reason, "Completion undone");
  assert.equal((await events(h, "task-cancelled", successor.id)).length, 1);
  const open = (await tasksOf(h, created.episode.record.id)).filter((record) => record.status === "open");
  assert.deepEqual(open.map((record) => record.id), [task.record.id], "one open copy of the series");

  // Completing again raises the series afresh.
  await h.service.completeTask(task.record.id);
  const after = (await tasksOf(h, created.episode.record.id)).filter((record) => record.status === "open");
  assert.equal(after.length, 1);
  assert.equal(after[0]?.due_date, isoDateWithOffset(7, due));
});

test("undoing a recurring completion leaves a next occurrence that was changed", async () => {
  const h = await harness();
  const { created, task } = await recurringTask(h, isoDateWithOffset(2, todayIso()));
  await h.service.completeTask(task.record.id);
  const successor = (await h.repository.list<TaskRecord>("task")).find(
    ({ record }) => record.episode_id === created.episode.record.id && record.status === "open"
  );
  assert.ok(successor);
  await h.repository.update<TaskRecord>(successor.path, { owner: "Dr Synthetic" });

  const reopened = await h.service.reopenTask(task.record.id);
  assert.equal(reopened.nextOccurrence, "kept");
  const kept = await h.repository.findById<TaskRecord>("task", successor.record.id);
  assert.equal(kept?.record.status, "open", "the clinician's edited task is left alone");
});

test("undoing a completion recorded before the roll-forward finds the older next occurrence", async () => {
  const h = await harness();
  const due = isoDateWithOffset(-20, todayIso());
  const { created, task } = await recurringTask(h, due);
  // What an earlier version raised: exactly one interval after the due date.
  const legacy = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Weekly dressing",
    taskType: "wound-care",
    priority: "routine",
    dueDate: isoDateWithOffset(7, due),
    owner: "",
    repeatEveryDays: 7
  });
  await h.repository.update<TaskRecord>(task.path, { status: "completed", completed_at: nowIso() });

  const reopened = await h.service.reopenTask(task.record.id);
  assert.equal(reopened.nextOccurrence, "cancelled");
  const withdrawn = await h.repository.findById<TaskRecord>("task", legacy.task.record.id);
  assert.equal(withdrawn?.record.status, "cancelled");
});

test("reopening a cancelled recurring task withdraws nothing", async () => {
  const h = await harness();
  const { created, task } = await recurringTask(h, isoDateWithOffset(2, todayIso()));
  await h.service.cancelTask(task.record.id, "Synthetic cancellation");
  const reopened = await h.service.reopenTask(task.record.id);
  assert.equal(reopened.nextOccurrence, "none");
  assert.equal((await tasksOf(h, created.episode.record.id)).length, 1);
});

// --- Restore -----------------------------------------------------------------

test("restoring an episode is refused while the same case is active again", async () => {
  const h = await harness();
  const first = await h.service.createEpisode(
    episodeInput({ mrn: "9000000601", patientName: "Synthetic Lima", caseName: "Tonsils" })
  );
  await h.service.archiveEpisode(first.episode.record.id, "Discharged");
  const readmitted = await h.service.createEpisode(
    episodeInput({ mrn: "9000000601", patientName: "Synthetic Lima", caseName: "tonsils" })
  );
  assert.equal(readmitted.duplicateEpisode, false);

  await assert.rejects(
    () => h.service.restoreEpisode(first.episode.record.id),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /An active episode for this case already exists/);
      assert.doesNotMatch(error.message, /Synthetic|Tonsils|\d{4,}/);
      return true;
    }
  );
  const archived = await h.repository.findById<EpisodeRecord>("episode", first.episode.record.id);
  assert.equal(archived?.record.status, "archived");
  const codes = (await h.integrity.scan()).map((issue) => issue.code);
  assert.ok(!codes.includes("duplicate-episode"), codes.join(", "));

  // Once the readmission is closed, the old episode can come back.
  await h.service.archiveEpisode(readmitted.episode.record.id, "Discharged");
  const restored = await h.service.restoreEpisode(first.episode.record.id);
  assert.notEqual(restored.record.status, "archived");
});

// --- Additional procedures ---------------------------------------------------

test("another procedure can be logged once the episode's first one is recorded", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000000701",
      patientName: "Synthetic Mike",
      caseName: "Adenotonsillar hypertrophy",
      pathway: "or-booking",
      nextAction: "Book theatre",
      dueDate: "2026-09-10"
    })
  );
  const patientId = created.patient.record.id;
  const episodeId = created.episode.record.id;
  const procedure = (name: string, overrides: Record<string, unknown> = {}) => ({
    patientId,
    episodeId,
    procedure: name,
    procedureDate: "2026-09-11",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: "",
    ...overrides
  });

  await h.service.completeProcedure(procedure("Tonsillectomy"));
  const afterFirst = await h.repository.findById<EpisodeRecord>("episode", episodeId);
  assert.equal(afterFirst?.record.pathway, "discharge-ready");
  assert.equal(afterFirst?.record.status, "ready-to-close");

  await h.service.completeProcedure(procedure("Adenoidectomy"));
  await assert.rejects(() => h.service.completeProcedure(procedure("Adenoidectomy")), /already in the logbook/);
  const afterSecond = await h.repository.findById<EpisodeRecord>("episode", episodeId);
  assert.equal(afterSecond?.record.pathway, "discharge-ready", "the pathway is left alone");
  assert.equal(afterSecond?.record.status, "ready-to-close", "the status is left alone");
  assert.equal(afterSecond?.record.next_action, "");
  const logged = (await h.repository.list<ProcedureRecord>("procedure")).map((item) => item.record);
  assert.equal(logged.length, 2, "one logbook entry per procedure, and a retry adds none");
  assert.ok(logged.every((record) => record.audit_pending === false));

  await h.service.completeProcedure(
    procedure("Examination under anaesthesia", {
      followUpRequired: true,
      followUpDate: "2026-10-01",
      followUpPlan: "Clinic review"
    })
  );
  const followUp = (await tasksOf(h, episodeId)).find((task) => task.task === "Clinic review");
  assert.equal(followUp?.task_type, "postop-follow-up");
  assert.equal(followUp?.status, "open");
  const afterThird = await h.repository.findById<EpisodeRecord>("episode", episodeId);
  assert.equal(afterThird?.record.pathway, "discharge-ready");
  assert.equal(afterThird?.record.next_action, "Clinic review", "the open follow-up is mirrored");

  await assert.rejects(
    () =>
      h.service.completeProcedure(
        procedure("Examination under anaesthesia", {
          followUpRequired: true,
          followUpDate: "2026-10-02",
          followUpPlan: "Clinic review"
        })
      ),
    /different follow-up details/
  );

  const plain = await h.service.createEpisode(
    episodeInput({ mrn: "9000000702", patientName: "Synthetic November", caseName: "Assessment only" })
  );
  await assert.rejects(
    () =>
      h.service.completeProcedure({
        ...procedure("Tonsillectomy"),
        patientId: plain.patient.record.id,
        episodeId: plain.episode.record.id
      }),
    /OR booking episode/
  );
});

// --- Discharge with open tasks -----------------------------------------------

async function episodeWithTasks(h: Harness, count: number) {
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000000801", patientName: "Synthetic Oscar", caseName: "Ward stay" })
  );
  for (let index = 0; index < count; index += 1) {
    await h.service.createTask({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      task: `Routine check ${index + 1}`,
      taskType: "other",
      priority: "routine",
      dueDate: isoDateWithOffset(index + 1, todayIso()),
      owner: "",
      ...(index === 0 ? { repeatEveryDays: 1 } : {})
    });
  }
  return created;
}

test("discharge closes the remaining open tasks only when asked, each audited", async () => {
  const h = await harness();
  const created = await episodeWithTasks(h, 3);
  const episodeId = created.episode.record.id;
  await assert.rejects(() => h.service.archiveEpisode(episodeId, "Discharged"), /3 open tasks remain/);

  const archived = await h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true });
  assert.equal(archived.record.status, "archived");
  assert.equal(archived.cancelledTasks, 3);
  const tasks = await tasksOf(h, episodeId);
  assert.equal(tasks.length, 3, "a cancelled repeat raises no next occurrence");
  for (const task of tasks) {
    assert.equal(task.status, "cancelled");
    assert.equal(task.cancel_reason, "Closed at discharge");
    assert.equal((await events(h, "task-cancelled", task.id)).length, 1);
  }
  const codes = (await h.integrity.scan()).map((issue) => issue.code);
  assert.ok(!codes.includes("missing-transition-event"), codes.join(", "));
});

test("closing tasks at discharge fails closed on an unreadable task note", async () => {
  const h = await harness();
  const created = await episodeWithTasks(h, 2);
  const [damaged] = await h.repository.list<TaskRecord>("task");
  assert.ok(damaged);
  h.app.vault.writeRaw(
    damaged.path,
    (h.app.vault.files.get(damaged.path) ?? "").replace(/^task: .*$/m, 'task: "unterminated')
  );
  h.repository.invalidatePath(damaged.path);

  await assert.rejects(
    () => h.service.archiveEpisode(created.episode.record.id, "Discharged", { cancelOpenTasks: true }),
    /could not be read/
  );
  const readable = (await tasksOf(h, created.episode.record.id)).filter((task) => task.status === "open");
  assert.equal(readable.length, 1, "nothing is cancelled while open work cannot be confirmed");
});

test("an interrupted close-at-discharge converges on retry", async () => {
  const h = await harness();
  const created = await episodeWithTasks(h, 3);
  const episodeId = created.episode.record.id;
  const realUpdate = h.repository.update.bind(h.repository);
  let failed = false;
  (h.repository as unknown as { update: typeof realUpdate }).update = async (path, changes) => {
    if (!failed && path === created.episode.path && changes.status === "archived") {
      failed = true;
      throw new Error("EIO: simulated failure");
    }
    return realUpdate(path, changes);
  };

  await assert.rejects(
    () => h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true }),
    /3 open tasks were already cancelled, but the episode was not discharged/
  );
  const episode = await h.repository.findById<EpisodeRecord>("episode", episodeId);
  assert.notEqual(episode?.record.status, "archived");
  assert.ok((await tasksOf(h, episodeId)).every((task) => task.status === "cancelled"));

  const retried = await h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true });
  assert.equal(retried.record.status, "archived");
  assert.equal(retried.cancelledTasks, 0);
});

// --- Merge sweep -------------------------------------------------------------

test("re-running a finished merge re-points records that arrived later under the retired patient", async () => {
  const h = await harness();
  const source = await h.service.createEpisode(
    episodeInput({ mrn: "9000000901", patientName: "Synthetic Papa", caseName: "Source case" })
  );
  const target = await h.service.createEpisode(
    episodeInput({
      mrn: "9000000902",
      patientName: "Synthetic Quebec",
      caseName: "Target case",
      nextAction: "Target work",
      dueDate: "2026-09-25"
    })
  );
  const sourceId = source.patient.record.id;
  const targetId = target.patient.record.id;
  await h.service.mergePatients(sourceId, targetId);

  // What Sync delivers from a device that was offline during the merge: a new
  // episode with a task under the retired patient, and a task under the
  // retired patient on an episode the merge already re-pointed.
  const timestamp = nowIso();
  const base = { schema_version: CURRENT_SCHEMA_VERSION, created_at: timestamp, updated_at: timestamp };
  const straggler = await h.repository.create<EpisodeRecord>({
    ...target.episode.record,
    ...base,
    id: "EPI-synthetic-straggler",
    patient_id: sourceId,
    case: "Offline case",
    next_action: "",
    due_date: ""
  });
  const taskBase = {
    ...base,
    entity: "task" as const,
    tags: ["clinical/task"],
    patient_id: sourceId,
    patient: "",
    task_type: "other" as const,
    status: "open" as const,
    priority: "routine" as const,
    due_date: "2026-09-26",
    owner: "",
    completed_at: "",
    cancelled_at: "",
    cancel_reason: "",
    repeat_every_days: 0,
    idempotency_key: ""
  };
  await h.repository.create<TaskRecord>({
    ...taskBase,
    id: "TSK-synthetic-straggler-a",
    episode_id: straggler.record.id,
    episode: "",
    task: "Offline task"
  });
  const onTarget = await h.repository.create<TaskRecord>({
    ...taskBase,
    id: "TSK-synthetic-straggler-b",
    episode_id: target.episode.record.id,
    episode: "",
    task: "Offline follow-up"
  });
  await assert.rejects(() => h.service.completeTask(onTarget.record.id), /context changed/);

  await h.service.mergePatients(sourceId, targetId);
  const episodes = (await h.repository.list<EpisodeRecord>("episode")).map((item) => item.record);
  const tasks = (await h.repository.list<TaskRecord>("task")).map((item) => item.record);
  assert.ok(episodes.every((record) => record.patient_id === targetId));
  assert.ok(tasks.every((record) => record.patient_id === targetId));
  assert.equal((await events(h, "patient-merge-swept", sourceId)).length, 1);
  const retired = await h.repository.findById<PatientRecord>("patient", sourceId);
  assert.equal(retired?.record.merged_into, targetId);
  assert.equal(retired?.record.status, "entered-in-error");
  const codes = (await h.integrity.scan()).map((issue) => issue.code);
  assert.ok(!codes.includes("mismatched-task-patient"), codes.join(", "));

  const completed = await h.service.completeTask(onTarget.record.id);
  assert.equal(completed.record.status, "completed");

  // Nothing left to sweep: no further writes or events.
  await h.service.mergePatients(sourceId, targetId);
  assert.equal((await events(h, "patient-merge-swept", sourceId)).length, 1);

  // A merged patient still cannot be merged into a different record.
  const other = await h.service.createEpisode(
    episodeInput({ mrn: "9000000903", patientName: "Synthetic Romeo", caseName: "Other case" })
  );
  await assert.rejects(
    () => h.service.mergePatients(sourceId, other.patient.record.id),
    /already been merged/
  );
});

// --- Handover ----------------------------------------------------------------

test("the handover lists tomorrow's and undated work, ranked by priority, with case and priority", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000001001",
      patientName: "Synthetic Sierra",
      caseName: "Synthetic neck abscess",
      careSetting: "inpatient"
    })
  );
  const add = (task: string, priority: "routine" | "urgent" | "emergency", dueDate: string) =>
    h.service.createTask({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      task,
      taskType: "other",
      priority,
      dueDate,
      owner: ""
    });
  await add("Routine obs", "routine", "2026-09-23");
  await add("Emergency airway check", "emergency", "2026-09-23");
  await add("Overdue drain review", "routine", "2026-09-21");
  await add("NBM for theatre", "emergency", "2026-09-24");
  await add("Chase histology", "urgent", "");
  await add("Later clinic letter", "routine", "2026-09-27");

  const note = buildHandoverNote(await h.repository.snapshot(), "2026-09-23");
  assert.match(note, /Verify against the ward list before relying on it; delete after use\./);
  assert.match(note, /## Overdue and due today \(3\)/);
  assert.match(note, /## Due tomorrow \(1\)/);
  assert.match(note, /## No date set \(1\)/);
  assert.match(note, /- NBM for theatre — .*Synthetic neck abscess · Emergency · due 2026-09-24/);
  assert.match(note, /- Chase histology — .*Synthetic neck abscess · Urgent · no date/);
  assert.doesNotMatch(note, /Later clinic letter/);
  assert.match(note, /Open tasks: 6/);

  const urgentSection = note.slice(note.indexOf("## Overdue and due today"), note.indexOf("## Due tomorrow"));
  const order = ["Emergency airway check", "Overdue drain review", "Routine obs"].map((task) =>
    urgentSection.indexOf(task)
  );
  assert.ok(order.every((position) => position > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "priority first, then the oldest date");

  const empty = buildHandoverNote({ patients: [], episodes: [], tasks: [], procedures: [] }, "2026-09-23");
  assert.match(empty, /Nothing due tomorrow/);
  assert.match(empty, /No open task without a date/);
});

test("the priority-first task order is stable across devices", () => {
  const task = (id: string, priority: TaskRecord["priority"], due_date: string) =>
    ({ id, priority, due_date }) as TaskRecord;
  const tasks = [
    task("TSK-b", "routine", "2026-09-23"),
    task("TSK-a", "routine", "2026-09-23"),
    task("TSK-c", "routine", ""),
    task("TSK-d", "emergency", "2026-09-30")
  ];
  const ids = (list: TaskRecord[]) => [...list].sort(compareTasksByPriority).map((item) => item.id);
  assert.deepEqual(ids(tasks), ["TSK-d", "TSK-a", "TSK-b", "TSK-c"]);
  assert.deepEqual(ids([...tasks].reverse()), ["TSK-d", "TSK-a", "TSK-b", "TSK-c"]);
});
