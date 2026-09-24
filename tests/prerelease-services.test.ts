/**
 * Pre-release fixes in the clinical services: re-submitting a logged
 * procedure, Complete + Undo on an on-hold episode, a half-applied episode
 * update, escalation on reopen and over unrecognised priorities, a
 * discharge-with-close that fails after cancelling tasks, and Undo or Reopen
 * after a repeating series has moved on. Synthetic data only; MRNs are
 * 9000-series.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLINICAL_WRITES_BLOCKED_MESSAGE } from "../src/data/repository";
import { isoDateWithOffset, todayIso } from "../src/domain/schema";
import type {
  EpisodeRecord,
  EventRecord,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import { validateRecord } from "../src/domain/validate";
import { episodeInput, harness, type Harness } from "./support/harness";

const tasksOf = async (h: Harness, episodeId: string): Promise<TaskRecord[]> =>
  (await h.repository.list<TaskRecord>("task"))
    .map((item) => item.record)
    .filter((task) => task.episode_id === episodeId);

const episodeOf = async (h: Harness, episodeId: string): Promise<EpisodeRecord> => {
  const found = await h.repository.findById<EpisodeRecord>("episode", episodeId);
  assert.ok(found);
  return found.record;
};

const events = async (h: Harness): Promise<EventRecord[]> =>
  (await h.repository.list<EventRecord>("event")).map((item) => item.record);

type UpdateFn = Harness["repository"]["update"];

/** Replaces repository.update for the rest of the test; returns the original. */
const interceptUpdate = (
  h: Harness,
  intercept: (target: string, changes: Parameters<UpdateFn>[1], real: UpdateFn) => ReturnType<UpdateFn>
): UpdateFn => {
  const real = h.repository.update.bind(h.repository) as UpdateFn;
  (h.repository as unknown as { update: UpdateFn }).update = ((target: string, changes: Parameters<UpdateFn>[1]) =>
    intercept(target, changes, real)) as UpdateFn;
  return real;
};

const restoreUpdate = (h: Harness, real: UpdateFn): void => {
  (h.repository as unknown as { update: UpdateFn }).update = real;
};

// --- Re-submitting a logged procedure ------------------------------------------

const orBooking = async (h: Harness, mrn: string) =>
  h.service.createEpisode(
    episodeInput({
      mrn,
      patientName: "Synthetic Alpha",
      caseName: "Appendicitis",
      pathway: "or-booking",
      nextAction: "Book theatre",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );

const procedureInput = (
  patientId: string,
  episodeId: string,
  overrides: Record<string, unknown> = {}
) => ({
  patientId,
  episodeId,
  procedure: "Appendicectomy",
  procedureDate: todayIso(),
  role: "Primary surgeon",
  outcome: "",
  followUpRequired: false,
  followUpDate: "",
  followUpPlan: "",
  ...overrides
});

test("re-submitting a fully logged procedure is refused and changes nothing", async () => {
  const h = await harness();
  const created = await orBooking(h, "9000880001");
  const episodeId = created.episode.record.id;
  const input = procedureInput(created.patient.record.id, episodeId);
  await h.service.completeProcedure(input);
  assert.equal((await episodeOf(h, episodeId)).pathway, "discharge-ready");

  // The clinician has since moved the episode on.
  await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "result-review",
    priority: "routine",
    nextAction: "Check histology",
    dueDate: isoDateWithOffset(7, todayIso())
  });
  const before = await episodeOf(h, episodeId);
  const tasksBefore = await tasksOf(h, episodeId);
  const eventsBefore = (await events(h)).length;

  await assert.rejects(
    () => h.service.completeProcedure(input),
    /^Error: This procedure is already in the logbook for this episode\. To log another, use a different date or name\.$/
  );
  assert.deepEqual(await episodeOf(h, episodeId), before, "the episode is untouched");
  assert.deepEqual(await tasksOf(h, episodeId), tasksBefore, "no task is completed or raised");
  assert.equal((await events(h)).length, eventsBefore, "nothing is audited");
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
});

