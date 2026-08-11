import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type {
  ClinicalSnapshot,
  EpisodeRecord,
  NewEpisodeInput,
  PatientRecord,
  ProcedureRecord,
  TaskRecord
} from "../domain/types";
import {
  careSettingLabel,
  displayPhone,
  episodeNeedsReview,
  normalizeText,
  pathwayLabel,
  priorityLabel,
  taskIsDueToday,
  taskIsOpen,
  taskIsOverdue,
  taskIsUndated,
  todayIso
} from "../domain/schema";
import { clinicalFolder } from "../data/paths";
import type { ClinicalSettings } from "../domain/settings";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { ClinicalRepository } from "../data/repository";
import type { QuickEntryAction } from "../quick-entry";
import { ClinicalService, PossibleDuplicatePatientError } from "../services/clinical-service";
import { IntegrityService } from "../services/integrity";
import { seedSyntheticFixtures } from "../services/synthetic-fixtures";
import {
  ArchiveEpisodeModal,
  CancelTaskModal,
  DuplicatePatientModal,
  IntegrityReportModal,
  MergePatientsModal,
  NewEpisodeModal,
  NewTaskModal,
  PatientIdentityModal,
  ProcedureModal,
  QuickEntryEpisodeModal,
  QuickEntryModal,
  UpdateEpisodeModal,
  type QuickEntryEpisodeChoice,
  patientIdentityLabel
} from "./modals";

export const CLINICAL_WORKSPACE_VIEW = "clinical-workspace-view";

type WorkspaceTab = "today" | "patients" | "tasks" | "surgery" | "more";

const TAB_LABELS: Record<WorkspaceTab, string> = {
  today: "Today",
  patients: "Patients",
  tasks: "Tasks",
  surgery: "Surgery",
  more: "More"
};

const PANEL_ID = "clinical-workspace-panel";
export const CLINICAL_PAGE_SIZE = 40;

export type ClinicalWorkspacePaneMode = "wide" | "compact" | "narrow";

export const CLINICAL_WORKSPACE_WIDE_MIN_WIDTH = 1050;
export const CLINICAL_WORKSPACE_COMPACT_MIN_WIDTH = 680;
export const CLINICAL_WORKSPACE_PANE_CLASSES = [
  "is-wide",
  "is-compact",
  "is-narrow"
] as const;

export interface ClinicalWorkspacePaneHost {
  readWidth: () => number;
  observeWidth: (listener: (width: number) => void) => () => void;
  applyMode: (mode: ClinicalWorkspacePaneMode) => void;
  resetMode: () => void;
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
  "today-overdue": "Overdue tasks",
  "today-due": "Today tasks",
  "today-undated": "Undated tasks",
  "patients-inpatient": "Inpatients",
  "patients-outpatient": "Outpatients",
  "tasks-open": "Open tasks",
  "surgery-bookings": "OR bookings",
  "surgery-logbook": "Surgery logbook",
  "more-patients": "Patient records",
  "more-archive": "Archived episodes"
};

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

