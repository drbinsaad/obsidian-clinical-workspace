/**
 * UI flows built on the reviewed service APIs: the MRN-owner question and the
 * duplicate-patient question asked while Add patient stays open, Discharge
 * listing and (only on an explicit tick) cancelling open work, Undo after
 * Complete, the Update notice for a moved task and escalated priorities,
 * "Add another procedure", and a refused restore.
 *
 * Real views and modals over an in-memory vault. Synthetic data only; MRNs
 * use the 9000 series.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Modal } from "obsidian";
import { isoDateWithOffset, procedureIdempotencyKey, todayIso } from "../src/domain/schema";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import type { EpisodeRecord, PatientRecord, ProcedureRecord, TaskRecord } from "../src/domain/types";
import {
  ArchiveEpisodeModal,
  DuplicatePatientModal,
  MrnOwnerConflictModal,
  NewEpisodeModal,
  ProcedureModal,
  QuickEntryEpisodeModal,
  UpdateEpisodeModal
} from "../src/ui/modals";
import {
  ClinicalWorkspaceView,
  UNDO_COMPLETE_NOTICE_MS,
  quickEntryEpisodeChoices
} from "../src/ui/workspace-view";
import { installTestDomGlobals, TestElement } from "./support/dom-harness";
import { episodeInput, harness, type Harness } from "./support/harness";
import { Notice as StubNotice } from "./support/obsidian-stub";

installTestDomGlobals();
// esbuild defines this flag in real builds; the More tab reads it.
(globalThis as { __DEV_TOOLS__?: boolean }).__DEV_TOOLS__ = false;
// Obsidian's global fragment builder; the Undo notice is built with it.
(globalThis as { createFragment?: unknown }).createFragment = (build?: (fragment: TestElement) => void) => {
  const fragment = new TestElement("#document-fragment");
  build?.(fragment);
  return fragment;
};

/* ---------------------------------------------------- modal mounting ----- */

type Mounted = {
  contentEl: TestElement;
  modalEl: TestElement;
  closes: number;
  onOpen: () => void;
  onClose?: () => void;
};

/** Every modal opened in this file, in order. The stub Modal has no open(). */
const opened: Mounted[] = [];
const modalPrototype = Modal.prototype as unknown as {
  open: (this: Mounted) => void;
  close: (this: Mounted) => void;
};
modalPrototype.open = function () {
  const content = new TestElement();
  // No window: the viewport controller stays unbound, as in a test DOM.
  (content as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: null };
  this.contentEl = content;
  this.modalEl = new TestElement();
  this.closes = 0;
  opened.push(this);
  this.onOpen();
};
modalPrototype.close = function () {
  this.closes += 1;
  if (typeof this.onClose === "function") this.onClose();
};

function lastOpened(modalClass: abstract new (...args: never[]) => unknown): Mounted {
  const found = [...opened].reverse().find((modal) => modal instanceof modalClass);
  assert.ok(found, `expected an open ${modalClass.name}`);
  return found;
}