test("re-submitting a logged procedure does not bring back its completed follow-up", async () => {
  const h = await harness();
  const created = await orBooking(h, "9000880002");
  const episodeId = created.episode.record.id;
  const input = procedureInput(created.patient.record.id, episodeId, {
    followUpRequired: true,
    followUpDate: isoDateWithOffset(14, todayIso()),
    followUpPlan: "Wound review"
  });
  await h.service.completeProcedure(input);
  const followUp = (await tasksOf(h, episodeId)).find((task) => task.task === "Wound review");
  assert.ok(followUp);
  await h.service.completeTask(followUp.id);
  const before = await episodeOf(h, episodeId);

  await assert.rejects(() => h.service.completeProcedure(input), /already in the logbook/);
  const reviews = (await tasksOf(h, episodeId)).filter((task) => task.task === "Wound review");
  assert.deepEqual(reviews.map((task) => task.status), ["completed"]);
  assert.deepEqual(await episodeOf(h, episodeId), before);
});

test("a procedure whose workflow failed part-way still converges on retry", async () => {
  const h = await harness();
  const created = await orBooking(h, "9000880003");
  const episodeId = created.episode.record.id;
  const input = procedureInput(created.patient.record.id, episodeId);
  const real = interceptUpdate(h, (target, changes, update) => {
    if (target === created.episode.path && changes.pathway === "discharge-ready") {
      throw new Error("EIO: simulated failure");
    }
    return update(target, changes);
  });
  await assert.rejects(() => h.service.completeProcedure(input), /simulated failure/);
  const [pending] = await h.repository.list<ProcedureRecord>("procedure");
  assert.equal(pending?.record.audit_pending, true);
  restoreUpdate(h, real);

  const retried = await h.service.completeProcedure(input);
  assert.equal(retried.record.audit_pending, false);
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.pathway, "discharge-ready");
  assert.equal(episode.status, "ready-to-close");
  assert.equal((await events(h)).filter((event) => event.action === "procedure-completed").length, 1);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
});

// --- Complete + Undo on an on-hold episode ---------------------------------------

test("undoing the completion of an on-hold episode's last task puts it back on hold", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880011",
      patientName: "Synthetic Bravo",
      caseName: "Awaiting imaging",
      nextAction: "Chase MRI report",
      dueDate: isoDateWithOffset(2, todayIso())
    })
  );
  const episodeId = created.episode.record.id;
  assert.ok(created.task);
  await h.repository.update<EpisodeRecord>(created.episode.path, { status: "on-hold" });

  await h.service.completeTask(created.task.record.id);
  const completed = await episodeOf(h, episodeId);
  assert.equal(completed.status, "ready-to-close");
  assert.equal(completed.status_before_ready, "on-hold");
  assert.deepEqual(validateRecord(completed), [], "the new field is not a schema problem");
  const issues = (await h.integrity.scan()).filter((issue) => issue.recordId === episodeId);
  assert.deepEqual(issues, [], "nor an integrity issue");

  await h.service.reopenTask(created.task.record.id);
  const reopened = await episodeOf(h, episodeId);
  assert.equal(reopened.status, "on-hold");
  assert.equal(reopened.status_before_ready, "");
  assert.equal(reopened.next_action, "Chase MRI report");
});

test("an episode with no recorded prior status returns to active on reopen", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880012",
      patientName: "Synthetic Charlie",
      caseName: "Wound check",
      nextAction: "Dressing review",
      dueDate: isoDateWithOffset(2, todayIso())
    })
  );
  const episodeId = created.episode.record.id;
  assert.ok(created.task);
  await h.service.completeTask(created.task.record.id);
  assert.equal((await episodeOf(h, episodeId)).status_before_ready, "active");
  // A record written before the field existed carries none at all.
  const raw = h.app.vault.files.get(created.episode.path) ?? "";
  h.app.vault.writeRaw(created.episode.path, raw.replace(/^status_before_ready: .*\r?\n/m, ""));
  h.repository.invalidatePath(created.episode.path);
  assert.equal((await episodeOf(h, episodeId)).status_before_ready, undefined);

  await h.service.reopenTask(created.task.record.id);
  assert.equal((await episodeOf(h, episodeId)).status, "active");
});

