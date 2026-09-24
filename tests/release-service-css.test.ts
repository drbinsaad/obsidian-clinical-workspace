/**
 * Release fixes for the procedure audit trail: a retried Complete surgery is
 * worded by how its record was first logged, not by the episode state the
 * failed attempt left behind. Synthetic data only; MRNs are 9000-series.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompleteProcedureInput,
  EpisodeRecord,
  EventRecord,
  ProcedureRecord,
  TaskRecord
} from "../src/domain/types";
import { isoDateWithOffset, todayIso } from "../src/domain/schema";
import { validateRecord } from "../src/domain/validate";
import { episodeInput, harness, type Harness } from "./support/harness";

const completions = async (h: Harness, targetId: string): Promise<string[]> =>
  (await h.repository.list<EventRecord>("event"))
    .map((item) => item.record)
    .filter((event) => event.action === "procedure-completed" && event.target_id === targetId)
    .map((event) => event.new_state);

const procedureNamed = async (h: Harness, name: string): Promise<ProcedureRecord> => {
  const found = (await h.repository.list<ProcedureRecord>("procedure")).find(
    (item) => item.record.procedure === name
  );
  assert.ok(found, "the procedure was saved");
  return found.record;
};

/**
 * An episode whose first surgery is logged and which is then booked again
 * for a return to theatre, so an earlier procedure already exists.
 */
async function rebookedEpisode(mrn: string) {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn,
      patientName: "Synthetic Return",
      caseName: "Neck abscess",
      pathway: "or-booking",
      nextAction: "Book theatre",
      dueDate: "2026-09-10"
    })
  );
  const episodeId = created.episode.record.id;
  const input = (overrides: Partial<CompleteProcedureInput> = {}): CompleteProcedureInput => ({
    patientId: created.patient.record.id,
    episodeId,
    procedure: "Incision and drainage",
    procedureDate: "2026-09-11",
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: "",
    ...overrides
  });
  await h.service.completeProcedure(input());
  await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "or-booking",
    priority: "routine",
    nextAction: "Book return to theatre",
    dueDate: isoDateWithOffset(3, todayIso())
  });
  const repo = h.repository as unknown as {
    create: (record: Record<string, unknown>) => Promise<unknown>;
    update: (path: string, changes: Record<string, unknown>) => Promise<unknown>;
  };
  return { h, episodeId, input, repo };
}

const episodeOf = async (h: Harness, episodeId: string): Promise<EpisodeRecord> =>
  (await h.repository.findById<EpisodeRecord>("episode", episodeId))!.record;

const bookingTasks = async (h: Harness, episodeId: string): Promise<string[]> =>
  (await h.repository.list<TaskRecord>("task"))
    .map((item) => item.record)
    .filter((task) => task.episode_id === episodeId && task.task_type === "book-or")
    .map((task) => task.status);

test("a retried Complete surgery with follow-up on a re-booked episode keeps its completion wording", async () => {
  const { h, episodeId, input, repo } = await rebookedEpisode("9000000951");
  const surgery = input({
    procedure: "Re-exploration of neck",
    procedureDate: "2026-09-14",
    followUpRequired: true,
    followUpDate: isoDateWithOffset(14, todayIso()),
    followUpPlan: "Wound review"
  });
  // The episode moves on and the booking completes; the follow-up task fails.
  const realCreate = repo.create.bind(h.repository);
  repo.create = async (record: Record<string, unknown>) => {
    if (record.entity === "task" && record.task_type === "postop-follow-up") {
      throw new Error("Injected write failure (synthetic)");
    }
    return realCreate(record);
  };
  await assert.rejects(() => h.service.completeProcedure(surgery), /Injected write failure/);
  repo.create = realCreate;
  assert.equal((await episodeOf(h, episodeId)).pathway, "opd-follow-up");
  const pending = await procedureNamed(h, "Re-exploration of neck");
  assert.equal(pending.audit_pending, true);

  const retried = await h.service.completeProcedure(surgery);
  assert.equal(retried.record.id, pending.id);
  assert.equal(retried.record.audit_pending, false);
  assert.deepEqual(await completions(h, retried.record.id), ["postoperative follow-up"]);
  assert.deepEqual(await bookingTasks(h, episodeId), ["completed", "completed"]);
  assert.equal(retried.record.logged_as, "completion");
  assert.deepEqual(validateRecord(retried.record), [], "the new field is not a schema problem");
  const issues = (await h.integrity.scan()).filter((issue) => issue.recordId === retried.record.id);
  assert.deepEqual(issues, [], "nor an integrity issue");
});