function openedCount(modalClass: abstract new (...args: never[]) => unknown): number {
  return opened.filter((modal) => modal instanceof modalClass).length;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${label}`);
}

/* ---------------------------------------------------------- helpers ----- */

type ViewInternals = {
  activeTab: "today" | "patients" | "tasks" | "surgery" | "more";
  contentEl: TestElement;
  refresh: () => Promise<void>;
  openAddPatient: () => void;
  openProcedureQuickEntry: (activeEpisodePath?: string) => Promise<void>;
};

async function mountView(
  h: Harness,
  tab: ViewInternals["activeTab"],
  settings = DEFAULT_SETTINGS
): Promise<{ view: ViewInternals; root: TestElement }> {
  const root = new TestElement();
  const view = new ClinicalWorkspaceView(
    {} as never,
    h.repository,
    h.service,
    h.integrity,
    () => settings
  ) as unknown as ViewInternals;
  view.contentEl = root;
  view.activeTab = tab;
  await view.refresh();
  return { view, root };
}

function buttonNamed(root: TestElement, pattern: RegExp): TestElement {
  const button = root
    .findAll("button")
    .find((candidate) => pattern.test(candidate.getAttribute("aria-label") ?? candidate.textContent));
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

function field(content: TestElement, label: string): TestElement {
  const control = content.findAll(`[aria-label="${label}"]`).find((element) =>
    ["INPUT", "SELECT"].includes(element.tagName)
  );
  assert.ok(control, `expected a field named ${label}`);
  return control;
}

function type(control: TestElement, value: string): void {
  control.value = value;
  control.dispatch("input");
}

function submitButton(content: TestElement): TestElement {
  const submit = content.find(".clinical-modal-actions")?.findAll("button").find((button) =>
    button.classes.has("mod-cta")
  );
  assert.ok(submit, "expected the form's submit button");
  return submit;
}

function noticeTexts(from = 0): string[] {
  return StubNotice.history.slice(from).map((notice) =>
    typeof notice.message === "string" ? notice.message : (notice.message as unknown as TestElement).textContent
  );
}

/** Notices may never carry an MRN, a patient name, or task wording. */
function assertIdentifierFree(text: string): void {
  assert.doesNotMatch(text, /\d{7,}/, `no MRN-shaped number in: ${text}`);
  assert.doesNotMatch(text, /Synthetic/, `no patient or clinical text in: ${text}`);
}

async function openAddPatientForm(view: ViewInternals): Promise<Mounted> {
  const before = openedCount(NewEpisodeModal);
  view.openAddPatient();
  assert.equal(openedCount(NewEpisodeModal), before + 1);
  const form = lastOpened(NewEpisodeModal);
  await flush(); // field names are applied in a microtask
  return form;
}

async function tasksOf(h: Harness, episodeId: string): Promise<TaskRecord[]> {
  return (await h.repository.list<TaskRecord>("task"))
    .map((item) => item.record)
    .filter((task) => task.episode_id === episodeId);
}

/* --------------------------------------------- 1. MRN owner conflict ----- */

test("an MRN recorded under another name keeps Add patient open and asks in a modal", async () => {
  const h = await harness();
  await h.service.createEpisode(
    episodeInput({ mrn: "9000800101", patientName: "Synthetic Alpha", caseName: "Case A" })
  );
  const { view } = await mountView(h, "today");
  const noticesBefore = StubNotice.history.length;
  const form = await openAddPatientForm(view);
  type(field(form.contentEl, "MRN"), "9000800101");
  type(field(form.contentEl, "Patient name"), "Synthetic Bravo");
  type(field(form.contentEl, "Case / reason"), "Case B");

  const conflictsBefore = openedCount(MrnOwnerConflictModal);
  field(form.contentEl, "MRN").focused = false;
  submitButton(form.contentEl).dispatch("click");
  await waitFor(() => openedCount(MrnOwnerConflictModal) > conflictsBefore, "the MRN question");
  const question = lastOpened(MrnOwnerConflictModal);
  // Identifiers belong in the modal, where the clinician can compare them.
  assert.match(question.contentEl.textContent, /MRN 9000800101 is already recorded for \u2068Synthetic Alpha\u2069/);
  assert.match(question.contentEl.textContent, /the form names \u2068Synthetic Bravo\u2069/);
  await flush();
  const back = buttonNamed(question.contentEl, /^Go back and check the MRN$/);
  assert.equal(back.focused, true, "the safe answer takes focus");

  back.dispatch("click");
  await waitFor(() => !submitButton(form.contentEl).disabled, "the form to settle");
  assert.equal(form.closes, 0, "the form stays open");
  assert.equal(field(form.contentEl, "MRN").value, "9000800101", "everything typed is still there");
  assert.equal(field(form.contentEl, "Patient name").value, "Synthetic Bravo");
  assert.equal(field(form.contentEl, "MRN").focused, true, "focus returns to the MRN");
  const note = form.contentEl.find(".clinical-modal-note");
  assert.equal(note?.hidden, false);
  assert.match(note?.textContent ?? "", /Nothing was saved\. Check the MRN/);
  assert.equal(form.contentEl.find(".clinical-modal-error")?.hidden, true, "going back is not a failure");
  assert.deepEqual(noticeTexts(noticesBefore), [], "no failure notice");
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 1, "nothing was written");

  // Confirming it is the same person files the episode under the stored chart.
  submitButton(form.contentEl).dispatch("click");
  await waitFor(() => openedCount(MrnOwnerConflictModal) > conflictsBefore + 1, "the second question");
  buttonNamed(lastOpened(MrnOwnerConflictModal).contentEl, /^Use this patient — /).dispatch("click");
  await waitFor(() => form.closes === 1, "the form to close");
  const patients = (await h.repository.list<PatientRecord>("patient")).map((item) => item.record);
  assert.equal(patients.length, 1);
  assert.equal(patients[0]?.patient_name, "Synthetic Alpha", "the stored name is kept");
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 2);
  const shown = noticeTexts(noticesBefore);
  assert.deepEqual(shown, ["Episode added to the existing patient record for this MRN; the stored name was kept."]);
  for (const text of shown) assertIdentifierFree(text);
});

test("a clean MRN match says the episode joined an existing record, without identifiers", async () => {
  const h = await harness();
  await h.service.createEpisode(
    episodeInput({ mrn: "9000800102", patientName: "Synthetic Charlie", caseName: "Case C" })
  );
  const { view } = await mountView(h, "today");
  const noticesBefore = StubNotice.history.length;
  const form = await openAddPatientForm(view);
  type(field(form.contentEl, "MRN"), "9000800102");
  type(field(form.contentEl, "Patient name"), "synthetic charlie");
  type(field(form.contentEl, "Case / reason"), "Case C2");
  submitButton(form.contentEl).dispatch("click");
  await waitFor(() => form.closes === 1, "the form to close");
  assert.deepEqual(noticeTexts(noticesBefore), ["Episode added to an existing patient record (matched by MRN)."]);
  assert.equal(view.activeTab, "patients");
});

/* ------------------------------------------ 2. Duplicate name question ----- */

test("cancelling the duplicate-patient question returns to the still-filled form", async () => {
  const h = await harness();
  await h.service.createEpisode(episodeInput({ mrn: "", patientName: "Synthetic Delta", caseName: "Case D" }));
  const { view } = await mountView(h, "today");
  const noticesBefore = StubNotice.history.length;
  const form = await openAddPatientForm(view);
  type(field(form.contentEl, "Patient name"), "Synthetic Delta");
  type(field(form.contentEl, "Case / reason"), "Case E");
  type(field(form.contentEl, "Next action"), "Synthetic review");

  const questionsBefore = openedCount(DuplicatePatientModal);
  submitButton(form.contentEl).dispatch("click");
  await waitFor(() => openedCount(DuplicatePatientModal) > questionsBefore, "the duplicate question");
  const question = lastOpened(DuplicatePatientModal);
  assert.match(question.contentEl.textContent, /No MRN was entered/);
  buttonNamed(question.contentEl, /^Cancel$/).dispatch("click");

  await waitFor(() => !submitButton(form.contentEl).disabled, "the form to settle");
  assert.equal(form.closes, 0, "Cancel no longer discards the form");
  assert.equal(field(form.contentEl, "Patient name").value, "Synthetic Delta");
  assert.equal(field(form.contentEl, "Case / reason").value, "Case E");
  assert.equal(field(form.contentEl, "Next action").value, "Synthetic review");
  assert.equal(form.contentEl.find(".clinical-modal-note")?.hidden, false);
  assert.equal(form.contentEl.find(".clinical-modal-error")?.hidden, true);
  assert.deepEqual(noticeTexts(noticesBefore), [], "backing out raises no failure notice");
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 1);

  submitButton(form.contentEl).dispatch("click");
  await waitFor(() => openedCount(DuplicatePatientModal) > questionsBefore + 1, "the question again");
  buttonNamed(lastOpened(DuplicatePatientModal).contentEl, /^Use this patient — /).dispatch("click");
  await waitFor(() => form.closes === 1, "the form to close");
  assert.equal((await h.repository.list<PatientRecord>("patient")).length, 1);
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 2);
  assert.deepEqual(noticeTexts(noticesBefore), ["Episode added to the chosen patient record."]);
});

test("an MRN typed for a name-only chart is shown as recorded on the chosen chart", async () => {
  const h = await harness();
  await h.service.createEpisode(episodeInput({ mrn: "", patientName: "Synthetic Echo", caseName: "Case F" }));
  const { view } = await mountView(h, "today");
  const noticesBefore = StubNotice.history.length;
  const form = await openAddPatientForm(view);
  type(field(form.contentEl, "MRN"), "9000800104");
  type(field(form.contentEl, "Patient name"), "Synthetic Echo");
  type(field(form.contentEl, "Case / reason"), "Case G");
  const questionsBefore = openedCount(DuplicatePatientModal);
  submitButton(form.contentEl).dispatch("click");
  await waitFor(() => openedCount(DuplicatePatientModal) > questionsBefore, "the duplicate question");
  const question = lastOpened(DuplicatePatientModal);
  assert.match(question.contentEl.textContent, /MRN 9000800104 will be recorded on the chosen chart/);
  assert.ok(
    question.contentEl.findAll("p").some((line) => line.textContent === "Choosing this chart records MRN 9000800104 on it."),
    "each chart without an MRN says it will take this one"
  );
  buttonNamed(question.contentEl, /^Use this patient — /).dispatch("click");
  await waitFor(() => form.closes === 1, "the form to close");
  const patients = (await h.repository.list<PatientRecord>("patient")).map((item) => item.record);
  assert.equal(patients.length, 1);
  assert.equal(patients[0]?.mrn, "9000800104");
  const shown = noticeTexts(noticesBefore);
  assert.deepEqual(shown, ["Episode added to the chosen patient record, and the MRN was recorded on it."]);
  for (const text of shown) assertIdentifierFree(text);
});

/* ---------------------------------------------------- 3. Discharge ----- */

async function episodeWithTwoTasks(h: Harness, mrn: string) {
  const created = await h.service.createEpisode(
    episodeInput({
      mrn,
      patientName: "Synthetic Foxtrot",
      caseName: "Case H",
      nextAction: "Synthetic dressing",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Synthetic bloods",
    taskType: "review-result",
    priority: "routine",
    dueDate: "",
    owner: ""
  });
  return created;
}

test("Discharge lists the open tasks and cancels them only after an explicit tick", async () => {
  const h = await harness();
  const created = await episodeWithTwoTasks(h, "9000800105");
  const { root } = await mountView(h, "patients");
  const card = root.findAll(".clinical-card").find((candidate) => candidate.find("h4")?.textContent === "Case H");
  assert.ok(card);
  assert.ok(
    card.findAll(".clinical-badge").some((badge) => badge.textContent === "2 open tasks"),
    "the card shows what stands in the way of discharge"
  );

  buttonNamed(root, /^Discharge — /).dispatch("click");
  const modal = lastOpened(ArchiveEpisodeModal);
  const listed = modal.contentEl.findAll("li").map((item) => item.textContent);
  assert.equal(listed.length, 2);
  assert.ok(listed.some((text) => text.includes("Synthetic dressing")));
  assert.ok(listed.some((text) => text.includes("Synthetic bloods") && text.endsWith("no date")));
  const check = modal.contentEl.findAll("input").find((input) => input.getAttribute("type") === "checkbox");
  assert.ok(check);
  assert.equal((check as unknown as { checked: boolean }).checked, false, "dropping open work starts off");
  assert.match(modal.contentEl.find(".clinical-confirm-check")?.textContent ?? "", /^Cancel these 2 open tasks \(reason: Closed at discharge\)$/);
  const submit = submitButton(modal.contentEl);
  assert.equal(submit.disabled, true, "Archive is unavailable while the tasks are open");
  const hintId = submit.getAttribute("aria-describedby") ?? "";
  assert.ok(hintId);
  assert.match(modal.contentEl.find(`#${hintId}`)?.textContent ?? "", /Archive stays unavailable while these tasks are open/);
  submit.dispatch("click");
  await flush();
  assert.equal(modal.closes, 0, "a disabled Archive does nothing");
  assert.equal((await tasksOf(h, created.episode.record.id)).filter((task) => task.status === "open").length, 2);

  (check as unknown as { checked: boolean }).checked = true;
  check.dispatch("change");
  assert.equal(submit.disabled, false);
  assert.match(modal.contentEl.find(`#${hintId}`)?.textContent ?? "", /Each task is cancelled with its own audit entry/);

  const noticesBefore = StubNotice.history.length;
  submit.dispatch("click");
  await waitFor(() => modal.closes === 1, "the discharge to finish");
  const episode = await h.repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode?.record.status, "archived");
  const tasks = await tasksOf(h, created.episode.record.id);
  assert.ok(tasks.every((task) => task.status === "cancelled" && task.cancel_reason === "Closed at discharge"));
  const shown = noticeTexts(noticesBefore);
  assert.deepEqual(shown, ["Patient episode archived. 2 open tasks were cancelled."]);
  for (const text of shown) assertIdentifierFree(text);
});