// --- A task filed under another patient blocks the update before any write ---------

test("updating an episode with a task filed under another patient writes nothing", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880021",
      patientName: "Synthetic Delta",
      caseName: "Chest pain",
      nextAction: "Call family",
      dueDate: isoDateWithOffset(3, todayIso())
    })
  );
  const other = await h.service.createEpisode(
    episodeInput({ mrn: "9000880022", patientName: "Synthetic Echo", caseName: "Other case" })
  );
  const episodeId = created.episode.record.id;
  assert.ok(created.task);
  await h.repository.update<TaskRecord>(created.task.path, {
    patient_id: other.patient.record.id
  });
  const before = await episodeOf(h, episodeId);
  const tasksBefore = await tasksOf(h, episodeId);
  const eventsBefore = (await events(h)).length;

  for (const nextAction of ["Call family", "Chase CT report"]) {
    await assert.rejects(
      () =>
        h.service.updateEpisode(episodeId, {
          careSetting: "inpatient",
          pathway: "result-review",
          priority: "urgent",
          nextAction,
          dueDate: isoDateWithOffset(5, todayIso()),
          expectedUpdatedAt: before.updated_at
        }),
      /^Error: A task on this episode is filed under a different patient, so nothing was saved\. Run the clinical data integrity check and repair that task, then save again\.$/
    );
    assert.deepEqual(await episodeOf(h, episodeId), before, "no field of the episode was written");
    assert.deepEqual(await tasksOf(h, episodeId), tasksBefore, "no task was moved, raised or created");
    assert.equal((await events(h)).length, eventsBefore);
  }
});

// --- Escalation on reopen, and never from or over an unrecognised priority ---------

test("a task reopened after its episode was escalated comes back at the episode's priority", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880031",
      patientName: "Synthetic Foxtrot",
      caseName: "Sepsis screen",
      nextAction: "Review bloods",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  const episodeId = created.episode.record.id;
  assert.ok(created.task);
  const taskId = created.task.record.id;
  await h.service.completeTask(taskId);
  const escalated = await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "emergency",
    nextAction: "",
    dueDate: ""
  });
  assert.equal(escalated.tasksEscalated, 0, "a closed task is not escalated");

  const reopened = await h.service.reopenTask(taskId);
  assert.equal(reopened.record.status, "open");
  assert.equal(reopened.record.priority, "emergency");
  const raised = (await events(h)).filter(
    (event) => event.action === "task-priority-raised" && event.target_id === taskId
  );
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.previous_state, "routine");
  assert.equal(raised[0]?.new_state, "emergency");
  assert.equal(raised[0]?.summary, "Task priority raised with its episode");
});

test("reopening never lowers a task, nor raises one whose priority is not recognised", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880032",
      patientName: "Synthetic Golf",
      caseName: "Follow-up",
      priority: "urgent",
      nextAction: "Review wound",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  assert.ok(created.task);
  const taskId = created.task.record.id;
  await h.service.completeTask(taskId);
  await h.repository.update<TaskRecord>(created.task.path, { priority: "Emergency" });
  const reopened = await h.service.reopenTask(taskId);
  assert.equal(reopened.record.priority, "Emergency");
  assert.ok(!(await events(h)).some((event) => event.action === "task-priority-raised"));
});

test("saving the form over an unrecognised priority escalates nothing", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880033",
      patientName: "Synthetic Hotel",
      caseName: "Abdominal pain",
      nextAction: "Surgical review",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  const episodeId = created.episode.record.id;
  assert.ok(created.task);
  // Hand-typed in the Properties panel.
  await h.repository.update<EpisodeRecord>(created.episode.path, { priority: "Emergency" });
  await h.repository.update<TaskRecord>(created.task.path, { priority: "Emergency" });

  // What the form submits: the seeded substitute and a new care setting.
  const result = await h.service.updateEpisode(episodeId, {
    careSetting: "inpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "Surgical review",
    dueDate: isoDateWithOffset(1, todayIso())
  });
  assert.equal(result.tasksEscalated, 0);
  const [task] = await tasksOf(h, episodeId);
  assert.equal(task?.priority, "Emergency", "an unrecognised value is never overwritten as 'raised'");
  assert.ok(!(await events(h)).some((event) => event.action === "task-priority-raised"));
});

