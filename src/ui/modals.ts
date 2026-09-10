import { App, Modal, Setting } from "obsidian";
import type {
  CareSetting,
  CompleteProcedureInput,
  EpisodeRecord,
  EpisodeUpdateInput,
  EventRecord,
  IntegrityIssue,
  MergePreview,
  NewEpisodeInput,
  NewTaskInput,
  PatientIdentityInput,
  PatientRecord,
  Pathway,
  Priority,
  ProcedureRecord,
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
  isoDateWithOffset,
  pathwayLabel,
  priorityLabel,
  taskIsOpen,
  todayIso
} from "../domain/schema";
import type { TaskBundle } from "../data/templates";
import type { QuickEntryAction } from "../quick-entry";
import { showClinicalNotice } from "./notices";

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

export interface ClinicalModalViewportLayout {
  height: number;
  keyboardOpen: boolean;
  shift: number;
}

export const CLINICAL_MODAL_VIEWPORT_SYNC_DELAYS = [0, 60, 180, 420] as const;

export interface ClinicalModalViewportMetrics {
  innerHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
  keyboardHeight: number;
}

export interface ClinicalModalViewportHost {
  readMetrics: () => ClinicalModalViewportMetrics;
  applyLayout: (layout: ClinicalModalViewportLayout) => void;
  resetLayout: () => void;
  revealFocusedControl: () => void;
  onViewportResize: (listener: () => void) => () => void;
  onViewportScroll: (listener: () => void) => () => void;
  onWindowResize: (listener: () => void) => () => void;
  onFocusIn: (listener: () => void) => () => void;
  setTimer: (listener: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
}

export function calculateClinicalModalViewportLayout(
  innerHeight: number,
  viewportHeight: number,
  viewportOffsetTop = 0,
  keyboardHeight = 0
): ClinicalModalViewportLayout {
  const safeInnerHeight = Number.isFinite(innerHeight) ? Math.max(1, innerHeight) : 1;
  const safeOffsetTop = Number.isFinite(viewportOffsetTop)
    ? Math.max(0, Math.min(viewportOffsetTop, safeInnerHeight - 1))
    : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight)
    ? Math.max(1, Math.min(viewportHeight, safeInnerHeight - safeOffsetTop))
    : safeInnerHeight - safeOffsetTop;
  const safeKeyboardHeight = Number.isFinite(keyboardHeight)
    ? Math.max(0, Math.min(keyboardHeight, safeInnerHeight - 1))
    : 0;
  const visibleBottom = Math.max(
    safeOffsetTop + 1,
    Math.min(safeOffsetTop + safeViewportHeight, safeInnerHeight - safeKeyboardHeight)
  );
  const visibleHeight = visibleBottom - safeOffsetTop;
  return {
    height: Math.round(visibleHeight),
    keyboardOpen: safeKeyboardHeight > 100 || safeInnerHeight - safeViewportHeight > 100,
    shift: Math.round(safeOffsetTop + visibleHeight / 2 - safeInnerHeight / 2)
  };
}

/**
 * Owns the iOS keyboard/viewport lifecycle without depending on Obsidian DOM
 * classes. Keeping this boundary executable in tests prevents a future modal
 * refactor from silently dropping the last keyboard-animation checkpoint or
 * leaking listeners after close.
 */
export class ClinicalModalViewportController {
  private cleanupListeners: Array<() => void> = [];
  private timers: number[] = [];
  private running = false;

  constructor(private readonly host: ClinicalModalViewportHost) {}

  private readonly sync = (): void => {
    if (!this.running) return;
    const metrics = this.host.readMetrics();
    this.host.applyLayout(calculateClinicalModalViewportLayout(
      metrics.innerHeight,
      metrics.viewportHeight,
      metrics.viewportOffsetTop,
      metrics.keyboardHeight
    ));
    this.host.revealFocusedControl();
  };

  private readonly handleFocus = (): void => {
    this.schedule();
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cleanupListeners = [
      this.host.onViewportResize(this.sync),
      this.host.onViewportScroll(this.sync),
      this.host.onWindowResize(this.sync),
      this.host.onFocusIn(this.handleFocus)
    ];
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const cleanup of this.cleanupListeners) cleanup();
    this.cleanupListeners = [];
    this.clearTimers();
    this.host.resetLayout();
  }

  private clearTimers(): void {
    for (const timer of this.timers) this.host.clearTimer(timer);
    this.timers = [];
  }

  private schedule(): void {
    if (!this.running) return;
    this.clearTimers();
    this.timers = CLINICAL_MODAL_VIEWPORT_SYNC_DELAYS.map((delay) =>
      this.host.setTimer(this.sync, delay)
    );
  }
}

abstract class ClinicalResponsiveModal extends Modal {
  private viewportController: ClinicalModalViewportController | null = null;

  open(): void {
    super.open();
    this.modalEl.addClass("clinical-modal");
    this.bindViewportLayout();
  }

  close(): void {
    this.viewportController?.stop();
    this.viewportController = null;
    super.close();
  }