test("Discharge refuses to cancel open work added after the form opened", async () => {
  const h = await harness();
  const created = await episodeWithTwoTasks(h, "9000800106");
  const { root } = await mountView(h, "patients");
  buttonNamed(root, /^Discharge — /).dispatch("click");
  const modal = lastOpened(ArchiveEpisodeModal);
  await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Synthetic late arrival",
    taskType: "other",
    priority: "urgent",
    dueDate: "",
    owner: ""
  });
  const check = modal.contentEl.findAll("input").find((input) => input.getAttribute("type") === "checkbox");
  assert.ok(check);
  (check as unknown as { checked: boolean }).checked = true;
  check.dispatch("change");
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.contentEl.find(".clinical-modal-error")?.hidden === false, "the refusal");
  assert.match(modal.contentEl.find(".clinical-modal-error")?.textContent ?? "", /added after this form opened\. Nothing was cancelled/);
  assert.equal(modal.closes, 0);
  const tasks = await tasksOf(h, created.episode.record.id);
  assert.equal(tasks.filter((task) => task.status === "open").length, 3, "nothing was cancelled");
});

test("the typed DISCHARGE confirmation still applies alongside the open-task list", async () => {
  const h = await harness();
  const created = await episodeWithTwoTasks(h, "9000800107");
  const { root } = await mountView(h, "patients", { ...DEFAULT_SETTINGS, confirmBeforeDischarge: true });
  buttonNamed(root, /^Discharge — /).dispatch("click");
  const modal = lastOpened(ArchiveEpisodeModal);
  await flush();
  const check = modal.contentEl.findAll("input").find((input) => input.getAttribute("type") === "checkbox");
  assert.ok(check);
  (check as unknown as { checked: boolean }).checked = true;
  check.dispatch("change");
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.contentEl.find(".clinical-modal-error")?.hidden === false, "the refusal");
  assert.match(modal.contentEl.find(".clinical-modal-error")?.textContent ?? "", /Type DISCHARGE to confirm/);
  assert.equal((await tasksOf(h, created.episode.record.id)).filter((task) => task.status === "open").length, 2);

  type(field(modal.contentEl, "Type DISCHARGE to confirm"), "discharge");
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "the discharge to finish");
  const episode = await h.repository.findById<EpisodeRecord>("episode", created.episode.record.id);
  assert.equal(episode?.record.status, "archived");
});