test("escalating an episode skips a task whose priority is not recognised", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000880034",
      patientName: "Synthetic India",
      caseName: "Fracture",
      nextAction: "Fracture clinic",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  const episodeId = created.episode.record.id;
  assert.ok(created.task);
  const second = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId,
    task: "Repeat X-ray",
    taskType: "other",
    priority: "routine",
    dueDate: isoDateWithOffset(2, todayIso()),
    owner: ""
  });
  await h.repository.update<TaskRecord>(created.task.path, { priority: "Emergency" });

  const result = await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "urgent",
    nextAction: "Fracture clinic",
    dueDate: isoDateWithOffset(1, todayIso())
  });
  assert.equal(result.tasksEscalated, 1);
  const byId = new Map((await tasksOf(h, episodeId)).map((task) => [task.id, task.priority]));
  assert.equal(byId.get(created.task.record.id), "Emergency");
  assert.equal(byId.get(second.task.record.id), "urgent");
});

// --- A discharge-with-close that fails after cancelling tasks ------------------

const onHoldWithTwoTasks = async (h: Harness, mrn: string) => {
  const created = await h.service.createEpisode(
    episodeInput({
      mrn,
      patientName: "Synthetic Juliet",
      caseName: "Leg ulcer",
      nextAction: "Dressing change",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Vascular review",
    taskType: "other",
    priority: "routine",
    dueDate: isoDateWithOffset(3, todayIso()),
    owner: ""
  });
  await h.repository.update<EpisodeRecord>(created.episode.path, { status: "on-hold" });
  return created;
};

test("a discharge that fails after cancelling tasks says so, and the retry keeps on hold", async () => {
  const h = await harness();
  const created = await onHoldWithTwoTasks(h, "9000880041");
  const episodeId = created.episode.record.id;
  const real = interceptUpdate(h, (target, changes, update) => {
    if (target === created.episode.path && changes.status === "archived") {
      throw new Error("EIO: simulated failure writing a synthetic path");
    }
    return update(target, changes);
  });

  await assert.rejects(
    () => h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "2 open tasks were already cancelled, but the episode was not discharged. Retry Discharge to finish."
      );
      return true;
    }
  );
  assert.ok((await tasksOf(h, episodeId)).every((task) => task.status === "cancelled"));
  const interrupted = await episodeOf(h, episodeId);
  assert.equal(interrupted.status, "on-hold", "the pre-discharge status is kept for the retry");
  assert.equal(interrupted.next_action, "");
  restoreUpdate(h, real);

  const retried = await h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true });
  assert.equal(retried.record.status, "archived");
  assert.equal(retried.record.status_before_archive, "on-hold");
  const restored = await h.service.restoreEpisode(episodeId);
  assert.equal(restored.record.status, "on-hold");
});

test("a discharge stopped by the write barrier passes on the barrier's own message", async () => {
  const h = await harness();
  const created = await onHoldWithTwoTasks(h, "9000880042");
  const episodeId = created.episode.record.id;
  const real = interceptUpdate(h, (target, changes, update) => {
    if (target === created.episode.path && changes.status === "archived") {
      h.repository.setWriteBlock(CLINICAL_WRITES_BLOCKED_MESSAGE);
    }
    return update(target, changes);
  });

  await assert.rejects(
    () => h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `2 open tasks were already cancelled, but the episode was not discharged. ${CLINICAL_WRITES_BLOCKED_MESSAGE} Retry Discharge to finish.`
      );
      return true;
    }
  );
  h.repository.setWriteBlock(null);
  restoreUpdate(h, real);
  const retried = await h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true });
  assert.equal(retried.record.status_before_archive, "on-hold");
});

