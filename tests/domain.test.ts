import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import {
  displayMrn,
  displayPhone,
  isIsoDate,
  mrnMatchKey,
  normalizeIsoDate,
  normalizeMrn,
  pathwayLabel,
  priorityLabel,
  procedureIdempotencyKey,
  taskIdempotencyKey,
  taskIsDueToday,
  taskIsOverdue,
  taskIsUndated,
  validateNewEpisodeInput
} from "../src/domain/schema";
import {
  canArchiveEpisode,
  canTransitionEpisode,
  canTransitionTask,
  pathwayAfterRestore,
  statusAfterRestore,
  statusAfterTaskCompletion
} from "../src/domain/transitions";
import { episodeInput } from "./support/harness";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema_version: 2,
    entity: "task",
    id: "TSK-1",
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z",
    tags: ["clinical/task"],
    patient_id: "PAT-1",
    patient: "[[Clinical Workspace/Patients/PAT-1]]",
    episode_id: "EPI-1",
    episode: "[[Clinical Workspace/Episodes/EPI-1]]",
    task: "Review result",
    task_type: "review-result",
    status: "open",
    priority: "routine",
    due_date: "2026-08-03",
    owner: "",
    completed_at: "",
    cancelled_at: "",
    cancel_reason: "",
    idempotency_key: "key",
    ...overrides
  };
}

test("MRN normalisation preserves the value as typed", () => {
  assert.equal(normalizeMrn(" 0009-0000 00001 "), "0009000000001");
  assert.equal(displayMrn(""), "MRN needed");
  assert.equal(displayPhone(""), "NFN");
});

test("MRN match key ignores leading zeroes so one patient is not split in two", () => {
  assert.equal(mrnMatchKey("0012345"), mrnMatchKey("12345"));
  assert.equal(mrnMatchKey(" 00-123 45 "), "12345");
  // A value that is all zeroes still has to keep one digit.
  assert.equal(mrnMatchKey("000"), "0");
  assert.notEqual(mrnMatchKey("12345"), mrnMatchKey("123456"));
  assert.equal(mrnMatchKey(""), "");
});

test("task and procedure idempotency keys are stable", () => {
  const first = taskIdempotencyKey({ episodeId: "EPI-1", task: " Check CT result ", dueDate: "2026-08-03" });
  const second = taskIdempotencyKey({ episodeId: "EPI-1", task: "check ct result", dueDate: "2026-08-03" });
  assert.equal(first, second);
  assert.equal(
    procedureIdempotencyKey("EPI-1", " Adenotonsillectomy ", "2026-08-03"),
    procedureIdempotencyKey("EPI-1", "adenotonsillectomy", "2026-08-03")
  );
});

test("date validation rejects impossible dates and tolerates a time component", () => {
  assert.equal(isIsoDate("2026-02-31"), false);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("not a date"), false);
  assert.equal(isIsoDate("2026-08-03"), true);
  // Obsidian's Properties panel writes a date-time when the field is typed.
  assert.equal(isIsoDate("2026-08-03T00:00:00"), true);
  assert.equal(normalizeIsoDate("2026-08-03T14:30:00.000Z"), "2026-08-03");
  assert.equal(normalizeIsoDate("2026-02-31"), "");
});

test("follow-up pathways require a next action and valid due date", () => {
  const input = episodeInput({ pathway: "opd-follow-up", nextAction: "", dueDate: "" });
  assert.match(validateNewEpisodeInput(input).join(" "), /Next action and due date/);
  input.nextAction = "Review patient";
  input.dueDate = "2026-02-31";
  assert.match(validateNewEpisodeInput(input).join(" "), /Due date is invalid/);
});

test("episode cannot be archived while an open task remains", () => {
  const decision = canArchiveEpisode("active", [task()], "EPI-1");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /1 open task remains/);
  assert.equal(canArchiveEpisode("ready-to-close", [task({ status: "completed" })], "EPI-1").allowed, true);
  // Cancelling is the documented escape hatch, so it must also unblock archive.
  assert.equal(canArchiveEpisode("active", [task({ status: "cancelled" })], "EPI-1").allowed, true);
});

test("completing the final task marks the episode ready to close", () => {
  const tasks = [task({ id: "TSK-1" }), task({ id: "TSK-2", status: "completed" })];
  assert.equal(statusAfterTaskCompletion(tasks, "EPI-1", "TSK-1"), "ready-to-close");
  const withRemaining = [...tasks, task({ id: "TSK-3", task: "Call family" })];
  assert.equal(statusAfterTaskCompletion(withRemaining, "EPI-1", "TSK-1"), null);
});

test("restore returns the pathway recorded before archiving", () => {
  assert.equal(pathwayAfterRestore("result-review"), "result-review");
  assert.equal(pathwayAfterRestore("or-booking"), "or-booking");
  // Records written before schema version 2 have nothing stored.
  assert.equal(pathwayAfterRestore(""), "assessment");
  assert.equal(pathwayAfterRestore("nonsense"), "assessment");
});

test("restore picks a status consistent with the episode's outstanding work", () => {
  assert.equal(statusAfterRestore("active", [], "EPI-1"), "ready-to-close");
  assert.equal(statusAfterRestore("active", [task()], "EPI-1"), "active");
  assert.equal(statusAfterRestore("on-hold", [task()], "EPI-1"), "on-hold");
});

test("state machines reject illegal transitions", () => {
  assert.equal(canTransitionEpisode("entered-in-error", "active"), false);
  assert.equal(canTransitionEpisode("archived", "active"), true);
  // completed -> open exists for audited mis-tap recovery (reopen).
  assert.equal(canTransitionTask("completed", "open"), true);
  assert.equal(canTransitionTask("entered-in-error", "open"), false);
  assert.equal(canTransitionTask("open", "cancelled"), true);
});

test("task date predicates handle missing and malformed values", () => {
  assert.equal(taskIsDueToday(task({ due_date: "2026-08-03" }), "2026-08-03"), true);
  assert.equal(taskIsOverdue(task({ due_date: "2026-08-02" }), "2026-08-03"), true);
  assert.equal(taskIsOverdue(task({ due_date: "" }), "2026-08-03"), false);
  // An undated open task is real work and must be reachable from Today.
  assert.equal(taskIsUndated(task({ due_date: "" })), true);
  assert.equal(taskIsUndated(task({ due_date: "2026-08-03" })), false);
  assert.equal(taskIsUndated(task({ due_date: "", status: "completed" })), false);
  // A hand-edited date-time still resolves to the right calendar day.
  assert.equal(taskIsDueToday(task({ due_date: "2026-08-03T09:00:00" }), "2026-08-03"), true);
});

test("labels degrade gracefully on hand-edited values", () => {
  assert.equal(priorityLabel("routine"), "Routine");
  assert.equal(priorityLabel(""), "Unknown");
  assert.equal(priorityLabel(undefined as unknown as string), "Unknown");
  assert.equal(pathwayLabel("assessment"), "Assessment");
  assert.equal(pathwayLabel("not-a-pathway"), "Unknown pathway");
});

test("episode record shape carries the fields restore depends on", () => {
  const episode: Partial<EpisodeRecord> = { pathway_before_archive: "result-review", status_before_archive: "active" };
  assert.equal(pathwayAfterRestore(String(episode.pathway_before_archive)), "result-review");
});