/**
 * Task/procedure shortcuts can target only a visible, active patient Episode.
 * The returned choices are labels for an explicit picker, never an automatic
 * attachment decision.
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
  return snapshot.episodes
    .filter(
      (episode) =>
        !["archived", "cancelled", "entered-in-error"].includes(episode.status) &&
        (purpose !== "procedure" || episode.pathway === "or-booking")
    )
    .flatMap((episode) => {
      const patient = patients.get(episode.patient_id);
      if (!patient) return [];
      return [{
        episode,
        patientLabel: patientIdentityLabel(patient.mrn, patient.patient_name),
        isCurrent: episode.id === currentEpisodeId
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
  private activeTab: WorkspaceTab = "today";
  private refreshing = false;
  private refreshQueued = false;
  private paneController: ClinicalWorkspacePaneController | null = null;
  private paneOwnerWindow: Window | null = null;
  private readonly listPages = new Map<string, number>();
  private pendingPageContext: {
    key: string;
    action: "previous" | "next";
    scrollTop: number;
  } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly repository: ClinicalRepository,
    private readonly service: ClinicalService,
    private readonly integrity: IntegrityService,
    private readonly getSettings: () => ClinicalSettings = () => DEFAULT_SETTINGS
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
    try {
      const snapshot = await this.repository.snapshot();
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
    const settings = this.getSettings();
    const defaults: Partial<NewEpisodeInput> = {
      careSetting: settings.defaultCareSetting,
      pathway: settings.defaultPathway,
      priority: settings.defaultPriority,
      ...seed
    };
    new NewEpisodeModal(
      this.app,
      async (input) => {
        try {
          const result = await this.service.createEpisode(input);
          new Notice(
            result.duplicateEpisode
              ? "This active case already exists; the existing episode was kept."
              : "Patient episode created."
          );
          this.activeTab = "patients";
          await this.refresh();
        } catch (error) {
          if (error instanceof PossibleDuplicatePatientError) {
            // Close the form, ask which patient this is, then resubmit.
            new DuplicatePatientModal(this.app, error.candidates, (patientId) => {
              void this.runAction(async () => {
                const resolved: NewEpisodeInput = patientId
                  ? { ...input, existingPatientId: patientId }
                  : { ...input, forceNewPatient: true };
                await this.service.createEpisode(resolved);
                new Notice("Patient episode created.");
                this.activeTab = "patients";
              });
            }).open();
            return;
          }
          throw error;
        }
      },
      defaults
    ).open();
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
    try {
      const choices = await this.quickEntryChoices(activeEpisodePath, "task");
      if (!choices.length) {
        new Notice("No active patient episode is available. Create an episode first.");
        return;
      }
      new QuickEntryEpisodeModal(this.app, "a task / follow-up", choices, (choice) => {
        new NewTaskModal(this.app, choice.episode, choice.patientLabel, async (input) => {
          const created = await this.service.createTask(input);
          new Notice(
            created.duplicate
              ? `Task already exists: ${created.task.record.task}`
              : `Task added: ${created.task.record.task}`
          );
          this.activeTab = "tasks";
          await this.refresh();
        }).open();
      }).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not open task quick entry.", 7000);
    }
  }

  /** Always shows an unselected Episode picker before opening the procedure form. */
  async openProcedureQuickEntry(activeEpisodePath = ""): Promise<void> {
    try {
      const choices = await this.quickEntryChoices(activeEpisodePath, "procedure");
      if (!choices.length) {
        new Notice(
          "No active operating-room booking episode is available. Move an episode to the operating-room booking pathway first."
        );
        return;
      }
      new QuickEntryEpisodeModal(this.app, "a procedure", choices, (choice) => {
        new ProcedureModal(this.app, choice.episode, choice.patientLabel, async (input) => {
          await this.service.completeProcedure(input);
          new Notice("Procedure logged and workflow updated.");
          this.activeTab = "surgery";
          await this.refresh();
        }).open();
      }).open();
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Could not open procedure quick entry.",
        7000
      );
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
    const [patients, episodes] = await Promise.all([
      this.repository.list<PatientRecord>("patient"),
      this.repository.list<EpisodeRecord>("episode")
    ]);
    const currentEpisodeId = episodes.find(
      (item) => item.path === activeEpisodePath
    )?.record.id ?? "";
    return quickEntryEpisodeChoices(
      {
        patients: patients.map((item) => item.record),
        episodes: episodes.map((item) => item.record),
        tasks: [],
        procedures: []
      },
      currentEpisodeId,
      purpose
    );
  }

  private render(snapshot: ClinicalSnapshot): void {
    const root = this.contentEl;
    root.empty();
    // The scroller is nested inside the view so the floating action button can
    // be a sibling of it: pinned to the view, and not scrolling away with the
    // content the way an absolutely positioned child of a scroller would.
    const scroller = root.createDiv({ cls: "clinical-workspace-scroll" });
    const shell = scroller.createDiv({ cls: "clinical-workspace-shell" });
    this.renderHeader(shell);
    this.renderTabs(shell);
    const panel = shell.createDiv({
      cls: "clinical-workspace-panel",
      attr: { id: PANEL_ID, role: "tabpanel", "aria-labelledby": `clinical-tab-${this.activeTab}` }
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
    this.restorePageContext(scroller);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "clinical-workspace-header" });
    const titles = header.createDiv({ cls: "clinical-workspace-heading" });
    titles.createEl("h2", { text: "Clinical Workspace", cls: "clinical-workspace-title" });
    titles.createDiv({ text: "Local-first patient workflow", cls: "clinical-workspace-subtitle" });
    const actions = header.createDiv({ cls: "clinical-workspace-header-actions" });
    const quickEntry = actions.createEl("button", {
      cls: "clinical-quick-entry-button",
      attr: { "aria-label": "Open Clinical Workspace quick entry" }
    });
    const quickEntryIcon = quickEntry.createSpan();
    setIcon(quickEntryIcon, "square-pen");
    quickEntry.createSpan({ text: "Quick entry" });
    quickEntry.addEventListener("click", () => this.openQuickEntry());
    const refresh = actions.createEl("button", {
      attr: { "aria-label": "Refresh Clinical Workspace" },
      cls: "clickable-icon clinical-refresh-button"
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  private renderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "clinical-workspace-tabs", attr: { role: "tablist" } });
    for (const [tab, label] of Object.entries(TAB_LABELS) as [WorkspaceTab, string][]) {
      const selected = this.activeTab === tab;
      const button = tabs.createEl("button", {
        text: label,
        cls: `clinical-workspace-tab${selected ? " is-active" : ""}`,
        attr: {
          id: `clinical-tab-${tab}`,
          role: "tab",
          "aria-selected": String(selected),
          "aria-controls": PANEL_ID,
          // Roving tabindex: only the selected tab is in the tab order.
          tabindex: selected ? "0" : "-1"
        }
      });
      button.addEventListener("click", () => this.selectTab(tab));
      button.addEventListener("keydown", (event) => this.handleTabKey(event, tab));
    }
  }

  private selectTab(tab: WorkspaceTab): void {
    this.activeTab = tab;
    void this.refresh();
  }

  private handleTabKey(event: KeyboardEvent, tab: WorkspaceTab): void {
    const order = Object.keys(TAB_LABELS) as WorkspaceTab[];
    const index = order.indexOf(tab);
    let next: WorkspaceTab | null = null;
    if (event.key === "ArrowRight") next = order[(index + 1) % order.length] ?? null;
    if (event.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length] ?? null;
    if (event.key === "Home") next = order[0] ?? null;
    if (event.key === "End") next = order[order.length - 1] ?? null;
    if (!next) return;
    event.preventDefault();
    this.selectTab(next);
    const focusSelectedTab = (): void => {
      const target = this.contentEl.querySelector(`#clinical-tab-${next}`);
      if (target?.instanceOf(HTMLElement)) target.focus();
    };
    const viewWindow = this.contentEl.ownerDocument.defaultView;
    if (viewWindow) viewWindow.setTimeout(focusSelectedTab, 0);
    else queueMicrotask(focusSelectedTab);
  }

  private renderToday(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const openTasks = snapshot.tasks.filter(taskIsOpen);
    const todayTasks = openTasks.filter((task) => taskIsDueToday(task));
    const overdueTasks = openTasks.filter((task) => taskIsOverdue(task));
    const undatedTasks = openTasks.filter((task) => taskIsUndated(task));
    const activeEpisodes = snapshot.episodes.filter((episode) => this.isActiveEpisode(episode));
    const inpatient = activeEpisodes.filter((episode) => episode.care_setting === "inpatient");
    const summary = container.createDiv({ cls: "clinical-summary-grid" });
    this.summaryCard(summary, todayTasks.length, "Due today");
    this.summaryCard(summary, overdueTasks.length, "Overdue");
    this.summaryCard(summary, inpatient.length, "Inpatients");
    this.summaryCard(summary, activeEpisodes.length, "Active episodes");

    this.sectionHeader(container, "Overdue", overdueTasks.length ? "Needs attention" : "All clear");
    this.renderTaskList(container, overdueTasks, snapshot, "today-overdue");
    this.sectionHeader(container, "Today", todayIso());
    this.renderTaskList(container, todayTasks, snapshot, "today-due");
    // Undated work is still outstanding; without this section Today under-reports.
    if (undatedTasks.length) {
      this.sectionHeader(container, "No date set", `${undatedTasks.length} open`);
      this.renderTaskList(container, undatedTasks, snapshot, "today-undated");
    }
  }

  private renderPatients(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const active = snapshot.episodes
      .filter((episode) => this.isActiveEpisode(episode))
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));
    const inpatient = active.filter((episode) => episode.care_setting === "inpatient");
    const outpatient = active.filter((episode) => episode.care_setting !== "inpatient");
    this.sectionHeader(container, "Inpatients", `${inpatient.length} active`);
    this.renderEpisodeList(container, inpatient, snapshot, "patients-inpatient");
    this.sectionHeader(container, "Outpatients", `${outpatient.length} active`);
    this.renderEpisodeList(container, outpatient, snapshot, "patients-outpatient");
  }

  private renderTasks(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const tasks = snapshot.tasks
      .filter(taskIsOpen)
      .sort((a, b) => this.taskSortKey(a).localeCompare(this.taskSortKey(b)));
    this.sectionHeader(container, "Open tasks", `${tasks.length} total`);
    this.renderTaskList(container, tasks, snapshot, "tasks-open");
  }

  private renderSurgery(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const bookings = snapshot.episodes
      .filter((episode) => this.isActiveEpisode(episode) && episode.pathway === "or-booking")
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));
    this.sectionHeader(container, "OR booking", `${bookings.length} awaiting surgery`);
    const list = container.createDiv({ cls: "clinical-list" });
    if (!bookings.length) this.empty(list, "No active OR bookings.");
    const bookingPage = this.pageFor("surgery-bookings", bookings);
    for (const episode of bookingPage.items) {
      const patient = this.patientFor(snapshot, episode.patient_id);
      const card = this.episodeCard(list, episode, patient);
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      this.actionButton(actions, "Open", () => this.openRecord("episode", episode.id));
      this.actionButton(
        actions,
        "Complete surgery",
        () => {
          new ProcedureModal(this.app, episode, this.patientLabel(patient), async (input) => {
            await this.service.completeProcedure(input);
            new Notice("Surgery logged and workflow updated.");
            await this.refresh();
          }).open();
        },
        true
      );
    }
    this.renderPagination(container, "surgery-bookings", bookingPage);

    const procedures = [...snapshot.procedures].sort((a, b) =>
      this.text(b.procedure_date).localeCompare(this.text(a.procedure_date))
    );
    this.sectionHeader(container, "Surgery logbook", `${procedures.length} completed`);
    const procedureList = container.createDiv({ cls: "clinical-list" });
    if (!procedures.length) this.empty(procedureList, "No completed procedures yet.");
    const procedurePage = this.pageFor("surgery-logbook", procedures);
    for (const procedure of procedurePage.items) this.renderProcedureCard(procedureList, procedure, snapshot);
    this.renderPagination(container, "surgery-logbook", procedurePage);
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

    this.sectionHeader(container, "Patient records", `${this.identifiablePatients(snapshot).length} on file`);
    const patientList = container.createDiv({ cls: "clinical-list" });
    const patients = this.identifiablePatients(snapshot);
    if (!patients.length) this.empty(patientList, "No patient records yet.");
    const patientPage = this.pageFor("more-patients", patients);
    for (const patient of patientPage.items) this.renderPatientCard(patientList, patient, snapshot);
    this.renderPagination(container, "more-patients", patientPage);

    this.sectionHeader(container, "Archive", "Searchable and restorable");
    const archived = snapshot.episodes
      .filter((episode) => episode.status === "archived")
      .sort((a, b) => this.text(b.closed_at).localeCompare(this.text(a.closed_at)));
    const archiveList = container.createDiv({ cls: "clinical-list" });
    if (!archived.length) this.empty(archiveList, "No archived episodes.");
    const archivePage = this.pageFor("more-archive", archived);
    for (const episode of archivePage.items) {
      const patient = this.patientFor(snapshot, episode.patient_id);
      const card = this.episodeCard(archiveList, episode, patient);
      if (episode.outcome) card.createEl("p", { text: `Outcome: ${episode.outcome}`, cls: "clinical-card-meta" });
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      this.actionButton(actions, "Open", () => this.openRecord("episode", episode.id));
      this.actionButton(
        actions,
        "Restore",
        () =>
          void this.runAction(async () => {
            await this.service.restoreEpisode(episode.id);
            new Notice("Patient episode restored.");
          }),
        true
      );
    }
    this.renderPagination(container, "more-archive", archivePage);

    this.sectionHeader(container, "Safety", "Data integrity");
    const safety = container.createDiv({ cls: "clinical-card" });
    safety.createEl("h4", { text: "Data integrity" });
    safety.createEl("p", {
      text: "Check duplicate MRNs, duplicate open tasks, broken links, unexpected values, and invalid dates.",
      cls: "clinical-card-meta"
    });
    const safetyActions = safety.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(safetyActions, "Run check", () => void this.showIntegrity());

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
        void this.runAction(async () => {
          const count = await seedSyntheticFixtures(this.service);
          new Notice(`${count} synthetic episodes created.`);
        })
      );
    }
  }

  private identifiablePatients(snapshot: ClinicalSnapshot): PatientRecord[] {
    return snapshot.patients
      .filter(
        (patient) =>
          patient.status === "active" &&
          !patient.merged_into &&
          !patient.merge_in_progress
      )
      .sort((a, b) => this.text(a.patient_name).localeCompare(this.text(b.patient_name)));
  }

  private renderPatientCard(container: HTMLElement, patient: PatientRecord, snapshot: ClinicalSnapshot): void {
    const card = container.createDiv({ cls: "clinical-card" });
    const top = card.createDiv({ cls: "clinical-card-top" });
    top.createEl("h4", { text: patient.patient_name || "Name not recorded" });
    top.createSpan({ text: patient.status, cls: "clinical-card-meta" });
    card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
    card.createEl("p", { text: `Phone ${displayPhone(patient.phone)}`, cls: "clinical-card-meta" });
    const episodes = snapshot.episodes.filter((episode) => episode.patient_id === patient.id).length;
    card.createEl("p", { text: `${episodes} episode${episodes === 1 ? "" : "s"}`, cls: "clinical-card-meta" });
    if (!patient.mrn || !patient.patient_name) {
      const badges = card.createDiv({ cls: "clinical-badges" });
      this.badge(badges, "Needs review", "overdue");
    }
    const actions = card.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(actions, "Open", () => this.openRecord("patient", patient.id));
    this.actionButton(actions, "Edit identity", () => {
      new PatientIdentityModal(this.app, patient, async (input) => {
        await this.service.updatePatientIdentity(patient.id, input);
        new Notice("Patient identity updated.");
        await this.refresh();
      }).open();
    });
    const others = this.identifiablePatients(snapshot).filter((item) => item.id !== patient.id);
    if (others.length) {
      this.actionButton(actions, "Merge", () => {
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
      });
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
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      this.actionButton(actions, "Open", () => this.openRecord("episode", episode.id));
      this.actionButton(actions, "+ Task", () => {
        new NewTaskModal(this.app, episode, this.patientLabel(patient), async (input) => {
          const created = await this.service.createTask(input);
          new Notice(
            created.duplicate
              ? `Task already exists: ${created.task.record.task}`
              : `Task added: ${created.task.record.task}`
          );
          await this.refresh();
        }).open();
      });
      this.actionButton(actions, "Update", () => {
        new UpdateEpisodeModal(this.app, episode, async (input) => {
          const result = await this.service.updateEpisode(episode.id, input);
          // Say what happened to the task. A next action that produced no task
          // must never pass silently — the clinician would assume it is on a
          // worklist when it is not.
          const outcome = result.task;
          let message = "Patient workflow updated.";
          if (outcome.kind === "created") {
            message = outcome.superseded
              ? `Task added: ${outcome.task.record.task}. ${outcome.superseded} superseded task${outcome.superseded === 1 ? "" : "s"} cancelled.`
              : `Task added: ${outcome.task.record.task}`;
          } else if (outcome.kind === "already-closed") {
            message = `No task added: “${outcome.task.record.task}” was already ${outcome.task.record.status}. Use + Task to raise it again.`;
          }
          new Notice(message, outcome.kind === "already-closed" ? 9000 : 4000);
          await this.refresh();
        }).open();
      });
      this.actionButton(
        actions,
        "Discharge",
        () => {
          new ArchiveEpisodeModal(
            this.app,
            episode,
            async (outcome) => {
              await this.service.archiveEpisode(episode.id, outcome);
              new Notice("Patient episode archived.");
              await this.refresh();
            },
            this.getSettings().confirmBeforeDischarge
          ).open();
        },
        false,
        true
      );
    }
    this.renderPagination(container, pageKey, page);
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
      const episode = snapshot.episodes.find((item) => item.id === task.episode_id);
      const card = list.createDiv({ cls: "clinical-card" });
      const top = card.createDiv({ cls: "clinical-card-top" });
      top.createEl("h4", { text: task.task || "Task not recorded" });
      top.createSpan({ text: task.due_date || "No date", cls: "clinical-card-meta" });
      card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
      if (episode) {
        card.createEl("p", {
          text: `${pathwayLabel(episode.pathway)} · ${episode.case}`,
          cls: "clinical-card-meta"
        });
      }
      const badges = card.createDiv({ cls: "clinical-badges" });
      this.badge(badges, priorityLabel(task.priority), task.priority);
      if (taskIsOverdue(task)) this.badge(badges, "Overdue", "overdue");
      if (task.owner) this.badge(badges, task.owner, "owner");
      const actions = card.createDiv({ cls: "clinical-card-actions" });
      this.actionButton(actions, "Open", () => this.openRecord("task", task.id));
      this.actionButton(
        actions,
        "Complete",
        () =>
          void this.runAction(async () => {
            await this.service.completeTask(task.id);
            new Notice("Task completed.");
          }),
        true
      );
      this.actionButton(actions, "Cancel", () => {
        new CancelTaskModal(this.app, task, async (reason) => {
          await this.service.cancelTask(task.id, reason);
          new Notice("Task cancelled.");
          await this.refresh();
        }).open();
      });
      if (episode) {
        this.actionButton(actions, "+ Task", () => {
          new NewTaskModal(this.app, episode, this.patientLabel(patient), async (input) => {
            const created = await this.service.createTask(input);
            new Notice(
              created.duplicate
                ? `Task already exists: ${created.task.record.task}`
                : `Task added: ${created.task.record.task}`
            );
            await this.refresh();
          }).open();
        });
      }
    }
    this.renderPagination(container, pageKey, page);
  }

  private episodeCard(container: HTMLElement, episode: EpisodeRecord, patient: PatientRecord | undefined): HTMLElement {
    const card = container.createDiv({ cls: "clinical-card" });
    const top = card.createDiv({ cls: "clinical-card-top" });
    top.createEl("h4", { text: episode.case || "Case not recorded" });
    top.createSpan({ text: episode.due_date || "Not set", cls: "clinical-card-meta" });
    card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
    if (patient) card.createEl("p", { text: `Phone ${displayPhone(patient.phone)}`, cls: "clinical-card-meta" });
    if (episode.next_action) {
      const next = card.createEl("p", { cls: "clinical-card-review" });
      next.createEl("strong", { text: "Next: " });
      next.appendText(episode.next_action);
    }
    const badges = card.createDiv({ cls: "clinical-badges" });
    this.badge(badges, careSettingLabel(episode.care_setting), episode.care_setting);
    this.badge(badges, pathwayLabel(episode.pathway), "pathway");
    this.badge(badges, priorityLabel(episode.priority), episode.priority);
    if (episodeNeedsReview(episode) || !patient?.mrn || !patient.patient_name) {
      this.badge(badges, "Needs review", "overdue");
    }
    return card;
  }

  private renderProcedureCard(container: HTMLElement, procedure: ProcedureRecord, snapshot: ClinicalSnapshot): void {
    const patient = this.patientFor(snapshot, procedure.patient_id);
    const card = container.createDiv({ cls: "clinical-card" });
    const top = card.createDiv({ cls: "clinical-card-top" });
    top.createEl("h4", { text: procedure.procedure || "Procedure not recorded" });
    top.createSpan({ text: procedure.procedure_date || "No date", cls: "clinical-card-meta" });
    card.createEl("p", { text: this.patientLabel(patient), cls: "clinical-card-meta" });
    card.createEl("p", { text: procedure.role, cls: "clinical-card-meta" });
    const badges = card.createDiv({ cls: "clinical-badges" });
    this.badge(badges, "Completed", "complete");
    this.badge(badges, procedure.follow_up_required ? "Follow-up required" : "No follow-up", "pathway");
    const actions = card.createDiv({ cls: "clinical-card-actions" });
    this.actionButton(actions, "Open log", () => this.openRecord("procedure", procedure.id));
  }

  private async showIntegrity(): Promise<void> {
    try {
      const issues = await this.integrity.scan();
      new IntegrityReportModal(this.app, issues, (path) => void this.openPath(path)).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Integrity check failed.", 7000);
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
      new Notice(error instanceof Error ? error.message : "The clinical action could not be completed.", 7000);
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
      new Notice(`File not found: ${path}`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(abstract);
  }

  private patientFor(snapshot: ClinicalSnapshot, patientId: string): PatientRecord | undefined {
    return snapshot.patients.find((patient) => patient.id === patientId);
  }

  private patientLabel(patient: PatientRecord | undefined): string {
    return patient
      ? patientIdentityLabel(patient.mrn, patient.patient_name)
      : "MRN needed · Patient identity missing";
  }

  private isActiveEpisode(episode: EpisodeRecord): boolean {
    return !["archived", "cancelled", "entered-in-error"].includes(episode.status);
  }

  /** Frontmatter is user-editable, so every sort key tolerates a missing value. */
  private text(value: unknown): string {
    return normalizeText(value);
  }

  private episodeSortKey(episode: EpisodeRecord): string {
    const priority = { emergency: "0", urgent: "1", routine: "2" }[episode.priority] ?? "3";
    return `${priority}|${episode.due_date || "9999-99-99"}|${this.text(episode.case).toLocaleLowerCase()}`;
  }

  private taskSortKey(task: TaskRecord): string {
    const priority = { emergency: "0", urgent: "1", routine: "2" }[task.priority] ?? "3";
    return `${task.due_date || "9999-99-99"}|${priority}|${this.text(task.task).toLocaleLowerCase()}`;
  }

  private summaryCard(container: HTMLElement, value: number, label: string): void {
    const card = container.createDiv({ cls: "clinical-summary-card" });
    card.createSpan({ text: String(value), cls: "clinical-summary-value" });
    card.createSpan({ text: label, cls: "clinical-summary-label" });
  }

  private sectionHeader(container: HTMLElement, title: string, note: string): void {
    const header = container.createDiv({ cls: "clinical-section-header" });
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
    previous.addEventListener("click", () => this.selectListPage(key, page.page - 1, "previous"));
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
    next.addEventListener("click", () => this.selectListPage(key, page.page + 1, "next"));
  }

  private selectListPage(
    key: string,
    page: number,
    action: "previous" | "next"
  ): void {
    const scroller = this.contentEl.querySelector(".clinical-workspace-scroll");
    this.pendingPageContext = {
      key,
      action,
      scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0
    };
    this.listPages.set(key, page);
    void this.refresh();
  }

  /** A page change redraws the view; retain the user's place and keyboard focus. */
  private restorePageContext(scroller: HTMLElement): void {
    const context = this.pendingPageContext;
    if (!context) return;
    scroller.scrollTop = context.scrollTop;
    const pagers = Array.from(this.contentEl.querySelectorAll(".clinical-pagination"));
    const navigation = pagers.find(
      (item): item is HTMLElement =>
        item.instanceOf(HTMLElement) && item.dataset.pageKey === context.key
    );
    const controls = navigation
      ? Array.from(navigation.querySelectorAll("button"))
      : [];
    const control = controls.find((item) => item.dataset.pageAction === context.action);
    const focusTarget = control && !control.disabled
      ? control
      : controls.find((item) => !item.disabled);
    focusTarget?.focus({ preventScroll: true });
    // A click can land during an in-flight refresh. Preserve the context for
    // the queued final redraw; otherwise that second redraw would jump to top.
    if (!this.refreshQueued) this.pendingPageContext = null;
  }

  private empty(container: HTMLElement, message: string): void {
    container.createDiv({ text: message, cls: "clinical-empty" });
  }

  private badge(container: HTMLElement, label: string, style: string): void {
    const safe = String(style).replace(/[^a-z0-9-]/gi, "") || "default";
    container.createSpan({ text: label, cls: `clinical-badge is-${safe}` });
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
    danger = false
  ): void {
    const button = container.createEl("button", {
      text: label,
      cls: `clinical-card-button${primary ? " mod-cta" : ""}${danger ? " is-danger" : ""}`
    });
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      void (async () => {
        try {
          await action();
        } finally {
          button.disabled = false;
        }
      })();
    });
  }
}
