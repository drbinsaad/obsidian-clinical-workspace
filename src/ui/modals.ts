import { App, Modal, Notice, Setting } from "obsidian";
import type {
  CareSetting,
  CompleteProcedureInput,
  EpisodeRecord,
  EpisodeUpdateInput,
  IntegrityIssue,
  MergePreview,
  NewEpisodeInput,
  NewTaskInput,
  PatientIdentityInput,
  PatientRecord,
  Pathway,
  Priority,
  TaskRecord,
  TaskType
} from "../domain/types";
import {
  CARE_SETTINGS,
  PATHWAYS,
  PRIORITIES,
  TASK_TYPES
} from "../domain/types";
import {
  careSettingLabel,
  displayMrn,
  displayPhone,
  pathwayLabel,
  priorityLabel,
  todayIso
} from "../domain/schema";

type AsyncSubmit<T> = (value: T) => Promise<void>;

const PATHWAY_OPTIONS = Object.fromEntries(
  PATHWAYS.map((value) => [value, pathwayLabel(value)])
) as Record<Pathway, string>;

const CARE_SETTING_OPTIONS = Object.fromEntries(
  CARE_SETTINGS.map((value) => [value, careSettingLabel(value)])
) as Record<CareSetting, string>;

const PRIORITY_OPTIONS = Object.fromEntries(
  PRIORITIES.map((value) => [value, priorityLabel(value)])
) as Record<Priority, string>;

const TASK_TYPE_OPTIONS = Object.fromEntries(
  TASK_TYPES.map((value) => [value, titleCase(value)])
) as Record<TaskType, string>;

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Obsidian's `Setting` renders its name as plain text with no `for`/`id` link
 * to the control, so screen readers announce the field as unlabelled. Naming
 * the control directly closes that gap.
 */
function labelControl(setting: Setting, name: string): Setting {
  const control = setting.settingEl.querySelector("input, select, textarea");
  if (control?.instanceOf(HTMLElement)) control.setAttribute("aria-label", name);
  return setting;
}

function namedSetting(container: HTMLElement, name: string): Setting {
  const setting = new Setting(container).setName(name);
  queueMicrotask(() => {
    labelControl(setting, name);
  });
  return setting;
}

/**
 * First-run/upgrade adoption is deliberately separate from Sync recovery. A
 * visible legacy record count is not proof that the rest of the workspace will
 * not arrive a moment later on another device.
 */
export class InitializeWorkspaceModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly hasManagedRecords: boolean,
    private readonly onDecision: (initialize: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", {
      text: this.hasManagedRecords
        ? "Adopt the current Clinical Workspace?"
        : "Initialize a new Clinical Workspace?",
      cls: "clinical-modal-heading"
    });
    this.contentEl.createEl("p", {
      text:
        this.hasManagedRecords
          ? "This older workspace has no trusted safety baseline yet. Continue only after synchronization is fully complete and the current records are known to be complete."
          : "No managed Clinical Workspace records or trusted safety baseline were found on this device. Continue only if this is a genuinely new or intentionally record-free workspace.",
      cls: "clinical-section-note"
    });
    this.contentEl.createEl("p", {
      text:
        "If this vault was already used on another device, cancel and wait for synchronization to finish or restore your backup. The confirmed current record count becomes the recovery baseline.",
      cls: "clinical-section-note"
    });
    const actions = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel — wait for synchronization" });
    cancel.addEventListener("click", () => this.finish(false));
    const initialize = actions.createEl("button", {
      text: this.hasManagedRecords ? "Adopt current workspace" : "Initialize new workspace",
      cls: "mod-cta"
    });
    initialize.addEventListener("click", () => this.finish(true));
    queueMicrotask(() => cancel.focus());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.onDecision(false);
    }
  }

  private finish(initialize: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(initialize);
    this.close();
  }
}

export abstract class ClinicalModal<T> extends Modal {
  private errorEl: HTMLElement | null = null;

  protected constructor(
    app: App,
    private readonly submitLabel: string,
    private readonly onSubmit: AsyncSubmit<T>
  ) {
    super(app);
  }

  protected abstract value(): T;

  protected addDateSetting(container: HTMLElement, label: string, value: string, onChange: (value: string) => void): void {
    namedSetting(container, label).addText((component) => {
      component.inputEl.type = "date";
      component.inputEl.setAttribute("aria-label", label);
      component.setValue(value).onChange(onChange);
    });
  }