test("a discharge that fails part-way through cancelling counts only what was cancelled", async () => {
  const h = await harness();
  const created = await onHoldWithTwoTasks(h, "9000880043");
  const episodeId = created.episode.record.id;
  let cancellations = 0;
  const real = interceptUpdate(h, (target, changes, update) => {
    if (changes.status === "cancelled" && ++cancellations === 2) throw new Error("EIO: simulated failure");
    return update(target, changes);
  });
  await assert.rejects(
    () => h.service.archiveEpisode(episodeId, "Discharged", { cancelOpenTasks: true }),
    /^Error: 1 open task was already cancelled, but the episode was not discharged\. Retry Discharge to finish\.$/
  );
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.status, "on-hold");
  const stillOpen = (await tasksOf(h, episodeId)).find((task) => task.status === "open");
  assert.equal(episode.next_action, stillOpen?.task, "the episode mirrors the task still open");
  restoreUpdate(h, real);
});

// --- Undo or Reopen after a repeating series has moved on ------------------------

const weeklySeries = async (h: Harness, mrn: string) => {
  const created = await h.service.createEpisode(
    episodeInput({ mrn, patientName: "Synthetic Kilo", caseName: "Chronic wound" })
  );
  const first = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Weekly dressing",
    taskType: "wound-care",
    priority: "routine",
    dueDate: todayIso(),
    owner: "",
    repeatEveryDays: 7
  });
  return { created, first: first.task };
};

const openSuccessor = async (h: Harness, episodeId: string, afterDueDate: string): Promise<TaskRecord> => {
  const next = (await tasksOf(h, episodeId)).find(
    (task) => task.status === "open" && task.due_date > afterDueDate
  );
  assert.ok(next);
  return next;
};

test("Undo is refused once the next occurrence of a repeating task was completed", async () => {
  const h = await harness();
  const { created, first } = await weeklySeries(h, "9000880051");
  const episodeId = created.episode.record.id;
  await h.service.completeTask(first.record.id);
  const second = await openSuccessor(h, episodeId, first.record.due_date);
  await h.service.completeTask(second.id);
  const third = await openSuccessor(h, episodeId, second.due_date);
  const tasksBefore = await tasksOf(h, episodeId);
  const episodeBefore = await episodeOf(h, episodeId);
  const eventsBefore = (await events(h)).length;

  await assert.rejects(
    () => h.service.reopenTask(first.record.id),
    /^Error: A later occurrence of this repeating task was already completed, so this one was not reopened\.$/
  );
  assert.deepEqual(await tasksOf(h, episodeId), tasksBefore, "nothing was reopened or withdrawn");
  assert.deepEqual(await episodeOf(h, episodeId), episodeBefore);
  assert.equal((await events(h)).length, eventsBefore);
  assert.equal(third.status, "open");

  // The latest completion can still be undone: it withdraws its own successor.
  const undone = await h.service.reopenTask(second.id);
  assert.equal(undone.nextOccurrence, "cancelled");
});

test("Reopen from the sheet is refused when a rescheduled later occurrence was completed", async () => {
  const h = await harness();
  const { created, first } = await weeklySeries(h, "9000880052");
  const episodeId = created.episode.record.id;
  await h.service.completeTask(first.record.id);
  const second = await openSuccessor(h, episodeId, first.record.due_date);
  // Moved to another day, which changes its idempotency key, then done.
  await h.service.rescheduleTask(second.id, isoDateWithOffset(9, todayIso()));
  await h.service.completeTask(second.id);
  const tasksBefore = await tasksOf(h, episodeId);

  await assert.rejects(() => h.service.reopenTask(first.record.id), /later occurrence .* already completed/);
  assert.deepEqual(await tasksOf(h, episodeId), tasksBefore);
});

test("Undo still reopens when the next occurrence was cancelled rather than completed", async () => {
  const h = await harness();
  const { created, first } = await weeklySeries(h, "9000880053");
  const episodeId = created.episode.record.id;
  await h.service.completeTask(first.record.id);
  const second = await openSuccessor(h, episodeId, first.record.due_date);
  await h.service.cancelTask(second.id, "Not needed");

  const reopened = await h.service.reopenTask(first.record.id);
  assert.equal(reopened.record.status, "open");
  assert.equal(reopened.nextOccurrence, "none");
});
