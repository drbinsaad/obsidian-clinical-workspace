import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { clinicalRootFolder, setClinicalRoot } from "./data/paths";
import { ClinicalRepository } from "./data/repository";
import { ClinicalService } from "./services/clinical-service";
import { IntegrityService } from "./services/integrity";
import { MigrationService, type MigrationMarker, type MigrationResult } from "./services/migration";
import { seedSyntheticFixtures } from "./services/synthetic-fixtures";
import { CARE_SETTINGS, PATHWAYS, PRIORITIES } from "./domain/types";
import {
  auditActor,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type ClinicalSettings
} from "./domain/settings";
import { IntegrityReportModal } from "./ui/modals";
import { ClinicalSettingTab } from "./ui/settings-tab";
import {
  CLINICAL_WORKSPACE_VIEW,
  ClinicalWorkspaceView
} from "./ui/workspace-view";

export default class ClinicalWorkspacePlugin extends Plugin {
  settings: ClinicalSettings = { ...DEFAULT_SETTINGS };

  private repository!: ClinicalRepository;
  private service!: ClinicalService;
  private integrity!: IntegrityService;
  private migration!: MigrationService;
  private refreshTimer: number | null = null;
  private structureReady = false;
  private integrityChecked = false;
  private pendingMigrationMarker: unknown = null;
  /** In-flight guards: concurrent first-run calls otherwise race on createFolder. */
  private structurePromise: Promise<void> | null = null;
  private activationPromise: Promise<ClinicalWorkspaceView> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.repository = new ClinicalRepository(this.app);
    this.repository.setActor(auditActor(this.settings));
    this.service = new ClinicalService(this.repository);
    this.integrity = new IntegrityService(this.repository);
    this.migration = new MigrationService(this.app);

    this.registerView(
      CLINICAL_WORKSPACE_VIEW,
      (leaf: WorkspaceLeaf) =>
        new ClinicalWorkspaceView(leaf, this.repository, this.service, this.integrity, () => this.settings)
    );

    this.addSettingTab(new ClinicalSettingTab(this.app, this, this.migration));

    this.addRibbonIcon("stethoscope", "Open Clinical Workspace", () => {
      void this.activateWorkspace();
    });

    this.addCommand({
      id: "open-clinical-workspace",
      name: "Open Clinical Workspace",
      callback: () => void this.activateWorkspace()
    });
    this.addCommand({
      id: "add-patient-episode",
      name: "Add patient episode",
      callback: () => void this.openAddPatient()
    });
    this.addCommand({
      id: "run-integrity-check",
      name: "Run clinical data integrity check",
      callback: () => void this.runIntegrityCheck()
    });

