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
  UpdateEpisodeModal,
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

export class ClinicalWorkspaceView extends ItemView {
  private activeTab: WorkspaceTab = "today";
  private refreshing = false;
  private refreshQueued = false;

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
    await this.refresh();
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
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "clinical-workspace-header" });
    const titles = header.createDiv();
    titles.createEl("h2", { text: "Clinical Workspace", cls: "clinical-workspace-title" });
    titles.createDiv({ text: "Local-first patient workflow", cls: "clinical-workspace-subtitle" });
    const refresh = header.createEl("button", {
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
    window.setTimeout(() => {
      const target = this.contentEl.querySelector(`#clinical-tab-${next}`);
      if (target?.instanceOf(HTMLElement)) target.focus();
    }, 0);
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
    this.renderTaskList(container, overdueTasks, snapshot);
    this.sectionHeader(container, "Today", todayIso());
    this.renderTaskList(container, todayTasks, snapshot);
    // Undated work is still outstanding; without this section Today under-reports.
    if (undatedTasks.length) {
      this.sectionHeader(container, "No date set", `${undatedTasks.length} open`);
      this.renderTaskList(container, undatedTasks, snapshot);
    }
  }

  private renderPatients(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const active = snapshot.episodes
      .filter((episode) => this.isActiveEpisode(episode))
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));
    const inpatient = active.filter((episode) => episode.care_setting === "inpatient");
    const outpatient = active.filter((episode) => episode.care_setting !== "inpatient");
    this.sectionHeader(container, "Inpatients", `${inpatient.length} active`);
    this.renderEpisodeList(container, inpatient, snapshot);
    this.sectionHeader(container, "Outpatients", `${outpatient.length} active`);
    this.renderEpisodeList(container, outpatient, snapshot);
  }

  private renderTasks(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const tasks = snapshot.tasks
      .filter(taskIsOpen)
      .sort((a, b) => this.taskSortKey(a).localeCompare(this.taskSortKey(b)));
    this.sectionHeader(container, "Open tasks", `${tasks.length} total`);
    this.renderTaskList(container, tasks, snapshot);
  }

  private renderSurgery(container: HTMLElement, snapshot: ClinicalSnapshot): void {
    const bookings = snapshot.episodes
      .filter((episode) => this.isActiveEpisode(episode) && episode.pathway === "or-booking")
      .sort((a, b) => this.episodeSortKey(a).localeCompare(this.episodeSortKey(b)));
    this.sectionHeader(container, "OR booking", `${bookings.length} awaiting surgery`);
    const list = container.createDiv({ cls: "clinical-list" });
    if (!bookings.length) this.empty(list, "No active OR bookings.");
    for (const episode of bookings) {
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

    const procedures = [...snapshot.procedures].sort((a, b) =>
      this.text(b.procedure_date).localeCompare(this.text(a.procedure_date))
    );
    this.sectionHeader(container, "Surgery logbook", `${procedures.length} completed`);
    const procedureList = container.createDiv({ cls: "clinical-list" });
    if (!procedures.length) this.empty(procedureList, "No completed procedures yet.");
    for (const procedure of procedures) this.renderProcedureCard(procedureList, procedure, snapshot);
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
    for (const patient of patients) this.renderPatientCard(patientList, patient, snapshot);

    this.sectionHeader(container, "Archive", "Searchable and restorable");
    const archived = snapshot.episodes
      .filter((episode) => episode.status === "archived")
      .sort((a, b) => this.text(b.closed_at).localeCompare(this.text(a.closed_at)));
    const archiveList = container.createDiv({ cls: "clinical-list" });
    if (!archived.length) this.empty(archiveList, "No archived episodes.");
    for (const episode of archived) {
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
      .filter((patient) => patient.status !== "entered-in-error" && !patient.merged_into)
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

  private renderEpisodeList(container: HTMLElement, episodes: EpisodeRecord[], snapshot: ClinicalSnapshot): void {
    const list = container.createDiv({ cls: "clinical-list" });
    if (!episodes.length) {
      this.empty(list, "No patients in this care setting.");
      return;
    }
    for (const episode of episodes) {
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
  }

  private renderTaskList(container: HTMLElement, tasks: TaskRecord[], snapshot: ClinicalSnapshot): void {
    const list = container.createDiv({ cls: "clinical-list" });
    if (!tasks.length) {
      this.empty(list, "Nothing on this list.");
      return;
    }
    for (const task of tasks) {
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