  protected addActions(container: HTMLElement): void {
    // Announced to assistive technology when a submission fails.
    this.errorEl = container.createDiv({ cls: "clinical-modal-error", attr: { role: "alert", "aria-live": "assertive" } });
    this.errorEl.hide();
    const actions = container.createDiv({ cls: "clinical-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", {
      text: this.submitLabel,
      cls: "mod-cta"
    });
    submit.addEventListener("click", () => void this.handleSubmit(submit));
    this.contentEl.addEventListener("keydown", (event) => {
      const input = event.target as HTMLInputElement | null;
      if (event.key !== "Enter" || event.isComposing || input?.tagName !== "INPUT") return;
      if (!["text", "tel", "number", "search", "email", "url"].includes(input.type)) return;
      event.preventDefault();
      void this.handleSubmit(submit);
    });
    queueMicrotask(() => {
      const first = this.contentEl.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
      if (first?.instanceOf(HTMLElement)) first.focus();
    });
  }

  private async handleSubmit(button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    this.errorEl?.hide();
    try {
      await this.onSubmit(this.value());
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The clinical action could not be completed.";
      if (this.errorEl) {
        this.errorEl.setText(message);
        this.errorEl.show();
      }
      new Notice(message, 7000);
      button.disabled = false;
    }
  }

  protected prepare(title: string, description: string): HTMLElement {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: title, cls: "clinical-modal-heading" });
    this.contentEl.createEl("p", { text: description, cls: "clinical-section-note" });
    // Fields live in their own scrolling region so the action row can be a
    // fixed footer. Previously the row was sticky inside the whole modal, which
    // pinned it to the bottom of a container taller than the screen — landing
    // it mid-form, over the fields, on a phone.
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    return body.createDiv({ cls: "clinical-form-section" });
  }
}

export class NewEpisodeModal extends ClinicalModal<NewEpisodeInput> {
  private input: NewEpisodeInput = {
    mrn: "",
    patientName: "",
    phone: "",
    caseName: "",
    careSetting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    nextAction: "",
    // Seeded to today so the control is visible. An empty date input renders as
    // nothing at all on iOS, leaving "Due date" looking like a label with no
    // field. A date with no next action creates no task, so this is inert until
    // the clinician actually asks for something.
    dueDate: todayIso()
  };

  constructor(app: App, onSubmit: AsyncSubmit<NewEpisodeInput>, seed?: Partial<NewEpisodeInput>) {
    super(app, "Create patient episode", onSubmit);
    if (seed) this.input = { ...this.input, ...seed };
  }

  onOpen(): void {
    const form = this.prepare(
      "Add patient",
      "One form creates or reuses the patient identity, opens the episode, and adds the first task when supplied."
    );
    namedSetting(form, "MRN").setDesc("Numbers only; leading zeroes are preserved.").addText((field) => {
      field.setValue(this.input.mrn).setPlaceholder("MRN or leave blank").onChange((value) => (this.input.mrn = value));
      field.inputEl.inputMode = "numeric";
    });
    namedSetting(form, "Patient name").addText((field) => {
      field
        .setValue(this.input.patientName)
        .setPlaceholder("Required when MRN is missing")
        .onChange((value) => (this.input.patientName = value));
    });
    namedSetting(form, "Phone").setDesc("Leave blank to store NFN.").addText((field) => {
      field.setValue(this.input.phone).setPlaceholder("NFN").onChange((value) => (this.input.phone = value));
      field.inputEl.inputMode = "tel";
    });
    namedSetting(form, "Case / reason").addText((field) => {
      field
        .setValue(this.input.caseName)
        .setPlaceholder("E.g. Laryngomalacia follow-up")
        .onChange((value) => (this.input.caseName = value));
    });
    namedSetting(form, "Care setting").addDropdown((field) => {
      field.addOptions(CARE_SETTING_OPTIONS).setValue(this.input.careSetting).onChange((value) => {
        this.input.careSetting = value as CareSetting;
      });
    });
    namedSetting(form, "Pathway").addDropdown((field) => {
      field.addOptions(PATHWAY_OPTIONS).setValue(this.input.pathway).onChange((value) => {
        this.input.pathway = value as Pathway;
      });
    });
    namedSetting(form, "Priority").addDropdown((field) => {
      field.addOptions(PRIORITY_OPTIONS).setValue(this.input.priority).onChange((value) => {
        this.input.priority = value as Priority;
      });
    });
    namedSetting(form, "Next action").addText((field) => {
      field
        .setValue(this.input.nextAction)
        .setPlaceholder("What must happen next?")
        .onChange((value) => (this.input.nextAction = value));
    });
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => (this.input.dueDate = value));
    this.addActions(this.contentEl);
  }

  protected value(): NewEpisodeInput {
    return this.input;
  }
}

