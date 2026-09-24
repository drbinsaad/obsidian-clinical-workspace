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
  formatLocalDateTime,
  isoDateWithOffset,
  mrnMatchKey,
  normalizeIsoDate,
  pathwayLabel,
  priorityLabel,
  searchKey,
  taskIsOpen,
  taskTypeLabel,
  todayIso
} from "../domain/schema";
import type { TaskBundle } from "../data/templates";
import {
  PATIENT_LIST_FORMATS,
  PATIENT_LIST_SCOPES,
  normalizePatientListFilter,
  patientListFormatLabel,
  patientListScopeLabel,
  type PatientListFilter,
  type PatientListFormat,
  type PatientListRequest,
  type PatientListScope
} from "../services/patient-list";
import type { QuickEntryAction } from "../quick-entry";
import { showClinicalErrorNotice } from "./notices";

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
  TASK_TYPES.map((value) => [value, taskTypeLabel(value)])
) as Record<TaskType, string>;

/** Numbers the ids that link a field to its hint text; unique per window. */
let fieldHintSequence = 0;

/**
 * Obsidian's `Setting` renders its name as plain text with no `for`/`id` link
 * to the control, so screen readers announce the field as unlabelled. Naming
 * the control directly closes that gap.
 */
function labelControl(setting: Setting, name: string): Setting {
  const control = setting.settingEl.querySelector("input, select, textarea");
  if (!control?.instanceOf(HTMLElement)) return setting;
  control.setAttribute("aria-label", name);
  // A hint such as "Numbers only; leading zeroes are preserved." is plain
  // text beside the field. Linking it lets a screen reader read the rule
  // with the field instead of skipping it.
  const hint = setting.descEl;
  if (hint.textContent?.trim()) {
    const id = hint.getAttribute("id") || `clinical-field-hint-${++fieldHintSequence}`;
    hint.setAttribute("id", id);
    const described = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    if (!described.includes(id)) control.setAttribute("aria-describedby", [...described, id].join(" "));
  }
  return setting;
}

/** Inputs for which a phone keyboard shows a Return key. */
const TEXT_ENTRY_TYPES = new Set(["text", "tel", "number", "search", "email", "url"]);

function isTextEntry(element: Element | null | undefined): element is HTMLInputElement {
  return element?.tagName === "INPUT" && TEXT_ENTRY_TYPES.has((element as HTMLInputElement).type);
}

/**
 * Enabled fields a person can reach now, in document order. A field in a
 * hidden group (the follow-up fields while follow-up is off) does not count,
 * and neither does one kept out of the tab order: Obsidian's toggle hides a
 * checkbox inside its label, and Return there would flip the toggle.
 */
function reachableFormControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("input, select, textarea")).filter((control) => {
    if ((control as HTMLInputElement).disabled) return false;
    if (control.getAttribute("tabindex") === "-1") return false;
    for (let node: HTMLElement | null = control; node && node !== root; node = node.parentElement) {
      if (node.hidden) return false;
    }
    return true;
  });
}

/**
 * Return moves to the next field and submits only from the form's last
 * field, so the keyboard's Return key reads "next" everywhere except there.
 * A form that ends with a date or a choice has no text field that submits.
 */
function syncEnterKeyHints(root: HTMLElement): void {
  const controls = reachableFormControls(root);
  const last = controls[controls.length - 1];
  for (const field of controls.filter(isTextEntry)) {
    field.setAttribute("enterkeyhint", field === last ? "done" : "next");
  }
}

function namedSetting(container: HTMLElement, name: string): Setting {
  const setting = new Setting(container).setName(name);
  queueMicrotask(() => {
    labelControl(setting, name);
    const control = setting.settingEl.querySelector("input, textarea");
    // dir=auto lets an Arabic name or case align, and move its caret,
    // right-to-left inside an otherwise left-to-right form.
    if (control?.tagName === "TEXTAREA" || isTextEntry(control)) control?.setAttribute("dir", "auto");
    const body = setting.settingEl.closest(".clinical-modal-body");
    if (body?.instanceOf(HTMLElement)) syncEnterKeyHints(body);
  });
  return setting;
}

type IdentityField = "name" | "mrn" | "phone" | "owner";

/**
 * iOS autocorrect can swap an unfamiliar or transliterated name for a
 * dictionary word when the user types a space, and autofill can offer a
 * number typed for another patient. Identity fields turn both off.
 */
function identityField(input: HTMLInputElement, kind: IdentityField): void {
  if (kind !== "phone") {
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocapitalize", kind === "name" ? "words" : "off");
  }
  if (kind === "mrn" || kind === "phone") input.setAttribute("autocomplete", "off");
}

/**
 * Submission failures belong to the same scroll surface as their form fields.
 * Keeping this choice explicit also gives the mobile layout contract a small,
 * executable boundary instead of relying on a source-text assertion.
 */
export function clinicalModalErrorContainer(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".clinical-modal-body") ?? container;
}

interface ClinicalModalRect {
  top: number;
  bottom: number;
}