/* ------------------------------------------------ 4. Undo after Complete ----- */

async function recurringTask(h: Harness, mrn: string) {
  const created = await h.service.createEpisode(
    episodeInput({ mrn, patientName: "Synthetic Golf", caseName: "Case J" })
  );
  const { task } = await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Synthetic weekly dressing",
    taskType: "wound-care",
    priority: "routine",
    dueDate: todayIso(),
    owner: "",
    repeatEveryDays: 7
  });
  return { created, task };
}

function undoNotice(from: number): { notice: StubNotice; undo: TestElement } {
  const notice = StubNotice.history.slice(from).find((candidate) => typeof candidate.message !== "string");
  assert.ok(notice, "expected the Task completed notice with Undo");
  const undo = (notice.message as unknown as TestElement).find("button");
  assert.ok(undo);
  return { notice, undo };
}

test("Complete offers Undo, which reopens the task from any tab and withdraws its next occurrence", async () => {
  const h = await harness();
  const { created, task } = await recurringTask(h, "9000800108");
  const { view, root } = await mountView(h, "tasks");
  const noticesBefore = StubNotice.history.length;
  buttonNamed(root, /^Complete — \u2068Synthetic weekly dressing/).dispatch("click");
  await waitFor(() => StubNotice.history.length > noticesBefore, "the completion notice");

  const { notice, undo } = undoNotice(noticesBefore);
  assert.equal(notice.duration, UNDO_COMPLETE_NOTICE_MS);
  assert.equal((notice.message as unknown as TestElement).textContent, "Task completed.Undo");
  assert.equal(undo.getAttribute("type"), "button", "a real, focusable button");
  assert.equal(undo.getAttribute("aria-label"), "Undo task completion");
  assertIdentifierFree(undo.getAttribute("aria-label") ?? "");
  const afterComplete = await tasksOf(h, created.episode.record.id);
  assert.equal(afterComplete.find((record) => record.id === task.record.id)?.status, "completed");
  assert.equal(afterComplete.filter((record) => record.status === "open").length, 1, "the next occurrence was raised");

  // Undo holds only the task id, so it still works after the view moved on.
  view.activeTab = "more";
  await view.refresh();
  const beforeUndo = StubNotice.history.length;
  undo.dispatch("click");
  undo.dispatch("click");
  assert.equal(undo.disabled, true, "a second tap does nothing");
  assert.equal(notice.hidden, true);
  await waitFor(() => StubNotice.history.length > beforeUndo, "the reopen notice");
  await flush();
  const tasks = await tasksOf(h, created.episode.record.id);
  assert.equal(tasks.find((record) => record.id === task.record.id)?.status, "open");
  assert.equal(tasks.filter((record) => record.status === "open").length, 1, "no duplicate series");
  assert.deepEqual(noticeTexts(beforeUndo), ["Task reopened. Its next occurrence was withdrawn."]);
});

test("Undo leaves an edited next occurrence open and says so", async () => {
  const h = await harness();
  const { created, task } = await recurringTask(h, "9000800109");
  const { root } = await mountView(h, "tasks");
  const noticesBefore = StubNotice.history.length;
  buttonNamed(root, /^Complete — \u2068Synthetic weekly dressing/).dispatch("click");
  await waitFor(() => StubNotice.history.length > noticesBefore, "the completion notice");
  const { undo } = undoNotice(noticesBefore);
  const successor = (await h.repository.list<TaskRecord>("task")).find(
    (item) => item.record.episode_id === created.episode.record.id && item.record.status === "open"
  );
  assert.ok(successor);
  await h.repository.update<TaskRecord>(successor.path, { owner: "Dr Owner" });

  const beforeUndo = StubNotice.history.length;
  undo.dispatch("click");
  await waitFor(() => StubNotice.history.length > beforeUndo, "the reopen notice");
  assert.deepEqual(noticeTexts(beforeUndo), ["Task reopened. Its next occurrence was changed, so it was left open."]);
  const reopened = await h.repository.findById<TaskRecord>("task", task.record.id);
  assert.equal(reopened?.record.status, "open");
});

