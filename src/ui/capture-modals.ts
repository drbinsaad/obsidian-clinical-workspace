import { App, Setting } from "obsidian";
import type { CaptureDraft } from "../capture/drafts";
import type { CaptureItem } from "../capture/store";
import { canonicalOption } from "../domain/schema";
import { PRIORITIES, TASK_TYPES } from "../domain/types";
import type { CompleteProcedureInput, NewEpisodeInput, NewTaskInput } from "../domain/types";
import { ClinicalModal } from "./modals";
import type { OrBookingSeed } from "./or-booking-modal";

const KIND_LABELS = { patient: "Patient / episode", task: "Task / follow-up", procedure: "Surgery performed", "or-booking": "OR booking" };

/** Text is a suggestion, never relationship or workflow authority. */
export function captureSeed(draft: CaptureDraft): {
  patient: Partial<NewEpisodeInput>;
  task: Partial<Pick<NewTaskInput, "task" | "taskType" | "dueDate" | "priority">>;
  procedure: Partial<Pick<CompleteProcedureInput, "procedure" | "procedureDate" | "outcome">>;
  booking: OrBookingSeed;
} {
  const f = draft.fields;
  const body = draft.body.trim();
  // A long note is kept in full in the preview, not truncated into a clinical field.
  const text = body.length <= 2000 ? body : "";
  const priority = canonicalOption(f.priority ?? "", PRIORITIES);
  const taskType = canonicalOption(f.task_type ?? "", TASK_TYPES);
  return {
    patient: {
      caseName: f.case || text,
      ...(f.mrn ? { mrn: f.mrn } : {}),
      ...(f.patient_name ? { patientName: f.patient_name } : {}),
      ...(f.phone ? { phone: f.phone } : {}),
      ...(f.next_action ? { nextAction: f.next_action } : {}),
      ...(f.due_date ? { dueDate: f.due_date } : {}),
      ...(priority ? { priority } : {})
    },
    task: { task: f.task || text, ...(taskType ? { taskType } : {}), ...(f.due_date ? { dueDate: f.due_date } : {}), ...(priority ? { priority } : {}) },
    // Captures may be reviewed days later; filing day is not operation day.
    procedure: { procedure: f.procedure || text, procedureDate: f.procedure_date ?? "", ...(f.outcome ? { outcome: f.outcome } : {}) },
    booking: { nextAction: f.next_action || text, ...(f.due_date ? { dueDate: f.due_date } : {}), ...(priority ? { priority } : {}) }
  };
}

/** Browsing never marks a capture or invokes a clinical service. */
export class CaptureInboxModal extends ClinicalModal<void> {
  constructor(
    app: App,
    private readonly items: CaptureItem[],
    private readonly review: (item: CaptureItem) => void,
    private readonly openSource: (item: CaptureItem) => void,
    private readonly setup: () => Promise<void>,
    refresh: () => Promise<void>
  ) { super(app, "Refresh inbox", refresh); }

  onOpen(): void {
    const body = this.prepare("Capture inbox", "Native captures are drafts, not clinical records. Review and choose the patient inside Clinical Workspace before filing. Process a capture on one device, then let Sync finish before switching devices.");
    const setup = body.createEl("button", { text: "Set up native capture" });
    const setupStatus = body.createEl("p", { cls: "clinical-section-note", attr: { role: "status" } });
    setup.addEventListener("click", () => {
      setup.disabled = true;
      void this.setup().then(() => {
        setupStatus.setText("Capture folder and four templates are ready. Configure the iPhone widget locations using the capture folder and matching template inside your clinical folder. Existing templates were kept.");
      }).catch(() => { setupStatus.setText("Capture setup could not finish. Check that editing is available, then try again. Existing notes were kept."); })
        .finally(() => { setup.disabled = false; });
    });
    if (!this.items.length) body.createEl("p", { text: "No captures found. Choose new note and a capture template in each widget location. Do not capture directly into patient, task or procedure record folders." });
    for (const item of this.items) {
      const card = body.createDiv({ cls: "clinical-card" });
      const state = item.draft?.state;
      card.createEl("h3", { text: item.draft ? KIND_LABELS[item.draft.kind] : "Unrecognized capture" });
      card.createEl("p", { text: item.path.split("/").pop() ?? "Capture draft", cls: "clinical-section-note", attr: { dir: "auto" } });
      card.createEl("p", { text: state === "processing" ? "Needs review — filing may be incomplete" : state === "filed" ? "Filed" : state === "reviewed" ? "Manually reviewed" : item.error ? "Check the capture template" : "Ready to review", cls: "clinical-section-note" });
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      const open = actions.createEl("button", { text: "Open draft" });
      open.addEventListener("click", () => { this.close(); this.openSource(item); });
      if (state === "draft" || state === "processing") {
        const button = actions.createEl("button", { text: state === "draft" ? "Review capture" : "Review filing", cls: "mod-cta" });
        button.addEventListener("click", () => { this.close(); this.review(item); });
      }
    }
    if (this.items.length >= 200) body.createEl("p", { text: "Showing up to 200 captures. Move filed/reviewed drafts to an archive outside the capture inbox to make room; their receipts stay with them." });
    this.addActions(this.contentEl);
  }
  protected value(): void { /* Refresh is read-only. */ }
}

/** Explicit acknowledgment before moving from an untrusted draft to a form. */
export class CaptureReviewModal extends ClinicalModal<void> {
  private confirmed = false;
  protected returnSubmits = false;
  constructor(app: App, private readonly item: CaptureItem, onSubmit: () => Promise<void>) {
    super(app, item.draft?.state === "processing" ? "Mark reviewed" : "Choose clinical details", onSubmit);
  }
  onOpen(): void {
    const interrupted = this.item.draft?.state === "processing";
    const body = this.prepare(interrupted ? "Review interrupted filing" : "Review capture", interrupted
      ? "Some clinical records may already have been saved. Check the patient, tasks and logbook first. Mark reviewed does not create, undo or retry anything; it keeps this draft and closes this review."
      : "Check this draft, then choose and confirm the patient/episode in the form. No clinical record is saved until you submit that form. File on one device only and let Sync finish before switching devices.");
    body.createEl("pre", { text: this.item.source, cls: "clinical-capture-preview", attr: { dir: "auto" } });
    if ((this.item.draft?.body.trim().length ?? 0) > 2000) body.createEl("p", { text: "This long capture is preserved here in full. Enter a concise summary in the clinical form; it has not been truncated automatically." });
    const label = interrupted ? "I checked the records; mark reviewed" : "I have reviewed this capture";
    new Setting(body).setName(label).addToggle((toggle) => {
      toggle.toggleEl.setAttribute("aria-label", label);
      toggle.setValue(false).onChange((value) => { this.confirmed = value; this.syncSubmitState(); });
    });
    this.addActions(this.contentEl);
  }
  protected canSubmit(): boolean { return this.confirmed; }
  protected value(): void {
    if (!this.confirmed) throw new Error("Review the capture before continuing.");
  }
}
