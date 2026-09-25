import assert from "node:assert/strict";
import test from "node:test";
import { todayIso } from "../src/domain/schema";
import type { EpisodeRecord, ProcedureRecord, TaskRecord } from "../src/domain/types";
import { episodeInput, harness } from "./support/harness";

async function setup() {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000997001", patientName: "Synthetic Return", pathway: "or-booking", nextAction: "Book theatre", dueDate: todayIso() }));
  const input = { patientId: created.patient.record.id, episodeId: created.episode.record.id, procedure: "Synthetic operation", procedureDate: todayIso(), role: "Primary surgeon", outcome: "", followUpRequired: false, followUpDate: "", followUpPlan: "" };
  const booking = async () => {
    const tasks = await h.repository.list<TaskRecord>("task");
    const found = tasks.find(t => t.record.episode_id === input.episodeId && t.record.task_type === "book-or" && ["open", "in-progress", "waiting"].includes(t.record.status));
    assert.ok(found);
    return found.record.id;
  };
  const rebook = () => h.service.updateEpisode(input.episodeId, { careSetting: "inpatient", pathway: "or-booking", priority: "urgent", nextAction: "Return to theatre", dueDate: todayIso() });
  return { h, input, booking, rebook };
}

test("new booking permits same-name same-day return; parallel submissions create one entry", async () => {
  const { h, input, booking, rebook } = await setup();
  await h.service.completeProcedure(input);
  await rebook();
  const request = { ...input, completionBookingTaskId: await booking() };
  const [first, second] = await Promise.all([h.service.completeProcedure(request), h.service.completeProcedure(request)]);
  assert.equal(first.record.id, second.record.id);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 2);
  assert.equal((await h.repository.findById<TaskRecord>("task", request.completionBookingTaskId))?.record.status, "completed");
});

test("captured missing booking fails before creating a procedure", async () => {
  const { h, input } = await setup();
  await assert.rejects(h.service.completeProcedure({ ...input, completionBookingTaskId: "TSK-missing" }), /booking/i);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 0);
});

test("committed old booking replay leaves newer booking and episode unchanged", async () => {
  const { h, input, booking, rebook } = await setup();
  const request = { ...input, completionBookingTaskId: await booking() };
  const first = await h.service.completeProcedure(request);
  await rebook();
  const before = await h.repository.findById("episode", input.episodeId);
  const newBooking = await booking();
  const retry = await h.service.completeProcedure(request);
  assert.equal(first.record.id, retry.record.id);
  assert.deepEqual(await h.repository.findById("episode", input.episodeId), before);
  assert.equal((await h.repository.findById<TaskRecord>("task", newBooking))?.record.status, "open");
  await assert.rejects(h.service.completeProcedure({ ...request, procedure: "Different operation" }), /different|conflict/i);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
});

test("pending completion retries its booking but refuses edited inputs and a newer booking", async () => {
  const { h, input, booking, rebook } = await setup();
  const request = { ...input, completionBookingTaskId: await booking() };
  const real = h.repository.createEvent.bind(h.repository);
  h.repository.createEvent = async (...args) => {
    if (args[0].action === "procedure-completed") throw new Error("Synthetic audit failure");
    return real(...args);
  };
  await assert.rejects(h.service.completeProcedure(request), /Synthetic audit failure/);
  h.repository.createEvent = real;
  assert.equal((await h.repository.list<ProcedureRecord>("procedure"))[0]?.record.audit_pending, true);
  await assert.rejects(h.service.completeProcedure({ ...request, procedure: "Changed operation" }), /different|conflict/i);
  await assert.rejects(h.service.completeProcedure({ ...request, followUpRequired: true, followUpDate: todayIso(), followUpPlan: "Review" }), /different follow-up/);
  await rebook();
  const newerBooking = await booking();
  const before = await h.repository.findById("episode", input.episodeId);
  await assert.rejects(h.service.completeProcedure(request), /booking changed/);
  assert.deepEqual(await h.repository.findById("episode", input.episodeId), before);
  assert.equal((await h.repository.findById<TaskRecord>("task", newerBooking))?.record.status, "open");
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
});

test("pending audit completion resumes once without recreating the entry", async () => {
  const { h, input, booking } = await setup();
  const request = { ...input, completionBookingTaskId: await booking() };
  const real = h.repository.createEvent.bind(h.repository);
  h.repository.createEvent = async (...args) => {
    if (args[0].action === "procedure-completed") throw new Error("Synthetic audit failure");
    return real(...args);
  };
  await assert.rejects(h.service.completeProcedure(request), /Synthetic audit failure/);
  h.repository.createEvent = real;
  const saved = await h.service.completeProcedure(request);
  assert.equal(saved.record.audit_pending, false);
  assert.equal(saved.record.completion_booking_task_id, request.completionBookingTaskId);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
});

test("ambiguous, cancelled, and empty captured bookings fail closed", async () => {
  const { h, input, booking } = await setup();
  const bookingId = await booking();
  const original = await h.repository.findById<TaskRecord>("task", bookingId);
  assert.ok(original);
  await h.repository.create<TaskRecord>({ ...original.record, id: "TSK-synthetic-second-booking", task: "Separate synthetic booking" });
  await assert.rejects(h.service.completeProcedure({ ...input, completionBookingTaskId: bookingId }), /ambiguous/);
  await assert.rejects(h.service.completeProcedure({ ...input, completionBookingTaskId: "" }), /booking/);
  await h.repository.update<TaskRecord>(original.path, { status: "cancelled" });
  await assert.rejects(h.service.completeProcedure({ ...input, completionBookingTaskId: bookingId }), /booking/);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 0);
});