test("a refused Undo surfaces the service's message once, through the clinical notice", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({ mrn: "9000800110", patientName: "Synthetic Hotel", caseName: "Case K", nextAction: "Synthetic check", dueDate: todayIso() })
  );
  const { root } = await mountView(h, "tasks");
  const noticesBefore = StubNotice.history.length;
  buttonNamed(root, /^Complete — \u2068Synthetic check/).dispatch("click");
  await waitFor(() => StubNotice.history.length > noticesBefore, "the completion notice");
  const { undo } = undoNotice(noticesBefore);
  await h.service.archiveEpisode(created.episode.record.id, "Discharged");

  const beforeUndo = StubNotice.history.length;
  undo.dispatch("click");
  await waitFor(() => StubNotice.history.length > beforeUndo, "the refusal notice");
  await flush();
  assert.deepEqual(noticeTexts(beforeUndo), ["Restore the episode before reopening its tasks."]);
});

/* ------------------------------------------------------- 5. Update ----- */

test("Update says a date-only change moved the task and how many tasks were escalated", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(
    episodeInput({
      mrn: "9000800111",
      patientName: "Synthetic India",
      caseName: "Case L",
      nextAction: "Synthetic wound check",
      dueDate: isoDateWithOffset(3, todayIso())
    })
  );
  await h.service.createTask({
    patientId: created.patient.record.id,
    episodeId: created.episode.record.id,
    task: "Synthetic bloods",
    taskType: "review-result",
    priority: "routine",
    dueDate: isoDateWithOffset(5, todayIso()),
    owner: ""
  });
  const { root } = await mountView(h, "patients");
  buttonNamed(root, /^Update — /).dispatch("click");
  const modal = lastOpened(UpdateEpisodeModal);
  await flush();
  assert.ok(
    modal.contentEl.findAll(".setting-item-description").some((hint) =>
      hint.textContent === "Changing the next action replaces the current task; changing only its date moves it."
    )
  );
  const moved = isoDateWithOffset(2, todayIso());
  type(field(modal.contentEl, "Due date"), moved);
  const priority = field(modal.contentEl, "Priority");
  priority.value = "urgent";
  priority.dispatch("change");

  const noticesBefore = StubNotice.history.length;
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "the update to finish");
  const shown = noticeTexts(noticesBefore);
  assert.deepEqual(shown, [`Task moved to ${moved}. 2 open tasks raised to Urgent.`]);
  for (const text of shown) assertIdentifierFree(text);
  const tasks = await tasksOf(h, created.episode.record.id);
  assert.equal(tasks.length, 2, "the task moved; nothing was cancelled and re-raised");
});

/* -------------------------------------------- 6. Another procedure ----- */

function procedureInput(patientId: string, episodeId: string, procedure: string) {
  return {
    patientId,
    episodeId,
    procedure,
    procedureDate: todayIso(),
    role: "Primary surgeon",
    outcome: "",
    followUpRequired: false,
    followUpDate: "",
    followUpPlan: ""
  };
}

for (const hasEarlierOperation of [false, true]) test(`reopening an unfinished default operation retries it (earlier entry: ${hasEarlierOperation})`, async () => {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({
    mrn: "9000997102", patientName: "Synthetic Interrupted", phone: "0500000001", pathway: "or-booking",
    nextAction: "Book theatre", dueDate: todayIso()
  }));
  const input = procedureInput(created.patient.record.id, created.episode.record.id, "Synthetic interrupted operation");
  if (hasEarlierOperation) {
    await h.service.completeProcedure({ ...input, procedure: "Synthetic earlier operation" });
    await h.service.updateEpisode(input.episodeId, {
      careSetting: "inpatient", pathway: "or-booking", priority: "urgent",
      nextAction: "Return to theatre", dueDate: todayIso()
    });
  }
  const realUpdate = h.repository.update.bind(h.repository);
  h.repository.update = async (...args) => {
    if (args[0].includes("/Tasks/") && args[1].status === "completed") throw new Error("Synthetic interruption");
    return realUpdate(...args);
  };
  await assert.rejects(h.service.completeProcedure(input), /Synthetic interruption/);
  h.repository.update = realUpdate;
  const { root } = await mountView(h, "surgery");
  buttonNamed(root, /^Complete surgery —/).dispatch("click");
  const modal = lastOpened(ProcedureModal);
  await flush();
  assert.equal(modal.contentEl.findAll(".checkbox-container").some((toggle) =>
    toggle.getAttribute("aria-label") === "This is a new operation for this booking"), false);
  type(field(modal.contentEl, "Surgery / procedure"), input.procedure);
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "pending original operation to resume");
  const entries = await h.repository.list<ProcedureRecord>("procedure");
  assert.equal(entries.length, hasEarlierOperation ? 2 : 1);
  assert.ok(entries.every((item) => item.record.audit_pending === false));
});