  private bindViewportLayout(): void {
    const viewWindow = this.contentEl.ownerDocument.defaultView;
    if (!viewWindow) return;
    const listen = (target: EventTarget | null, type: string, listener: () => void): (() => void) => {
      if (!target) return () => undefined;
      const handler = () => listener();
      target.addEventListener(type, handler);
      return () => target.removeEventListener(type, handler);
    };
    this.viewportController = new ClinicalModalViewportController({
      readMetrics: () => {
        const viewport = viewWindow.visualViewport;
        const keyboardHeight = Number.parseFloat(
          viewWindow.getComputedStyle(this.modalEl).getPropertyValue("--keyboard-height")
        );
        return {
          innerHeight: viewWindow.innerHeight,
          viewportHeight: viewport?.height ?? viewWindow.innerHeight,
          viewportOffsetTop: viewport?.offsetTop ?? 0,
          keyboardHeight
        };
      },
      applyLayout: (layout) => {
        this.modalEl.style.setProperty("--clinical-modal-visual-height", `${layout.height}px`);
        this.modalEl.style.setProperty("--clinical-modal-visual-shift", `${layout.shift}px`);
        this.modalEl.toggleClass("is-virtual-keyboard-open", layout.keyboardOpen);
      },
      resetLayout: () => {
        this.modalEl.style.removeProperty("--clinical-modal-visual-height");
        this.modalEl.style.removeProperty("--clinical-modal-visual-shift");
        this.modalEl.removeClass("is-virtual-keyboard-open");
      },
      revealFocusedControl: () => {
        const target = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
        if (!target || !this.contentEl.contains(target) || typeof target.scrollIntoView !== "function") return;
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      },
      onViewportResize: (listener) => listen(viewWindow.visualViewport, "resize", listener),
      onViewportScroll: (listener) => listen(viewWindow.visualViewport, "scroll", listener),
      onWindowResize: (listener) => listen(viewWindow, "resize", listener),
      onFocusIn: (listener) => listen(this.contentEl, "focusin", listener),
      setTimer: (listener, delay) => viewWindow.setTimeout(listener, delay),
      clearTimer: (timer) => viewWindow.clearTimeout(timer)
    });
    this.viewportController.start();
  }
}

/**
 * First-run/upgrade adoption is deliberately separate from Sync recovery. A
 * visible legacy record count is not proof that the rest of the workspace will
 * not arrive a moment later on another device.
 */