    // Compiled out of release builds; see esbuild.config.mjs. The seeding logic
    // lives inline rather than in a method, because a class method body is not
    // reachability-tree-shaken and would keep the fixture data in the bundle
    // even with the command itself removed.
    if (__DEV_TOOLS__) {
      this.addCommand({
        id: "seed-synthetic-demo-data",
        name: "Development: add synthetic demo data",
        callback: () =>
          void (async () => {
            try {
              await this.ensureStructure();
              const count = await seedSyntheticFixtures(this.service);
              new Notice(`${count} synthetic clinical episode${count === 1 ? "" : "s"} created.`);
              const view = await this.activateWorkspace();
              await view.refresh();
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : "Synthetic data could not be created.",
                7000
              );
            }
          })()
      });
    }

    this.app.workspace.onLayoutReady(() => this.registerVaultEvents());
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }

  async loadSettings(): Promise<void> {
    const stored = await this.loadData();
    this.settings = normalizeSettings(stored, {
      careSettings: CARE_SETTINGS,
      pathways: PATHWAYS,
      priorities: PRIORITIES
    });
    setClinicalRoot(this.settings.rootFolder);
    this.pendingMigrationMarker = stored;
  }

  async updateSettings(patch: Partial<ClinicalSettings>): Promise<void> {
    this.settings = normalizeSettings(
      { ...this.settings, ...patch },
      { careSettings: CARE_SETTINGS, pathways: PATHWAYS, priorities: PRIORITIES }
    );
    // normalizeSettings drops unknown keys, so an unrelated settings change would
    // otherwise erase an in-flight migration marker and with it the only record
    // that a move was interrupted.
    await this.saveData(this.withPendingMarker(this.settings));
    this.repository.setActor(auditActor(this.settings));
    setClinicalRoot(this.settings.rootFolder);
    await this.refreshOpenViews();
  }

  /**
   * Moves every record to a new root folder.
   *
   * The new location is persisted *before* the rename, not after. Writing it
   * afterwards looks safer but is not: the rename is the irreversible step, so
   * any failure or interruption after it would leave the plugin pointing at a
   * folder that no longer holds the records, and the workspace would come back
   * empty with no way to recover from inside the plugin. A marker records that
   * a move was in flight so `reconcileMigration` can settle it on next load.
   */
  async migrateRootFolder(target: string): Promise<MigrationResult> {
    const result = await this.migration.run(target, async (plan) => {
      this.settings = { ...this.settings, rootFolder: plan.to };
      await this.saveData({ ...this.settings, migrationInProgress: { from: plan.from, to: plan.to } });
      setClinicalRoot(plan.to);
    });
    await this.saveData(this.settings);
    await this.refreshOpenViews();
    if (result.danglingLinks > 0) {
      new Notice(
        `Records moved, but ${result.danglingLinks} note${result.danglingLinks === 1 ? " still refers" : "s still refer"} to the old folder. Run the integrity check.`,
        12000
      );
    }
    return result;
  }

  /**
   * Settles a migration that was interrupted between the marker being written
   * and the move completing. Whichever of the two folders actually exists wins,
   * because that is where the records are.
   */
  /** Re-attaches an in-flight migration marker to whatever is being saved. */
  private withPendingMarker(settings: ClinicalSettings): Record<string, unknown> {
    const marker = (this.pendingMigrationMarker as { migrationInProgress?: MigrationMarker } | null)
      ?.migrationInProgress;
    return marker ? { ...settings, migrationInProgress: marker } : { ...settings };
  }

  private async reconcileMigration(stored: unknown): Promise<void> {
    const marker = (stored as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress;
    if (!marker?.from || !marker?.to) return;
    // "Holds records", not "exists" and not "contains any markdown": ensureStructure
    // writes a home note and database views, so a freshly created empty root would
    // otherwise look occupied — which is the exact failure this is here to prevent.
    const RECORD_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"];
    const holdsRecords = (root: string) =>
      this.app.vault
        .getMarkdownFiles()
        .some((file) => RECORD_FOLDERS.some((folder) => file.path.startsWith(`${root}/${folder}/`)));
    const actual = holdsRecords(marker.to) ? marker.to : holdsRecords(marker.from) ? marker.from : null;
    if (actual && actual !== this.settings.rootFolder) {
      this.settings = { ...this.settings, rootFolder: actual };
      setClinicalRoot(actual);
    }
    this.pendingMigrationMarker = null;
    await this.saveData(this.settings);
    new Notice(
      `Clinical Workspace recovered an interrupted folder move. Records are in "${this.settings.rootFolder}".`,
      12000
    );
  }

  /**
   * Folders and database views are created the first time the user actually
   * opens the workspace, not on load. A plugin that writes into a vault before
   * the user has asked it to do anything is both surprising and contrary to
   * Obsidian's community plugin guidelines.
   */
  private async ensureStructure(): Promise<void> {
    if (this.structureReady) return;
    // Shared promise rather than a boolean: two callers arriving together would
    // both see structureReady === false and both start creating folders.
    this.structurePromise ??= (async () => {
      try {
        await this.repository.ensureStructure();
        this.structureReady = true;
      } finally {
        this.structurePromise = null;
      }
    })();
    await this.structurePromise;
  }

  private async refreshOpenViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(CLINICAL_WORKSPACE_VIEW)) {
      const view = leaf.view;
      if (view instanceof ClinicalWorkspaceView) await view.refresh();
    }
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => this.scheduleRefresh(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleRefresh(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.scheduleRefresh(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.scheduleRefresh(file.path);
        this.scheduleRefresh(oldPath);
      })
    );
  }

  private scheduleRefresh(path: string): void {
    if (!path.startsWith(`${clinicalRootFolder()}/`)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshOpenViews();
    }, this.settings.refreshDebounceMs);
  }

  private async activateWorkspace(): Promise<ClinicalWorkspaceView> {
    this.activationPromise ??= this.doActivateWorkspace().finally(() => {
      this.activationPromise = null;
    });
    return this.activationPromise;
  }

  private async doActivateWorkspace(): Promise<ClinicalWorkspaceView> {
    // Reconciliation runs FIRST. ensureStructure creates whatever root the
    // settings name, so running it first would manufacture an empty folder at
    // the interrupted destination and reconciliation would then "find" it.
    if (this.pendingMigrationMarker) {
      const marker = this.pendingMigrationMarker;
      this.pendingMigrationMarker = null;
      await this.reconcileMigration(marker);
    }
    await this.ensureStructure();
    const existing = this.app.workspace.getLeavesOfType(CLINICAL_WORKSPACE_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) {
      await leaf.setViewState({ type: CLINICAL_WORKSPACE_VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof ClinicalWorkspaceView)) {
      throw new Error("Clinical Workspace view could not be opened.");
    }
    await view.refresh();
    if (this.settings.runIntegrityOnStartup && !this.integrityChecked) {
      this.integrityChecked = true;
      await this.runIntegrityCheck({ onlyWhenIssuesFound: true });
    }
    return view;
  }

  private async openAddPatient(): Promise<void> {
    try {
      const view = await this.activateWorkspace();
      view.openAddPatient();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not open Add Patient.", 7000);
    }
  }

  private async runIntegrityCheck(options: { onlyWhenIssuesFound?: boolean } = {}): Promise<void> {
    try {
      await this.ensureStructure();
      const issues = await this.integrity.scan();
      if (options.onlyWhenIssuesFound && !issues.length) return;
      // Results are rendered in the interface. They are never written to the
      // developer console, because the records they describe are identifiable.
      new IntegrityReportModal(this.app, issues, (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) void this.app.workspace.getLeaf(false).openFile(file as never);
      }).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Integrity check failed.", 7000);
    }
  }
}