test("reopening a bound completion after booking close resumes its saved booking", async () => {
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000997103", patientName: "Synthetic Retry", pathway: "or-booking" }));
  const input = procedureInput(created.patient.record.id, created.episode.record.id, "Synthetic repeat operation");
  await h.service.completeProcedure(input);
  await h.service.updateEpisode(input.episodeId, { careSetting: "inpatient", pathway: "or-booking", priority: "urgent", nextAction: "Return to theatre", dueDate: todayIso() });
  const booking = (await tasksOf(h, input.episodeId)).find(task => task.task_type === "book-or" && task.status === "open");
  assert.ok(booking);
  const real = h.repository.update.bind(h.repository);
  h.repository.update = async (...args) => {
    if (args[1].last_completion_booking_task_id) throw new Error("Synthetic transition failure");
    return real(...args);
  };
  await assert.rejects(h.service.completeProcedure({ ...input, completionBookingTaskId: booking.id }), /Synthetic transition failure/);
  h.repository.update = real;
  const snapshot = await h.repository.snapshot();
  const pending = snapshot.procedures.find(procedure => procedure.audit_pending === true);
  assert.ok(pending);
  assert.equal(quickEntryEpisodeChoices(snapshot, "", "procedure")[0]?.completionBookingTaskId, booking.id);
  const ambiguous = { ...snapshot, procedures: [...snapshot.procedures, { ...pending, id: "PRC-synthetic-ambiguous" }] };
  assert.equal(quickEntryEpisodeChoices(ambiguous, "", "procedure")[0]?.completionBookingTaskId, "");
  const currentBooking = { ...booking, id: "TSK-synthetic-current", status: "open" as const };
  assert.equal(quickEntryEpisodeChoices({ ...snapshot, tasks: [...snapshot.tasks, currentBooking] }, "", "procedure")[0]?.completionBookingTaskId, currentBooking.id);
  assert.equal(quickEntryEpisodeChoices({ ...snapshot, tasks: [...snapshot.tasks, currentBooking, { ...currentBooking, id: "TSK-synthetic-other" }] }, "", "procedure")[0]?.completionBookingTaskId, "");
  const { root } = await mountView(h, "surgery");
  buttonNamed(root, /^Complete surgery —/).dispatch("click");
  const modal = lastOpened(ProcedureModal);
  await flush();
  type(field(modal.contentEl, "Surgery / procedure"), input.procedure);
  const confirmation = modal.contentEl.findAll(".checkbox-container").find(toggle => toggle.getAttribute("aria-label") === "This is a new operation for this booking");
  assert.ok(confirmation);
  confirmation.dispatch("click");
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "saved bound operation to resume");
  const entries = await h.repository.list<ProcedureRecord>("procedure");
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.record.audit_pending === false));
});

for (const entry of ["surgery", "quick entry"] as const) {
  test(`${entry} completes an explicitly confirmed same-day return against its captured booking`, async () => {
    const h = await harness();
    const created = await h.service.createEpisode(episodeInput({
      mrn: "9000997101", patientName: "Synthetic Return", phone: "0500000000",
      caseName: "Synthetic repeat case", pathway: "or-booking"
    }));
    const episodeId = created.episode.record.id;
    const input = procedureInput(created.patient.record.id, episodeId, "Synthetic repeat operation");
    await h.service.completeProcedure(input);
    await h.service.updateEpisode(episodeId, {
      careSetting: "inpatient", pathway: "or-booking", priority: "urgent",
      nextAction: "Return to theatre", dueDate: todayIso()
    });
    const booking = (await tasksOf(h, episodeId)).find((task) => task.task_type === "book-or" && task.status === "open")!;
    assert.ok(booking);
    const { root, view } = await mountView(h, "surgery");
    if (entry === "surgery") buttonNamed(root, /^Complete surgery —/).dispatch("click");
    else {
      await view.openProcedureQuickEntry();
      buttonNamed(lastOpened(QuickEntryEpisodeModal).contentEl, /^Use this episode for a procedure:/).dispatch("click");
    }
    const modal = lastOpened(ProcedureModal);
    await flush();
    const confirm = modal.contentEl.findAll(".checkbox-container")
      .find((toggle) => toggle.getAttribute("aria-label") === "This is a new operation for this booking");
    assert.ok(confirm, "a rebooked operation needs an explicit confirmation");
    type(field(modal.contentEl, "Surgery / procedure"), input.procedure);
    submitButton(modal.contentEl).dispatch("click");
    await waitFor(() => modal.contentEl.find(".clinical-modal-error")?.hidden === false, "confirmation refusal");
    await waitFor(() => !submitButton(modal.contentEl).disabled, "confirmation refusal to settle");
    assert.equal((await h.repository.list<ProcedureRecord>("procedure")).length, 1);
    confirm.dispatch("click");
    submitButton(modal.contentEl).dispatch("click");
    await waitFor(() => modal.closes === 1 || modal.contentEl.find(".clinical-modal-error")?.hidden === false, "confirmed return completion");
    assert.equal(modal.closes, 1, modal.contentEl.find(".clinical-modal-error")?.textContent ?? "completion should close the form");
    const entries = await h.repository.list<ProcedureRecord>("procedure");
    assert.equal(entries.length, 2);
    assert.equal(entries.filter((item) => item.record.completion_booking_task_id === booking.id).length, 1);
    assert.equal((await h.repository.findById<TaskRecord>("task", booking.id))?.record.status, "completed");
  });
}