export class InitializeWorkspaceModal extends ClinicalResponsiveModal {
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
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", {
      text: this.hasManagedRecords
        ? "Adopt the current Clinical Workspace?"
        : "Initialize a new Clinical Workspace?",
      cls: "clinical-modal-heading"
    });
    body.createEl("p", {
      text:
        this.hasManagedRecords
          ? "This older workspace has no trusted safety baseline yet. Continue only after synchronization is fully complete and the current records are known to be complete."
          : "No managed Clinical Workspace records or trusted safety baseline were found on this device. Continue only if this is a genuinely new or intentionally record-free workspace.",
      cls: "clinical-section-note"
    });
    body.createEl("p", {
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

type QuickEntryFormAction = Exclude<QuickEntryAction, "hub">;

const QUICK_ENTRY_OPTIONS: ReadonlyArray<{
  action: QuickEntryFormAction;
  label: string;
  description: string;
}> = [
  {
    action: "new-patient-episode",
    label: "New patient / episode",
    description: "Open a blank patient and episode form."
  },
  {
    action: "add-task-follow-up",
    label: "Add task / follow-up",
    description: "Choose an episode, then add a task."
  },
  {
    action: "record-procedure",
    label: "Record procedure",
    description: "Choose an episode, then log a procedure."
  },
  {
    action: "today",
    label: "Today's pending work",
    description: "Open overdue, due-today, and undated work."
  }
];

/** A context-free entry hub used by commands, touch controls, and safe URIs. */
export class QuickEntryModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly onChoose: (action: QuickEntryFormAction) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.modalEl.addClass("clinical-quick-entry-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Quick entry", cls: "clinical-modal-heading" });
    this.contentEl.createEl("p", {
      text: "Choose an action. Patient details and clinical text are entered only inside Clinical Workspace.",
      cls: "clinical-section-note"
    });
    const actions = this.contentEl.createDiv({ cls: "clinical-quick-entry-grid" });
    for (const option of QUICK_ENTRY_OPTIONS) {
      const button = actions.createEl("button", {
        cls: "clinical-quick-entry-option",
        attr: { type: "button" }
      });
      button.createEl("strong", { text: option.label });
      button.createSpan({ text: option.description, cls: "clinical-section-note" });
      button.addEventListener("click", () => {
        this.close();
        this.onChoose(option.action);
      });
    }
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    queueMicrotask(() => {
      const first = actions.querySelector("button");
      if (first?.instanceOf(HTMLElement)) first.focus();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface QuickEntryEpisodeChoice {
  episode: EpisodeRecord;
  patientLabel: string;
  isCurrent: boolean;
}

/**
 * Wraps user-entered text in first-strong isolates (FSI…PDI) so an Arabic
 * name or case label cannot visually reorder the LTR template around it.
 * Display-time only; persisted values never carry these controls.
 */
export function bidiIsolate(value: string): string {
  return value ? `\u2068${value}\u2069` : value;
}

export function episodeChoiceAccessibleLabel(
  actionLabel: string,
  choice: QuickEntryEpisodeChoice
): string {
  const action = choice.isCurrent ? "Confirm current episode" : "Use this episode";
  const episode = choice.episode.case ? bidiIsolate(choice.episode.case) : "Case not recorded";
  return `${action} for ${actionLabel}: ${episode}; ${choice.patientLabel}; episode ${choice.episode.id}`;
}

/**
 * Explicit context gate for task and procedure shortcuts. Nothing is selected
 * by default and no clinical write occurs here; the user must choose a visibly
 * labelled episode before the blank action form opens.
 */
export class QuickEntryEpisodeModal extends ClinicalResponsiveModal {
  private query = "";
  private resultsEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly actionLabel: string,
    private readonly choices: readonly QuickEntryEpisodeChoice[],
    private readonly onChoose: (choice: QuickEntryEpisodeChoice) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body clinical-episode-picker-body" });
    body.createEl("h2", {
      text: "Choose episode",
      cls: "clinical-modal-heading"
    });
    body.createEl("p", {
      text: `For ${this.actionLabel}, confirm the patient and episode below. The shortcut never chooses or attaches a record automatically.`,
      cls: "clinical-section-note"
    });
    const search = body.createEl("input", {
      cls: "clinical-quick-entry-search",
      attr: {
        type: "search",
        placeholder: "Search visible patient or case",
        "aria-label": "Search active patient episodes",
        autocomplete: "off"
      }
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderChoices();
    });
    this.countEl = body.createDiv({
      cls: "clinical-section-note",
      attr: { "aria-live": "polite" }
    });
    this.resultsEl = body.createDiv({ cls: "clinical-quick-entry-results" });
    this.renderChoices();
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    queueMicrotask(() => search.focus());
  }

  onClose(): void {
    this.query = "";
    this.resultsEl = null;
    this.countEl = null;
    this.contentEl.empty();
  }

  private renderChoices(): void {
    if (!this.resultsEl || !this.countEl) return;
    const query = this.query.trim().toLocaleLowerCase();
    const matching = this.choices.filter((choice) => {
      if (!query) return true;
      return `${choice.patientLabel} ${choice.episode.case}`.toLocaleLowerCase().includes(query);
    });
    const visible = matching.slice(0, 40);
    this.countEl.setText(
      matching.length > visible.length
        ? `${matching.length} matches · showing the first ${visible.length}`
        : `${matching.length} matching active episode${matching.length === 1 ? "" : "s"}`
    );
    this.resultsEl.empty();
    if (!visible.length) {
      this.resultsEl.createEl("p", {
        text: "No active episode matches this search.",
        cls: "clinical-empty"
      });
      return;
    }
    for (const choice of visible) {
      const card = this.resultsEl.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: choice.episode.case || "Case not recorded" });
      if (choice.isCurrent) {
        top.createSpan({ text: "Current episode", cls: "clinical-badge is-current" });
      }
      card.createEl("p", { text: choice.patientLabel, cls: "clinical-card-meta" });
      card.createEl("p", {
        text: `${careSettingLabel(choice.episode.care_setting)} · ${pathwayLabel(choice.episode.pathway)}`,
        cls: "clinical-card-meta"
      });
      const choose = card.createEl("button", {
        text: choice.isCurrent ? "Confirm current episode" : "Use this episode",
        cls: "clinical-card-button mod-cta",
        attr: {
          type: "button",
          "aria-label": episodeChoiceAccessibleLabel(this.actionLabel, choice)
        }
      });
      choose.addEventListener("click", () => {
        this.close();
        this.onChoose(choice);
      });
    }
  }
}

/**
 * A dropdown can only display values it offers. Seeding it with an
 * unrecognised frontmatter value makes it SHOW the first option while the
 * form still SUBMITS the invalid one — the user approves a value they never
 * saw. The seed is folded to a valid option so display and write agree.
 */