test("a repeated completion event on a re-booked episode names what the completion did", async () => {
  const { h, episodeId, input, repo } = await rebookedEpisode("9000000952");
  const surgery = input({ procedure: "Re-exploration of neck", procedureDate: "2026-09-14" });
  // The completion runs to its audit event and then fails to clear the debt.
  const realUpdate = repo.update.bind(h.repository);
  repo.update = async (path: string, changes: Record<string, unknown>) => {
    if (path.includes("/Procedures/") && changes.audit_pending === false) {
      throw new Error("Injected write failure (synthetic)");
    }
    return realUpdate(path, changes);
  };
  await assert.rejects(() => h.service.completeProcedure(surgery), /Injected write failure/);
  repo.update = realUpdate;
  assert.equal((await episodeOf(h, episodeId)).status, "ready-to-close");

  const retried = await h.service.completeProcedure(surgery);
  assert.equal(retried.record.audit_pending, false);
  assert.deepEqual(await completions(h, retried.record.id), ["ready to close", "ready to close"]);
});

test("a retried addition keeps its addition wording, and a record without the field falls back", async () => {
  const { h, episodeId, input, repo } = await rebookedEpisode("9000000953");
  // Complete surgery for the return to theatre moves the episode on.
  await h.service.completeProcedure(input({ procedure: "Re-exploration of neck", procedureDate: "2026-09-14" }));
  const after = await episodeOf(h, episodeId);

  const realUpdate = repo.update.bind(h.repository);
  repo.update = async (path: string, changes: Record<string, unknown>) => {
    if (path.includes("/Procedures/") && changes.audit_pending === false) {
      throw new Error("Injected write failure (synthetic)");
    }
    return realUpdate(path, changes);
  };
  const addition = input({ procedure: "Ligation of vessel", procedureDate: "2026-09-14" });
  await assert.rejects(() => h.service.completeProcedure(addition), /Injected write failure/);
  const form = input({
    procedure: "Wound washout",
    procedureDate: "2026-09-14",
    additionalEntryId: "ADD-synthetic-95"
  });
  await assert.rejects(() => h.service.completeProcedure(form), /Injected write failure/);
  repo.update = realUpdate;
  assert.equal((await procedureNamed(h, "Ligation of vessel")).logged_as, "addition");
  assert.equal((await procedureNamed(h, "Wound washout")).logged_as, "addition");

  const retriedAddition = await h.service.completeProcedure(addition);
  assert.deepEqual(await completions(h, retriedAddition.record.id), ["episode unchanged", "episode unchanged"]);
  const retriedForm = await h.service.completeProcedure(form);
  assert.deepEqual(await completions(h, retriedForm.record.id), ["episode unchanged", "episode unchanged"]);
  const episode = await episodeOf(h, episodeId);
  assert.equal(episode.pathway, after.pathway, "an addition leaves the episode alone");
  assert.equal(episode.status, after.status);

  // A record saved before the field existed keeps today's calculation.
  const legacyInput = input({ procedure: "Drain removal", procedureDate: "2026-09-15" });
  repo.update = async (path: string, changes: Record<string, unknown>) => {
    if (path.includes("/Procedures/") && changes.audit_pending === false) {
      throw new Error("Injected write failure (synthetic)");
    }
    return realUpdate(path, changes);
  };
  await assert.rejects(() => h.service.completeProcedure(legacyInput), /Injected write failure/);
  repo.update = realUpdate;
  const legacy = (await h.repository.list<ProcedureRecord>("procedure")).find(
    (item) => item.record.procedure === "Drain removal"
  );
  assert.ok(legacy);
  const stored = h.app.vault.files.get(legacy.path);
  assert.ok(stored);
  assert.match(stored, /^logged_as: addition$/m);
  h.app.vault.writeRaw(legacy.path, stored.replace(/^logged_as: .*\n/m, ""));
  // Mirrors the vault modify event for the external edit.
  h.repository.invalidatePath(legacy.path);
  assert.equal((await procedureNamed(h, "Drain removal")).logged_as, undefined);
  const retriedLegacy = await h.service.completeProcedure(legacyInput);
  assert.deepEqual(await completions(h, retriedLegacy.record.id), ["episode unchanged", "episode unchanged"]);
});