test("failure before closing booking resumes without duplicate and preserves unrelated work", async () => {
  const { h, input, booking } = await setup();
  const bookingId = await booking();
  const unrelated = await h.service.createTask({ patientId: input.patientId, episodeId: input.episodeId, task: "Review synthetic result", taskType: "review-result", priority: "routine", dueDate: todayIso(), owner: "" });
  const target = await h.repository.findById<TaskRecord>("task", bookingId);
  assert.ok(target);
  const real = h.repository.update.bind(h.repository);
  h.repository.update = async (path, changes) => {
    if (path === target.path) throw new Error("Synthetic task failure");
    return real(path, changes);
  };
  const request = { ...input, completionBookingTaskId: bookingId };
  await assert.rejects(h.service.completeProcedure(request), /Synthetic task failure/);
  h.repository.update = real;
  await h.service.completeProcedure(request);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
  assert.equal((await h.repository.findById<TaskRecord>("task", bookingId))?.record.status, "completed");
  assert.deepEqual(await h.repository.findById<TaskRecord>("task", unrelated.task.record.id), unrelated.task);
  assert.equal((await h.repository.findById<EpisodeRecord>("episode", input.episodeId))?.record.status, "active");
});

test("pending old completion cannot overwrite a taskless rebooking after its transition", async () => {
  const { h, input, booking } = await setup();
  const request = { ...input, completionBookingTaskId: await booking() };
  const real = h.repository.createEvent.bind(h.repository);
  h.repository.createEvent = async (...args) => {
    if (args[0].action === "procedure-completed") throw new Error("Synthetic audit failure");
    return real(...args);
  };
  await assert.rejects(h.service.completeProcedure(request), /Synthetic audit failure/);
  h.repository.createEvent = real;
  await h.service.updateEpisode(input.episodeId, { careSetting: "inpatient", pathway: "or-booking", priority: "urgent", nextAction: "", dueDate: "" });
  const before = await h.repository.findById<EpisodeRecord>("episode", input.episodeId);
  await assert.rejects(h.service.completeProcedure(request), /changed|booking/i);
  assert.deepEqual(await h.repository.findById<EpisodeRecord>("episode", input.episodeId), before);
});

test("pending older operation cannot rewind a newer completed operation marker", async () => {
  const { h, input, booking, rebook } = await setup();
  const first = { ...input, completionBookingTaskId: await booking() };
  const real = h.repository.createEvent.bind(h.repository);
  h.repository.createEvent = async (...args) => {
    if (args[0].action === "procedure-completed") throw new Error("Synthetic audit failure");
    return real(...args);
  };
  await assert.rejects(h.service.completeProcedure(first), /Synthetic audit failure/);
  h.repository.createEvent = real;
  await rebook();
  await h.service.completeProcedure({ ...input, completionBookingTaskId: await booking() });
  const before = await h.repository.findById<EpisodeRecord>("episode", input.episodeId);
  await assert.rejects(h.service.completeProcedure(first), /changed|newer|booking/i);
  assert.deepEqual(await h.repository.findById<EpisodeRecord>("episode", input.episodeId), before);
});

test("a pending default completion cannot be duplicated by switching to a booking-bound request", async () => {
  const { h, input, booking } = await setup();
  const bookingId = await booking();
  const target = await h.repository.findById<TaskRecord>("task", bookingId);
  assert.ok(target);
  const real = h.repository.update.bind(h.repository);
  h.repository.update = async (path, changes) => {
    if (path === target.path) throw new Error("Synthetic task failure");
    return real(path, changes);
  };
  await assert.rejects(h.service.completeProcedure(input), /Synthetic task failure/);
  h.repository.update = real;
  await assert.rejects(h.service.completeProcedure({ ...input, completionBookingTaskId: bookingId }), /pending|incomplete|retry/i);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
  await h.service.completeProcedure(input);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
});

test("a newer operation interrupted before transition may resume from its predecessor marker", async () => {
  const { h, input, booking, rebook } = await setup();
  const firstBooking = await booking();
  await h.service.completeProcedure({ ...input, completionBookingTaskId: firstBooking });
  await rebook();
  const nextBooking = await booking();
  const target = await h.repository.findById<TaskRecord>("task", nextBooking);
  assert.ok(target);
  const real = h.repository.update.bind(h.repository);
  h.repository.update = async (path, changes) => {
    if (path === target.path) throw new Error("Synthetic task failure");
    return real(path, changes);
  };
  const request = { ...input, completionBookingTaskId: nextBooking };
  await assert.rejects(h.service.completeProcedure(request), /Synthetic task failure/);
  h.repository.update = real;
  const completed = await h.service.completeProcedure(request);
  assert.equal(completed.record.completion_predecessor_booking_task_id, firstBooking);
  assert.equal(completed.record.audit_pending, false);
  assert.equal((await h.repository.findById<EpisodeRecord>("episode", input.episodeId))?.record.last_completion_booking_task_id, nextBooking);
  assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 2);
});