function seedOption<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export abstract class ClinicalModal<T> extends ClinicalResponsiveModal {
  private errorEl: HTMLElement | null = null;
  private cancelEl: HTMLButtonElement | null = null;
  private submitting = false;

  protected constructor(
    app: App,
    private readonly submitLabel: string,
    private readonly onSubmit: AsyncSubmit<T>
  ) {
    super(app);
  }

  close(): void {
    // Escape or a backdrop tap during an in-flight submit would let the
    // modal report cancellation while the clinical write completes anyway.
    // The submit settles within moments and then decides: close on success,
    // stay open with the error on failure.
    if (this.submitting) return;
    super.close();
  }

  protected abstract value(): T;

  protected addDateSetting(
    container: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    quickOffsets = false
  ): void {
    let dateInput: HTMLInputElement | null = null;
    namedSetting(container, label).addText((component) => {
      component.inputEl.type = "date";
      component.inputEl.setAttribute("aria-label", label);
      component.setValue(value).onChange(onChange);
      dateInput = component.inputEl;
    });
    if (!quickOffsets) return;
    // Interval chips: clinicians think in "see again in two weeks", and
    // typing a date is the slowest input in the form on a phone.
    const chips = container.createDiv({ cls: "clinical-date-chips" });
    const offsets: ReadonlyArray<[string, number, string]> = [
      ["+1w", 7, "one week from today"],
      ["+2w", 14, "two weeks from today"],
      ["+1m", 30, "one month from today"],
      ["+3m", 90, "three months from today"]
    ];
    for (const [chipLabel, days, description] of offsets) {
      const chip = chips.createEl("button", {
        text: chipLabel,
        cls: "clinical-chip",
        attr: { type: "button", "aria-label": `Set ${label.toLocaleLowerCase()} ${description}` }
      });
      chip.addEventListener("click", () => {
        const next = isoDateWithOffset(days);
        if (dateInput) dateInput.value = next;
        onChange(next);
      });
    }
  }

  protected addActions(container: HTMLElement): void {
    // Announced to assistive technology when a submission fails.
    this.errorEl = container.createDiv({ cls: "clinical-modal-error", attr: { role: "alert", "aria-live": "assertive" } });
    this.errorEl.hide();
    const actions = container.createDiv({ cls: "clinical-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    this.cancelEl = cancel;
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
    this.submitting = true;
    if (this.cancelEl) this.cancelEl.disabled = true;
    this.errorEl?.hide();
    try {
      await this.onSubmit(this.value());
      this.submitting = false;
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The clinical action could not be completed.";
      if (this.errorEl) {
        this.errorEl.setText(message);
        this.errorEl.show();
      }
      showClinicalNotice(message, 7000);
      this.submitting = false;
      if (this.cancelEl) this.cancelEl.disabled = false;
      button.disabled = false;
    }
  }

  protected prepare(title: string, description: string): HTMLElement {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    // Fields live in their own scrolling region so the action row can be a
    // fixed footer. Previously the row was sticky inside the whole modal, which
    // pinned it to the bottom of a container taller than the screen — landing
    // it mid-form, over the fields, on a phone.
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: title, cls: "clinical-modal-heading" });
    body.createEl("p", { text: description, cls: "clinical-section-note" });
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
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => (this.input.dueDate = value), true);
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
export class DuplicatePatientModal extends ClinicalResponsiveModal {
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
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Possible duplicate patient", cls: "clinical-modal-heading" });
    body.createEl("p", {
      text: "No MRN was entered, and a patient with this name already exists. Choose an existing record or create a separate one.",
      cls: "clinical-section-note"
    });
    const list = body.createDiv({ cls: "clinical-list" });
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
      priority: seedOption(episode.priority, PRIORITIES, "routine"),
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
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => (this.input.dueDate = value), true);
    namedSetting(form, "Priority").addDropdown((field) => {
      field.addOptions(PRIORITY_OPTIONS).setValue(this.input.priority).onChange((value) => {
        this.input.priority = value as Priority;
      });
    });
    namedSetting(form, "Repeat")
      .setDesc("Completing the task schedules the next occurrence; cancelling stops the series.")
      .addDropdown((field) => {
        field
          .addOptions({
            "0": "No repeat",
            "7": "Weekly",
            "14": "Every 2 weeks",
            "30": "Monthly",
            "90": "Every 3 months",
            "180": "Every 6 months",
            "365": "Yearly"
          })
          .setValue(String(this.input.repeatEveryDays ?? 0))
          .onChange((value) => {
            this.input.repeatEveryDays = Number(value) || 0;
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

/** Moves an open task to a new date without the cancel-and-recreate dance. */
export class RescheduleTaskModal extends ClinicalModal<string> {
  private dueDate: string;
  private readonly task: TaskRecord;

  constructor(app: App, task: TaskRecord, onSubmit: AsyncSubmit<string>) {
    super(app, "Reschedule", onSubmit);
    this.task = task;
    this.dueDate = task.due_date || todayIso();
  }

  onOpen(): void {
    const form = this.prepare(
      "Reschedule task",
      "The task keeps its wording, priority, and owner; only the due date moves."
    );
    form.createEl("h3", { text: this.task.task, attr: { dir: "auto" } });
    if (this.task.due_date) {
      form.createEl("p", { text: `Currently due ${this.task.due_date}`, cls: "clinical-card-meta" });
    }
    this.addDateSetting(form, "New due date", this.dueDate, (value) => (this.dueDate = value), true);
    this.addActions(this.contentEl);
  }

  protected value(): string {
    if (!this.dueDate) throw new Error("Choose the new due date.");
    return this.dueDate;
  }
}

export class UpdateEpisodeModal extends ClinicalModal<EpisodeUpdateInput> {
  private input: EpisodeUpdateInput;
  private readonly episode: EpisodeRecord;

  constructor(app: App, episode: EpisodeRecord, onSubmit: AsyncSubmit<EpisodeUpdateInput>) {
    super(app, "Save changes", onSubmit);
    this.episode = episode;
    this.input = {
      careSetting: seedOption(episode.care_setting, CARE_SETTINGS, "outpatient"),
      pathway: seedOption(episode.pathway, PATHWAYS, "assessment"),
      priority: seedOption(episode.priority, PRIORITIES, "routine"),
      nextAction: episode.next_action,
      dueDate: episode.due_date,
      // Saving over a record that changed after this form opened would
      // silently revert fields the user never touched.
      expectedUpdatedAt: episode.updated_at
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
    this.addDateSetting(form, "Due date", this.input.dueDate, (value) => (this.input.dueDate = value), true);
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
      phone: patient.phone,
      // Same stale-snapshot guard as the episode form.
      expectedUpdatedAt: patient.updated_at
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
export class MergePatientsModal extends ClinicalResponsiveModal {
  private targetId = "";
  private typedConfirmation = "";
  private merging = false;

  close(): void {
    // A merge in flight re-points many notes; dismissing the modal mid-way
    // would report cancellation while the writes complete anyway.
    if (this.merging) return;
    super.close();
  }

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
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Merge patient records", cls: "clinical-modal-heading" });
    body.createEl("p", {
      text: "Every episode, task and procedure moves to the record you keep. Nothing is deleted: this record is marked entered-in-error and kept for audit.",
      cls: "clinical-section-note"
    });

    const form = body.createDiv({ cls: "clinical-form-section" });
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

    const summary = body.createDiv({ cls: "clinical-card" });
    // Each refresh takes a generation token. A slower preview finishing after
    // a newer selection is discarded instead of appending stale counts or a
    // stale error under the newer result.
    let previewGeneration = 0;
    const refresh = async () => {
      const generation = ++previewGeneration;
      summary.empty();
      if (!this.targetId) {
        summary.createEl("p", { text: "No other patient record is available to merge into.", cls: "clinical-card-meta" });
        return;
      }
      summary.createEl("p", { text: "Checking what this merge will move…", cls: "clinical-card-meta" });
      try {
        const result = await this.preview(this.targetId);
        if (generation !== previewGeneration) return;
        summary.empty();
        summary.createEl("h4", { text: "This merge will move" });
        summary.createEl("p", { text: `${result.episodes} episode${result.episodes === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
        summary.createEl("p", { text: `${result.tasks} task${result.tasks === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
        summary.createEl("p", { text: `${result.procedures} procedure${result.procedures === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
      } catch (error) {
        if (generation !== previewGeneration) return;
        summary.empty();
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

    const errorEl = body.createDiv({ cls: "clinical-modal-error", attr: { role: "alert", "aria-live": "assertive" } });
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
        cancel.disabled = true;
        this.merging = true;
        errorEl.hide();
        try {
          await this.onConfirm(this.targetId);
          this.merging = false;
          this.close();
        } catch (error) {
          errorEl.setText(error instanceof Error ? error.message : "The merge could not be completed.");
          errorEl.show();
          this.merging = false;
          cancel.disabled = false;
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
    }, true);
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
export class IntegrityReportModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly issues: IntegrityIssue[],
    private readonly onOpenPath: (path: string) => void,
    private readonly checkScope?: { scannedRecords: number; checkFamilies: number }
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Data integrity", cls: "clinical-modal-heading" });
    if (!this.issues.length) {
      // "Configured checks passed", never "no issues": the scan covers what
      // it is configured to cover, and claiming more would teach users to
      // trust a guarantee this plugin does not make.
      const scope = this.checkScope
        ? `Configured checks passed: ${this.checkScope.checkFamilies} check families over ${this.checkScope.scannedRecords} records found nothing to report.`
        : "Configured checks passed.";
      body.createEl("p", { text: scope, cls: "clinical-section-note" });
      body.createEl("p", {
        text: "This is not a full validation of every field in every note; hand edits outside the configured checks are not examined.",
        cls: "clinical-section-note"
      });
      return;
    }
    const errors = this.issues.filter((issue) => issue.severity === "error").length;
    body.createEl("p", {
      text: `${this.issues.length} issue${this.issues.length === 1 ? "" : "s"} found (${errors} error${errors === 1 ? "" : "s"}). Open a record to correct it.`,
      cls: "clinical-section-note"
    });
    // Identifier-free summary for a bug report: issue codes and counts only —
    // no record ids, paths, or clinical text. Shown as selectable text and
    // copied manually: programmatic clipboard access is deliberately banned
    // by the community preflight, because the clipboard leaves the app.
    const show = body.createEl("button", {
      text: "Show identifier-free summary",
      cls: "clinical-card-button"
    });
    const summaryBox = body.createEl("textarea", {
      cls: "clinical-summary-export",
      attr: { readonly: "readonly", rows: "6", "aria-label": "Identifier-free integrity summary" }
    });
    summaryBox.hide();
    show.addEventListener("click", () => {
      const counts = new Map<string, number>();
      for (const issue of this.issues) {
        const key = `${issue.code} (${issue.severity})`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      summaryBox.value = [
        "Clinical Workspace integrity summary",
        this.checkScope
          ? `${this.checkScope.checkFamilies} check families over ${this.checkScope.scannedRecords} records`
          : "scope not recorded",
        ...[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => `- ${key}: ${count}`)
      ].join("\n");
      summaryBox.show();
      summaryBox.focus();
      summaryBox.select();
    });
    const list = body.createDiv({ cls: "clinical-integrity-list" });
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

/**
 * Shown once after the plugin has been updated: a short, identifier-free
 * summary of what changed, with a link to the full release notes on GitHub.
 * Purely informational — it makes no network request; the link opens in the
 * system browser only when the user chooses to follow it.
 */
export class WhatsNewModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly version: string,
    private readonly highlights: readonly string[],
    private readonly releaseUrl: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", {
      text: `What's new in Clinical Workspace ${this.version}`,
      cls: "clinical-modal-heading"
    });
    body.createEl("p", {
      text: "This window appears once after an update. Nothing was sent anywhere to show it.",
      cls: "clinical-section-note"
    });
    const list = body.createEl("ul", { cls: "clinical-whats-new-list" });
    for (const highlight of this.highlights) {
      list.createEl("li", { text: highlight });
    }
    body.createEl("p", { cls: "clinical-section-note" }, (paragraph) => {
      paragraph.createEl("a", {
        text: "Read the full release notes on GitHub",
        attr: { href: this.releaseUrl, rel: "noopener" }
      });
    });
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const close = footer.createEl("button", { text: "Close", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Generic typed-confirmation gate for identifier-free maintenance actions
 * (baseline adoption, body migration). Shows counts, never record content.
 */
export class ConfirmMaintenanceModal extends ClinicalResponsiveModal {
  private typed = "";
  private decided = false;

  constructor(
    app: App,
    private readonly options: {
      title: string;
      lines: string[];
      confirmWord: string;
      confirmLabel: string;
      onDecide: (confirmed: boolean) => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: this.options.title, cls: "clinical-modal-heading" });
    for (const line of this.options.lines) {
      body.createEl("p", { text: line, cls: "clinical-section-note" });
    }
    const form = body.createDiv({ cls: "clinical-form-section" });
    namedSetting(form, `Type ${this.options.confirmWord} to confirm`).addText((field) => {
      field.setPlaceholder(this.options.confirmWord).onChange((value) => (this.typed = value));
    });
    const errorEl = body.createDiv({ cls: "clinical-modal-error", attr: { role: "alert", "aria-live": "assertive" } });
    errorEl.hide();
    const actions = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: this.options.confirmLabel, cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      if (this.typed.trim().toUpperCase() !== this.options.confirmWord.toUpperCase()) {
        errorEl.setText("Enter the confirmation word shown above.");
        errorEl.show();
        return;
      }
      this.decided = true;
      this.close();
      this.options.onDecide(true);
    });
  }

  onClose(): void {
    if (!this.decided) this.options.onDecide(false);
    this.contentEl.empty();
  }
}

/**
 * Previews a task-bundle template and applies it on explicit confirmation.
 * The ordinary duplicate suppression means re-applying a bundle is safe.
 */
export class ApplyTemplateModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly episodeCase: string,
    private readonly bundles: readonly TaskBundle[],
    private readonly onApply: (bundle: TaskBundle) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Apply task template", cls: "clinical-modal-heading" });
    body.createEl("p", {
      text: `Creates the template's standard tasks for ${bidiIsolate(this.episodeCase) || "this episode"}. Identical open tasks are kept, not duplicated. Nothing runs automatically.`,
      cls: "clinical-section-note"
    });
    if (!this.bundles.length) {
      body.createEl("p", {
        text: "No task template matches this episode. Create one in the templates folder — see the data model reference for the format.",
        cls: "clinical-empty"
      });
    }
    const list = body.createDiv({ cls: "clinical-list" });
    for (const bundle of this.bundles) {
      const card = list.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: bundle.name, attr: { dir: "auto" } });
      top.createSpan({
        text: `${bundle.tasks.length} task${bundle.tasks.length === 1 ? "" : "s"}`,
        cls: "clinical-card-meta"
      });
      if (bundle.pathway) {
        card.createEl("p", { text: pathwayLabel(bundle.pathway), cls: "clinical-card-meta" });
      }
      for (const item of bundle.tasks.slice(0, 6)) {
        card.createEl("p", {
          text: `• ${item.task}${item.dueInDays !== null ? ` — due in ${item.dueInDays} day${item.dueInDays === 1 ? "" : "s"}` : ""}`,
          cls: "clinical-card-meta",
          attr: { dir: "auto" }
        });
      }
      if (bundle.tasks.length > 6) {
        card.createEl("p", { text: `…and ${bundle.tasks.length - 6} more`, cls: "clinical-card-meta" });
      }
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      const apply = actions.createEl("button", {
        text: "Apply template",
        cls: "clinical-card-button mod-cta",
        attr: { "aria-label": `Apply template ${bundle.name}` }
      });
      apply.addEventListener("click", () => {
        this.close();
        this.onApply(bundle);
      });
    }
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Chronological audit trail for one episode, from the existing Event notes. */
export class EpisodeHistoryModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly episodeCase: string,
    private readonly events: readonly EventRecord[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Episode history", cls: "clinical-modal-heading" });
    body.createEl("p", {
      text: `${bidiIsolate(this.episodeCase) || "Episode"} — audit events recorded on this device, newest first.`,
      cls: "clinical-section-note"
    });
    const sorted = [...this.events].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!sorted.length) {
      body.createEl("p", { text: "No audit events recorded for this episode.", cls: "clinical-empty" });
    }
    const list = body.createDiv({ cls: "clinical-integrity-list" });
    for (const event of sorted.slice(0, 100)) {
      const row = list.createDiv({ cls: "clinical-integrity-issue" });
      const head = row.createDiv({ cls: "clinical-card-top" });
      head.createEl("strong", { text: event.summary || event.action });
      head.createSpan({ text: event.created_at.slice(0, 16).replace("T", " "), cls: "clinical-card-meta" });
      const change = [event.previous_state, event.new_state].filter(Boolean).join(" → ");
      row.createEl("p", {
        text: `${event.action}${change ? ` · ${change}` : ""} · ${event.actor}`,
        cls: "clinical-card-meta"
      });
    }
    if (sorted.length > 100) {
      body.createEl("p", { text: `Showing the most recent 100 of ${sorted.length} events.`, cls: "clinical-section-note" });
    }
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const close = footer.createEl("button", { text: "Close", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface PatientDetailData {
  patient: PatientRecord;
  episodes: EpisodeRecord[];
  tasks: TaskRecord[];
  procedures: ProcedureRecord[];
  events: EventRecord[];
}

/** One screen per patient: episodes, work, logbook, and trail together. */
export class PatientDetailModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly data: PatientDetailData,
    private readonly onOpenRecord: (entity: "patient" | "episode" | "task" | "procedure", id: string) => void,
    private readonly onReopenTask: (taskId: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    const { patient } = this.data;
    body.createEl("h2", {
      text: patient.patient_name ? bidiIsolate(patient.patient_name) : "Patient record",
      cls: "clinical-modal-heading",
      attr: { dir: "auto" }
    });
    body.createEl("p", {
      text: `${patientIdentityLabel(patient.mrn, patient.patient_name)} · Phone ${displayPhone(patient.phone)} · ${patient.status}`,
      cls: "clinical-section-note"
    });

    const section = (title: string, note: string): HTMLElement => {
      const header = body.createDiv({ cls: "clinical-section-header" });
      header.createEl("h3", { text: title });
      header.createSpan({ text: note, cls: "clinical-section-note" });
      return body.createDiv({ cls: "clinical-list" });
    };

    const episodes = [...this.data.episodes].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    const episodeList = section("Episodes", `${episodes.length} total`);
    if (!episodes.length) episodeList.createDiv({ text: "No episodes.", cls: "clinical-empty" });
    for (const episode of episodes.slice(0, 20)) {
      const card = episodeList.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: episode.case || "Case not recorded", attr: { dir: "auto" } });
      top.createSpan({ text: episode.status, cls: "clinical-card-meta" });
      card.createEl("p", { text: pathwayLabel(episode.pathway), cls: "clinical-card-meta" });
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      const open = actions.createEl("button", {
        text: "Open",
        cls: "clinical-card-button",
        attr: { "aria-label": `Open episode ${bidiIsolate(episode.case) || episode.id}` }
      });
      open.addEventListener("click", () => {
        this.close();
        this.onOpenRecord("episode", episode.id);
      });
    }

    const openTasks = this.data.tasks.filter(taskIsOpen);
    const openList = section("Open work", `${openTasks.length} task${openTasks.length === 1 ? "" : "s"}`);
    if (!openTasks.length) openList.createDiv({ text: "Nothing outstanding.", cls: "clinical-empty" });
    for (const task of openTasks.slice(0, 20)) {
      const card = openList.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: task.task || "Task not recorded", attr: { dir: "auto" } });
      top.createSpan({ text: task.due_date || "No date", cls: "clinical-card-meta" });
    }

    // Closed work is where a mis-tapped completion is recovered from — the
    // open-task lists elsewhere can never show it.
    const closedTasks = this.data.tasks
      .filter((task) => ["completed", "cancelled"].includes(task.status))
      .sort((a, b) =>
        `${b.completed_at || b.cancelled_at || ""}`.localeCompare(`${a.completed_at || a.cancelled_at || ""}`)
      );
    const closedList = section("Recently closed", `${closedTasks.length} task${closedTasks.length === 1 ? "" : "s"}`);
    if (!closedTasks.length) closedList.createDiv({ text: "No closed tasks.", cls: "clinical-empty" });
    const closableEpisodes = new Set(
      this.data.episodes
        .filter((episode) => !["archived", "cancelled", "entered-in-error"].includes(episode.status))
        .map((episode) => episode.id)
    );
    for (const task of closedTasks.slice(0, 10)) {
      const card = closedList.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: task.task || "Task not recorded", attr: { dir: "auto" } });
      top.createSpan({ text: task.status, cls: "clinical-card-meta" });
      if (closableEpisodes.has(task.episode_id)) {
        const actions = card.createDiv({ cls: "clinical-card-actions" });
        const reopen = actions.createEl("button", {
          text: "Reopen",
          cls: "clinical-card-button",
          attr: { "aria-label": `Reopen task ${bidiIsolate(task.task) || task.id}` }
        });
        reopen.addEventListener("click", () => {
          this.close();
          this.onReopenTask(task.id);
        });
      }
    }

    const procedures = [...this.data.procedures].sort((a, b) =>
      (b.procedure_date || "").localeCompare(a.procedure_date || "")
    );
    const procedureList = section("Procedures", `${procedures.length} logged`);
    if (!procedures.length) procedureList.createDiv({ text: "No procedures logged.", cls: "clinical-empty" });
    for (const procedure of procedures.slice(0, 10)) {
      const card = procedureList.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: procedure.procedure || "Procedure not recorded", attr: { dir: "auto" } });
      top.createSpan({ text: procedure.procedure_date || "No date", cls: "clinical-card-meta" });
    }

    const events = [...this.data.events].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const eventList = section("Recent history", `${events.length} audit event${events.length === 1 ? "" : "s"}`);
    if (!events.length) eventList.createDiv({ text: "No audit events.", cls: "clinical-empty" });
    for (const event of events.slice(0, 15)) {
      const row = eventList.createDiv({ cls: "clinical-integrity-issue" });
      const head = row.createDiv({ cls: "clinical-card-top" });
      head.createEl("strong", { text: event.summary || event.action });
      head.createSpan({ text: event.created_at.slice(0, 16).replace("T", " "), cls: "clinical-card-meta" });
    }

    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const close = footer.createEl("button", { text: "Close", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ClinicalSearchData {
  patients: PatientRecord[];
  episodes: EpisodeRecord[];
  tasks: TaskRecord[];
  procedures: ProcedureRecord[];
}

/** One search box across patients, episodes, tasks, and the logbook. */
export class ClinicalSearchModal extends ClinicalResponsiveModal {
  private query = "";
  private resultsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly data: ClinicalSearchData,
    private readonly onOpenRecord: (entity: "patient" | "episode" | "task" | "procedure", id: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.modalEl.addClass("clinical-search-modal");
    this.contentEl.empty();
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body clinical-episode-picker-body" });
    body.createEl("h2", { text: "Search clinical records", cls: "clinical-modal-heading" });
    const search = body.createEl("input", {
      cls: "clinical-quick-entry-search",
      attr: {
        type: "search",
        placeholder: "Patient, MRN, case, task, or procedure",
        "aria-label": "Search clinical records",
        autocomplete: "off",
        enterkeyhint: "search"
      }
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderResults();
    });
    this.statusEl = body.createDiv({
      cls: "clinical-section-note clinical-search-status",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true"
      }
    });
    this.resultsEl = body.createDiv({ cls: "clinical-quick-entry-results" });
    this.renderResults();
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = footer.createEl("button", { text: "Close" });
    cancel.addEventListener("click", () => this.close());
    queueMicrotask(() => search.focus());
  }

  onClose(): void {
    this.query = "";
    this.resultsEl = null;
    this.statusEl = null;
    this.contentEl.empty();
  }

  private renderResults(): void {
    if (!this.resultsEl || !this.statusEl) return;
    this.resultsEl.empty();
    const query = this.query.trim().toLocaleLowerCase();
    if (query.length < 2) {
      this.modalEl.addClass("is-search-compact");
      this.statusEl.addClass("clinical-empty");
      this.setSearchStatus("Type at least two characters to search.");
      return;
    }
    const matches = (text: string): boolean => text.toLocaleLowerCase().includes(query);
    const groups: Array<{
      title: string;
      rows: Array<{ label: string; meta: string; entity: "patient" | "episode" | "task" | "procedure"; id: string }>;
    }> = [
      {
        title: "Patients",
        rows: this.data.patients
          .filter((patient) => matches(`${patient.patient_name} ${patient.mrn}`))
          .slice(0, 8)
          .map((patient) => ({
            label: patientIdentityLabel(patient.mrn, patient.patient_name),
            meta: patient.status,
            entity: "patient",
            id: patient.id
          }))
      },
      {
        title: "Episodes",
        rows: this.data.episodes
          .filter((episode) => matches(episode.case))
          .slice(0, 8)
          .map((episode) => ({
            label: episode.case || "Case not recorded",
            meta: `${pathwayLabel(episode.pathway)} · ${episode.status}`,
            entity: "episode",
            id: episode.id
          }))
      },
      {
        title: "Tasks",
        rows: this.data.tasks
          .filter((task) => matches(task.task))
          .slice(0, 8)
          .map((task) => ({
            label: task.task || "Task not recorded",
            meta: `${task.status}${task.due_date ? ` · due ${task.due_date}` : ""}`,
            entity: "task",
            id: task.id
          }))
      },
      {
        title: "Procedures",
        rows: this.data.procedures
          .filter((procedure) => matches(procedure.procedure))
          .slice(0, 8)
          .map((procedure) => ({
            label: procedure.procedure || "Procedure not recorded",
            meta: procedure.procedure_date || "No date",
            entity: "procedure",
            id: procedure.id
          }))
      }
    ];
    const withRows = groups.filter((group) => group.rows.length);
    if (!withRows.length) {
      this.modalEl.addClass("is-search-compact");
      this.statusEl.addClass("clinical-empty");
      this.setSearchStatus("Nothing matches this search.");
      return;
    }
    this.modalEl.removeClass("is-search-compact");
    this.statusEl.removeClass("clinical-empty");
    const resultCount = withRows.reduce((count, group) => count + group.rows.length, 0);
    this.setSearchStatus(`${resultCount} result${resultCount === 1 ? "" : "s"} shown.`);
    for (const group of withRows) {
      this.resultsEl.createEl("h3", { text: group.title, cls: "clinical-search-group" });
      for (const row of group.rows) {
        const button = this.resultsEl.createEl("button", {
          cls: "clinical-quick-entry-option",
          attr: { type: "button", "aria-label": `Open ${group.title.toLocaleLowerCase().replace(/s$/, "")}: ${row.label}` }
        });
        button.createEl("strong", { text: row.label, attr: { dir: "auto" } });
        button.createSpan({ text: row.meta, cls: "clinical-section-note" });
        button.addEventListener("click", () => {
          this.close();
          this.onOpenRecord(row.entity, row.id);
        });
      }
    }
  }

  private setSearchStatus(message: string): void {
    if (this.statusEl?.textContent === message) return;
    this.statusEl?.setText(message);
  }
}

export function patientIdentityLabel(mrn: string, patientName: string): string {
  return `MRN ${displayMrn(mrn)} · ${patientName ? bidiIsolate(patientName) : "Name not recorded"}`;
}