/**
 * Shown when a patient is being created without an MRN and an existing record
 * carries the same name. Without this step the two are silently kept apart.
 */
export class DuplicatePatientModal extends Modal {
  constructor(
    app: App,
    private readonly candidates: PatientRecord[],
    private readonly onChoose: (patientId: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Possible duplicate patient", cls: "clinical-modal-heading" });
    this.contentEl.createEl("p", {
      text: "No MRN was entered, and a patient with this name already exists. Choose an existing record or create a separate one.",
      cls: "clinical-section-note"
    });
    const list = this.contentEl.createDiv({ cls: "clinical-list" });
    for (const candidate of this.candidates) {
      const card = list.createDiv({ cls: "clinical-card" });
      card.createEl("h4", { text: candidate.patient_name || "Name not recorded" });
      card.createEl("p", { text: `MRN ${displayMrn(candidate.mrn)}`, cls: "clinical-card-meta" });
      card.createEl("p", { text: `Phone ${displayPhone(candidate.phone)}`, cls: "clinical-card-meta" });
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      const use = actions.createEl("button", { text: "Use this patient", cls: "clinical-card-button mod-cta" });
      use.addEventListener("click", () => {
        this.onChoose(candidate.id);
        this.close();
      });
    }
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const create = footer.createEl("button", { text: "Create separate patient", cls: "clinical-card-button" });
    create.addEventListener("click", () => {
      this.onChoose(null);
      this.close();
    });
  }
}

export class NewTaskModal extends ClinicalModal<NewTaskInput> {
  private input: NewTaskInput;
  private readonly patientLabel: string;

  constructor(
    app: App,
    private readonly episode: EpisodeRecord,
    patientLabel: string,
    onSubmit: AsyncSubmit<NewTaskInput>
  ) {
    super(app, "Add task", onSubmit);
    this.input = {
      patientId: episode.patient_id,
      episodeId: episode.id,
      task: "",
      taskType: "clinical-review",
      priority: episode.priority,
      dueDate: episode.due_date || todayIso(),
      owner: ""
    };
    this.patientLabel = patientLabel;
  }

  onOpen(): void {
    const form = this.prepare("Add patient task", `${this.patientLabel} · ${this.episode.case}`);
    namedSetting(form, "Task").addText((field) => {
      field.setPlaceholder("Action for the team").onChange((value) => (this.input.task = value));
    });
    namedSetting(form, "Task type").addDropdown((field) => {
      field.addOptions(TASK_TYPE_OPTIONS).setValue(this.input.taskType).onChange((value) => {
        this.input.taskType = value as TaskType;
      });
    });
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => (this.input.dueDate = value));
    namedSetting(form, "Priority").addDropdown((field) => {
      field.addOptions(PRIORITY_OPTIONS).setValue(this.input.priority).onChange((value) => {
        this.input.priority = value as Priority;
      });
    });
    namedSetting(form, "Owner").addText((field) => {
      field.setPlaceholder("Optional team member").onChange((value) => (this.input.owner = value));
    });
    this.addActions(this.contentEl);
  }

  protected value(): NewTaskInput {
    return this.input;
  }
}

export class UpdateEpisodeModal extends ClinicalModal<EpisodeUpdateInput> {
  private input: EpisodeUpdateInput;
  private readonly episode: EpisodeRecord;

  constructor(app: App, episode: EpisodeRecord, onSubmit: AsyncSubmit<EpisodeUpdateInput>) {
    super(app, "Save changes", onSubmit);
    this.episode = episode;
    this.input = {
      careSetting: episode.care_setting,
      pathway: episode.pathway,
      priority: episode.priority,
      nextAction: episode.next_action,
      dueDate: episode.due_date
    };
  }