test("an episode past OR booking with a logged procedure offers Add another procedure", async () => {
  const h = await harness();
  const operated = await h.service.createEpisode(
    episodeInput({ mrn: "9000800112", patientName: "Synthetic Juliet", caseName: "Case M", pathway: "or-booking" })
  );
  await h.service.completeProcedure(
    procedureInput(operated.patient.record.id, operated.episode.record.id, "Synthetic tonsillectomy")
  );
  const booked = await h.service.createEpisode(
    episodeInput({ mrn: "9000800113", patientName: "Synthetic Kilo", caseName: "Case N", pathway: "or-booking" })
  );
  await h.service.createEpisode(
    episodeInput({ mrn: "9000800114", patientName: "Synthetic Lima", caseName: "Case O" })
  );

  const snapshot = await h.repository.snapshot();
  const choices = quickEntryEpisodeChoices(snapshot, "", "procedure");
  assert.deepEqual(
    choices.map((choice) => [choice.episode.id, choice.additionalProcedure === true]).sort(),
    [[booked.episode.record.id, false], [operated.episode.record.id, true]].sort(),
    "an OR booking as before, plus the operated episode as another procedure; never an assessment"
  );

  // Surgery tab: the logbook entry carries the action.
  const { root } = await mountView(h, "surgery");
  const add = buttonNamed(root, /^Add another procedure — \u2068Case M/);
  add.dispatch("click");
  const modal = lastOpened(ProcedureModal);
  await flush();
  assert.equal(modal.contentEl.find("h2")?.textContent, "Add another procedure");
  assert.equal(submitButton(modal.contentEl).textContent, "Log procedure");
  type(field(modal.contentEl, "Surgery / procedure"), "Synthetic adenoidectomy");
  const noticesBefore = StubNotice.history.length;
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "the procedure to be logged");
  assert.deepEqual(noticeTexts(noticesBefore), ["Procedure added to the logbook."]);
  const logged = (await h.repository.list<ProcedureRecord>("procedure")).filter(
    (item) => item.record.episode_id === operated.episode.record.id
  );
  assert.equal(logged.length, 2);
  const episode = await h.repository.findById<EpisodeRecord>("episode", operated.episode.record.id);
  assert.equal(episode?.record.pathway, "discharge-ready", "the workflow is left as it was");
  assert.equal(
    root.findAll("button").filter((button) => /^Add another procedure — \u2068Case M/.test(button.getAttribute("aria-label") ?? "")).length,
    1,
    "offered once per episode, not on every logbook entry"
  );
});

test("the procedure Quick Entry picker labels an added procedure", async () => {
  const h = await harness();
  const operated = await h.service.createEpisode(
    episodeInput({ mrn: "9000800115", patientName: "Synthetic Mike", caseName: "Case P", pathway: "or-booking" })
  );
  await h.service.completeProcedure(
    procedureInput(operated.patient.record.id, operated.episode.record.id, "Synthetic septoplasty")
  );
  const { view } = await mountView(h, "today");
  await view.openProcedureQuickEntry();
  const picker = lastOpened(QuickEntryEpisodeModal);
  const choose = buttonNamed(picker.contentEl, /^Add another procedure to this episode: /);
  assert.equal(choose.textContent, "Add another procedure");
  assert.match(picker.contentEl.textContent, /A procedure is already logged here; this adds another\./);
  choose.dispatch("click");
  const modal = lastOpened(ProcedureModal);
  assert.equal(modal.contentEl.find("h2")?.textContent, "Add another procedure");
});

test("Add another procedure logs a same-name, same-day procedure as its own entry, once per form", async () => {
  const h = await harness();
  const operated = await h.service.createEpisode(
    episodeInput({
      mrn: "9000800117",
      patientName: "Synthetic Oscar",
      phone: "0500000000",
      caseName: "Case R",
      pathway: "or-booking"
    })
  );
  const episodeId = operated.episode.record.id;
  await h.service.completeProcedure(
    procedureInput(operated.patient.record.id, episodeId, "Synthetic excision of lesion")
  );
  const reviewDue = isoDateWithOffset(7, todayIso());
  await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "result-review",
    priority: "routine",
    nextAction: "Review histology",
    dueDate: reviewDue
  });
  const loggedCount = async () =>
    (await h.repository.list<ProcedureRecord>("procedure")).filter(
      (item) => item.record.episode_id === episodeId
    ).length;
  const assertEpisodeUntouched = async (label: string) => {
    const episode = (await h.repository.findById<EpisodeRecord>("episode", episodeId))!.record;
    assert.equal(episode.pathway, "result-review", `${label}: the pathway is left alone`);
    assert.equal(episode.next_action, "Review histology", `${label}: the next action is left alone`);
    assert.equal(episode.due_date, reviewDue, `${label}: the due date is left alone`);
  };

  // The first attempt writes the entry and then fails; the form stays open.
  const repo = h.repository as unknown as {
    update: (path: string, changes: Record<string, unknown>) => Promise<unknown>;
  };
  const realUpdate = repo.update.bind(h.repository);
  let armed = true;
  repo.update = async (path: string, changes: Record<string, unknown>) => {
    if (armed && path.includes("/Procedures/") && changes.audit_pending === false) {
      armed = false;
      throw new Error("Injected write failure (synthetic)");
    }
    return realUpdate(path, changes);
  };

  const { root, view } = await mountView(h, "surgery");
  buttonNamed(root, /^Add another procedure — \u2068Case R/).dispatch("click");
  const modal = lastOpened(ProcedureModal);
  await flush();
  type(field(modal.contentEl, "Surgery / procedure"), "Synthetic excision of lesion");
  const noticesBefore = StubNotice.history.length;
  submitButton(modal.contentEl).dispatch("click");
  const error = () => modal.contentEl.find(".clinical-modal-error");
  await waitFor(() => modal.closes === 1 || error()?.hidden === false, "the first attempt to settle");
  assert.equal(await loggedCount(), 2, "the first attempt wrote the second lesion's own entry");
  await assertEpisodeUntouched("first attempt");
  assert.equal(modal.closes, 0, "the injected failure keeps the form open to retry");

  // Retrying the same form completes that entry; it does not add another.
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "the retried procedure to be logged");
  assert.equal(noticeTexts(noticesBefore).at(-1), "Procedure added to the logbook.");
  assert.equal(await loggedCount(), 2, "the second lesion is its own logbook entry, written once");
  const entries = (await h.repository.list<ProcedureRecord>("procedure")).map((item) => item.record);
  assert.ok(entries.every((record) => record.audit_pending === false), "the retry settled the audit");
  await assertEpisodeUntouched("logbook");

  // Quick entry reaches the same form; a third lesion is a third entry.
  await view.openProcedureQuickEntry();
  const picker = lastOpened(QuickEntryEpisodeModal);
  buttonNamed(picker.contentEl, /^Add another procedure to this episode: /).dispatch("click");
  const quick = lastOpened(ProcedureModal);
  await flush();
  type(field(quick.contentEl, "Surgery / procedure"), "Synthetic excision of lesion");
  const quickNotices = StubNotice.history.length;
  submitButton(quick.contentEl).dispatch("click");
  await waitFor(() => quick.closes === 1, "the quick-entry procedure to be logged");
  assert.deepEqual(noticeTexts(quickNotices), ["Procedure added to the logbook."]);
  assert.equal(await loggedCount(), 3);
  await assertEpisodeUntouched("quick entry");
});

