import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import { captureSeed, CaptureReviewModal } from "../src/ui/capture-modals";
import { NewTaskModal, ProcedureModal } from "../src/ui/modals";
import { parseCaptureDraft } from "../src/capture/drafts";
import { episodeInput, harness } from "./support/harness";
import { installTestDomGlobals, TestElement } from "./support/dom-harness";

installTestDomGlobals();
const source = (kind: string, extra = "", body = "Synthetic captured action") =>
  `---\nclinical_capture: 1\ncapture_kind: ${kind}\n${extra}---\n${body}`;

test("capture seeds only approved fields and leaves unstructured patient identity blank", () => {
  const seed = captureSeed(parseCaptureDraft(source("patient")));
  assert.equal(seed.patient.caseName, "Synthetic captured action");
  assert.equal(seed.patient.mrn, undefined);
  assert.equal(seed.patient.existingPatientId, undefined);
  assert.equal(seed.patient.forceNewPatient, undefined);
  const explicit = captureSeed(parseCaptureDraft(source("patient", 'mrn: "9000000101"\npatient_name: "Fictional Capture"\nphone: "0500000000"\n')));
  assert.equal(explicit.patient.mrn, "9000000101");
  assert.equal(explicit.patient.phone, "0500000000");
});

test("capture review cannot continue until the human confirmation is checked", () => {
  const item = { path: "Clinical Workspace/Inbox/Capture/demo.md", source: source("task"), draft: parseCaptureDraft(source("task")) };
  const modal = new CaptureReviewModal(new App(), item, async () => undefined) as unknown as {
    contentEl: TestElement; modalEl: TestElement; onOpen(): void; canSubmit(): boolean;
  };
  modal.contentEl = new TestElement();
  modal.modalEl = new TestElement();
  modal.onOpen();
  assert.equal(modal.canSubmit(), false);
  const toggle = modal.contentEl.findAll('[aria-label="I have reviewed this capture"]')[0];
  assert.ok(toggle);
  toggle.dispatch("click");
  assert.equal(modal.canSubmit(), true);
  assert.match(modal.contentEl.textContent, /one device/i);
  assert.match(modal.contentEl.textContent, /Synthetic captured action/);
});

test("a delayed surgery capture does not silently use the filing date as the operation date", () => {
  assert.equal(captureSeed(parseCaptureDraft(source("procedure"))).procedure.procedureDate, "");
  assert.equal(captureSeed(parseCaptureDraft(source("procedure", 'procedure_date: "2026-09-27"\n'))).procedure.procedureDate, "2026-09-27");
});

test("task and procedure prefill never changes the picker-selected relationship or retry identity", async () => {
  const h = await harness();
  const { episode } = await h.service.createEpisode(episodeInput());
  const task = new NewTaskModal(h.app as unknown as App, episode.record, "Fictional Capture", async () => undefined,
    { task: "Synthetic task", patientId: "PAT-wrong", episodeId: "EPI-wrong" } as never) as unknown as { value(): { task:string; patientId:string; episodeId:string } };
  assert.equal(task.value().task, "Synthetic task");
  assert.equal(task.value().patientId, episode.record.patient_id);
  assert.equal(task.value().episodeId, episode.record.id);
  const procedure = new ProcedureModal(h.app as unknown as App, episode.record, "Fictional Capture", async () => undefined,
    { additional: true, seed: { procedure: "Synthetic operation", patientId: "PAT-wrong", additionalEntryId: "BAD" } } as never) as unknown as { value(): { procedure:string; patientId:string; additionalEntryId:string } };
  assert.equal(procedure.value().procedure, "Synthetic operation");
  assert.equal(procedure.value().patientId, episode.record.patient_id);
  assert.match(procedure.value().additionalEntryId, /^ADD-/);
});