  onOpen(): void {
    const form = this.prepare(
      "Update patient workflow",
      "Change Inpatient/Outpatient, pathway, priority and next action from one screen."
    );
    form.createEl("h3", { text: this.episode.case });
    namedSetting(form, "Care setting").addDropdown((field) => {
      field.addOptions(CARE_SETTING_OPTIONS).setValue(this.input.careSetting).onChange((value) => {
        this.input.careSetting = value as CareSetting;
      });
    });
    namedSetting(form, "Pathway").addDropdown((field) => {
      field.addOptions(PATHWAY_OPTIONS).setValue(this.input.pathway).onChange((value) => {
        this.input.pathway = value as Pathway;
      });
    });
    namedSetting(form, "Priority").addDropdown((field) => {
      field.addOptions(PRIORITY_OPTIONS).setValue(this.input.priority).onChange((value) => {
        this.input.priority = value as Priority;
      });
    });
    namedSetting(form, "Next action")
      .setDesc("A new task is added only when this changes.")
      .addText((field) => {
        field.setValue(this.input.nextAction).setPlaceholder("What must happen next?").onChange((value) => {
          this.input.nextAction = value;
        });
      });
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => (this.input.dueDate = value));
    this.addActions(this.contentEl);
  }

  protected value(): EpisodeUpdateInput {
    return this.input;
  }
}

export class PatientIdentityModal extends ClinicalModal<PatientIdentityInput> {
  private input: PatientIdentityInput;

  constructor(app: App, patient: PatientRecord, onSubmit: AsyncSubmit<PatientIdentityInput>) {
    super(app, "Save identity", onSubmit);
    this.input = {
      mrn: patient.mrn,
      patientName: patient.patient_name,
      phone: patient.phone
    };
  }

  onOpen(): void {
    const form = this.prepare(
      "Correct patient identity",
      "Fix an MRN, name or phone number recorded against this patient. Linked episode, task and procedure labels are updated automatically."
    );
    namedSetting(form, "MRN").setDesc("Numbers only; leading zeroes are preserved.").addText((field) => {
      field.setValue(this.input.mrn).setPlaceholder("MRN or leave blank").onChange((value) => (this.input.mrn = value));
      field.inputEl.inputMode = "numeric";
    });
    namedSetting(form, "Patient name").addText((field) => {
      field.setValue(this.input.patientName).onChange((value) => (this.input.patientName = value));
    });
    namedSetting(form, "Phone").addText((field) => {
      field.setValue(this.input.phone).setPlaceholder("NFN").onChange((value) => (this.input.phone = value));
      field.inputEl.inputMode = "tel";
    });
    this.addActions(this.contentEl);
  }

  protected value(): PatientIdentityInput {
    return this.input;
  }
}

/** Two-step merge: pick a surviving record, then confirm what will move. */
export class MergePatientsModal extends Modal {
  private targetId = "";
  private typedConfirmation = "";