test("an Add another procedure form left open while its episode goes back on OR booking adds only its entry", async () => {
  const h = await harness();
  const operated = await h.service.createEpisode(
    episodeInput({
      mrn: "9000800118",
      patientName: "Synthetic Papa",
      phone: "0500000001",
      caseName: "Case S",
      pathway: "or-booking"
    })
  );
  const episodeId = operated.episode.record.id;
  await h.service.completeProcedure(
    procedureInput(operated.patient.record.id, episodeId, "Synthetic excision biopsy")
  );
  await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "result-review",
    priority: "routine",
    nextAction: "Review histology",
    dueDate: isoDateWithOffset(7, todayIso())
  });
  const { root } = await mountView(h, "surgery");
  buttonNamed(root, /^Add another procedure — \u2068Case S/).dispatch("click");
  const modal = lastOpened(ProcedureModal);
  await flush();
  type(field(modal.contentEl, "Surgery / procedure"), "Synthetic lymph node excision");

  // While the form is open, a return to theatre is booked.
  const bookingDue = isoDateWithOffset(3, todayIso());
  await h.service.updateEpisode(episodeId, {
    careSetting: "outpatient",
    pathway: "or-booking",
    priority: "routine",
    nextAction: "Book return to theatre",
    dueDate: bookingDue
  });
  const tasksBefore = await tasksOf(h, episodeId);

  const noticesBefore = StubNotice.history.length;
  submitButton(modal.contentEl).dispatch("click");
  const error = () => modal.contentEl.find(".clinical-modal-error");
  await waitFor(() => modal.closes === 1 || error()?.hidden === false, "the submission to settle");
  assert.equal(modal.closes, 1, "the form is not refused");
  assert.deepEqual(noticeTexts(noticesBefore), ["Procedure added to the logbook."]);
  assert.equal(
    (await h.repository.list<ProcedureRecord>("procedure")).filter((item) => item.record.episode_id === episodeId)
      .length,
    2,
    "the form added its own entry"
  );
  const episode = (await h.repository.findById<EpisodeRecord>("episode", episodeId))!.record;
  assert.equal(episode.pathway, "or-booking", "the new booking is not completed");
  assert.equal(episode.next_action, "Book return to theatre");
  assert.equal(episode.due_date, bookingDue);
  assert.deepEqual(await tasksOf(h, episodeId), tasksBefore, "the booking task stays open");
});

test("Complete surgery on a booking still logs with the plain key and moves the episode on", async () => {
  const h = await harness();
  const booked = await h.service.createEpisode(
    episodeInput({
      mrn: "9000800119",
      patientName: "Synthetic Quebec",
      phone: "0500000000",
      caseName: "Case T",
      pathway: "or-booking",
      nextAction: "Book theatre",
      dueDate: isoDateWithOffset(1, todayIso())
    })
  );
  const episodeId = booked.episode.record.id;
  const { root } = await mountView(h, "surgery");
  buttonNamed(root, /^Complete surgery — \u2068Case T/).dispatch("click");
  const modal = lastOpened(ProcedureModal);
  await flush();
  assert.equal(modal.contentEl.find("h2")?.textContent, "Complete surgery");
  type(field(modal.contentEl, "Surgery / procedure"), "Synthetic septoplasty");
  const noticesBefore = StubNotice.history.length;
  submitButton(modal.contentEl).dispatch("click");
  await waitFor(() => modal.closes === 1, "the surgery to be logged");
  assert.deepEqual(noticeTexts(noticesBefore), ["Surgery logged and workflow updated."]);
  const [logged] = (await h.repository.list<ProcedureRecord>("procedure")).map((item) => item.record);
  assert.equal(
    logged?.idempotency_key,
    procedureIdempotencyKey(episodeId, "Synthetic septoplasty", todayIso()),
    "Complete surgery carries no entry id"
  );
  const episode = (await h.repository.findById<EpisodeRecord>("episode", episodeId))!.record;
  assert.equal(episode.pathway, "discharge-ready");
  assert.equal(episode.status, "ready-to-close");
});

/* ------------------------------------------------------ 7. Restore ----- */

test("a refused restore shows the service's reason once, with no stack", async () => {
  const h = await harness();
  const first = await h.service.createEpisode(
    episodeInput({ mrn: "9000800116", patientName: "Synthetic November", caseName: "Case Q" })
  );
  await h.service.archiveEpisode(first.episode.record.id, "Discharged");
  await h.service.createEpisode(
    episodeInput({ mrn: "9000800116", patientName: "Synthetic November", caseName: "case q" })
  );
  const { root } = await mountView(h, "more");
  const noticesBefore = StubNotice.history.length;
  const restore = buttonNamed(root, /^Restore — /);
  restore.dispatch("click");
  await waitFor(() => StubNotice.history.length > noticesBefore, "the refusal notice");
  await flush();
  await flush();
  assert.deepEqual(noticeTexts(noticesBefore), ["An active episode for this case already exists. Open it instead."]);
  const episode = await h.repository.findById<EpisodeRecord>("episode", first.episode.record.id);
  assert.equal(episode?.record.status, "archived");
});
