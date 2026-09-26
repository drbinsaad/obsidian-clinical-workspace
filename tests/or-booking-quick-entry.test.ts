import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import type { EpisodeRecord, EpisodeUpdateInput, TaskRecord } from "../src/domain/types";
import { QUICK_ENTRY_ACTIONS, QUICK_ENTRY_COMMAND_IDS, QUICK_ENTRY_PROTOCOL_ACTIONS, isSafeQuickEntryProtocolInvocation } from "../src/quick-entry";
import { installTestDomGlobals, TestElement } from "./support/dom-harness";
import { episodeInput, harness } from "./support/harness";

installTestDomGlobals();

test("Book OR has a dedicated action-only command and protocol", () => {
  assert.ok((QUICK_ENTRY_ACTIONS as readonly string[]).includes("book-or"));
  assert.equal((QUICK_ENTRY_COMMAND_IDS as Record<string, string>)["book-or"], "book-or");
  assert.equal((QUICK_ENTRY_PROTOCOL_ACTIONS as Record<string, string>)["book-or"], "clinical-workspace-book-or");
  assert.equal(isSafeQuickEntryProtocolInvocation("clinical-workspace-book-or", { action: "clinical-workspace-book-or", episodeId: "synthetic" }), false);
});

async function form(seed?: { nextAction?: string; dueDate?: string }, patientLabel = "") {
  const { BookOrModal } = await import("../src/ui/or-booking-modal");
  const environment = await harness();
  const created = await environment.service.createEpisode(episodeInput({ mrn: "9000009101", phone: "0500000000", nextAction: "Review synthetic result", dueDate: "2027-01-01" }));
  created.episode = (await environment.repository.findById<EpisodeRecord>("episode", created.episode.record.id))!;
  const submissions: EpisodeUpdateInput[] = [];
  const modal = new BookOrModal(new App(), created.episode.record, async (input) => { submissions.push(input); }, seed, patientLabel);
  let closes = 0;
  modal.close = () => { closes += 1; };
  const content = new TestElement();
  (content as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: null };
  Object.assign(modal, { contentEl: content, modalEl: new TestElement() });
  modal.onOpen();
  const internals = modal as unknown as { value(): EpisodeUpdateInput };
  return { ...environment, created, content, internals, submissions, closes: () => closes };
}

function setField(content: TestElement, name: string, value: string): void {
  const field = content.querySelector(`[aria-label="${name}"]`);
  assert.ok(field, `missing ${name}`);
  field.value = value;
  field.dispatch("input");
}

test("booking review shows the chosen patient identity as safe text alongside the case", async () => {
  const label = "MRN 9000009101 — Synthetic <patient>";
  const { content, created } = await form(undefined, label);
  assert.ok(content.textContent.includes(label));
  assert.ok(content.textContent.includes(created.episode.record.case));
  assert.equal(content.querySelector("patient"), null);
});

test("Book OR requires a fresh plan and chosen date without inheriting an unrelated task", async () => {
  const { content, internals, created } = await form();
  assert.throws(() => internals.value(), /next action/i);
  setField(content, "Next action", "Plan synthetic surgery");
  assert.throws(() => internals.value(), /date/i);
  setField(content, "Due date", "2027-02-30");
  assert.throws(() => internals.value(), /date/i);
  setField(content, "Due date", "2027-02-20");
  assert.deepEqual(internals.value(), { careSetting: "outpatient", pathway: "or-booking", priority: "routine", nextAction: "Plan synthetic surgery", dueDate: "2027-02-20", expectedUpdatedAt: created.episode.record.updated_at });
  assert.match(content.textContent, /planned surgery/i);
  assert.match(content.textContent, /logbook/i);
});

test("captured booking seed uses existing workflow update without logging a procedure", async () => {
  const { service, repository, created, internals } = await form({ nextAction: "Book synthetic surgery", dueDate: "2027-03-01" });
  await service.updateEpisode(created.episode.record.id, internals.value());
  const episode = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode!.record.pathway, "or-booking");
  const tasks = await repository.list<TaskRecord>("task");
  const booking = tasks.find(({ record }) => record.task === "Book synthetic surgery");
  assert.ok(booking);
  assert.equal(booking.record.task_type, "book-or");
  assert.equal(booking.record.due_date, "2027-03-01");
  assert.equal((await repository.list("procedure")).length, 0);
});

test("booking submission keeps an invalid form open and submits only the reviewed plan", async () => {
  const { content, submissions, closes } = await form();
  const submit = content.querySelector(".mod-cta");
  assert.ok(submit);
  submit.dispatch("click");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(submissions.length, 0);
  assert.equal(closes(), 0);
  assert.match(content.textContent, /Enter the next action/);
  setField(content, "Next action", "  Book reviewed synthetic surgery  ");
  setField(content, "Due date", "2027-04-01");
  submit.dispatch("click");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(submissions.length, 1);
  assert.ok(submissions[0]);
  assert.equal(submissions[0].nextAction, "Book reviewed synthetic surgery");
  assert.equal(submissions[0].pathway, "or-booking");
  assert.equal(closes(), 1);
});

test("a booking opened before a record change is refused without new surgery work", async () => {
  const { service, repository, created, internals } = await form({ nextAction: "Book synthetic surgery", dueDate: "2027-03-01" });
  const input = internals.value();
  // Use an explicit older snapshot: repository updates generate their own
  // timestamps, and two synchronous test writes can share a millisecond.
  input.expectedUpdatedAt = "2000-01-01T00:00:00.000Z";
  await repository.update<EpisodeRecord>(created.episode.path, { priority: "urgent" });
  await assert.rejects(service.updateEpisode(created.episode.record.id, input), /changed after the form/);
  const current = await repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(current!.record.pathway, "assessment");
  assert.equal((await repository.list<TaskRecord>("task")).filter(({ record }) => record.task_type === "book-or").length, 0);
  assert.equal((await repository.list("procedure")).length, 0);
});
