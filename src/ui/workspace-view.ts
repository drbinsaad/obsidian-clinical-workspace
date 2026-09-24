import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type {
  ClinicalSnapshot,
  EpisodeRecord,
  EventRecord,
  NewEpisodeInput,
  Pathway,
  PatientRecord,
  Priority,
  ProcedureRecord,
  TaskRecord,
  TaskType
} from "../domain/types";
import { PATHWAYS, PRIORITIES } from "../domain/types";
import {
  careSettingLabel,
  daysOverdue,
  displayPhone,
  episodeNeedsReview,
  isoDateWithOffset,
  normalizeComparable,
  normalizeMrn,
  normalizeText,
  pathwayLabel,
  priorityLabel,
  taskIsDueToday,
  taskIsOpen,
  taskIsOverdue,
  taskIsUndated,
  taskIsUpcoming,
  taskTypeLabel,
  todayIso
} from "../domain/schema";
import { clinicalFolder } from "../data/paths";
import { listTaskBundles, type TaskBundle } from "../data/templates";
import { buildHandoverNote } from "../services/handover";
import {
  buildPatientListCsv,
  buildPatientListMarkdown,
  countDistinctPatients,
  patientListFileBaseName,
  selectPatientListRows,
  type PatientListFilter,
  type PatientListRequest
} from "../services/patient-list";
import type { ClinicalSettings } from "../domain/settings";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { ClinicalRepository } from "../data/repository";
import type { QuickEntryAction } from "../quick-entry";
import {
  ClinicalService,
  MrnIdentityConflictError,
  PossibleDuplicatePatientError,
  type CreateEpisodeResult,
  type ReopenTaskResult
} from "../services/clinical-service";
import { IntegrityService } from "../services/integrity";
import { seedSyntheticFixtures } from "../services/synthetic-fixtures";
import {
  ApplyTemplateModal,
  ArchiveEpisodeModal,
  CancelTaskModal,
  ClinicalSearchModal,
  ClinicalSubmitCancelled,
  DuplicatePatientModal,
  EpisodeHistoryModal,
  IntegrityReportModal,
  MergePatientsModal,
  MrnOwnerConflictModal,
  NewEpisodeModal,
  NewTaskModal,
  PatientDetailModal,
  PatientIdentityModal,
  PatientListModal,
  ProcedureModal,
  QuickEntryEpisodeModal,
  QuickEntryModal,
  RescheduleTaskModal,
  UpdateEpisodeModal,
  type QuickEntryEpisodeChoice,
  bidiIsolate,
  patientIdentityLabel
} from "./modals";
import {
  compactClinicalRecoveryNotice,
  showClinicalErrorNotice,
  showClinicalNotice
} from "./notices";

export const CLINICAL_WORKSPACE_VIEW = "clinical-workspace-view";

type WorkspaceTab = "today" | "patients" | "tasks" | "surgery" | "more";

const TAB_LABELS: Record<WorkspaceTab, string> = {
  today: "Today",
  patients: "Patients",
  tasks: "Tasks",
  surgery: "Surgery",
  more: "More"
};

let workspaceViewInstanceSequence = 0;
export const CLINICAL_PAGE_SIZE = 40;

export type ClinicalWorkspacePaneMode = "wide" | "compact" | "narrow";

export const CLINICAL_WORKSPACE_WIDE_MIN_WIDTH = 1050;
export const CLINICAL_WORKSPACE_COMPACT_MIN_WIDTH = 680;
export const CLINICAL_WORKSPACE_PANE_CLASSES = [
  "is-wide",
  "is-compact",
  "is-narrow"
] as const;

/**
 * Recovery hooks the plugin lends the view for its read-only banner. Both
 * stay identifier-free: the banner text is the repository's barrier reason.
 */
export interface ClinicalWorkspaceRecoveryHost {
  /** True while the listed records may be only part of what Sync will deliver. */
  recordsMayBeIncomplete: () => boolean;
  /** Runs the same recheck as the “Recheck records and unlock editing” command. */
  recheck: () => Promise<void>;
}

export interface ClinicalWorkspacePaneHost {
  readWidth: () => number;
  observeWidth: (listener: (width: number) => void) => () => void;
  applyMode: (mode: ClinicalWorkspacePaneMode) => void;
  resetMode: () => void;
}

/** A redraw may return focus only when no newer interaction now owns it. */
export function clinicalActionFocusMayReturn(
  action: HTMLElement,
  ownerDocument: Document | undefined = (
    action as HTMLElement & { ownerDocument?: Document }
  ).ownerDocument
): boolean {
  if (!ownerDocument) return true;
  const active = ownerDocument.activeElement as HTMLElement | null;
  return !active ||
    active === action ||
    active === ownerDocument.body ||
    active === ownerDocument.documentElement ||
    active.isConnected === false;
}

/**
 * Chooses layout from the leaf's content width, not the Obsidian window. A
 * stacked tab can be narrow inside a wide desktop window, so viewport media
 * queries cannot make this decision reliably.
 */
export function clinicalWorkspacePaneMode(width: number): ClinicalWorkspacePaneMode {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  if (safeWidth >= CLINICAL_WORKSPACE_WIDE_MIN_WIDTH) return "wide";
  if (safeWidth >= CLINICAL_WORKSPACE_COMPACT_MIN_WIDTH) return "compact";
  return "narrow";
}

/** Owns resize transitions and guarantees that observation ends with the view. */
export class ClinicalWorkspacePaneController {
  private disconnect: (() => void) | null = null;
  private mode: ClinicalWorkspacePaneMode | null = null;
  private running = false;

  constructor(private readonly host: ClinicalWorkspacePaneHost) {}

  private readonly sync = (width: number): void => {
    if (!this.running) return;
    // Hidden/inactive leaves can briefly measure zero while a stacked tab is
    // sliding. Retain the last valid mode instead of flashing to narrow.
    if (!Number.isFinite(width) || width <= 0) return;
    const next = clinicalWorkspacePaneMode(width);
    if (next === this.mode) return;
    this.mode = next;
    this.host.applyMode(next);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sync(this.host.readWidth());
    this.disconnect = this.host.observeWidth(this.sync);
  }

  measure(): void {
    this.sync(this.host.readWidth());
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.disconnect?.();
    this.disconnect = null;
    this.mode = null;
    this.host.resetMode();
  }
}

function elementWidth(element: HTMLElement): number {
  const rectWidth = element.getBoundingClientRect().width;
  return Number.isFinite(rectWidth) && rectWidth > 0 ? rectWidth : element.clientWidth;
}

/**
 * Uses the element's owning window so a Clinical Workspace moved into an
 * Obsidian pop-out observes through that window's DOM realm as well.
 */