/** Reveal only controls that the form's own scrollport actually clips. */
export function clinicalModalControlNeedsReveal(
  control: ClinicalModalRect,
  scrollport: ClinicalModalRect,
  inset = 8
): boolean {
  const safeInset = Number.isFinite(inset) ? Math.max(0, inset) : 0;
  if (
    !Number.isFinite(control.top) ||
    !Number.isFinite(control.bottom) ||
    !Number.isFinite(scrollport.top) ||
    !Number.isFinite(scrollport.bottom)
  ) return true;
  return control.top < scrollport.top + safeInset ||
    control.bottom > scrollport.bottom - safeInset;
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
  onUserScrollIntent: (listener: () => void) => () => void;
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

  /**
   * Keep the modal fitted to the visual viewport without changing the user's
   * position inside its scrollable form. iPadOS emits visualViewport `scroll`
   * events while a nested sheet is being dragged; revealing the still-focused
   * input from that event snaps the form back toward the input and feels like
   * the sheet has frozen.
   */
  private sync(revealFocusedControl: boolean): void {
    if (!this.running) return;
    const metrics = this.host.readMetrics();
    this.host.applyLayout(calculateClinicalModalViewportLayout(
      metrics.innerHeight,
      metrics.viewportHeight,
      metrics.viewportOffsetTop,
      metrics.keyboardHeight
    ));
    if (revealFocusedControl) this.host.revealFocusedControl();
  }

  private readonly handleViewportScroll = (): void => {
    // A focus schedules late keyboard-animation checkpoints. If the user
    // starts moving the sheet before the final checkpoint, those callbacks
    // must not pull the still-focused field back into view.
    this.clearTimers();
    this.sync(false);
  };

  private readonly cancelScheduledReveals = (): void => {
    this.clearTimers();
  };

  private readonly syncLayoutAndReveal = (): void => {
    this.sync(true);
  };

  private readonly handleFocus = (): void => {
    this.schedule();
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cleanupListeners = [
      // Resize can be a late keyboard transition, rotation, or Split View
      // change. Ask the host to reveal only when the active control is truly
      // clipped after the new geometry is applied.
      this.host.onViewportResize(this.syncLayoutAndReveal),
      this.host.onViewportScroll(this.handleViewportScroll),
      this.host.onWindowResize(this.syncLayoutAndReveal),
      this.host.onFocusIn(this.handleFocus),
      this.host.onUserScrollIntent(this.cancelScheduledReveals)
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
      this.host.setTimer(this.syncLayoutAndReveal, delay)
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
        this.modalEl.setCssProps({
          "--clinical-modal-visual-height": `${layout.height}px`,
          "--clinical-modal-visual-shift": `${layout.shift}px`
        });
        this.modalEl.toggleClass("is-virtual-keyboard-open", layout.keyboardOpen);
      },
      resetLayout: () => {
        // An empty value removes the custom property.
        this.modalEl.setCssProps({
          "--clinical-modal-visual-height": "",
          "--clinical-modal-visual-shift": ""
        });
        this.modalEl.removeClass("is-virtual-keyboard-open");
      },
      revealFocusedControl: () => {
        const target = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
        const body = this.contentEl.querySelector<HTMLElement>(".clinical-modal-body");
        if (
          !target ||
          !body ||
          !body.contains(target) ||
          typeof target.scrollIntoView !== "function" ||
          !clinicalModalControlNeedsReveal(
            target.getBoundingClientRect(),
            body.getBoundingClientRect()
          )
        ) return;
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      },
      onViewportResize: (listener) => listen(viewWindow.visualViewport, "resize", listener),
      onViewportScroll: (listener) => listen(viewWindow.visualViewport, "scroll", listener),
      onWindowResize: (listener) => listen(viewWindow, "resize", listener),
      onFocusIn: (listener) => listen(this.contentEl, "focusin", listener),
      onUserScrollIntent: (listener) => {
        const body = this.contentEl.querySelector<HTMLElement>(".clinical-modal-body");
        if (!body) return () => undefined;
        const cleanups = [
          listen(body, "pointerdown", listener),
          listen(body, "touchstart", listener),
          listen(body, "wheel", listener)
        ];
        return () => {
          for (const cleanup of cleanups) cleanup();
        };
      },
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
  /** The patient's stored MRN, so a digits-only search can match it as an MRN. */
  patientMrn?: string;
  /**
   * For the procedure picker: the episode has moved on from OR booking after
   * a logged procedure, so choosing it adds another procedure.
   */
  additionalProcedure?: boolean;
}

/**
 * A digits-only query is also compared as an MRN, so "0012345" finds a
 * patient stored as "12345". "" when the query is not an MRN.
 */
function mrnQueryKey(query: string): string {
  const key = mrnMatchKey(query);
  return /^\d+$/.test(key) ? key : "";
}

/**
 * Wraps user-entered text in first-strong isolates (FSI…PDI) so an Arabic
 * name or case label cannot visually reorder the LTR template around it.
 * Display-time only; persisted values never carry these controls.
 */
export function bidiIsolate(value: string): string {
  return value ? `\u2068${value}\u2069` : value;
}

/** Visible text of an Episode picker row's button. */
function episodeChoiceButtonText(choice: QuickEntryEpisodeChoice): string {
  if (choice.isCurrent) return "Confirm current episode";
  return choice.additionalProcedure ? "Add another procedure" : "Use this episode";
}

export function episodeChoiceAccessibleLabel(
  actionLabel: string,
  choice: QuickEntryEpisodeChoice
): string {
  const action = episodeChoiceButtonText(choice);
  const purpose = choice.additionalProcedure
    ? choice.isCurrent ? "to add another procedure" : "to this episode"
    : `for ${actionLabel}`;
  const episode = choice.episode.case ? bidiIsolate(choice.episode.case) : "Case not recorded";
  return `${action} ${purpose}: ${episode}; ${choice.patientLabel}; episode ${choice.episode.id}`;
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
  /** Folded once per open, not per keystroke. */
  private readonly searchIndex: ReadonlyArray<{ choice: QuickEntryEpisodeChoice; key: string; mrnKey: string }>;

  constructor(
    app: App,
    private readonly actionLabel: string,
    choices: readonly QuickEntryEpisodeChoice[],
    private readonly onChoose: (choice: QuickEntryEpisodeChoice) => void
  ) {
    super(app);
    this.searchIndex = choices.map((choice) => ({
      choice,
      key: searchKey(`${choice.patientLabel} ${choice.episode.case}`),
      mrnKey: mrnMatchKey(choice.patientMrn)
    }));
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
    // Folded on both sides: Arabic spelling variants and Arabic-Indic digits
    // typed on an iPhone keyboard still find the stored record.
    const query = searchKey(this.query);
    const queryMrn = mrnQueryKey(this.query);
    const matching = this.searchIndex
      .filter((entry) =>
        !query || entry.key.includes(query) || (queryMrn !== "" && entry.mrnKey === queryMrn)
      )
      .map((entry) => entry.choice);
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
      top.createEl("h4", { text: choice.episode.case || "Case not recorded", attr: { dir: "auto" } });
      if (choice.isCurrent) {
        top.createSpan({ text: "Current episode", cls: "clinical-badge is-current" });
      }
      card.createEl("p", { text: choice.patientLabel, cls: "clinical-card-meta" });
      card.createEl("p", {
        text: `${careSettingLabel(choice.episode.care_setting)} · ${pathwayLabel(choice.episode.pathway)}`,
        cls: "clinical-card-meta"
      });
      if (choice.additionalProcedure) {
        card.createEl("p", {
          text: "A procedure is already logged here; this adds another.",
          cls: "clinical-card-review"
        });
      }
      const choose = card.createEl("button", {
        text: episodeChoiceButtonText(choice),
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
/**
 * Seeds a select from a stored value. A value typed by hand in the Properties
 * panel ("Emergency", "OR booking") is matched ignoring case and spacing, so
 * saving the form keeps the stored choice instead of silently resetting it
 * to the fallback, which for priority would lower an emergency to routine.
 */
function seedOption<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return allowed.find((option) => option === key) ?? fallback;
}

/**
 * Thrown by a submit handler when the user backed out of a follow-up question,
 * such as which patient this is. Nothing was saved and nothing failed: the
 * form stays open with everything typed, and says so quietly instead of
 * raising an error Notice.
 */
export class ClinicalSubmitCancelled extends Error {
  constructor(
    message = "Nothing was saved. Check the details, then submit again.",
    /** Accessible name of the field to return focus to, such as "MRN". */
    readonly focusField = ""
  ) {
    super(message);
    this.name = "ClinicalSubmitCancelled";
  }
}

export abstract class ClinicalModal<T> extends ClinicalResponsiveModal {
  private errorEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private cancelEl: HTMLButtonElement | null = null;
  private submitEl: HTMLButtonElement | null = null;
  private submitting = false;
  /**
   * Whether plain Return in the form's last field submits. A destructive
   * form whose only text field is also its last (Discharge, Cancel task)
   * turns this off: iPhone users tap Return ("done") to hide the keyboard,
   * and that one tap archived the episode or cancelled the task. There
   * Return only hides the keyboard; the button or Ctrl/Cmd+Enter submits.
   */
  protected returnSubmits = true;

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

  /** A form that must not be submitted in its current state says so here. */
  protected canSubmit(): boolean {
    return true;
  }

  /** The Notice for a failure whose own message is not safe to show there. */
  protected submitFailureNotice(): string {
    return "This could not be saved. The form shows why.";
  }

  /** Re-applies canSubmit() to the submit button after the form's state changed. */
  protected syncSubmitState(): void {
    if (this.submitEl && !this.submitting) this.submitEl.disabled = !this.canSubmit();
  }

  /** Links the submit button to the text that explains when it is unavailable. */
  protected describeSubmit(hintId: string): void {
    this.submitEl?.setAttribute("aria-describedby", hintId);
  }

  protected addDateSetting(
    container: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    quickOffsets = false
  ): void {
    let dateInput: HTMLInputElement | null = null;
    // Forward-looking dates (due, follow-up) get the chips and a past-date
    // hint. A past due date is usually a slip, such as a default carried over
    // from an overdue episode, so it is named before submit rather than after.
    let pastHint: HTMLElement | null = null;
    const pastHintId = quickOffsets ? `clinical-date-hint-${++fieldHintSequence}` : "";
    const showPastHint = (date: string): void => {
      const normalized = normalizeIsoDate(date);
      pastHint?.setText(normalized && normalized < todayIso() ? "This date is in the past." : "");
    };
    const change = (next: string): void => {
      onChange(next);
      showPastHint(next);
    };
    namedSetting(container, label).addText((component) => {
      component.inputEl.type = "date";
      component.inputEl.setAttribute("aria-label", label);
      if (pastHintId) component.inputEl.setAttribute("aria-describedby", pastHintId);
      component.setValue(value).onChange(change);
      dateInput = component.inputEl;
    });
    if (!quickOffsets) return;
    // Interval chips: clinicians think in "see again in two weeks", and
    // typing a date is the slowest input in the form on a phone. Today and
    // the next two days are the commonest ward-round dates.
    const chips = container.createDiv({ cls: "clinical-date-chips" });
    const offsets: ReadonlyArray<[string, number, string]> = [
      ["Today", 0, "today"],
      ["+1d", 1, "tomorrow"],
      ["+2d", 2, "two days from today"],
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
        change(next);
      });
    }
    pastHint = container.createEl("p", {
      cls: "clinical-section-note clinical-date-hint",
      attr: { id: pastHintId, "aria-live": "polite" }
    });
    showPastHint(value);
  }

  protected addActions(container: HTMLElement): void {
    // Keep a potentially long recovery/write error inside the form's one
    // scrolling region. When it was a fixed sibling of the body and footer, a
    // keyboard-sized iPad viewport could leave almost no draggable form area.
    // Announced to assistive technology when a submission fails.
    const errorContainer = clinicalModalErrorContainer(container);
    this.errorEl = errorContainer.createDiv({
      cls: "clinical-modal-error",
      attr: { role: "alert", "aria-live": "assertive" }
    });
    this.errorEl.hide();
    // Backing out of a follow-up question is not a failure; it gets a quiet
    // status line rather than the alert.
    this.noteEl = errorContainer.createDiv({
      cls: "clinical-modal-note",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.noteEl.hide();
    const actions = container.createDiv({ cls: "clinical-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    this.cancelEl = cancel;
    const submit = actions.createEl("button", {
      text: this.submitLabel,
      cls: "mod-cta"
    });
    this.submitEl = submit;
    this.syncSubmitState();
    submit.addEventListener("click", () => void this.handleSubmit(submit));
    this.contentEl.addEventListener("keydown", (event) => {
      const input = event.target as HTMLElement | null;
      if (event.key !== "Enter" || event.isComposing || !isTextEntry(input)) return;
      event.preventDefault();
      // Many iPhone users tap Return to move on or to hide the keyboard. When
      // any Return submitted, one tap after the procedure name logged the
      // surgery with the default role and date, and one after Next action
      // filed the task before its Due date was reached. Only the form's last
      // field, or an explicit Ctrl/Cmd+Enter, submits; elsewhere Return moves on.
      const controls = reachableFormControls(this.contentEl);
      if (event.ctrlKey || event.metaKey) {
        void this.handleSubmit(submit);
        return;
      }
      if (controls[controls.length - 1] === input) {
        if (this.returnSubmits) void this.handleSubmit(submit);
        else input.blur();
        return;
      }
      const index = controls.indexOf(input);
      if (index >= 0) controls[index + 1]?.focus();
    });
    // Showing a hidden group (follow-up) changes which field is last.
    this.contentEl.addEventListener("focusin", () => syncEnterKeyHints(this.contentEl));
    // Without preventScroll, focusing a first field below a long case name
    // scrolled the form past its own title on a small phone. The keyboard
    // handler still reveals the field if the keyboard would cover it.
    queueMicrotask(() => {
      reachableFormControls(this.contentEl)[0]?.focus({ preventScroll: true });
    });
  }

  private async handleSubmit(button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    this.submitting = true;
    if (this.cancelEl) this.cancelEl.disabled = true;
    this.errorEl?.hide();
    this.noteEl?.hide();
    try {
      await this.onSubmit(this.value());
      this.submitting = false;
      this.close();
    } catch (error) {
      if (error instanceof ClinicalSubmitCancelled) {
        this.noteEl?.setText(error.message);
        this.noteEl?.show();
      } else {
        const message = error instanceof Error ? error.message : "The clinical action could not be completed.";
        if (this.errorEl) {
          this.errorEl.setText(message);
          this.errorEl.show();
          this.errorEl.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        // The form's error line keeps the detail; the Notice, which others
        // may see, never repeats a file-system error that names a note.
        showClinicalErrorNotice(error, this.submitFailureNotice(), 7000);
      }
      this.submitting = false;
      if (this.cancelEl) this.cancelEl.disabled = false;
      button.disabled = !this.canSubmit();
      if (error instanceof ClinicalSubmitCancelled && error.focusField) {
        const field = reachableFormControls(this.contentEl).find(
          (control) => control.getAttribute("aria-label") === error.focusField
        );
        field?.focus();
      }
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
      identityField(field.inputEl, "mrn");
    });
    namedSetting(form, "Patient name").addText((field) => {
      field
        .setValue(this.input.patientName)
        .setPlaceholder("Required when MRN is missing")
        .onChange((value) => (this.input.patientName = value));
      identityField(field.inputEl, "name");
    });
    namedSetting(form, "Phone").setDesc("Leave blank to store NFN.").addText((field) => {
      field.setValue(this.input.phone).setPlaceholder("NFN").onChange((value) => (this.input.phone = value));
      field.inputEl.inputMode = "tel";
      identityField(field.inputEl, "phone");
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

export interface DuplicatePatientOptions {
  /** The MRN typed into the form, when there was one; the candidates have none. */
  enteredMrn?: string;
  /** Called when the prompt closes without a choice, so the form can stay open. */
  onCancel?: () => void;
}

/**
 * Shown when a new patient's name matches a record that has no MRN: either
 * no MRN was entered, or the one entered belongs to nobody yet. Without this
 * step the two are silently kept apart.
 */
export class DuplicatePatientModal extends ClinicalResponsiveModal {
  private decided = false;

  constructor(
    app: App,
    private readonly candidates: PatientRecord[],
    private readonly onChoose: (patientId: string | null) => void,
    private readonly options: DuplicatePatientOptions = {}
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const enteredMrn = this.options.enteredMrn ?? "";
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Possible duplicate patient", cls: "clinical-modal-heading" });
    body.createEl("p", {
      text: enteredMrn
        ? `A patient with this name is already recorded without an MRN. If this is the same person, choose their record: MRN ${enteredMrn} will be recorded on the chosen chart. Otherwise create a separate patient.`
        : "No MRN was entered, and a patient with this name already exists. Choose an existing record or create a separate one.",
      cls: "clinical-section-note"
    });
    const list = body.createDiv({ cls: "clinical-list" });
    for (const candidate of this.candidates) {
      const card = list.createDiv({ cls: "clinical-card" });
      card.createEl("h4", { text: candidate.patient_name || "Name not recorded", attr: { dir: "auto" } });
      card.createEl("p", { text: `MRN ${displayMrn(candidate.mrn)}`, cls: "clinical-card-meta" });
      card.createEl("p", { text: `Phone ${displayPhone(candidate.phone)}`, cls: "clinical-card-meta" });
      if (enteredMrn && !candidate.mrn) {
        card.createEl("p", {
          text: `Choosing this chart records MRN ${enteredMrn} on it.`,
          cls: "clinical-card-review"
        });
      }
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      const use = actions.createEl("button", {
        text: "Use this patient",
        cls: "clinical-card-button mod-cta",
        // Several candidates share this button text; name the record it picks.
        attr: { "aria-label": `Use this patient — ${patientIdentityLabel(candidate.mrn, candidate.patient_name)}` }
      });
      use.addEventListener("click", () => this.choose(candidate.id));
    }
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const create = footer.createEl("button", { text: "Create separate patient", cls: "clinical-card-button" });
    create.addEventListener("click", () => this.choose(null));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.options.onCancel?.();
    }
  }

  private choose(patientId: string | null): void {
    if (this.decided) return;
    this.decided = true;
    this.onChoose(patientId);
    this.close();
  }
}

/**
 * Shown when the MRN entered for a new episode is already recorded for a
 * patient under a different name, which is what a mistyped MRN looks like.
 * The stored identity is shown here, in the modal, and never in a Notice.
 * Closing without a choice goes back to the still-filled form.
 */
export class MrnOwnerConflictModal extends ClinicalResponsiveModal {
  private decided = false;

  constructor(
    app: App,
    private readonly stored: PatientRecord,
    private readonly typedName: string,
    private readonly onDecide: (useStoredPatient: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("clinical-modal");
    this.contentEl.empty();
    const { stored } = this;
    const body = this.contentEl.createDiv({ cls: "clinical-modal-body" });
    body.createEl("h2", { text: "Check the MRN", cls: "clinical-modal-heading" });
    body.createEl("p", {
      text: `MRN ${displayMrn(stored.mrn)} is already recorded for ${bidiIsolate(stored.patient_name)}, but the form names ${bidiIsolate(this.typedName.trim())}. A one-digit slip in the MRN would file this episode in someone else's record.`,
      cls: "clinical-section-note"
    });
    const card = body.createDiv({ cls: "clinical-card" });
    card.createEl("h4", { text: stored.patient_name || "Name not recorded", attr: { dir: "auto" } });
    card.createEl("p", { text: `MRN ${displayMrn(stored.mrn)}`, cls: "clinical-card-meta" });
    card.createEl("p", { text: `Phone ${displayPhone(stored.phone)}`, cls: "clinical-card-meta" });
    body.createEl("p", {
      text: "If this is the same person, use this patient: the episode is added to their record and the stored name is kept. A wrong name can be corrected later from the patient's record.",
      cls: "clinical-section-note"
    });
    const footer = this.contentEl.createDiv({ cls: "clinical-modal-actions" });
    const back = footer.createEl("button", { text: "Go back and check the MRN", cls: "mod-cta" });
    back.addEventListener("click", () => this.finish(false));
    const use = footer.createEl("button", {
      text: "Use this patient",
      attr: { "aria-label": `Use this patient — ${patientIdentityLabel(stored.mrn, stored.patient_name)}` }
    });
    use.addEventListener("click", () => this.finish(true));
    // The safe answer takes focus, so Return or a hurried tap goes back.
    queueMicrotask(() => back.focus());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.onDecide(false);
    }
  }

  private finish(useStoredPatient: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.close();
    this.onDecide(useStoredPatient);
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
    // The episode's due date tracks its earliest open task, so for a patient
    // with overdue work it is already past and a quick entry would be created
    // overdue. A later planned date is still honoured.
    const today = todayIso();
    const episodeDue = normalizeIsoDate(episode.due_date);
    this.input = {
      patientId: episode.patient_id,
      episodeId: episode.id,
      task: "",
      taskType: "clinical-review",
      priority: seedOption(episode.priority, PRIORITIES, "routine"),
      dueDate: episodeDue > today ? episodeDue : today,
      owner: ""
    };
    this.patientLabel = patientLabel;
  }

  onOpen(): void {
    const form = this.prepare("Add patient task", `${this.patientLabel} · ${bidiIsolate(this.episode.case)}`);
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
      identityField(field.inputEl, "owner");
    });
    this.addActions(this.contentEl);
  }

  protected value(): NewTaskInput {
    return this.input;
  }
}

/**
 * Chooses which patients go into an exported list and in which format. The
 * match count updates as the filters change, so the clinician sees what the
 * file will hold before anything is written.
 */
export class PatientListModal extends ClinicalModal<PatientListRequest> {
  private filter: PatientListFilter;
  private format: PatientListFormat = "markdown";
  private matchEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly countMatches: (filter: PatientListFilter) => { episodes: number; patients: number },
    onSubmit: AsyncSubmit<PatientListRequest>,
    seed?: Partial<PatientListFilter>
  ) {
    super(app, "Create patient list", onSubmit);
    this.filter = normalizePatientListFilter(seed);
  }

  onOpen(): void {
    const form = this.prepare(
      "Export patient list",
      "Choose any combination of care setting, pathway, priority, and episode status. The list is saved in the clinical documents folder and contains patient identifiers — delete it after use."
    );
    namedSetting(form, "Care setting").addDropdown((field) => {
      field
        .addOptions({ all: "Any care setting", ...CARE_SETTING_OPTIONS })
        .setValue(this.filter.careSetting)
        .onChange((value) => {
          this.filter.careSetting = value as PatientListFilter["careSetting"];
          this.updateMatches();
        });
    });
    namedSetting(form, "Pathway").addDropdown((field) => {
      field
        .addOptions({ all: "Any pathway", ...PATHWAY_OPTIONS })
        .setValue(this.filter.pathway)
        .onChange((value) => {
          this.filter.pathway = value as PatientListFilter["pathway"];
          this.updateMatches();
        });
    });
    namedSetting(form, "Priority").addDropdown((field) => {
      field
        .addOptions({ all: "Any priority", ...PRIORITY_OPTIONS })
        .setValue(this.filter.priority)
        .onChange((value) => {
          this.filter.priority = value as PatientListFilter["priority"];
          this.updateMatches();
        });
    });
    namedSetting(form, "Episodes").addDropdown((field) => {
      field
        .addOptions(
          Object.fromEntries(PATIENT_LIST_SCOPES.map((scope) => [scope, patientListScopeLabel(scope)]))
        )
        .setValue(this.filter.scope)
        .onChange((value) => {
          this.filter.scope = value as PatientListScope;
          this.updateMatches();
        });
    });
    namedSetting(form, "Format")
      .setDesc("A note opens here in the vault. A spreadsheet file opens in your spreadsheet app.")
      .addDropdown((field) => {
        field
          .addOptions(
            Object.fromEntries(PATIENT_LIST_FORMATS.map((format) => [format, patientListFormatLabel(format)]))
          )
          .setValue(this.format)
          .onChange((value) => {
            this.format = value as PatientListFormat;
          });
      });
    this.matchEl = form.createEl("p", {
      cls: "clinical-section-note clinical-patient-list-matches",
      attr: { "aria-live": "polite" }
    });
    this.updateMatches();
    this.addActions(this.contentEl);
  }

  private updateMatches(): void {
    if (!this.matchEl) return;
    const { episodes, patients } = this.countMatches(this.filter);
    this.matchEl.setText(
      episodes
        ? `${episodes} episode${episodes === 1 ? "" : "s"} for ${patients} patient${patients === 1 ? "" : "s"} match.`
        : "No episodes match these filters yet."
    );
  }

  protected submitFailureNotice(): string {
    return "The patient list could not be created. The form shows why.";
  }

  protected value(): PatientListRequest {
    if (!this.countMatches(this.filter).episodes) {
      throw new Error("No episodes match these filters. Change a filter and try again.");
    }
    return { filter: { ...this.filter }, format: this.format };
  }
}

/** Moves an open task to a new date without the cancel-and-recreate dance. */
export class RescheduleTaskModal extends ClinicalModal<string> {
  private dueDate: string;
  private readonly task: TaskRecord;

  constructor(app: App, task: TaskRecord, onSubmit: AsyncSubmit<string>) {
    super(app, "Reschedule", onSubmit);
    this.task = task;
    // Starting from the current, often overdue, date made the commonest
    // move — to tomorrow — a trip through the iOS date wheel.
    this.dueDate = isoDateWithOffset(1);
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
    form.createEl("h3", { text: this.episode.case, attr: { dir: "auto" } });
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
      .setDesc("Changing the next action replaces the current task; changing only its date moves it.")
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
      identityField(field.inputEl, "mrn");
    });
    namedSetting(form, "Patient name").addText((field) => {
      field.setValue(this.input.patientName).onChange((value) => (this.input.patientName = value));
      identityField(field.inputEl, "name");
    });
    namedSetting(form, "Phone").addText((field) => {
      field.setValue(this.input.phone).setPlaceholder("NFN").onChange((value) => (this.input.phone = value));
      field.inputEl.inputMode = "tel";
      identityField(field.inputEl, "phone");
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
      text: patientIdentityLabel(this.source.mrn, this.source.patient_name),
      cls: "clinical-card-meta"
    });

    const options: Record<string, string> = {};
    for (const candidate of this.candidates) {
      options[candidate.id] = patientIdentityLabel(candidate.mrn, candidate.patient_name);
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

export interface ArchiveEpisodeRequest {
  outcome: string;
  /** True only when open tasks were listed and the clinician ticked to cancel them. */
  cancelOpenTasks: boolean;
}

export class ArchiveEpisodeModal extends ClinicalModal<ArchiveEpisodeRequest> {
  private outcome = "Discharged";
  private typedConfirmation = "";
  /** Dropping open clinical work is an explicit choice, so this starts off. */
  private cancelOpenTasks = false;
  private blockHint: HTMLElement | null = null;
  private readonly episode: EpisodeRecord;
  private readonly requireConfirmation: boolean;
  private readonly openTasks: readonly TaskRecord[];

  constructor(
    app: App,
    episode: EpisodeRecord,
    onSubmit: AsyncSubmit<ArchiveEpisodeRequest>,
    requireConfirmation = false,
    openTasks: readonly TaskRecord[] = []
  ) {
    super(app, "Archive episode", onSubmit);
    this.returnSubmits = false;
    this.episode = episode;
    this.requireConfirmation = requireConfirmation;
    this.openTasks = openTasks;
  }

  onOpen(): void {
    const form = this.prepare(
      "Discharge and archive",
      "The record remains searchable and can be restored with its pathway and outcome intact."
    );
    form.createEl("h3", { text: this.episode.case, attr: { dir: "auto" } });
    namedSetting(form, "Outcome / reason").addText((field) => {
      field.setValue(this.outcome).onChange((value) => (this.outcome = value));
    });
    if (this.openTasks.length) this.renderOpenTasks(form);
    if (this.requireConfirmation) {
      namedSetting(form, "Type DISCHARGE to confirm")
        .setDesc("Confirmation is enabled in Clinical Workspace settings.")
        .addText((field) => {
          field.setPlaceholder("DISCHARGE").onChange((value) => (this.typedConfirmation = value));
        });
    }
    this.addActions(this.contentEl);
    const hintId = this.blockHint?.getAttribute("id");
    if (hintId) this.describeSubmit(hintId);
  }

  /**
   * Discharge used to reveal open work only as an error after submit, and
   * clearing it meant cancelling each task from another tab. The work is
   * listed here, and one explicit tick cancels it as part of the discharge.
   */
  private renderOpenTasks(form: HTMLElement): void {
    const count = this.openTasks.length;
    const section = form.createDiv({ cls: "clinical-discharge-tasks" });
    section.createEl("h4", {
      text: `${count} open task${count === 1 ? "" : "s"} on this episode`
    });
    const list = section.createEl("ul", { cls: "clinical-discharge-task-list" });
    for (const task of this.openTasks) {
      list.createEl("li", {
        text: `${bidiIsolate(task.task || "Task not recorded")} — ${task.due_date ? `due ${task.due_date}` : "no date"}`
      });
    }
    const label = section.createEl("label", { cls: "clinical-confirm-check" });
    const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = this.cancelOpenTasks;
    label.createSpan({
      text: count === 1
        ? "Cancel this open task (reason: Closed at discharge)"
        : `Cancel these ${count} open tasks (reason: Closed at discharge)`
    });
    this.blockHint = section.createEl("p", {
      cls: "clinical-section-note",
      attr: { id: `clinical-discharge-hint-${++fieldHintSequence}`, "aria-live": "polite" }
    });
    checkbox.addEventListener("change", () => {
      this.cancelOpenTasks = checkbox.checked;
      this.syncBlockHint();
      this.syncSubmitState();
    });
    this.syncBlockHint();
  }

  private syncBlockHint(): void {
    const one = this.openTasks.length === 1;
    this.blockHint?.setText(
      this.cancelOpenTasks
        ? `${one ? "The task is" : "Each task is"} cancelled with its own audit entry and stays in the record.`
        : `Archive stays unavailable while ${one ? "this task is" : "these tasks are"} open. Select the option above to cancel ${one ? "it" : "them"} at discharge, or complete ${one ? "it" : "them"} first.`
    );
  }

  protected canSubmit(): boolean {
    return !this.openTasks.length || this.cancelOpenTasks;
  }

  protected value(): ArchiveEpisodeRequest {
    if (this.requireConfirmation && this.typedConfirmation.trim().toUpperCase() !== "DISCHARGE") {
      throw new Error("Type DISCHARGE to confirm, or turn the confirmation off in settings.");
    }
    return {
      outcome: this.outcome,
      cancelOpenTasks: this.openTasks.length > 0 && this.cancelOpenTasks
    };
  }
}

/** Lets an open task be closed without completing it, so discharge is never blocked. */
export class CancelTaskModal extends ClinicalModal<string> {
  private reason = "";
  private readonly task: TaskRecord;

  constructor(app: App, task: TaskRecord, onSubmit: AsyncSubmit<string>) {
    super(app, "Cancel task", onSubmit);
    this.returnSubmits = false;
    this.task = task;
  }

  onOpen(): void {
    const form = this.prepare(
      "Cancel this task",
      "The task is closed without being marked complete, and stops blocking discharge. It stays in the record."
    );
    form.createEl("h3", { text: this.task.task, attr: { dir: "auto" } });
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
  private readonly additional: boolean;

  constructor(
    app: App,
    episode: EpisodeRecord,
    patientLabel: string,
    onSubmit: AsyncSubmit<CompleteProcedureInput>,
    /**
     * `additional`: the episode already has a logged procedure and has moved
     * on from OR booking; this logs another without changing its workflow.
     */
    options: { additional?: boolean } = {}
  ) {
    super(app, options.additional ? "Log procedure" : "Complete surgery", onSubmit);
    this.additional = options.additional === true;
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
    const form = this.prepare(
      this.additional ? "Add another procedure" : "Complete surgery",
      `${this.patientLabel} · ${bidiIsolate(this.episode.case)}`
    );
    if (this.additional) {
      form.createEl("p", {
        text: "This episode already has a logged procedure. This adds another logbook entry; the episode's pathway, status and next action stay as they are, and a follow-up task is added only if you ask for one.",
        cls: "clinical-section-note"
      });
    }
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
    for (const [index, issue] of this.issues.entries()) {
      const row = list.createDiv({ cls: "clinical-integrity-issue" });
      const head = row.createDiv({ cls: "clinical-card-top" });
      head.createEl("strong", { text: issue.message });
      head.createSpan({ text: issue.severity, cls: `clinical-badge is-${issue.severity === "error" ? "emergency" : "urgent"}` });
      row.createEl("p", { text: issue.recordId, cls: "clinical-card-meta" });
      const open = row.createEl("button", {
        text: "Open record",
        cls: "clinical-card-button",
        // One button per issue, so say which. Some messages name a folder;
        // the accessible name carries the position and record id, never a path.
        attr: {
          "aria-label": `Open record — issue ${index + 1} of ${this.issues.length}${issue.recordId ? `, ${issue.recordId}` : ""}`
        }
      });
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
        text: "No task template matches this episode. Create one in the templates folder; the task templates section of the everyday-use guide shows the format.",
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
      // Type, priority and date are spelled out for every item: a hand-typed
      // value the reader did not recognise falls back to "other", the
      // episode's priority, or no date, and must be visible before applying.
      for (const item of bundle.tasks.slice(0, 6)) {
        const details = [
          taskTypeLabel(item.taskType),
          item.priority ? priorityLabel(item.priority) : "episode's priority",
          item.dueInDays !== null
            ? `due in ${item.dueInDays} day${item.dueInDays === 1 ? "" : "s"}`
            : "no due date"
        ];
        card.createEl("p", {
          text: `• ${bidiIsolate(item.task)} — ${details.join(" · ")}`,
          cls: "clinical-card-meta"
        });
      }
      if (bundle.tasks.length > 6) {
        card.createEl("p", { text: `…and ${bundle.tasks.length - 6} more`, cls: "clinical-card-meta" });
      }
      if (bundle.warnings.length) {
        card.createEl("p", { text: "Check this template:", cls: "clinical-card-meta" });
        const warnings = card.createEl("ul", { cls: "clinical-template-warnings" });
        for (const warning of bundle.warnings) warnings.createEl("li", { text: warning });
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
      head.createSpan({ text: formatLocalDateTime(event.created_at), cls: "clinical-card-meta" });
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

/**
 * The view's own task actions, run after this sheet closes so the view's
 * refresh, not this sheet's snapshot, shows the result.
 */
export interface PatientDetailTaskActions {
  complete: (task: TaskRecord) => void;
  reschedule: (task: TaskRecord) => void;
}

/** One screen per patient: episodes, work, logbook, and trail together. */
export class PatientDetailModal extends ClinicalResponsiveModal {
  constructor(
    app: App,
    private readonly data: PatientDetailData,
    private readonly onOpenRecord: (entity: "patient" | "episode" | "task" | "procedure", id: string) => void,
    private readonly onReopenTask: (taskId: string) => void,
    private readonly taskActions: PatientDetailTaskActions | null = null
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
      const taskActions = this.taskActions;
      if (!taskActions) continue;
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      const context = bidiIsolate(task.task) || task.id;
      const complete = actions.createEl("button", {
        text: "Complete",
        cls: "clinical-card-button mod-cta",
        attr: { "aria-label": `Complete task ${context}` }
      });
      complete.addEventListener("click", () => {
        this.close();
        taskActions.complete(task);
      });
      const reschedule = actions.createEl("button", {
        text: "Reschedule",
        cls: "clinical-card-button",
        attr: { "aria-label": `Reschedule task ${context}` }
      });
      reschedule.addEventListener("click", () => {
        this.close();
        taskActions.reschedule(task);
      });
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
      head.createSpan({ text: formatLocalDateTime(event.created_at), cls: "clinical-card-meta" });
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

type ClinicalSearchEntity = "patient" | "episode" | "task" | "procedure";

interface ClinicalSearchRow {
  label: string;
  meta: string;
  entity: ClinicalSearchEntity;
  id: string;
  /** Whose record a non-patient row is; "" on patient rows. */
  patientLabel: string;
  /** searchKey of the row's own text plus its patient's name and MRN. */
  key: string;
  mrnKey: string;
}

const SEARCH_GROUP_LIMIT = 8;

/** One search box across patients, episodes, tasks, and the logbook. */
export class ClinicalSearchModal extends ClinicalResponsiveModal {
  private query = "";
  private resultsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  /** Built on first search. A snapshot can hold hundreds of records, so fold once, not per keystroke. */
  private searchIndex: ReadonlyArray<{ title: string; rows: ClinicalSearchRow[] }> | null = null;

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

  private buildSearchIndex(): ReadonlyArray<{ title: string; rows: ClinicalSearchRow[] }> {
    const patients = new Map(this.data.patients.map((patient) => [patient.id, patient]));
    // Episodes, tasks and procedures carry their patient's name and MRN, so a
    // patient search also finds their work and two patients' identical
    // "Case 1" rows can be told apart.
    const record = (
      entity: Exclude<ClinicalSearchEntity, "patient">,
      id: string,
      label: string,
      detail: string,
      ownText: string,
      patientId: string
    ): ClinicalSearchRow => {
      const patient = patients.get(patientId);
      const patientLabel = patient
        ? patientIdentityLabel(patient.mrn, patient.patient_name)
        : "MRN needed · Patient identity missing";
      return {
        label,
        meta: `${patientLabel} · ${detail}`,
        entity,
        id,
        patientLabel,
        key: searchKey(`${ownText} ${patient?.patient_name ?? ""} ${patient?.mrn ?? ""}`),
        mrnKey: mrnMatchKey(patient?.mrn)
      };
    };
    return [
      {
        title: "Patients",
        rows: this.data.patients.map((patient): ClinicalSearchRow => ({
          label: patientIdentityLabel(patient.mrn, patient.patient_name),
          meta: patient.status,
          entity: "patient",
          id: patient.id,
          patientLabel: "",
          key: searchKey(`${patient.patient_name} ${patient.mrn}`),
          mrnKey: mrnMatchKey(patient.mrn)
        }))
      },
      {
        title: "Episodes",
        rows: this.data.episodes.map((episode) =>
          record(
            "episode",
            episode.id,
            episode.case || "Case not recorded",
            `${pathwayLabel(episode.pathway)} · ${episode.status}`,
            episode.case,
            episode.patient_id
          )
        )
      },
      {
        title: "Tasks",
        rows: this.data.tasks.map((task) =>
          record(
            "task",
            task.id,
            task.task || "Task not recorded",
            `${task.status}${task.due_date ? ` · due ${task.due_date}` : ""}`,
            task.task,
            task.patient_id
          )
        )
      },
      {
        title: "Procedures",
        rows: this.data.procedures.map((procedure) =>
          record(
            "procedure",
            procedure.id,
            procedure.procedure || "Procedure not recorded",
            procedure.procedure_date || "No date",
            procedure.procedure,
            procedure.patient_id
          )
        )
      }
    ];
  }

  private renderResults(): void {
    if (!this.resultsEl || !this.statusEl) return;
    this.resultsEl.empty();
    // Folded on both sides, so an Arabic spelling variant or Arabic-Indic
    // digits typed on an iPhone keyboard still find the stored record.
    const query = searchKey(this.query);
    if (query.length < 2) {
      this.modalEl.addClass("is-search-compact");
      this.statusEl.addClass("clinical-empty");
      this.setSearchStatus("Type at least two characters to search.");
      return;
    }
    const queryMrn = mrnQueryKey(this.query);
    this.searchIndex ??= this.buildSearchIndex();
    const groups = this.searchIndex.map((group) => {
      const matching = group.rows.filter(
        (row) => row.key.includes(query) || (queryMrn !== "" && row.mrnKey === queryMrn)
      );
      return {
        title: group.title,
        rows: matching.slice(0, SEARCH_GROUP_LIMIT),
        hidden: Math.max(0, matching.length - SEARCH_GROUP_LIMIT)
      };
    });
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
    const hiddenCount = withRows.reduce((count, group) => count + group.hidden, 0);
    // A capped group used to look complete; say that more matched.
    this.setSearchStatus(
      `${resultCount} result${resultCount === 1 ? "" : "s"} shown${
        hiddenCount ? `; ${hiddenCount} more match — refine your search` : ""
      }.`
    );
    for (const group of withRows) {
      this.resultsEl.createEl("h3", { text: group.title, cls: "clinical-search-group" });
      const singular = group.title.toLocaleLowerCase().replace(/s$/, "");
      for (const row of group.rows) {
        const button = this.resultsEl.createEl("button", {
          cls: "clinical-quick-entry-option",
          attr: {
            type: "button",
            "aria-label": `Open ${singular}: ${row.label}${row.patientLabel ? `, ${row.patientLabel}` : ""}`
          }
        });
        button.createEl("strong", { text: row.label, attr: { dir: "auto" } });
        button.createSpan({ text: row.meta, cls: "clinical-section-note" });
        button.addEventListener("click", () => {
          this.close();
          this.onOpenRecord(row.entity, row.id);
        });
      }
      if (group.hidden) {
        this.resultsEl.createEl("p", {
          text: `+${group.hidden} more — refine your search`,
          cls: "clinical-section-note clinical-search-more"
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