  constructor(
    app: App,
    private readonly source: PatientRecord,
    private readonly candidates: PatientRecord[],
    private readonly preview: (targetId: string) => Promise<MergePreview>,
    private readonly onConfirm: (targetId: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Merge patient records", cls: "clinical-modal-heading" });
    this.contentEl.createEl("p", {
      text: "Every episode, task and procedure moves to the record you keep. Nothing is deleted: this record is marked entered-in-error and kept for audit.",
      cls: "clinical-section-note"
    });

    const form = this.contentEl.createDiv({ cls: "clinical-form-section" });
    form.createEl("h3", { text: "Merging away" });
    form.createEl("p", {
      text: `MRN ${displayMrn(this.source.mrn)} · ${this.source.patient_name || "Name not recorded"}`,
      cls: "clinical-card-meta"
    });

    const options: Record<string, string> = {};
    for (const candidate of this.candidates) {
      options[candidate.id] = `MRN ${displayMrn(candidate.mrn)} · ${candidate.patient_name || "Name not recorded"}`;
    }
    this.targetId = this.candidates[0]?.id ?? "";

    const summary = this.contentEl.createDiv({ cls: "clinical-card" });
    const refresh = async () => {
      summary.empty();
      if (!this.targetId) {
        summary.createEl("p", { text: "No other patient record is available to merge into.", cls: "clinical-card-meta" });
        return;
      }
      try {
        const result = await this.preview(this.targetId);
        summary.createEl("h4", { text: "This merge will move" });
        summary.createEl("p", { text: `${result.episodes} episode${result.episodes === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
        summary.createEl("p", { text: `${result.tasks} task${result.tasks === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
        summary.createEl("p", { text: `${result.procedures} procedure${result.procedures === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
      } catch (error) {
        summary.createEl("p", {
          text: error instanceof Error ? error.message : "Preview failed.",
          cls: "clinical-card-meta"
        });
      }
    };

    namedSetting(form, "Keep this record").addDropdown((field) => {
      field.addOptions(options).setValue(this.targetId).onChange((value) => {
        this.targetId = value;
        void refresh();
      });
    });
    namedSetting(form, "Type MERGE to confirm")
      .setDesc("The source record is retired for audit and every linked record is re-pointed.")
      .addText((field) => {
        field.setPlaceholder("MERGE").onChange((value) => (this.typedConfirmation = value));
      });
    void refresh();

    const errorEl = this.contentEl.createDiv({ cls: "clinical-modal-error", attr: { role: "alert", "aria-live": "assertive" } });
    errorEl.hide();
    const actions = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "Merge records", cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      void (async () => {
        if (!this.targetId) return;
        if (this.typedConfirmation.trim().toUpperCase() !== "MERGE") {
          errorEl.setText("Enter the confirmation word shown above.");
          errorEl.show();
          return;
        }
        confirm.disabled = true;
        errorEl.hide();
        try {
          await this.onConfirm(this.targetId);
          this.close();
        } catch (error) {
          errorEl.setText(error instanceof Error ? error.message : "The merge could not be completed.");
          errorEl.show();
          confirm.disabled = false;
        }
      })();
    });
    this.contentEl.addEventListener("keydown", (event) => {
      const input = event.target as HTMLInputElement | null;
      if (event.key !== "Enter" || event.isComposing || input?.tagName !== "INPUT") return;
      event.preventDefault();
      confirm.click();
    });
    queueMicrotask(() => {
      const first = this.contentEl.querySelector("select:not([disabled]), input:not([disabled])");
      if (first?.instanceOf(HTMLElement)) first.focus();
    });
  }
}

export class ArchiveEpisodeModal extends ClinicalModal<string> {
  private outcome = "Discharged";
  private typedConfirmation = "";
  private readonly episode: EpisodeRecord;
  private readonly requireConfirmation: boolean;

  constructor(
    app: App,
    episode: EpisodeRecord,
    onSubmit: AsyncSubmit<string>,
    requireConfirmation = false
  ) {
    super(app, "Archive episode", onSubmit);
    this.episode = episode;
    this.requireConfirmation = requireConfirmation;
  }

  onOpen(): void {
    const form = this.prepare(
      "Discharge and archive",
      "The record remains searchable and can be restored with its pathway and outcome intact. Open tasks must be completed or cancelled first."
    );
    form.createEl("h3", { text: this.episode.case });
    namedSetting(form, "Outcome / reason").addText((field) => {
      field.setValue(this.outcome).onChange((value) => (this.outcome = value));
    });
    if (this.requireConfirmation) {
      namedSetting(form, "Type DISCHARGE to confirm")
        .setDesc("Confirmation is enabled in Clinical Workspace settings.")
        .addText((field) => {
          field.setPlaceholder("DISCHARGE").onChange((value) => (this.typedConfirmation = value));
        });
    }
    this.addActions(this.contentEl);
  }

  protected value(): string {
    if (this.requireConfirmation && this.typedConfirmation.trim().toUpperCase() !== "DISCHARGE") {
      throw new Error("Type DISCHARGE to confirm, or turn the confirmation off in settings.");
    }
    return this.outcome;
  }
}

/** Lets an open task be closed without completing it, so discharge is never blocked. */
export class CancelTaskModal extends ClinicalModal<string> {
  private reason = "";
  private readonly task: TaskRecord;

  constructor(app: App, task: TaskRecord, onSubmit: AsyncSubmit<string>) {
    super(app, "Cancel task", onSubmit);
    this.task = task;
  }

  onOpen(): void {
    const form = this.prepare(
      "Cancel this task",
      "The task is closed without being marked complete, and stops blocking discharge. It stays in the record."
    );
    form.createEl("h3", { text: this.task.task });
    namedSetting(form, "Reason").addText((field) => {
      field.setPlaceholder("E.g. No longer required").onChange((value) => (this.reason = value));
    });
    this.addActions(this.contentEl);
  }

  protected value(): string {
    return this.reason;
  }
}

export class ProcedureModal extends ClinicalModal<CompleteProcedureInput> {
  private input: CompleteProcedureInput;
  private readonly episode: EpisodeRecord;
  private readonly patientLabel: string;

  constructor(
    app: App,
    episode: EpisodeRecord,
    patientLabel: string,
    onSubmit: AsyncSubmit<CompleteProcedureInput>
  ) {
    super(app, "Complete surgery", onSubmit);
    this.episode = episode;
    this.patientLabel = patientLabel;
    this.input = {
      patientId: episode.patient_id,
      episodeId: episode.id,
      // Left blank on purpose: the case name is the referral reason, not the
      // operation performed, and a logbook that defaults to it is worthless.
      procedure: "",
      procedureDate: todayIso(),
      role: "Primary surgeon",
      outcome: "",
      followUpRequired: false,
      followUpDate: "",
      followUpPlan: ""
    };
  }

  onOpen(): void {
    const form = this.prepare("Complete surgery", `${this.patientLabel} · ${this.episode.case}`);
    namedSetting(form, "Surgery / procedure")
      .setDesc("The operation performed, which may differ from the booked case.")
      .addText((field) => {
        field.setPlaceholder(this.episode.case).onChange((value) => (this.input.procedure = value));
      });
    this.addDateSetting(form, "Surgery date", this.input.procedureDate, (value) => {
      this.input.procedureDate = value;
    });
    namedSetting(form, "Your role").addDropdown((field) => {
      field
        .addOptions({
          "Primary surgeon": "Primary surgeon",
          "Assistant surgeon": "Assistant surgeon",
          Supervisor: "Supervisor",
          Observer: "Observer"
        })
        .setValue(this.input.role)
        .onChange((value) => (this.input.role = value));
    });
    namedSetting(form, "Outcome").addText((field) => {
      field.setPlaceholder("Optional short outcome").onChange((value) => (this.input.outcome = value));
    });
    let followUpFields: HTMLDivElement;
    namedSetting(form, "Follow-up required").addToggle((field) => {
      field.toggleEl.setAttribute("aria-label", "Follow-up required");
      field.setValue(this.input.followUpRequired).onChange((value) => {
        this.input.followUpRequired = value;
        followUpFields.hidden = !value;
      });
    });
    followUpFields = form.createDiv({ cls: "clinical-follow-up-fields" });
    followUpFields.hidden = !this.input.followUpRequired;
    this.addDateSetting(followUpFields, "Follow-up date", this.input.followUpDate, (value) => {
      this.input.followUpDate = value;
    });
    namedSetting(followUpFields, "Follow-up plan").addText((field) => {
      field.setPlaceholder("Required only when follow-up is on").onChange((value) => {
        this.input.followUpPlan = value;
      });
    });
    this.addActions(this.contentEl);
  }

  protected value(): CompleteProcedureInput {
    return this.input;
  }
}

/**
 * Renders integrity results in the interface. Previously these were written to
 * the developer console, which put MRNs somewhere users are asked to copy from.
 */
export class IntegrityReportModal extends Modal {
  constructor(
    app: App,
    private readonly issues: IntegrityIssue[],
    private readonly onOpenPath: (path: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Data integrity", cls: "clinical-modal-heading" });
    if (!this.issues.length) {
      this.contentEl.createEl("p", {
        text: "No duplicate MRNs, duplicate open tasks, broken links or invalid dates were found.",
        cls: "clinical-section-note"
      });
      return;
    }
    const errors = this.issues.filter((issue) => issue.severity === "error").length;
    this.contentEl.createEl("p", {
      text: `${this.issues.length} issue${this.issues.length === 1 ? "" : "s"} found (${errors} error${errors === 1 ? "" : "s"}). Open a record to correct it.`,
      cls: "clinical-section-note"
    });
    const list = this.contentEl.createDiv({ cls: "clinical-integrity-list" });
    for (const issue of this.issues) {
      const row = list.createDiv({ cls: "clinical-integrity-issue" });
      const head = row.createDiv({ cls: "clinical-card-top" });
      head.createEl("strong", { text: issue.message });
      head.createSpan({ text: issue.severity, cls: `clinical-badge is-${issue.severity === "error" ? "emergency" : "urgent"}` });
      row.createEl("p", { text: issue.recordId, cls: "clinical-card-meta" });
      const open = row.createEl("button", { text: "Open record", cls: "clinical-card-button" });
      open.addEventListener("click", () => {
        this.onOpenPath(issue.path);
        this.close();
      });
    }
  }
}

export function patientIdentityLabel(mrn: string, patientName: string): string {
  return `MRN ${displayMrn(mrn)} · ${patientName || "Name not recorded"}`;
}
