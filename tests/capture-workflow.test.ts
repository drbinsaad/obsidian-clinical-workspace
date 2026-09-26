import assert from "node:assert/strict";
import test from "node:test";
import { Modal } from "obsidian";
import { CaptureStore } from "../src/capture/store";
import { parseCaptureDraft } from "../src/capture/drafts";
import { CaptureInboxModal, CaptureReviewModal } from "../src/ui/capture-modals";
import { BookOrModal } from "../src/ui/or-booking-modal";
import { MrnOwnerConflictModal, NewEpisodeModal, NewTaskModal, QuickEntryEpisodeModal } from "../src/ui/modals";
import { ClinicalWorkspaceView } from "../src/ui/workspace-view";
import type { EpisodeRecord, TaskRecord } from "../src/domain/types";
import { installTestDomGlobals, TestElement } from "./support/dom-harness";
import { episodeInput, harness } from "./support/harness";
import { Notice as StubNotice } from "./support/obsidian-stub";

installTestDomGlobals();
type Mounted = { contentEl: TestElement; modalEl: TestElement; closes: number; onOpen(): void; onClose?(): void; close(): void };
const opened: Mounted[] = [];
const proto = Modal.prototype as unknown as { open(this: Mounted): void; close(this: Mounted): void };
proto.open = function () {
  this.contentEl = new TestElement();
  (this.contentEl as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: null };
  this.modalEl = new TestElement(); this.closes = 0; opened.push(this); this.onOpen();
};
proto.close = function () { this.closes += 1; this.onClose?.(); };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (condition()) return; await flush(); }
  assert.fail("UI operation did not settle");
}
function last(klass: abstract new (...args: never[]) => unknown): Mounted {
  const item = [...opened].reverse().find((candidate) => candidate instanceof klass);
  assert.ok(item); return item;
}
function button(modal: Mounted, pattern: RegExp): TestElement {
  const found = modal.contentEl.findAll("button").find((item) => pattern.test(item.getAttribute("aria-label") ?? item.textContent));
  assert.ok(found, String(pattern)); return found;
}
function submit(modal: Mounted): void {
  const found = modal.contentEl.find(".clinical-modal-actions")?.findAll("button").find((item) => item.classes.has("mod-cta"));
  assert.ok(found); found.dispatch("click");
}
function input(modal: Mounted, name: string, value: string): void {
  const field = modal.contentEl.findAll(`[aria-label="${name}"]`).find((item) => item.tagName === "INPUT");
  assert.ok(field); field.value = value; field.dispatch("input");
}
async function setup(kind: string, body = "Synthetic captured action", fields = "") {
  opened.length = 0;
  const h = await harness();
  const created = await h.service.createEpisode(episodeInput({ mrn: "9000009201", patientName: "Synthetic Alpha", phone: "0500000000" }));
  const view = new ClinicalWorkspaceView({} as never, h.repository, h.service, h.integrity);
  Object.assign(view, { app: h.app, refresh: async () => undefined });
  const store = new CaptureStore(h.app as never, h.repository);
  await store.setup();
  const source = `---\nclinical_capture: 1\ncapture_kind: "${kind}"\n${fields}---\n${body}`;
  const file = await h.app.vault.create("Clinical Workspace/Inbox/Capture/synthetic.md", source);
  return { ...h, view, store, created, file, source, state: async () => parseCaptureDraft(await h.app.vault.read(file)) };
}
async function review(view: ClinicalWorkspaceView): Promise<void> {
  await view.openCaptureInbox();
  button(last(CaptureInboxModal), /^Review capture$/).dispatch("click");
  await until(() => opened.some((item) => item instanceof CaptureReviewModal));
}
async function confirmReview(): Promise<void> {
  const modal = last(CaptureReviewModal);
  const toggle = modal.contentEl.find('[aria-label="I have reviewed this capture"]');
  assert.ok(toggle); toggle.dispatch("click"); submit(modal);
  await until(() => modal.closes > 0);
}
function choose(): void { button(last(QuickEntryEpisodeModal), /^Use this episode/).dispatch("click"); }

test("capture browsing and cancelling review do not claim or write clinical records", async () => {
  const h = await setup("task");
  await review(h.view);
  button(last(CaptureReviewModal), /^Cancel$/).dispatch("click");
  assert.equal(await h.app.vault.read(h.file), h.source);
  assert.equal((await h.repository.list("task")).length, 0);
  assert.equal((await h.repository.list("episode")).length, 1);
});

test("a deleted or moved capture opens nothing and reports a generic notice", async () => {
  for (const change of ["deleted", "moved"] as const) {
    const h = await setup("task");
    let openedFiles = 0; let resolvedLinks = 0;
    Object.assign(h.app, { workspace: {
      openLinkText: async () => { resolvedLinks++; },
      getLeaf: () => ({ openFile: async () => { openedFiles++; } })
    } });
    await h.view.openCaptureInbox();
    const notices = StubNotice.history.length;
    if (change === "deleted") h.app.vault.deleteRaw(h.file.path);
    else h.app.vault.renameRaw(h.file.path, "Clinical Workspace/Inbox/Capture/moved-synthetic.md");
    button(last(CaptureInboxModal), /^Open draft$/).dispatch("click");
    await flush();
    assert.equal(resolvedLinks, 0, "must not use link resolution or offer creating a note");
    assert.equal(openedFiles, 0);
    const messages = StubNotice.history.slice(notices).map((notice) => String(notice.message));
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /draft.*available|could not open/i);
    assert.doesNotMatch(messages.join(" "), /synthetic|9000|Inbox|Capture\//);
  }
});