export function createClinicalWorkspacePaneHost(element: HTMLElement): ClinicalWorkspacePaneHost {
  return {
    readWidth: () => elementWidth(element),
    observeWidth: (listener) => {
      const ResizeObserverConstructor = element.ownerDocument.defaultView?.ResizeObserver;
      if (!ResizeObserverConstructor) return () => undefined;
      const observer = new ResizeObserverConstructor((entries) => {
        const entry = entries.find((candidate) => candidate.target === element) ?? entries[0];
        listener(entry?.contentRect.width ?? elementWidth(element));
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    applyMode: (mode) => {
      for (const className of CLINICAL_WORKSPACE_PANE_CLASSES) {
        element.classList.toggle(className, className === `is-${mode}`);
      }
    },
    resetMode: () => {
      element.classList.remove(...CLINICAL_WORKSPACE_PANE_CLASSES);
    }
  };
}

const LIST_PAGE_LABELS: Record<string, string> = {
  "today-ward": "Ward round",
  "today-overdue": "Overdue tasks",
  "today-due": "Today tasks",
  "today-upcoming": "Upcoming tasks",
  "today-undated": "Undated tasks",
  "patients-inpatient": "Inpatients",
  "patients-outpatient": "Outpatients",
  "tasks-open": "Open tasks",
  "surgery-bookings": "OR bookings",
  "surgery-logbook": "Surgery logbook",
  "more-patients": "Patient records",
  "more-archive": "Archived episodes"
};

/** The paged lists each tab's filter chips narrow. */
const PATIENT_FILTER_PAGES = ["patients-inpatient", "patients-outpatient"] as const;
const TASK_FILTER_PAGES = ["tasks-open"] as const;

/**
 * What identifies the control that held focus before a redraw, so the
 * rebuilt copy of it can take focus back.
 */
interface FocusedControlKey {
  id: string;
  pageKey: string;
  pageAction: string;
  /** Lower-case tag name, such as "button", or "h4" for a focused card heading. */
  tag: string;
  name: string;
  /** Which of the same-tag elements sharing this name it was. */
  occurrence: number;
  /** The record a card action belongs to, and its visible label. */
  recordId: string;
  action: string;
}

function controlName(control: Element): string {
  return control.getAttribute("aria-label") ?? (control.textContent ?? "").trim();
}

/**
 * Merged, merging and retired patients have no sheet of their own: their
 * episodes and work are split across records, and the service refuses task
 * changes while a merge is in progress.
 */
function hasPatientSheet(patient: PatientRecord | undefined): patient is PatientRecord {
  return Boolean(
    patient &&
    patient.status === "active" &&
    !patient.merged_into &&
    !patient.merge_in_progress
  );
}

export interface PageWindow<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/**
 * Keeps mobile rendering bounded while preserving the full result count.
 * Frontmatter is user-editable and Sync can remove records between refreshes,
 * so an out-of-range page is clamped rather than rendering an empty panel.
 */
export function pageWindow<T>(items: readonly T[], requestedPage: number): PageWindow<T> {
  const pages = Math.max(1, Math.ceil(items.length / CLINICAL_PAGE_SIZE));
  const requested = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const page = Math.min(Math.max(0, requested), pages - 1);
  const start = page * CLINICAL_PAGE_SIZE;
  return {
    items: items.slice(start, start + CLINICAL_PAGE_SIZE),
    page,
    pages,
    total: items.length
  };
}

/** How long the "Task completed" notice keeps its Undo button. */
export const UNDO_COMPLETE_NOTICE_MS = 9000;

/**
 * What Add patient reports. Identifier-free: a reused chart is described by
 * how it was matched, never by whose it is.
 */
function newEpisodeNotice(result: CreateEpisodeResult, input: NewEpisodeInput): string {
  if (result.duplicateEpisode) return "This active case already exists; the existing episode was kept.";
  if (input.existingPatientId) {
    return normalizeMrn(input.mrn)
      ? "Episode added to the chosen patient record, and the MRN was recorded on it."
      : "Episode added to the chosen patient record.";
  }
  if (result.reusedPatient) {
    return input.confirmMrnOwner
      ? "Episode added to the existing patient record for this MRN; the stored name was kept."
      : "Episode added to an existing patient record (matched by MRN).";
  }
  return "Patient episode created.";
}

/**
 * What adding a task reports. Notices stay free of clinical text, so the
 * task's wording is left to the card and the note.
 */
function taskAddedNotice(duplicate: boolean): string {
  return duplicate ? "Task already exists." : "Task added.";
}

/** A closed task's status in fixed words; a hand-edited status is never echoed. */
function closedTaskStatusLabel(status: string): string {
  if (status === "completed" || status === "cancelled") return status;
  if (status === "entered-in-error") return "entered in error";
  return "closed";
}

/** Identifier-free; says what happened to a recurring task's next occurrence. */
function reopenedTaskNotice(result: Pick<ReopenTaskResult, "nextOccurrence">): string {
  if (result.nextOccurrence === "cancelled") return "Task reopened. Its next occurrence was withdrawn.";
  if (result.nextOccurrence === "kept") {
    return "Task reopened. Its next occurrence was changed, so it was left open.";
  }
  return "Task reopened.";
}

/**
 * Task/procedure shortcuts can target only a visible, active patient Episode.
 * The returned choices are labels for an explicit picker, never an automatic
 * attachment decision. A procedure goes on an OR booking, or on an episode
 * that has moved on after a logged procedure, as another procedure.
 */
export function quickEntryEpisodeChoices(
  snapshot: ClinicalSnapshot,
  currentEpisodeId = "",
  purpose: "task" | "procedure" = "task"
): QuickEntryEpisodeChoice[] {
  const patients = new Map(
    snapshot.patients
      .filter(
        (patient) =>
          patient.status === "active" &&
          !patient.merged_into &&
          !patient.merge_in_progress
      )
      .map((patient) => [patient.id, patient] as const)
  );
  const withProcedure = new Set(
    snapshot.procedures
      .filter((procedure) => procedure.status === "completed")
      .map((procedure) => procedure.episode_id)
  );
  return snapshot.episodes
    .filter(
      (episode) =>
        !["archived", "cancelled", "entered-in-error"].includes(episode.status) &&
        (purpose !== "procedure" || episode.pathway === "or-booking" || withProcedure.has(episode.id))
    )
    .flatMap((episode) => {
      const patient = patients.get(episode.patient_id);
      if (!patient) return [];
      return [{
        episode,
        patientLabel: patientIdentityLabel(patient.mrn, patient.patient_name),
        isCurrent: episode.id === currentEpisodeId,
        patientMrn: patient.mrn,
        ...(purpose === "procedure" && episode.pathway !== "or-booking"
          ? { additionalProcedure: true }
          : {})
      }];
    })
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return `${a.patientLabel}|${a.episode.case}`.localeCompare(
        `${b.patientLabel}|${b.episode.case}`
      );
    });
}

export class ClinicalWorkspaceView extends ItemView {
  private readonly instanceId = ++workspaceViewInstanceSequence;
  private activeTab: WorkspaceTab = "today";
  private refreshing = false;
  private refreshQueued = false;
  /** In-session filters for the Tasks tab; "all" shows everything. */
  private taskPriorityFilter: Priority | "all" = "all";
  private taskTypeFilter: TaskType | "all" = "all";
  /** In-session filters for the Patients tab; "all" shows everything. */
  private patientPathwayFilter: Pathway | "all" = "all";
  private patientPriorityFilter: Priority | "all" = "all";
  private paneController: ClinicalWorkspacePaneController | null = null;
  private paneOwnerWindow: Window | null = null;
  private readonly listPages = new Map<string, number>();
  private pendingPageContext: {
    key: string;
    action: "previous" | "next";
    scrollTop: number;
    /** Enter or Space on the pager, as opposed to a tap or click. */
    keyboard: boolean;
    /** How many refreshes had started when the pager was pressed. */
    refreshesStarted: number;
  } | null = null;
  private renderGeneration = 0;
  /** Tasks whose completion this view is writing now. */
  private readonly completingTasks = new Set<string>();
  /** Counts refreshes as they start; a render knows which one it belongs to. */
  private refreshesStarted = 0;
  private renderingRefresh = 0;
  private writeBlockSlot: HTMLElement | null = null;

  private tabId(tab: WorkspaceTab): string {
    return `clinical-workspace-${this.instanceId}-tab-${tab}`;
  }

  private panelId(): string {
    return `clinical-workspace-${this.instanceId}-panel`;
  }

  constructor(
    leaf: WorkspaceLeaf,
    private readonly repository: ClinicalRepository,
    private readonly service: ClinicalService,
    private readonly integrity: IntegrityService,
    private readonly getSettings: () => ClinicalSettings = () => DEFAULT_SETTINGS,
    private readonly recovery: ClinicalWorkspaceRecoveryHost | null = null
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CLINICAL_WORKSPACE_VIEW;
  }

  getDisplayText(): string {
    return "Clinical Workspace";
  }

  getIcon(): string {
    return "stethoscope";
  }

  /** Do not invite data entry when the repository already knows it cannot save. */
  private canOpenWriteForm(): boolean {
    const reason = this.repository.getWriteBlockReason();
    if (!reason) return true;
    showClinicalNotice(reason, 9000);
    return false;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("clinical-workspace-view");
    this.bindPaneController();
    await this.refresh();
  }

  onResize(): void {
    this.bindPaneController();
    this.paneController?.measure();
  }

  async onClose(): Promise<void> {
    this.paneController?.stop();
    this.paneController = null;
    this.paneOwnerWindow = null;
  }

  /** Rebinds after Obsidian moves this leaf into or out of a pop-out window. */
  private bindPaneController(): void {
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (this.paneController && ownerWindow === this.paneOwnerWindow) return;
    this.paneController?.stop();
    this.paneOwnerWindow = ownerWindow;
    this.paneController = new ClinicalWorkspacePaneController(
      createClinicalWorkspacePaneHost(this.contentEl)
    );
    this.paneController.start();
  }

  /**
   * Re-reads the vault and redraws. A change arriving while a refresh is in
   * flight is queued rather than dropped, otherwise a sync burst can leave the
   * interface showing stale data with no indication.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    const started = ++this.refreshesStarted;
    try {
      const snapshot = await this.repository.snapshot();
      this.renderingRefresh = started;
      this.render(snapshot);
    } catch (error) {
      this.renderFailure(error);
    } finally {
      this.refreshing = false;
    }
    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.refresh();
    }
  }

  openAddPatient(seed?: Partial<NewEpisodeInput>): void {
    // The workspace can open read-only; never collect input it cannot save.
    if (!this.canOpenWriteForm()) return;
    const settings = this.getSettings();
    const defaults: Partial<NewEpisodeInput> = {
      careSetting: settings.defaultCareSetting,
      pathway: settings.defaultPathway,
      priority: settings.defaultPriority,
      ...seed
    };
    new NewEpisodeModal(this.app, (input) => this.submitNewEpisode(input), defaults).open();
  }

  /**
   * Files the Add patient form. A question about who the patient is gets
   * asked while the form stays open, and backing out of it returns to the
   * form with everything still typed. Each resubmission carries only the
   * answer the user gave; the form's own values are never changed.
   */
  private async submitNewEpisode(input: NewEpisodeInput): Promise<void> {
    let result: CreateEpisodeResult;
    try {
      result = await this.service.createEpisode(input);
    } catch (error) {
      if (error instanceof PossibleDuplicatePatientError) {
        const patientId = await this.askWhichPatient(error.candidates, input.mrn);
        if (patientId === undefined) throw new ClinicalSubmitCancelled();
        return this.submitNewEpisode(
          patientId ? { ...input, existingPatientId: patientId } : { ...input, forceNewPatient: true }
        );
      }
      if (error instanceof MrnIdentityConflictError) {
        const useStoredPatient = await this.askMrnOwner(error.patient, input.patientName);
        if (!useStoredPatient) {
          throw new ClinicalSubmitCancelled("Nothing was saved. Check the MRN, then submit again.", "MRN");
        }
        return this.submitNewEpisode({ ...input, confirmMrnOwner: error.patient.id });
      }
      throw error;
    }
    new Notice(newEpisodeNotice(result, input));
    this.activeTab = "patients";
    await this.refresh();
  }

  /** Resolves to the chosen patient's id, null for a separate patient, or undefined on cancel. */
  private askWhichPatient(candidates: PatientRecord[], enteredMrn: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      new DuplicatePatientModal(this.app, candidates, resolve, {
        enteredMrn: normalizeMrn(enteredMrn),
        onCancel: () => resolve(undefined)
      }).open();
    });
  }

  /** Resolves true only when the user confirms the MRN's stored owner is this patient. */
  private askMrnOwner(stored: PatientRecord, typedName: string): Promise<boolean> {
    return new Promise((resolve) => {
      new MrnOwnerConflictModal(this.app, stored, typedName, resolve).open();
    });
  }

  openQuickEntry(activeEpisodePath = ""): void {
    new QuickEntryModal(
      this.app,
      (action) => this.runQuickEntryAction(action, activeEpisodePath)
    ).open();
  }

  /** Opens Today and refreshes from disk so a shortcut never shows a stale list. */
  async openTodayPendingWork(): Promise<void> {
    this.activeTab = "today";
    await this.refresh();
  }

  /** Always shows an unselected Episode picker before opening the task form. */
  async openAddTaskQuickEntry(activeEpisodePath = ""): Promise<void> {
    if (!this.canOpenWriteForm()) return;
    try {
      const choices = await this.quickEntryChoices(activeEpisodePath, "task");
      if (!choices.length) {
        new Notice("No active patient episode is available. Create an episode first.");
        return;
      }
      new QuickEntryEpisodeModal(this.app, "a task / follow-up", choices, (choice) => {
        if (!this.canOpenWriteForm()) return;
        new NewTaskModal(this.app, choice.episode, choice.patientLabel, async (input) => {
          const created = await this.service.createTask(input);
          new Notice(taskAddedNotice(created.duplicate));
          this.activeTab = "tasks";
          await this.refresh();
        }).open();
      }).open();
    } catch (error) {
      showClinicalErrorNotice(error, "Could not open task quick entry.");
    }
  }

  /** Always shows an unselected Episode picker before opening the procedure form. */
  async openProcedureQuickEntry(activeEpisodePath = ""): Promise<void> {
    if (!this.canOpenWriteForm()) return;
    try {
      const choices = await this.quickEntryChoices(activeEpisodePath, "procedure");
      if (!choices.length) {
        new Notice(
          "No active operating-room booking episode, or episode with a logged procedure, is available. Move an episode to the operating-room booking pathway first."
        );
        return;
      }
      new QuickEntryEpisodeModal(this.app, "a procedure", choices, (choice) => {
        if (!this.canOpenWriteForm()) return;
        const additional = choice.additionalProcedure === true;
        new ProcedureModal(this.app, choice.episode, choice.patientLabel, async (input) => {
          await this.service.completeProcedure(input);
          new Notice(additional ? "Procedure added to the logbook." : "Procedure logged and workflow updated.");
          this.activeTab = "surgery";
          await this.refresh();
        }, { additional }).open();
      }).open();
    } catch (error) {
      showClinicalErrorNotice(error, "Could not open procedure quick entry.");
    }
  }

  private runQuickEntryAction(
    action: Exclude<QuickEntryAction, "hub">,
    activeEpisodePath: string
  ): void {
    switch (action) {
      case "new-patient-episode":
        this.openAddPatient();
        break;
      case "add-task-follow-up":
        void this.openAddTaskQuickEntry(activeEpisodePath);
        break;
      case "record-procedure":
        void this.openProcedureQuickEntry(activeEpisodePath);
        break;
      case "today":
        void this.openTodayPendingWork();
        break;
    }
  }

  /**
   * An exact active-file match can be promoted as a suggestion, but it remains
   * an unselected picker row. The scoped Episode listing — not arbitrary note
   * frontmatter — is the authority for that match.
   */
  private async quickEntryChoices(
    activeEpisodePath: string,
    purpose: "task" | "procedure"
  ): Promise<QuickEntryEpisodeChoice[]> {
    const [patients, episodes, procedures] = await Promise.all([
      this.repository.list<PatientRecord>("patient"),
      this.repository.list<EpisodeRecord>("episode"),
      purpose === "procedure" ? this.repository.list<ProcedureRecord>("procedure") : Promise.resolve([])
    ]);
    const currentEpisodeId = episodes.find(
      (item) => item.path === activeEpisodePath
    )?.record.id ?? "";
    return quickEntryEpisodeChoices(
      {
        patients: patients.map((item) => item.record),
        episodes: episodes.map((item) => item.record),
        tasks: [],
        procedures: procedures.map((item) => item.record)
      },
      currentEpisodeId,
      purpose
    );
  }

  private lastRenderedTab: WorkspaceTab | null = null;

  private render(snapshot: ClinicalSnapshot): void {
    this.renderGeneration += 1;
    this.indexSnapshot(snapshot);
    const root = this.contentEl;
    // A background refresh — a sync burst, another device's write — redraws
    // in place. Losing the reading position on every redraw makes long lists
    // unusable mid-ward-round, so the scroll offset survives same-tab
    // renders; a deliberate tab switch still starts at the top.
    const previousScroller = root.querySelector(".clinical-workspace-scroll");
    const previousScrollTop = previousScroller?.instanceOf(HTMLElement)
      ? previousScroller.scrollTop
      : 0;
    const sameTab = this.lastRenderedTab === this.activeTab;
    this.lastRenderedTab = this.activeTab;
    const focusKey = this.focusedControlKey(root);
    root.empty();
    // The scroller is nested inside the view so the floating action button can
    // be a sibling of it: pinned to the view, and not scrolling away with the
    // content the way an absolutely positioned child of a scroller would.
    const scroller = root.createDiv({ cls: "clinical-workspace-scroll" });
    const shell = scroller.createDiv({ cls: "clinical-workspace-shell" });
    this.writeBlockSlot = shell.createDiv({ cls: "clinical-write-block-slot" });
    this.syncWriteBlockBanner();
    this.renderHeader(shell);
    const activeTab = this.renderTabs(shell);
    const panel = shell.createDiv({
      cls: "clinical-workspace-panel",
      attr: { id: this.panelId(), role: "tabpanel", "aria-labelledby": this.tabId(this.activeTab) }
    });
    switch (this.activeTab) {
      case "today":
        this.renderToday(panel, snapshot);
        break;
      case "patients":
        this.renderPatients(panel, snapshot);
        break;
      case "tasks":
        this.renderTasks(panel, snapshot);
        break;
      case "surgery":
        this.renderSurgery(panel, snapshot);
        break;
      case "more":
        this.renderMore(panel, snapshot);
        break;
    }
    const add = root.createEl("button", {
      text: "+",
      attr: { "aria-label": "Add patient" },
      cls: "mod-cta clinical-primary-action"
    });
    add.addEventListener("click", () => this.openAddPatient());
    const pageChange = this.pendingPageContext !== null;
    if (!pageChange && sameTab && previousScrollTop > 0) {
      scroller.scrollTop = previousScrollTop;
    }
    this.restorePageContext(scroller);
    this.revealActiveTab(activeTab, scroller);
    // A page change places focus itself; any other redraw hands focus back.
    if (focusKey && !pageChange) this.restoreFocusedControl(focusKey);
  }

  /**
   * Every vault or Sync event redraws the whole view, and the plugin's own
   * writes arrive twice (the action's refresh, then the vault event). Each
   * redraw destroyed the focused control and left keyboard and VoiceOver
   * users at the top of the document. Null when focus is elsewhere, so a
   * redraw never pulls focus out of the editor or an open form.
   */
  private focusedControlKey(root: HTMLElement): FocusedControlKey | null {
    const ownerDocument = (root as HTMLElement & { ownerDocument?: Document }).ownerDocument;
    const active = ownerDocument?.activeElement;
    if (!active?.instanceOf(HTMLElement) || active === root || !root.contains(active)) return null;
    const tag = active.tagName.toLowerCase();
    const name = controlName(active);
    const pager = active.closest(".clinical-pagination");
    return {
      id: active.getAttribute("id") ?? "",
      pageKey: pager?.instanceOf(HTMLElement) ? pager.dataset.pageKey ?? "" : "",
      pageAction: active.dataset.pageAction ?? "",
      tag,
      name,
      occurrence: Math.max(0, this.namesakes(root, tag, name).indexOf(active)),
      recordId: active.dataset.recordId ?? "",
      action: active.dataset.action ?? ""
    };
  }

  /** The card action with this label on this record's card, if still drawn. */
  private recordControl(recordId: string, action: string): HTMLElement | undefined {
    return Array.from(this.contentEl.querySelectorAll("button")).find(
      (control) => control.dataset.recordId === recordId && control.dataset.action === action
    );
  }

  /** Elements with this tag and accessible name, in document order. */
  private namesakes(root: HTMLElement, tag: string, name: string): Element[] {
    if (!tag || !name) return [];
    return Array.from(root.querySelectorAll(tag)).filter((element) => controlName(element) === name);
  }

  private restoreFocusedControl(key: FocusedControlKey): void {
    const root = this.contentEl;
    const byId = key.id
      ? Array.from(root.querySelectorAll("[id]")).find((element) => element.getAttribute("id") === key.id)
      : undefined;
    const byPage = key.pageKey && key.pageAction
      ? this.pagerControl(key.pageKey, key.pageAction)
      : undefined;
    // A card action returns only to its own record's control. Matching by
    // name moved focus from a completed recurring task onto the next
    // occurrence's identically named Complete, one keypress from closing
    // work not yet done.
    const byRecord = key.recordId ? this.recordControl(key.recordId, key.action) : undefined;
    const sameName = key.recordId ? [] : this.namesakes(root, key.tag, key.name);
    const target = byId ?? byPage ?? byRecord ?? sameName[Math.min(key.occurrence, sameName.length - 1)];
    if (target?.instanceOf(HTMLElement)) {
      // A card heading is focusable only once paging has focused it.
      if (key.tag !== "button" && target.getAttribute("tabindex") === null) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
      return;
    }
    // The control went with its record (a completed task): keep focus in the
    // view rather than letting it fall to the document body.
    const heading = root.querySelector(".clinical-workspace-title");
    if (heading?.instanceOf(HTMLElement)) heading.focus({ preventScroll: true });
  }

  /**
   * Redraws only the read-only banner, so a Sync barrier opening or closing
   * never re-renders the lists or moves the reading position.
   */
  syncWriteBlockBanner(): void {
    const slot = this.writeBlockSlot;
    const recovery = this.recovery;
    if (!slot || !recovery) return;
    // Emptying the slot destroys a focused Recheck now button, which dropped
    // keyboard and VoiceOver users to the document body. Inside render() the
    // slot is new, so focus is never in it and render() places focus itself.
    const ownerDocument = (this.contentEl as HTMLElement & { ownerDocument?: Document }).ownerDocument;
    const active = ownerDocument?.activeElement;
    const hadFocus = Boolean(active?.instanceOf(HTMLElement) && slot.contains(active));
    slot.empty();
    const reason = this.repository.getWriteBlockReason();
    if (!reason) {
      if (hadFocus) {
        const heading = this.contentEl.querySelector(".clinical-workspace-title");
        if (heading?.instanceOf(HTMLElement)) heading.focus({ preventScroll: true });
      }
      return;
    }
    const banner = slot.createDiv({
      cls: "clinical-write-block-banner",
      attr: { role: "status" }
    });
    banner.createEl("strong", { text: "Editing is paused", cls: "clinical-write-block-title" });
    banner.createEl("p", {
      text: compactClinicalRecoveryNotice(reason),
      cls: "clinical-write-block-text",
      attr: { title: reason }
    });
    if (recovery.recordsMayBeIncomplete()) {
      banner.createEl("p", {
        text: "The records shown may be incomplete until this is resolved.",
        cls: "clinical-write-block-text"
      });
    }
    const button = banner.createEl("button", {
      text: "Recheck now",
      cls: "clinical-card-button clinical-write-block-action"
    });
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      void recovery.recheck().finally(() => {
        button.disabled = false;
      });
    });
    if (hadFocus) button.focus({ preventScroll: true });
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "clinical-workspace-header" });
    const titles = header.createDiv({ cls: "clinical-workspace-heading" });
    titles.createEl("h2", {
      text: "Clinical Workspace",
      cls: "clinical-workspace-title",
      attr: { tabindex: "-1" }
    });
    titles.createDiv({ text: "Local-first patient workflow", cls: "clinical-workspace-subtitle" });
    const actions = header.createDiv({ cls: "clinical-workspace-header-actions" });
    const search = actions.createEl("button", {
      attr: { "aria-label": "Search clinical records" },
      cls: "clickable-icon clinical-refresh-button"
    });
    setIcon(search, "search");
    search.addEventListener("click", () => void this.openSearch());
    const quickEntry = actions.createEl("button", {
      cls: "clinical-quick-entry-button",
      attr: {
        "aria-label": "Open Clinical Workspace quick entry",
        title: "Quick entry"
      }
    });
    const quickEntryIcon = quickEntry.createSpan({
      cls: "clinical-quick-entry-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(quickEntryIcon, "square-pen");
    quickEntry.createSpan({ text: "Quick entry", cls: "clinical-quick-entry-label" });
    quickEntry.addEventListener("click", () => this.openQuickEntry());
    const refresh = actions.createEl("button", {
      attr: { "aria-label": "Refresh Clinical Workspace" },
      cls: "clickable-icon clinical-refresh-button"
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  private renderTabs(container: HTMLElement): HTMLElement | null {
    const tabs = container.createDiv({ cls: "clinical-workspace-tabs", attr: { role: "tablist" } });
    let activeButton: HTMLElement | null = null;
    for (const [tab, label] of Object.entries(TAB_LABELS) as [WorkspaceTab, string][]) {
      const selected = this.activeTab === tab;
      const button = tabs.createEl("button", {
        text: label,
        cls: `clinical-workspace-tab${selected ? " is-active" : ""}`,
        attr: {
          id: this.tabId(tab),
          role: "tab",
          "aria-selected": String(selected),
          "aria-controls": this.panelId(),
          // Roving tabindex: only the selected tab is in the tab order.
          tabindex: selected ? "0" : "-1"
        }
      });
      if (selected) activeButton = button;
      button.addEventListener("click", () => void this.selectTab(tab));
      button.addEventListener("keydown", (event) => this.handleTabKey(event, tab));
    }
    return activeButton;
  }

  /** Reveal the selected intrinsic-width tab without disturbing reading position. */
  private revealActiveTab(activeTab: HTMLElement | null, scroller: HTMLElement): void {
    if (!activeTab || typeof activeTab.scrollIntoView !== "function") return;
    const previousScrollTop = scroller.scrollTop;
    activeTab.scrollIntoView({ inline: "nearest", block: "nearest" });
    // scrollIntoView understands both RTL scroll models, but its block axis can
    // also touch the ancestor scroller. Keep this operation horizontal-only.
    scroller.scrollTop = previousScrollTop;
  }

  private selectTab(tab: WorkspaceTab): Promise<void> {
    this.activeTab = tab;
    return this.refresh();
  }

  private handleTabKey(event: KeyboardEvent, tab: WorkspaceTab): void {
    const order = Object.keys(TAB_LABELS) as WorkspaceTab[];
    const index = order.indexOf(tab);
    // In a right-to-left layout the tabs run right-to-left, so ArrowRight
    // must move to the visually-right tab — the PREVIOUS one in the array.
    const viewDirectionWindow = this.contentEl.ownerDocument.defaultView;
    const rtl =
      viewDirectionWindow?.getComputedStyle(this.contentEl).direction === "rtl";
    const forwardKey = rtl ? "ArrowLeft" : "ArrowRight";
    const backwardKey = rtl ? "ArrowRight" : "ArrowLeft";
    let next: WorkspaceTab | null = null;
    if (event.key === forwardKey) next = order[(index + 1) % order.length] ?? null;
    if (event.key === backwardKey) next = order[(index - 1 + order.length) % order.length] ?? null;
    if (event.key === "Home") next = order[0] ?? null;
    if (event.key === "End") next = order[order.length - 1] ?? null;
    if (!next) return;
    event.preventDefault();
    // Focus AFTER the async re-render completes. A zero-delay timer used to
    // focus the old tab button, which the redraw then destroyed — dropping
    // keyboard focus to the body on every arrow press.
    void this.selectTab(next).then(() => {
      const target = this.contentEl.querySelector(`#${this.tabId(next)}`);
      if (target?.instanceOf(HTMLElement)) target.focus();
    });
  }

  private renderToday(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const openTasks = snapshot.tasks.filter(taskIsOpen);
    // File order is effectively random and differs between devices, which
    // could leave an emergency below routine work, or on page 2.
    const byPriority = (a: TaskRecord, b: TaskRecord): number =>
      this.priorityFirstTaskSortKey(a).localeCompare(this.priorityFirstTaskSortKey(b));
    const todayTasks = openTasks.filter((task) => taskIsDueToday(task)).sort(byPriority);
    const overdueTasks = openTasks.filter((task) => taskIsOverdue(task)).sort(byPriority);
    const undatedTasks = openTasks.filter((task) => taskIsUndated(task)).sort(byPriority);
    const activeEpisodes = snapshot.episodes.filter((episode) => this.isActiveEpisode(episode));
    const inpatient = activeEpisodes.filter((episode) => episode.care_setting === "inpatient");
    const summary = container.createDiv({ cls: "clinical-summary-grid" });
    this.summaryCard(summary, todayTasks.length, "Due today");
    this.summaryCard(summary, overdueTasks.length, "Overdue");
    this.summaryCard(summary, inpatient.length, "Inpatients");
    this.summaryCard(summary, activeEpisodes.length, "Active episodes");

    // Ward round: inpatients in priority order, one glance per patient.
    const wardEpisodes = inpatient
      .slice()
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));
    if (wardEpisodes.length) {
      this.sectionHeader(
        container,
        "Ward round",
        `${wardEpisodes.length} inpatient${wardEpisodes.length === 1 ? "" : "s"}`,
        "today-ward"
      );
      const ward = container.createDiv({ cls: "clinical-ward-list" });
      // Paged like every other list: a fixed cut-off silently dropped the
      // lowest-priority inpatients while the header still counted them.
      const wardPage = this.pageFor("today-ward", wardEpisodes);
      for (const episode of wardPage.items) {
        const patient = this.patientFor(snapshot, episode.patient_id);
        const row = ward.createDiv({ cls: "clinical-ward-row" });
        const text = row.createDiv({ cls: "clinical-ward-text" });
        text.createEl("strong", { text: this.patientLabel(patient), attr: { dir: "auto" } });
        text.createSpan({
          text: `${episode.case ? bidiIsolate(episode.case) : "Case not recorded"} · ${priorityLabel(episode.priority)}${
            normalizeText(episode.next_action) ? ` · next: ${bidiIsolate(episode.next_action)}` : ""
          }${episode.due_date ? ` (${episode.due_date})` : ""}`,
          cls: "clinical-card-meta"
        });
        const context = this.episodeContext(episode, patient);
        const rowActions = row.createDiv({ cls: "clinical-ward-actions" });
        // The patient sheet (episodes, open work with Complete and
        // Reschedule, history) is what a round acts on; the raw note that
        // "Open" shows has no clinical actions, so it comes second.
        if (hasPatientSheet(patient)) {
          this.actionButton(rowActions, "View", () => this.openPatientDetail(patient), false, false, context, episode.id);
        }
        this.actionButton(rowActions, "Open", () => this.openRecord("episode", episode.id), false, false, context, episode.id);
      }
      this.renderPagination(container, "today-ward", wardPage);
    }

    this.sectionHeader(container, "Overdue", overdueTasks.length ? "Needs attention" : "All clear", "today-overdue");
    this.renderTaskList(container, overdueTasks, snapshot, "today-overdue");
    this.sectionHeader(container, "Today", todayIso(), "today-due");
    this.renderTaskList(container, todayTasks, snapshot, "today-due");
    // The coming week, so tomorrow's clinic is visible tonight without
    // leaving the Today view. Shown only when something is scheduled.
    const upcomingTasks = openTasks
      .filter((task) => taskIsUpcoming(task))
      .sort((a, b) => this.taskSortKey(a).localeCompare(this.taskSortKey(b)));
    if (upcomingTasks.length) {
      this.sectionHeader(container, "Next 7 days", `${upcomingTasks.length} scheduled`, "today-upcoming");
      this.renderTaskList(container, upcomingTasks, snapshot, "today-upcoming");
    }
    // Undated work is still outstanding; without this section Today under-reports.
    if (undatedTasks.length) {
      this.sectionHeader(container, "No date set", `${undatedTasks.length} open`, "today-undated");
      this.renderTaskList(container, undatedTasks, snapshot, "today-undated");
    }
  }

  private renderPatients(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    // Obsidian's mobile navbar shares the bottom edge with view content. A
    // floating, context-free "+" could cover the final card and did not say
    // what it created, so mobile layouts get one explicit action inside
    // Patients. CSS keeps this hidden on desktop, where the existing FAB remains.
    const mobileAction = container.createDiv({ cls: "clinical-mobile-context-action" });
    const addPatient = mobileAction.createEl("button", {
      cls: "mod-cta clinical-mobile-add-button",
      attr: { type: "button", "aria-label": "Add patient" }
    });
    const addPatientIcon = addPatient.createSpan({ cls: "clinical-mobile-add-icon" });
    setIcon(addPatientIcon, "user-plus");
    addPatient.createSpan({ text: "Add patient" });
    addPatient.addEventListener("click", () => this.openAddPatient());

    const allActive = snapshot.episodes.filter((episode) => this.isActiveEpisode(episode));
    this.renderPatientFilters(container, allActive);
    const active = allActive
      .filter(
        (episode) =>
          (this.patientPathwayFilter === "all" || episode.pathway === this.patientPathwayFilter) &&
          (this.patientPriorityFilter === "all" || episode.priority === this.patientPriorityFilter)
      )
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));
    const filtering = active.length !== allActive.length;
    const countNote = (shown: EpisodeRecord[], total: EpisodeRecord[]): string =>
      filtering ? `${shown.length} of ${total.length} shown` : `${total.length} active`;
    const clearFilters = (): void => {
      this.patientPathwayFilter = "all";
      this.patientPriorityFilter = "all";
    };
    const groups = [
      { title: "Inpatients", key: "patients-inpatient", inpatient: true },
      { title: "Outpatients", key: "patients-outpatient", inpatient: false }
    ];
    for (const group of groups) {
      const inSetting = (episode: EpisodeRecord): boolean =>
        (episode.care_setting === "inpatient") === group.inpatient;
      const shown = active.filter(inSetting);
      const total = allActive.filter(inSetting);
      this.sectionHeader(container, group.title, countNote(shown, total), group.key);
      if (!shown.length && total.length) {
        const noun = group.title.toLocaleLowerCase();
        this.renderFilteredEmpty(
          container,
          `No ${noun} match these filters.`,
          clearFilters,
          `show every ${noun.replace(/s$/, "")}`,
          PATIENT_FILTER_PAGES
        );
      } else {
        this.renderEpisodeList(container, shown, snapshot, group.key);
      }
    }
  }

  /**
   * A filter that hides a whole list says so and offers to clear it, rather
   * than an empty state that reads as "nothing to do".
   */
  private renderFilteredEmpty(
    container: HTMLElement,
    message: string,
    clear: () => void,
    accessibleContext: string,
    pageKeys: readonly string[]
  ): void {
    const list = container.createDiv({ cls: "clinical-list" });
    const empty = list.createDiv({ cls: "clinical-empty" });
    empty.createDiv({ text: message });
    const actions = empty.createDiv({ cls: "clinical-empty-actions" });
    this.actionButton(
      actions,
      "Clear filters",
      () => {
        this.changeFilters(clear, pageKeys);
        return this.refresh();
      },
      false,
      false,
      accessibleContext
    );
  }

  /**
   * Pathway and priority chips for the Patients tab, plus an export action
   * that starts from whatever the chips currently show.
   */
  private renderPatientFilters(container: HTMLElement, active: EpisodeRecord[]): void {
    const filters = container.createDiv({ cls: "clinical-chip-rows" });
    const chip = (row: HTMLElement, label: string, selected: boolean, apply: () => void): void =>
      this.filterChip(row, label, selected, apply, PATIENT_FILTER_PAGES);
    // A selected pathway stays visible even after its last episode closes, so
    // a filter can never hide the list without a chip that clears it. Only a
    // recognised pathway gets a chip: Export list cannot represent a
    // hand-edited value and widened such a seed to every pathway. Those
    // episodes stay listed under "All pathways".
    const knownPathways: readonly string[] = PATHWAYS;
    const pathwaysInUse = [
      ...new Set([
        ...active.map((episode) => episode.pathway),
        ...(this.patientPathwayFilter === "all" ? [] : [this.patientPathwayFilter])
      ])
    ]
      .filter((pathway) => knownPathways.includes(pathway))
      .sort((a, b) => pathwayLabel(a).localeCompare(pathwayLabel(b)));
    if (pathwaysInUse.length > 1 || this.patientPathwayFilter !== "all") {
      const pathwayRow = this.chipRow(filters, "Filter by pathway");
      chip(pathwayRow, "All pathways", this.patientPathwayFilter === "all", () => {
        this.patientPathwayFilter = "all";
      });
      for (const pathway of pathwaysInUse) {
        chip(pathwayRow, pathwayLabel(pathway), this.patientPathwayFilter === pathway, () => {
          this.patientPathwayFilter = this.patientPathwayFilter === pathway ? "all" : pathway;
        });
      }
    }
    const priorityRow = this.chipRow(filters, "Filter by priority");
    chip(priorityRow, "All", this.patientPriorityFilter === "all", () => {
      this.patientPriorityFilter = "all";
    });
    for (const priority of PRIORITIES) {
      chip(priorityRow, priorityLabel(priority), this.patientPriorityFilter === priority, () => {
        this.patientPriorityFilter = this.patientPriorityFilter === priority ? "all" : priority;
      });
    }
    const exportRow = container.createDiv({ cls: "clinical-card-actions clinical-patient-list-actions" });
    this.actionButton(
      exportRow,
      "Export list",
      () =>
        this.openPatientListExport({
          pathway: this.patientPathwayFilter,
          priority: this.patientPriorityFilter
        }),
      false,
      false,
      "save these patients to a note or CSV file"
    );
  }

  private renderTasks(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const open = snapshot.tasks.filter(taskIsOpen);
    const filtered = open
      .filter(
        (task) =>
          (this.taskPriorityFilter === "all" || task.priority === this.taskPriorityFilter) &&
          (this.taskTypeFilter === "all" || task.task_type === this.taskTypeFilter)
      )
      .sort((a, b) => this.taskSortKey(a).localeCompare(this.taskSortKey(b)));
    const filteredNote =
      filtered.length === open.length
        ? `${open.length} total`
        : `${filtered.length} of ${open.length} shown`;
    this.sectionHeader(container, "Open tasks", filteredNote, "tasks-open");
    this.renderTaskFilters(container, open);
    if (!filtered.length && open.length) {
      this.renderFilteredEmpty(container, "No open tasks match these filters.", () => {
        this.taskPriorityFilter = "all";
        this.taskTypeFilter = "all";
      }, "show every open task", TASK_FILTER_PAGES);
      return;
    }
    this.renderTaskList(container, filtered, snapshot, "tasks-open");
  }

  /** Chip rows: one for priority, one for the task types actually in use. */
  private renderTaskFilters(container: HTMLElement, open: TaskRecord[]): void {
    const filters = container.createDiv({ cls: "clinical-chip-rows" });
    const chip = (row: HTMLElement, label: string, selected: boolean, apply: () => void): void =>
      this.filterChip(row, label, selected, apply, TASK_FILTER_PAGES);

    const priorityRow = this.chipRow(filters, "Filter by priority");
    chip(priorityRow, "All", this.taskPriorityFilter === "all", () => {
      this.taskPriorityFilter = "all";
    });
    for (const priority of PRIORITIES) {
      chip(priorityRow, priorityLabel(priority), this.taskPriorityFilter === priority, () => {
        this.taskPriorityFilter = this.taskPriorityFilter === priority ? "all" : priority;
      });
    }

    // A selected type keeps its chip after its last task closes, as the
    // Patients pathway filter does; otherwise the filter went on hiding
    // every task with no chip left to clear it.
    const typesInUse = [
      ...new Set([
        ...open.map((task) => task.task_type),
        ...(this.taskTypeFilter === "all" ? [] : [this.taskTypeFilter])
      ])
    ].sort();
    if (typesInUse.length > 1 || this.taskTypeFilter !== "all") {
      const typeRow = this.chipRow(filters, "Filter by task type");
      chip(typeRow, "All types", this.taskTypeFilter === "all", () => {
        this.taskTypeFilter = "all";
      });
      for (const type of typesInUse) {
        chip(typeRow, taskTypeLabel(type), this.taskTypeFilter === type, () => {
          this.taskTypeFilter = this.taskTypeFilter === type ? "all" : type;
        });
      }
    }
  }

  /** A labelled group, so a screen reader says which filter a row of chips sets. */
  private chipRow(container: HTMLElement, label: string): HTMLElement {
    return container.createDiv({
      cls: "clinical-chip-row",
      attr: { role: "group", "aria-label": label }
    });
  }

  /**
   * One toggle chip in a filter row; selecting it redraws the current tab.
   * Its visible label is its accessible name, so a Voice Control user can
   * say what they see; aria-pressed and the row's label carry the rest.
   */
  private filterChip(
    row: HTMLElement,
    label: string,
    active: boolean,
    apply: () => void,
    pageKeys: readonly string[]
  ): void {
    const button = row.createEl("button", {
      text: label,
      cls: `clinical-chip${active ? " is-active" : ""}`,
      attr: { type: "button", "aria-pressed": String(active) }
    });
    button.addEventListener("click", () => {
      const ownerDocument = (
        button as HTMLButtonElement & { ownerDocument?: Document }
      ).ownerDocument;
      const ownedFocusAtStart = !ownerDocument || ownerDocument.activeElement === button;
      this.changeFilters(apply, pageKeys);
      // A filter change re-reads nothing it does not need; refresh() serves
      // the redraw and keeps the scroll position like any other re-render.
      void this.refresh().then(() => {
        if (
          ownedFocusAtStart &&
          clinicalActionFocusMayReturn(button, ownerDocument)
        ) this.restoreActionFocus(label);
      });
    });
  }

  /**
   * Applies a chip or Clear filters. When a filter really changed, the lists
   * it narrows start again at page 1: a kept page index was only clamped to
   * the last page of the new matches, hiding the highest-priority ones.
   */
  private changeFilters(apply: () => void, pageKeys: readonly string[]): void {
    const filters = (): string => [
      this.taskPriorityFilter,
      this.taskTypeFilter,
      this.patientPathwayFilter,
      this.patientPriorityFilter
    ].join("|");
    const before = filters();
    apply();
    if (filters() === before) return;
    for (const key of pageKeys) this.listPages.delete(key);
  }

  private renderSurgery(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const bookings = snapshot.episodes
      .filter((episode) => this.isActiveEpisode(episode) && episode.pathway === "or-booking")
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));

    // Logbook at a glance: the counts a surgeon reports — total cases, the
    // current month, and primary-operator cases — computed locally from the
    // same records the list below shows.
    const completedProcedures = snapshot.procedures.filter(
      (procedure) => procedure.status === "completed"
    );
    const currentMonth = todayIso().slice(0, 7);
    const thisMonth = completedProcedures.filter((procedure) =>
      normalizeText(procedure.procedure_date).startsWith(currentMonth)
    );
    const asPrimary = completedProcedures.filter(
      (procedure) => normalizeComparable(procedure.role) === "primary surgeon"
    );
    const summary = container.createDiv({ cls: "clinical-summary-grid" });
    this.summaryCard(summary, completedProcedures.length, "Total logged");
    this.summaryCard(summary, thisMonth.length, "This month");
    this.summaryCard(summary, asPrimary.length, "As primary");
    this.summaryCard(summary, bookings.length, "Awaiting OR");

    this.sectionHeader(container, "OR booking", `${bookings.length} awaiting surgery`, "surgery-bookings");
    const list = container.createDiv({ cls: "clinical-list" });
    if (!bookings.length) this.empty(list, "No active OR bookings.");
    const bookingPage = this.pageFor("surgery-bookings", bookings);
    for (const episode of bookingPage.items) {
      const patient = this.patientFor(snapshot, episode.patient_id);
      const card = this.episodeCard(list, episode, patient);
      const context = this.episodeContext(episode, patient);
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      // The primary action comes first: on phones it fills the first row and
      // the remaining buttons pair up beneath it without gaps.
      this.actionButton(
        actions,
        "Complete surgery",
        () => {
          if (!this.canOpenWriteForm()) return;
          new ProcedureModal(this.app, episode, this.patientLabel(patient), async (input) => {
            await this.service.completeProcedure(input);
            new Notice("Surgery logged and workflow updated.");
            await this.refresh();
          }).open();
        },
        true,
        false,
        context,
        episode.id
      );
      this.actionButton(actions, "Open", () => this.openRecord("episode", episode.id), false, false, context, episode.id);
    }
    this.renderPagination(container, "surgery-bookings", bookingPage);

    // Only completed procedures belong in a list headed "N completed" and
    // badged "Completed" — a hand-edited cancelled/entered-in-error record
    // would otherwise be shown with a badge contradicting its own status.
    const procedures = [...completedProcedures].sort((a, b) =>
      this.text(b.procedure_date).localeCompare(this.text(a.procedure_date))
    );
    this.sectionHeader(container, "Surgery logbook", `${procedures.length} completed`, "surgery-logbook");
    const procedureList = container.createDiv({ cls: "clinical-list" });
    if (!procedures.length) this.empty(procedureList, "No completed procedures yet.");
    // A second procedure from the same operation, or a return to theatre, is
    // logged from the episode's newest entry, once per episode.
    const newestPerEpisode = new Set<string>();
    const episodesSeen = new Set<string>();
    for (const procedure of procedures) {
      if (episodesSeen.has(procedure.episode_id)) continue;
      episodesSeen.add(procedure.episode_id);
      newestPerEpisode.add(procedure.id);
    }
    const procedurePage = this.pageFor("surgery-logbook", procedures);
    for (const procedure of procedurePage.items) {
      this.renderProcedureCard(procedureList, procedure, snapshot, newestPerEpisode.has(procedure.id));
    }
    this.renderPagination(container, "surgery-logbook", procedurePage);

    // The counts a training portfolio asks for: per procedure, how many and
    // in what role — computed locally from the same records listed above.
    if (completedProcedures.length) {
      this.sectionHeader(container, "Logbook breakdown", "By procedure");
      const groups = new Map<string, { label: string; total: number; primary: number; year: number }>();
      const currentYear = todayIso().slice(0, 4);
      for (const procedure of completedProcedures) {
        const key = normalizeComparable(procedure.procedure) || "(not recorded)";
        const group = groups.get(key) ?? {
          label: procedure.procedure || "Not recorded",
          total: 0,
          primary: 0,
          year: 0
        };
        group.total += 1;
        if (normalizeComparable(procedure.role) === "primary surgeon") group.primary += 1;
        if (normalizeText(procedure.procedure_date).startsWith(currentYear)) group.year += 1;
        groups.set(key, group);
      }
      const rows = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, 15);
      const tableWrap = container.createDiv({ cls: "clinical-table-wrap" });
      const table = tableWrap.createEl("table", { cls: "clinical-breakdown-table" });
      const head = table.createEl("thead").createEl("tr");
      for (const column of ["Procedure", "Total", "As primary", "This year"]) {
        head.createEl("th", { text: column });
      }
      const tbody = table.createEl("tbody");
      for (const row of rows) {
        const tr = tbody.createEl("tr");
        tr.createEl("td", { text: row.label, attr: { dir: "auto" } });
        tr.createEl("td", { text: String(row.total) });
        tr.createEl("td", { text: String(row.primary) });
        tr.createEl("td", { text: String(row.year) });
      }
      if (groups.size > rows.length) {
        container.createEl("p", {
          text: `Showing the ${rows.length} most frequent of ${groups.size} distinct procedures.`,
          cls: "clinical-section-note"
        });
      }
    }
  }

  private renderMore(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    this.sectionHeader(container, "Database views", "Core Obsidian Bases");
    const databases = container.createDiv({ cls: "clinical-list" });
    const databaseCard = databases.createDiv({ cls: "clinical-card" });
    databaseCard.createEl("h4", { text: "Structured views" });
    databaseCard.createEl("p", {
      text: "Open the native patients, episodes, tasks, or surgery logbook database.",
      cls: "clinical-card-meta"
    });
    const databaseActions = databaseCard.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(databaseActions, "Patients", () => this.openBase("Patients"));
    this.actionButton(databaseActions, "Episodes", () => this.openBase("Episodes"));
    this.actionButton(databaseActions, "Tasks", () => this.openBase("Tasks"));
    this.actionButton(databaseActions, "Surgery", () => this.openBase("Surgery Logbook"));

    this.sectionHeader(
      container,
      "Patient records",
      `${this.identifiablePatients(snapshot).length} on file`,
      "more-patients"
    );
    const patientList = container.createDiv({ cls: "clinical-list" });
    const patients = this.identifiablePatients(snapshot);
    if (!patients.length) this.empty(patientList, "No patient records yet.");
    const patientPage = this.pageFor("more-patients", patients);
    for (const patient of patientPage.items) this.renderPatientCard(patientList, patient, snapshot);
    this.renderPagination(container, "more-patients", patientPage);

    this.sectionHeader(container, "Archive", "Searchable and restorable", "more-archive");
    const archived = snapshot.episodes
      .filter((episode) => episode.status === "archived")
      .sort((a, b) => this.text(b.closed_at).localeCompare(this.text(a.closed_at)));
    const archiveList = container.createDiv({ cls: "clinical-list" });
    if (!archived.length) this.empty(archiveList, "No archived episodes.");
    const archivePage = this.pageFor("more-archive", archived);
    for (const episode of archivePage.items) {
      const patient = this.patientFor(snapshot, episode.patient_id);
      const card = this.episodeCard(archiveList, episode, patient);
      if (episode.outcome) {
        card.createEl("p", { text: `Outcome: ${bidiIsolate(episode.outcome)}`, cls: "clinical-card-meta" });
      }
      const context = this.episodeContext(episode, patient);
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      // Primary first, so the phone grid has no half-empty row.
      this.actionButton(
        actions,
        "Restore",
        () =>
          this.runAction(async () => {
            await this.service.restoreEpisode(episode.id);
            new Notice("Patient episode restored.");
          }),
        true,
        false,
        context,
        episode.id
      );
      this.actionButton(actions, "Open", () => this.openRecord("episode", episode.id), false, false, context, episode.id);
    }
    this.renderPagination(container, "more-archive", archivePage);

    this.sectionHeader(container, "Patient lists", "Export any patient type");
    const lists = container.createDiv({ cls: "clinical-card" });
    lists.createEl("h4", { text: "Export a patient list" });
    lists.createEl("p", {
      text: "Pick a care setting, pathway, priority, and episode status — for example every inpatient, every urgent follow-up, or everyone waiting for surgery — and save the matching patients as a note or a spreadsheet file in the documents folder. It contains identifiers; delete it after use.",
      cls: "clinical-card-meta"
    });
    const listActions = lists.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(listActions, "Export patient list", () => this.openPatientListExport());

    this.sectionHeader(container, "Ward handover", "Generated from today's records");
    const handover = container.createDiv({ cls: "clinical-card" });
    handover.createEl("h4", { text: "End-of-day handover note" });
    handover.createEl("p", {
      text: "Writes one note in the documents folder listing inpatients, then every patient's overdue, due-today, due-tomorrow and undated tasks. It contains identifiers, stays inside the clinical folder, and should be deleted after use.",
      cls: "clinical-card-meta"
    });
    const handoverActions = handover.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(handoverActions, "Generate handover", () => this.generateHandover());

    this.sectionHeader(container, "Safety", "Data integrity");
    const safety = container.createDiv({ cls: "clinical-card" });
    safety.createEl("h4", { text: "Data integrity" });
    safety.createEl("p", {
      text: "Run the configured checks: duplicates, broken links, unexpected values, text stored as a number, invalid dates and repeat intervals, follow-up contradictions, logbook-export readiness, stale database views, and audit-trail coverage. Not a full validation of every field.",
      cls: "clinical-card-meta"
    });
    const safetyActions = safety.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(safetyActions, "Run check", () => this.showIntegrity());

    if (__DEV_TOOLS__) {
      this.sectionHeader(container, "Development", "Not present in release builds");
      const dev = container.createDiv({ cls: "clinical-card" });
      dev.createEl("h4", { text: "Synthetic data" });
      dev.createEl("p", {
        text: "Creates fabricated patients for testing. Never use in a vault holding real patient information.",
        cls: "clinical-card-meta"
      });
      const devActions = dev.createDiv({ cls: "clinical-card-actions" });
      this.actionButton(devActions, "Add synthetic demo", () =>
        this.runAction(async () => {
          const count = await seedSyntheticFixtures(this.service);
          new Notice(`${count} synthetic episodes created.`);
        })
      );
    }
  }

  /** One screen per patient: episodes, work, logbook, and trail together. */
  private async openPatientDetail(rendered: PatientRecord): Promise<void> {
    try {
      const [snapshot, events] = await Promise.all([
        this.repository.snapshot(),
        this.repository.list<EventRecord>("event")
      ]);
      // The button was drawn from an older snapshot. A patient merged, or
      // corrected on another device, since then is read afresh, and one with
      // no sheet any more opens as its note, as search does.
      const patient = snapshot.patients.find((item) => item.id === rendered.id);
      if (!hasPatientSheet(patient)) {
        this.openRecord("patient", rendered.id);
        return;
      }
      new PatientDetailModal(
        this.app,
        {
          patient,
          episodes: snapshot.episodes.filter((episode) => episode.patient_id === patient.id),
          tasks: snapshot.tasks.filter((task) => task.patient_id === patient.id),
          procedures: snapshot.procedures.filter((procedure) => procedure.patient_id === patient.id),
          events: events.map((item) => item.record).filter((event) => event.patient_id === patient.id)
        },
        (entity, id) => this.openRecord(entity, id),
        (taskId) => void this.reopenTask(taskId),
        // The sheet closes first and the view's own actions run, so nothing
        // acts on the sheet's snapshot after the record has changed.
        {
          complete: (task) => void this.completeTask(task),
          reschedule: (task) => this.openReschedule(task)
        }
      ).open();
    } catch (error) {
      showClinicalErrorNotice(error, "The patient view could not be opened.");
    }
  }

  /** One search box across patients, episodes, tasks, and the logbook. */
  async openSearch(): Promise<void> {
    try {
      const snapshot = await this.repository.snapshot();
      new ClinicalSearchModal(this.app, snapshot, (entity, id) => {
        // A patient opens the patient sheet (episodes, open work, history)
        // rather than a note of properties. A merged or retired patient has
        // no sheet of its own, so its note opens as before.
        const patient = entity === "patient"
          ? this.identifiablePatients(snapshot).find((item) => item.id === id)
          : undefined;
        if (patient) void this.openPatientDetail(patient);
        else this.openRecord(entity, id);
      }).open();
    } catch (error) {
      showClinicalErrorNotice(error, "Search could not be opened.");
    }
  }

  /**
   * Opens the patient-list export form. `seed` pre-selects filters, for
   * example the chips currently active on the Patients tab.
   */
  async openPatientListExport(seed?: Partial<PatientListFilter>): Promise<void> {
    if (!this.canOpenWriteForm()) return;
    try {
      const snapshot = await this.repository.snapshot();
      const today = todayIso();
      new PatientListModal(
        this.app,
        (filter) => {
          const rows = selectPatientListRows(snapshot, filter, today);
          return { episodes: rows.length, patients: countDistinctPatients(rows) };
        },
        (request) => this.writePatientList(request),
        seed
      ).open();
    } catch (error) {
      showClinicalErrorNotice(error, "The patient list could not be opened.");
    }
  }

  /**
   * Re-reads the records at submit time so the file reflects what is on disk
   * now, not what the form was opened against.
   */
  private async writePatientList(request: PatientListRequest): Promise<void> {
    const snapshot = await this.repository.snapshot();
    const today = todayIso();
    const rows = selectPatientListRows(snapshot, request.filter, today);
    if (!rows.length) throw new Error("No episodes match these filters any more. Change a filter and try again.");
    const baseName = patientListFileBaseName(request.filter, today);
    const folder = clinicalFolder("documents");
    const count = `${rows.length} episode${rows.length === 1 ? "" : "s"}`;
    if (request.format === "csv") {
      await this.repository.createLooseFile(folder, baseName, "csv", buildPatientListCsv(rows));
      // Obsidian cannot display a CSV itself; say where it went instead.
      new Notice(
        `Patient list CSV (${count}) saved in the documents folder. It contains patient identifiers. Open it from your file manager or the Files app, and delete it after use.`,
        9000
      );
      return;
    }
    const path = await this.repository.createLooseNote(
      folder,
      baseName,
      buildPatientListMarkdown(rows, request.filter, today)
    );
    new Notice(`Patient list (${count}) created in the documents folder. Delete it after use.`, 7000);
    await this.openPath(path);
  }

  /** Writes today's ward handover note into the Documents folder and opens it. */
  async generateHandover(): Promise<void> {
    try {
      const snapshot = await this.repository.snapshot();
      const today = todayIso();
      const path = await this.repository.createLooseNote(
        clinicalFolder("documents"),
        `Handover ${today}`,
        buildHandoverNote(snapshot, today)
      );
      new Notice("Handover note created in the documents folder. Delete it after use.", 7000);
      await this.openPath(path);
    } catch (error) {
      showClinicalErrorNotice(error, "The handover note could not be created.");
    }
  }

  private identifiablePatients(snapshot: ClinicalSnapshot): PatientRecord[] {
    return snapshot.patients
      .filter((patient) => hasPatientSheet(patient))
      .sort((a, b) => this.text(a.patient_name).localeCompare(this.text(b.patient_name)));
  }

  private renderPatientCard(container: HTMLElement, patient: PatientRecord, snapshot: ClinicalSnapshot): void {
    const card = container.createDiv({ cls: "clinical-card" });
    const top = card.createDiv({ cls: "clinical-card-top" });
    top.createEl("h4", { text: patient.patient_name || "Name not recorded", attr: { dir: "auto" } });
    top.createSpan({ text: patient.status, cls: "clinical-card-meta" });
    card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
    card.createEl("p", { text: `Phone ${displayPhone(patient.phone)}`, cls: "clinical-card-meta" });
    const episodes = snapshot.episodes.filter((episode) => episode.patient_id === patient.id).length;
    card.createEl("p", { text: `${episodes} episode${episodes === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
    if (!patient.mrn || !patient.patient_name) {
      const badges = card.createDiv({ cls: "clinical-badges" });
      this.badge(badges, "Needs review", "overdue");
    }
    const patientContext = this.patientLabel(patient);
    const actions = card.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(actions, "View", () => this.openPatientDetail(patient), false, false, patientContext, patient.id);
    this.actionButton(actions, "Open", () => this.openRecord("patient", patient.id), false, false, patientContext, patient.id);
    this.actionButton(actions, "Edit identity", () => {
      if (!this.canOpenWriteForm()) return;
      new PatientIdentityModal(this.app, patient, async (input) => {
        await this.service.updatePatientIdentity(patient.id, input);
        new Notice("Patient identity updated.");
        await this.refresh();
      }).open();
    }, false, false, patientContext, patient.id);
    const others = this.identifiablePatients(snapshot).filter((item) => item.id !== patient.id);
    if (others.length) {
      this.actionButton(actions, "Merge", () => {
        if (!this.canOpenWriteForm()) return;
        new MergePatientsModal(
          this.app,
          patient,
          others,
          (targetId) => this.service.previewPatientMerge(patient.id, targetId),
          async (targetId) => {
            await this.service.mergePatients(patient.id, targetId);
            new Notice("Patient records merged.");
            await this.refresh();
          }
        ).open();
      }, false, false, patientContext, patient.id);
    }
  }

  private renderEpisodeList(
    container: HTMLElement,
    episodes: EpisodeRecord[],
    snapshot: ClinicalSnapshot,
    pageKey: string
  ): void {
    const list = container.createDiv({ cls: "clinical-list" });
    if (!episodes.length) {
      this.empty(list, "No patients in this care setting.");
      return;
    }
    const page = this.pageFor(pageKey, episodes);
    for (const episode of page.items) {
      const patient = this.patientFor(snapshot, episode.patient_id);
      const card = this.episodeCard(list, episode, patient);
      const context = this.episodeContext(episode, patient);
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      this.actionButton(actions, "Open", () => this.openRecord("episode", episode.id), false, false, context, episode.id);
      this.actionButton(actions, "+ Task", () => {
        if (!this.canOpenWriteForm()) return;
        new NewTaskModal(this.app, episode, this.patientLabel(patient), async (input) => {
          const created = await this.service.createTask(input);
          new Notice(taskAddedNotice(created.duplicate));
          await this.refresh();
        }).open();
      }, false, false, context, episode.id);
      this.actionButton(actions, "Update", () => {
        if (!this.canOpenWriteForm()) return;
        new UpdateEpisodeModal(this.app, episode, async (input) => {
          const result = await this.service.updateEpisode(episode.id, input);
          // Say what happened to the task. A next action that produced no task
          // must never pass silently — the clinician would assume it is on a
          // worklist when it is not.
          const outcome = result.task;
          let message = "Patient workflow updated.";
          if (outcome.kind === "created") {
            message = outcome.superseded
              ? `Task added. ${outcome.superseded} superseded task${outcome.superseded === 1 ? "" : "s"} cancelled.`
              : "Task added.";
          } else if (outcome.kind === "rescheduled") {
            // Only the date changed, so the task moved and kept its type,
            // owner and repeat.
            message = outcome.task.record.due_date
              ? `Task moved to ${outcome.task.record.due_date}.`
              : "Task moved.";
          } else if (outcome.kind === "already-closed") {
            message = `No task added: that task was already ${closedTaskStatusLabel(outcome.task.record.status)}. Use + Task to raise it again.`;
          }
          if (result.tasksEscalated) {
            message = `${message.replace(/\.?$/, ".")} ${result.tasksEscalated} open task${result.tasksEscalated === 1 ? "" : "s"} raised to ${priorityLabel(result.episode.record.priority)}.`;
          }
          new Notice(message, outcome.kind === "already-closed" || result.tasksEscalated ? 9000 : 4000);
          await this.refresh();
        }).open();
      }, false, false, context, episode.id);
      this.actionButton(actions, "Template", () => this.openApplyTemplate(episode), false, false, context, episode.id);
      this.actionButton(actions, "History", () => this.openEpisodeHistory(episode), false, false, context, episode.id);
      this.actionButton(
        actions,
        "Discharge",
        () => {
          if (!this.canOpenWriteForm()) return;
          const openTasks = this.openTasksFor(snapshot, episode.id);
          new ArchiveEpisodeModal(
            this.app,
            episode,
            async (request) => {
              // The tick covered the tasks listed; work that arrived since
              // (another device, Sync) must be seen before it is cancelled.
              if (request.cancelOpenTasks) await this.assertOpenTasksUnchanged(episode.id, openTasks);
              const result = await this.service.archiveEpisode(episode.id, request.outcome, {
                cancelOpenTasks: request.cancelOpenTasks
              });
              new Notice(
                result.cancelledTasks
                  ? `Patient episode archived. ${result.cancelledTasks} open task${result.cancelledTasks === 1 ? " was" : "s were"} cancelled.`
                  : "Patient episode archived."
              );
              await this.refresh();
            },
            this.getSettings().confirmBeforeDischarge,
            openTasks
          ).open();
        },
        false,
        true,
        context,
        episode.id
      );
    }
    this.renderPagination(container, pageKey, page);
  }

  /** An episode's open tasks, soonest first and undated last, as Discharge lists them. */
  private openTasksFor(snapshot: ClinicalSnapshot, episodeId: string): TaskRecord[] {
    return snapshot.tasks
      .filter((task) => task.episode_id === episodeId && taskIsOpen(task))
      .sort((a, b) => this.taskSortKey(a).localeCompare(this.taskSortKey(b)));
  }

  /** Refuses when the episode now has open work the discharge form did not list. */
  private async assertOpenTasksUnchanged(episodeId: string, listed: readonly TaskRecord[]): Promise<void> {
    const shown = new Set(listed.map((task) => task.id));
    const unseen = (await this.repository.list<TaskRecord>("task")).some(
      ({ record }) => record.episode_id === episodeId && taskIsOpen(record) && !shown.has(record.id)
    );
    if (unseen) {
      throw new Error(
        "This episode has open work that was added after this form opened. Nothing was cancelled. Close this form, then open Discharge again to review it."
      );
    }
  }

  /** Explicit, previewed application of a user-authored task bundle. */
  private async openApplyTemplate(episode: EpisodeRecord): Promise<void> {
    if (!this.canOpenWriteForm()) return;
    try {
      const bundles = (await listTaskBundles(this.app.vault)).filter(
        (bundle) => bundle.pathway === null || bundle.pathway === episode.pathway
      );
      new ApplyTemplateModal(this.app, episode.case, bundles, (bundle) => {
        void this.applyTemplate(episode, bundle);
      }).open();
    } catch (error) {
      showClinicalErrorNotice(error, "Templates could not be read.");
    }
  }

  private async applyTemplate(episode: EpisodeRecord, bundle: TaskBundle): Promise<void> {
    try {
      let created = 0;
      let existing = 0;
      for (const item of bundle.tasks) {
        const result = await this.service.createTask({
          patientId: episode.patient_id,
          episodeId: episode.id,
          task: item.task,
          taskType: item.taskType,
          priority: item.priority ?? episode.priority,
          dueDate: item.dueInDays !== null ? isoDateWithOffset(item.dueInDays) : "",
          owner: ""
        });
        if (result.duplicate) existing += 1;
        else created += 1;
      }
      new Notice(
        existing
          ? `${created} task${created === 1 ? "" : "s"} created; ${existing} already existed and ${existing === 1 ? "was" : "were"} kept.`
          : `${created} task${created === 1 ? "" : "s"} created from the template.`
      );
      await this.refresh();
    } catch (error) {
      showClinicalErrorNotice(error, "The template could not be applied.");
      await this.refresh();
    }
  }

  private async openEpisodeHistory(episode: EpisodeRecord): Promise<void> {
    try {
      const events = (await this.repository.list<EventRecord>("event"))
        .map((item) => item.record)
        .filter((event) => event.episode_id === episode.id || event.target_id === episode.id);
      new EpisodeHistoryModal(this.app, episode.case, events).open();
    } catch (error) {
      showClinicalErrorNotice(error, "The episode history could not be read.");
    }
  }

  private renderTaskList(
    container: HTMLElement,
    tasks: TaskRecord[],
    snapshot: ClinicalSnapshot,
    pageKey: string
  ): void {
    const list = container.createDiv({ cls: "clinical-list" });
    if (!tasks.length) {
      this.empty(list, "Nothing on this list.");
      return;
    }
    const page = this.pageFor(pageKey, tasks);
    for (const task of page.items) {
      const patient = this.patientFor(snapshot, task.patient_id);
      const episode = this.renderEpisodeById.get(task.episode_id);
      const card = list.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: task.task || "Task not recorded", attr: { dir: "auto" } });
      top.createSpan({ text: task.due_date || "No date", cls: "clinical-card-meta" });
      card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
      if (episode) {
        card.createEl("p", {
          text: `${pathwayLabel(episode.pathway)} · ${bidiIsolate(episode.case)}`,
          cls: "clinical-card-meta"
        });
      }
      const badges = card.createDiv({ cls: "clinical-badges" });
      this.badge(badges, priorityLabel(task.priority), task.priority);
      // The age matters: "overdue since yesterday" and "overdue for a month"
      // need different responses, and a bare badge hides the difference.
      const overdueDays = daysOverdue(task);
      if (overdueDays > 0) {
        this.badge(badges, overdueDays === 1 ? "Overdue 1 day" : `Overdue ${overdueDays} days`, "overdue");
      }
      if ((task.repeat_every_days ?? 0) > 0) this.badge(badges, "Repeats", "pathway");
      if (task.owner) this.badge(badges, task.owner, "owner", true);
      const context = this.taskContext(task, patient);
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      // On phones card actions form a two-column grid in which the primary
      // action fills a row. Complete first, then pairs, leaves no half-empty
      // row, and keeps Complete and Cancel apart against a hurried mis-tap.
      this.actionButton(actions, "Complete", () => this.completeTask(task), true, false, context, task.id);
      this.actionButton(actions, "Reschedule", () => this.openReschedule(task), false, false, context, task.id);
      if (episode) {
        this.actionButton(actions, "+ Task", () => {
          if (!this.canOpenWriteForm()) return;
          new NewTaskModal(this.app, episode, this.patientLabel(patient), async (input) => {
            const created = await this.service.createTask(input);
            new Notice(taskAddedNotice(created.duplicate));
            await this.refresh();
          }).open();
        }, false, false, this.episodeContext(episode, patient), task.id);
      }
      this.actionButton(actions, "Open", () => this.openRecord("task", task.id), false, false, context, task.id);
      this.actionButton(actions, "Cancel", () => {
        if (!this.canOpenWriteForm()) return;
        new CancelTaskModal(this.app, task, async (reason) => {
          await this.service.cancelTask(task.id, reason);
          new Notice("Task cancelled.");
          await this.refresh();
        }).open();
      }, false, true, context, task.id);
    }
    this.renderPagination(container, pageKey, page);
  }

  private completeTask(task: TaskRecord): Promise<void> {
    // The card and the patient sheet can both reach one task; a second tap
    // while the first completion is being written must not start another.
    if (this.completingTasks.has(task.id)) return Promise.resolve();
    this.completingTasks.add(task.id);
    const requestedAt = Date.now();
    return this.runAction(async () => {
      const completed = await this.service.completeTask(task.id);
      if (completed.record.status !== "completed") {
        new Notice("This task was already closed.");
      } else if (Date.parse(completed.record.completed_at) >= requestedAt) {
        this.showCompletedNotice(task.id);
      } else {
        // The service returns a task completed earlier (on another device,
        // or by an earlier tap) unchanged. Undo belongs to that completion.
        new Notice("This task was already completed.");
      }
    }).finally(() => this.completingTasks.delete(task.id));
  }

  /**
   * Complete writes on one tap, and the next card then slides under the
   * finger, so the notice offers Undo for a few seconds. It holds only the
   * task id: Undo works from any tab, and after the view has redrawn. The
   * text stays identifier-free.
   */
  private showCompletedNotice(taskId: string): void {
    let notice: Notice | null = null;
    const message = createFragment((fragment) => {
      const row = fragment.createDiv({ cls: "clinical-undo-notice" });
      row.createSpan({ text: "Task completed." });
      const undo = row.createEl("button", {
        text: "Undo",
        cls: "clinical-undo-notice-action",
        attr: { type: "button", "aria-label": "Undo task completion" }
      });
      undo.addEventListener("click", () => {
        if (undo.disabled) return;
        undo.disabled = true;
        notice?.hide();
        void this.reopenTask(taskId);
      });
    });
    notice = new Notice(message, UNDO_COMPLETE_NOTICE_MS);
  }

  /** Reopen errors, including a closed write barrier, surface as a clinical notice. */
  private reopenTask(taskId: string): Promise<void> {
    return this.runAction(async () => {
      const reopened = await this.service.reopenTask(taskId);
      new Notice(reopenedTaskNotice(reopened));
    });
  }

  private openReschedule(task: TaskRecord): void {
    if (!this.canOpenWriteForm()) return;
    new RescheduleTaskModal(this.app, task, async (dueDate) => {
      const result = await this.service.rescheduleTask(task.id, dueDate);
      // The service leaves a same-date reschedule untouched; say so rather
      // than announce a move that did not happen. Re-saving is not an error.
      new Notice(result.record.updated_at === task.updated_at ? "Date unchanged." : `Task moved to ${dueDate}.`);
      await this.refresh();
    }).open();
  }

  private episodeCard(container: HTMLElement, episode: EpisodeRecord, patient: PatientRecord | undefined): HTMLElement {
    const card = container.createDiv({ cls: "clinical-card" });
    const top = card.createDiv({ cls: "clinical-card-top" });
    top.createEl("h4", { text: episode.case || "Case not recorded", attr: { dir: "auto" } });
    top.createSpan({ text: episode.due_date || "Not set", cls: "clinical-card-meta" });
    const label = this.patientLabel(patient);
    if (hasPatientSheet(patient)) {
      // The patient line doubles as the way into the patient sheet: another
      // action button would add a fourth row to every card on a phone.
      const view = card.createEl("button", {
        cls: "clinical-card-meta clinical-card-patient-link",
        attr: { type: "button", "aria-label": `${label} — view patient` }
      });
      view.createSpan({ text: label });
      const chevron = view.createSpan({ cls: "clinical-card-patient-chevron", attr: { "aria-hidden": "true" } });
      setIcon(chevron, "chevron-right");
      // Guarded like actionButton: a quick double tap opened two stacked
      // sheets, the second showing work the first had already closed.
      view.addEventListener("click", () => {
        if (view.disabled) return;
        view.disabled = true;
        void this.openPatientDetail(patient).finally(() => {
          view.disabled = false;
        });
      });
    } else {
      card.createEl("p", { text: label, cls: "clinical-card-meta" });
    }
    if (patient) card.createEl("p", { text: `Phone ${displayPhone(patient.phone)}`, cls: "clinical-card-meta" });
    if (episode.next_action) {
      const next = card.createEl("p", { cls: "clinical-card-review" });
      next.createEl("strong", { text: "Next: " });
      next.createSpan({ text: episode.next_action, attr: { dir: "auto" } });
    }
    const badges = card.createDiv({ cls: "clinical-badges" });
    this.badge(badges, careSettingLabel(episode.care_setting), episode.care_setting);
    this.badge(badges, pathwayLabel(episode.pathway), "pathway");
    this.badge(badges, priorityLabel(episode.priority), episode.priority);
    // What stands between this episode and Discharge, before Discharge is opened.
    const openTasks = this.renderOpenTaskCount.get(episode.id) ?? 0;
    if (openTasks) this.badge(badges, `${openTasks} open task${openTasks === 1 ? "" : "s"}`, "open-tasks");
    if (episodeNeedsReview(episode) || !patient?.mrn || !patient.patient_name) {
      this.badge(badges, "Needs review", "overdue");
    }
    return card;
  }

  private renderProcedureCard(
    container: HTMLElement,
    procedure: ProcedureRecord,
    snapshot: ClinicalSnapshot,
    newestForEpisode = false
  ): void {
    const patient = this.patientFor(snapshot, procedure.patient_id);
    const card = container.createDiv({ cls: "clinical-card" });
    const top = card.createDiv({ cls: "clinical-card-top" });
    top.createEl("h4", { text: procedure.procedure || "Procedure not recorded", attr: { dir: "auto" } });
    top.createSpan({ text: procedure.procedure_date || "No date", cls: "clinical-card-meta" });
    card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
    card.createEl("p", { text: procedure.role, cls: "clinical-card-meta" });
    const badges = card.createDiv({ cls: "clinical-badges" });
    this.badge(badges, "Completed", "complete");
    this.badge(badges, procedure.follow_up_required ? "Follow-up required" : "No follow-up", "pathway");
    const actions = card.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(
      actions,
      "Open log",
      () => this.openRecord("procedure", procedure.id),
      false,
      false,
      `${procedure.procedure ? bidiIsolate(procedure.procedure) : "procedure not recorded"}, ${this.patientLabel(patient)}`,
      procedure.id
    );
    // An episode still on OR booking logs its procedures from the booking
    // card; one that has moved on takes another here without changing its
    // workflow.
    const episode = this.renderEpisodeById.get(procedure.episode_id);
    if (
      newestForEpisode &&
      episode &&
      patient &&
      this.isActiveEpisode(episode) &&
      episode.pathway !== "or-booking" &&
      patient.status === "active" &&
      !patient.merged_into &&
      !patient.merge_in_progress
    ) {
      this.actionButton(
        actions,
        "Add another procedure",
        () => {
          if (!this.canOpenWriteForm()) return;
          new ProcedureModal(this.app, episode, this.patientLabel(patient), async (input) => {
            await this.service.completeProcedure(input);
            new Notice("Procedure added to the logbook.");
            await this.refresh();
          }, { additional: true }).open();
        },
        false,
        false,
        this.episodeContext(episode, patient),
        procedure.id
      );
    }
  }

  private async showIntegrity(): Promise<void> {
    try {
      const report = await this.integrity.report();
      new IntegrityReportModal(this.app, report.issues, (path) => void this.openPath(path), {
        scannedRecords: report.scannedRecords,
        checkFamilies: report.checkFamilies
      }).open();
    } catch (error) {
      showClinicalErrorNotice(error, "Integrity check failed.");
    }
  }

  private renderFailure(error: unknown): void {
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "clinical-workspace-shell" });
    shell.createEl("h2", { text: "Clinical Workspace" });
    shell.createEl("p", {
      text: error instanceof Error ? error.message : "The workspace could not be loaded.",
      cls: "clinical-empty"
    });
    const retry = shell.createEl("button", { text: "Try again", cls: "mod-cta" });
    retry.addEventListener("click", () => void this.refresh());
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      await this.refresh();
    } catch (error) {
      showClinicalErrorNotice(error, "The clinical action could not be completed.");
      await this.refresh();
    }
  }

  private openRecord(entity: "patient" | "episode" | "task" | "procedure", id: string): void {
    void this.openRecordAsync(entity, id);
  }

  /**
   * Resolves through the repository rather than assuming the filename still
   * matches the id, so a renamed note still opens.
   */
  private async openRecordAsync(
    entity: "patient" | "episode" | "task" | "procedure",
    id: string
  ): Promise<void> {
    const found = await this.repository.findById(entity, id);
    if (!found) {
      new Notice("That record could not be found.");
      return;
    }
    await this.openPath(found.path);
  }

  private openBase(name: string): void {
    void this.openPath(`${clinicalFolder("bases")}/${name}.base`);
  }

  private async openPath(path: string): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      // No path in the message: record notes can be renamed to patient
      // names, and Notice text must stay identifier-free.
      new Notice("That file could not be found in the vault. Run the clinical data integrity check.");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(abstract);
  }

  /**
   * Lookup maps rebuilt once per render pass. Card lists used to call
   * Array.find per row, which made a full redraw quadratic in caseload size.
   */
  private renderPatientById = new Map<string, PatientRecord>();
  private renderEpisodeById = new Map<string, EpisodeRecord>();
  private renderOpenTaskCount = new Map<string, number>();

  private indexSnapshot(snapshot: ClinicalSnapshot): void {
    this.renderPatientById = new Map(snapshot.patients.map((patient) => [patient.id, patient]));
    this.renderEpisodeById = new Map(snapshot.episodes.map((episode) => [episode.id, episode]));
    this.renderOpenTaskCount = new Map();
    for (const task of snapshot.tasks) {
      if (!taskIsOpen(task)) continue;
      this.renderOpenTaskCount.set(task.episode_id, (this.renderOpenTaskCount.get(task.episode_id) ?? 0) + 1);
    }
  }

  private patientFor(_snapshot: ClinicalSnapshot, patientId: string): PatientRecord | undefined {
    return this.renderPatientById.get(patientId);
  }

  private patientLabel(patient: PatientRecord | undefined): string {
    return patient
      ? patientIdentityLabel(patient.mrn, patient.patient_name)
      : "MRN needed · Patient identity missing";
  }

  /** Accessible-name context for one episode's action buttons. */
  private episodeContext(episode: EpisodeRecord, patient: PatientRecord | undefined): string {
    const caseLabel = episode.case ? bidiIsolate(episode.case) : "case not recorded";
    return `${caseLabel}, ${this.patientLabel(patient)}`;
  }

  /** Accessible-name context for one task's action buttons. */
  private taskContext(task: TaskRecord, patient: PatientRecord | undefined): string {
    const taskLabel = task.task ? bidiIsolate(task.task) : "task not recorded";
    return `${taskLabel}, ${this.patientLabel(patient)}`;
  }

  private isActiveEpisode(episode: EpisodeRecord): boolean {
    return !["archived", "cancelled", "entered-in-error"].includes(episode.status);
  }

  /** Frontmatter is user-editable, so every sort key tolerates a missing value. */
  private text(value: unknown): string {
    return normalizeText(value);
  }

  /**
   * The id breaks ties the same way on every device, as in
   * priorityFirstTaskSortKey: without it tied records kept the vault's file
   * order, which differs between devices, and moved across a page boundary.
   */
  private episodeSortKey(episode: EpisodeRecord): string {
    const priority = { emergency: "0", urgent: "1", routine: "2" }[episode.priority] ?? "3";
    return `${priority}|${episode.due_date || "9999-99-99"}|${this.text(episode.case).toLocaleLowerCase()}|${this.text(episode.id)}`;
  }

  private taskSortKey(task: TaskRecord): string {
    const priority = { emergency: "0", urgent: "1", routine: "2" }[task.priority] ?? "3";
    return `${task.due_date || "9999-99-99"}|${priority}|${this.text(task.task).toLocaleLowerCase()}|${this.text(task.id)}`;
  }

  /**
   * Priority, then oldest due date, then wording, for lists where the date
   * is shared or past (Overdue, Today, No date). The id breaks ties the same
   * way on every device, so a page holds the same tasks after each refresh.
   */
  private priorityFirstTaskSortKey(task: TaskRecord): string {
    const priority = { emergency: "0", urgent: "1", routine: "2" }[task.priority] ?? "3";
    return `${priority}|${task.due_date || "9999-99-99"}|${this.text(task.task).toLocaleLowerCase()}|${task.id}`;
  }

  private summaryCard(container: HTMLElement, value: number, label: string): void {
    const card = container.createDiv({ cls: "clinical-summary-card" });
    card.createSpan({ text: String(value), cls: "clinical-summary-value" });
    card.createSpan({ text: label, cls: "clinical-summary-label" });
  }

  /** `pageKey` names the paged list this header introduces. */
  private sectionHeader(container: HTMLElement, title: string, note: string, pageKey = ""): void {
    const header = container.createDiv({
      cls: "clinical-section-header",
      attr: pageKey ? { "data-page-section": pageKey } : {}
    });
    header.createEl("h3", { text: title });
    header.createSpan({ text: note, cls: "clinical-section-note" });
  }

  private pageFor<T>(key: string, items: readonly T[]): PageWindow<T> {
    const page = pageWindow(items, this.listPages.get(key) ?? 0);
    this.listPages.set(key, page.page);
    return page;
  }

  private renderPagination<T>(container: HTMLElement, key: string, page: PageWindow<T>): void {
    if (page.pages <= 1) return;
    const label = LIST_PAGE_LABELS[key] ?? "Clinical list";
    const navigation = container.createDiv({
      cls: "clinical-pagination",
      attr: {
        role: "navigation",
        "aria-label": `${label} pages`,
        "data-page-key": key
      }
    });
    const previous = navigation.createEl("button", {
      text: "Previous",
      cls: "clinical-card-button",
      attr: {
        "aria-label": `Previous ${label.toLocaleLowerCase()} page; current page ${page.page + 1} of ${page.pages}`,
        "data-page-action": "previous"
      }
    });
    previous.disabled = page.page === 0;
    // A keyboard press on a button fires click with detail 0.
    previous.addEventListener("click", (event) =>
      this.selectListPage(key, page.page - 1, "previous", event.detail === 0)
    );
    navigation.createSpan({
      text: `Page ${page.page + 1} of ${page.pages} · ${page.total} total`,
      cls: "clinical-section-note",
      attr: { "aria-live": "polite" }
    });
    const next = navigation.createEl("button", {
      text: "Next",
      cls: "clinical-card-button",
      attr: {
        "aria-label": `Next ${label.toLocaleLowerCase()} page; current page ${page.page + 1} of ${page.pages}`,
        "data-page-action": "next"
      }
    });
    next.disabled = page.page >= page.pages - 1;
    next.addEventListener("click", (event) =>
      this.selectListPage(key, page.page + 1, "next", event.detail === 0)
    );
  }

  private selectListPage(
    key: string,
    page: number,
    action: "previous" | "next",
    keyboard: boolean
  ): void {
    const scroller = this.contentEl.querySelector(".clinical-workspace-scroll");
    this.pendingPageContext = {
      key,
      action,
      // instanceOf, not instanceof: a pop-out window has its own HTMLElement.
      scrollTop: scroller?.instanceOf(HTMLElement) ? scroller.scrollTop : 0,
      keyboard,
      refreshesStarted: this.refreshesStarted
    };
    this.listPages.set(key, page);
    void this.refresh();
  }

  private pagerNavigation(key: string): HTMLElement | undefined {
    return Array.from(this.contentEl.querySelectorAll(".clinical-pagination")).find(
      (item): item is HTMLElement => item.instanceOf(HTMLElement) && item.dataset.pageKey === key
    );
  }

  /** The pager's Previous or Next button, or its other button when that one is disabled. */
  private pagerControl(key: string, action: string): HTMLButtonElement | undefined {
    const navigation = this.pagerNavigation(key);
    const controls = navigation ? Array.from(navigation.querySelectorAll("button")) : [];
    const control = controls.find((item) => item.dataset.pageAction === action);
    return control && !control.disabled ? control : controls.find((item) => !item.disabled);
  }

  /** A page change redraws the view; place the reader, and focus, on the new page. */
  private restorePageContext(scroller: HTMLElement): void {
    const context = this.pendingPageContext;
    if (!context) return;
    const header = context.keyboard
      ? undefined
      : Array.from(this.contentEl.querySelectorAll("[data-page-section]")).find(
          (item): item is HTMLElement =>
            item.instanceOf(HTMLElement) && item.dataset.pageSection === context.key
        );
    const list = this.pagerNavigation(context.key)?.previousElementSibling;
    const firstHeading = list?.querySelector("h4") ?? list?.querySelector("strong");
    if (header && firstHeading?.instanceOf(HTMLElement) && typeof header.scrollIntoView === "function") {
      // A tap on Next at the foot of a long list used to keep the old offset
      // and land the reader at the end of the new page. Start the page at its
      // heading instead, with focus on its first item.
      header.scrollIntoView({ block: "start" });
      firstHeading.setAttribute("tabindex", "-1");
      firstHeading.focus({ preventScroll: true });
    } else {
      // From the keyboard, stay on the pager so repeated presses keep paging.
      scroller.scrollTop = context.scrollTop;
      this.pagerControl(context.key, context.action)?.focus({ preventScroll: true });
    }
    // A click can land during an in-flight refresh, whose render comes first.
    // Keep the context for the redraw the click queued, then drop it: later
    // Sync redraws must not scroll back to the header or take focus again.
    if (!this.refreshQueued || this.renderingRefresh > context.refreshesStarted) {
      this.pendingPageContext = null;
    }
  }

  private empty(container: HTMLElement, message: string): void {
    container.createDiv({ text: message, cls: "clinical-empty" });
  }

  /** `userText` marks free text, such as an owner's name, that may be Arabic. */
  private badge(container: HTMLElement, label: string, style: string, userText = false): void {
    const safe = String(style).replace(/[^a-z0-9-]/gi, "") || "default";
    container.createSpan({
      text: label,
      cls: `clinical-badge is-${safe}`,
      attr: userText ? { dir: "auto" } : {}
    });
  }

  /**
   * Card actions are disabled for the duration of their handler. Unlike the
   * modal submit button these fire directly, so an impatient double tap would
   * otherwise run the action twice.
   */
  private actionButton(
    container: HTMLElement,
    label: string,
    action: () => void | Promise<void>,
    primary = false,
    danger = false,
    // Rendered lists repeat the same button text on every card, which reads
    // as an indistinguishable pile of "Discharge" buttons in a screen-reader
    // rotor. The context names the record without changing the visible label.
    accessibleContext = "",
    // The id of the record whose card holds the button. Focus returns to
    // this record's control after a redraw, never to a namesake on another.
    recordId = ""
  ): void {
    const attr: Record<string, string> = accessibleContext
      ? { "aria-label": `${label} — ${accessibleContext}` }
      : {};
    if (recordId) {
      attr["data-record-id"] = recordId;
      attr["data-action"] = label;
    }
    const button = container.createEl("button", {
      text: label,
      cls: `clinical-card-button${primary ? " mod-cta" : ""}${danger ? " is-danger" : ""}`,
      attr
    });
    button.addEventListener("click", () => {
      if (button.disabled) return;
      const generation = this.renderGeneration;
      const accessibleName = accessibleContext ? `${label} — ${accessibleContext}` : label;
      const ownerDocument = (
        button as HTMLButtonElement & { ownerDocument?: Document }
      ).ownerDocument;
      const ownedFocusAtStart = !ownerDocument || ownerDocument.activeElement === button;
      button.disabled = true;
      void (async () => {
        try {
          await action();
        } finally {
          button.disabled = false;
          if (
            this.renderGeneration !== generation &&
            ownedFocusAtStart &&
            clinicalActionFocusMayReturn(button, ownerDocument)
          ) {
            this.restoreActionFocus(accessibleName, recordId, label);
          }
        }
      })();
    });
  }

  /**
   * Keep keyboard users in the workspace after a redraw-triggering action.
   * A record's card action goes back only to that record's control; when the
   * control went with its record, focus goes to the title, never a namesake.
   */
  private restoreActionFocus(accessibleName: string, recordId = "", action = ""): void {
    const controls = Array.from(this.contentEl.querySelectorAll("button"));
    const target = recordId
      ? this.recordControl(recordId, action)
      : controls.find((control) => {
        const aria = control.getAttribute("aria-label");
        return (aria ?? (control.textContent ?? "").trim()) === accessibleName;
      });
    if (target?.instanceOf(HTMLElement)) {
      target.focus({ preventScroll: true });
      return;
    }
    const heading = this.contentEl.querySelector(".clinical-workspace-title");
    if (heading?.instanceOf(HTMLElement)) heading.focus({ preventScroll: true });
  }
}