test("capture task needs explicit episode choice, validates before claim, then stores task receipt", async () => {
  const h = await setup("task", "Synthetic captured action", 'due_date: "2027-01-01"\n');
  await review(h.view); await confirmReview();
  assert.ok(last(QuickEntryEpisodeModal));
  assert.equal(opened.some((item) => item instanceof NewTaskModal), false);
  assert.equal((await h.state()).state, "draft");
  choose(); await flush();
  const form = last(NewTaskModal);
  assert.equal(form.contentEl.find('[aria-label="Task"]')?.value, "Synthetic captured action");
  assert.equal(form.contentEl.find('[aria-label="Due date"]')?.value, "2027-01-01");
  input(form, "Task", " "); submit(form); await flush();
  assert.equal((await h.state()).state, "draft");
  assert.equal((await h.repository.list("task")).length, 0);
  input(form, "Task", "Synthetic reviewed task"); submit(form);
  await until(() => form.closes > 0);
  const tasks = await h.repository.list<TaskRecord>("task"); assert.equal(tasks.length, 1); assert.ok(tasks[0]);
  assert.equal(tasks[0].record.patient_id, h.created.patient.record.id);
  assert.equal(tasks[0].record.episode_id, h.created.episode.record.id);
  assert.equal((await h.state()).result, `Task ${tasks[0].record.id}`);
  assert.equal((await h.state()).state, "filed");
});

test("uncertain capture save remains processing and reopening offers review without retry", async () => {
  const h = await setup("task");
  const real = h.service.createTask.bind(h.service); let calls = 0;
  h.service.createTask = async (value) => { calls++; await real(value); throw new Error("Synthetic partial persistence"); };
  await review(h.view); await confirmReview(); choose();
  const form = last(NewTaskModal); submit(form);
  await until(() => form.contentEl.textContent.includes("Filing may be incomplete"));
  assert.equal((await h.state()).state, "processing"); assert.equal(calls, 1);
  submit(form); await flush(); assert.equal(calls, 1);
  form.close(); await h.view.openCaptureInbox();
  button(last(CaptureInboxModal), /^Review filing$/).dispatch("click");
  await until(() => last(CaptureReviewModal).contentEl.textContent.includes("interrupted filing"));
  const recovery = last(CaptureReviewModal);
  const toggle = recovery.contentEl.find('[aria-label="I checked the records; mark reviewed"]'); assert.ok(toggle);
  toggle.dispatch("click"); submit(recovery); await until(() => recovery.closes > 0);
  assert.equal((await h.state()).state, "reviewed"); assert.equal(calls, 1);
  assert.equal((await h.repository.list("task")).length, 1);
});

test("patient capture MRN conflict rolls back exactly and the confirmation files under stored owner", async () => {
  const h = await setup("patient", "Synthetic second episode", 'mrn: "9000009201"\npatient_name: "Synthetic Bravo"\nphone: "0500000000"\n');
  await review(h.view); await confirmReview();
  const form = last(NewEpisodeModal); submit(form);
  await until(() => opened.some((item) => item instanceof MrnOwnerConflictModal));
  assert.equal(await h.app.vault.read(h.file), h.source);
  button(last(MrnOwnerConflictModal), /^Go back and check the MRN$/).dispatch("click");
  await until(() => form.contentEl.textContent.includes("Nothing was saved"));
  assert.equal(await h.app.vault.read(h.file), h.source);
  assert.equal((await h.repository.list("episode")).length, 1);
  const questions = opened.filter((item) => item instanceof MrnOwnerConflictModal).length;
  submit(form);
  await until(() => opened.filter((item) => item instanceof MrnOwnerConflictModal).length > questions);
  button(last(MrnOwnerConflictModal), /^Use this patient/).dispatch("click");
  await until(() => form.closes > 0);
  assert.equal((await h.state()).state, "filed");
  assert.equal((await h.repository.list("patient")).length, 1);
  assert.equal((await h.repository.list<EpisodeRecord>("episode")).length, 2);
  assert.ok((await h.state()).result?.includes(h.created.patient.record.id));
});

test("OR capture selects identity explicitly and files planned work without a procedure", async () => {
  const h = await setup("or-booking", "Synthetic booking", 'due_date: "2027-02-01"\n');
  await review(h.view); await confirmReview();
  assert.equal(opened.some((item) => item instanceof BookOrModal), false);
  choose(); const form = last(BookOrModal);
  assert.match(form.contentEl.textContent, /9000009201/); assert.match(form.contentEl.textContent, /Synthetic Alpha/);
  submit(form); await until(() => form.closes > 0);
  assert.equal((await h.state()).state, "filed");
  assert.equal((await h.repository.list("procedure")).length, 0);
  const episode = await h.repository.findById<EpisodeRecord>("episode", h.created.episode.record.id);
  assert.equal(episode?.record.pathway, "or-booking");
});
