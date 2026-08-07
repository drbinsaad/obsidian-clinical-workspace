import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { clinicalRootFolder, setClinicalRoot } from "./data/paths";
import { ClinicalRepository } from "./data/repository";
import { markdownFilesInFolder } from "./data/vault-scope";
import { ClinicalService } from "./services/clinical-service";
import { IntegrityService } from "./services/integrity";
import {
  MigrationService,
  resolveMigrationRoot,
  type MigrationMarker,
  type MigrationPlan,
  type MigrationResult
} from "./services/migration";
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
  private refreshMaxWaitTimer: number | null = null;
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
      void this.openWorkspace();
    });

    this.addCommand({
      id: "open-workspace",
      name: "Open workspace",
      callback: () => void this.openWorkspace()
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
    if (this.refreshMaxWaitTimer !== null) window.clearTimeout(this.refreshMaxWaitTimer);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as unknown;
    this.settings = normalizeSettings(stored, {
      careSettings: CARE_SETTINGS,
      pathways: PATHWAYS,
      priorities: PRIORITIES
    });
    setClinicalRoot(this.settings.rootFolder);
    const marker = (stored as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress;
    this.pendingMigrationMarker = marker?.from && marker.to ? { migrationInProgress: marker } : null;
  }

  /** Applies data.json changes delivered by Obsidian Sync without a restart. */
  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    if (!this.repository) return;
    this.repository.setActor(auditActor(this.settings));
    this.structureReady = false;
    this.integrityChecked = false;
    await this.refreshOpenViews();
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
    const attempt: { plan?: MigrationPlan } = {};
    try {
      const result = await this.migration.run(target, async (plan) => {
        attempt.plan = plan;
        const marker = { from: plan.from, to: plan.to };
        this.settings = { ...this.settings, rootFolder: plan.to };
        this.pendingMigrationMarker = { migrationInProgress: marker };
        await this.saveData(this.withPendingMarker(this.settings));
        setClinicalRoot(plan.to);
      });
      // `MigrationService.run` never throws after the rename succeeds. Reaching
      // here therefore proves the destination holds the moved records and the
      // recovery marker can be retired.
      this.pendingMigrationMarker = null;
      await this.saveData(this.settings);
      await this.refreshOpenViews();
      if (result.danglingLinks > 0) {
        new Notice(
          `Records moved, but ${result.danglingLinks} note${result.danglingLinks === 1 ? " still refers" : "s still refer"} to the old folder. Run the integrity check.`,
          12000
        );
      } else if (result.linkVerificationFailed) {
        new Notice(
          "Records moved, but their rewritten links could not be verified. Run the integrity check before continuing clinical work.",
          12000
        );
      }
      return result;
    } catch (error) {
      // A throw can only happen before or during rename. Point back at the
      // source immediately and keep the marker armed until reconciliation has
      // inspected the vault. An unrelated settings save must not erase it.
      const failedPlan = attempt.plan;
      if (failedPlan) {
        const marker = { from: failedPlan.from, to: failedPlan.to };
        this.settings = { ...this.settings, rootFolder: failedPlan.from };
        this.pendingMigrationMarker = { migrationInProgress: marker };
        setClinicalRoot(failedPlan.from);
        await this.saveData(this.withPendingMarker(this.settings));
      }
      throw error;
    }
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
      markdownFilesInFolder(this.app.vault, root)
        .some((file) => RECORD_FOLDERS.some((folder) => file.path.startsWith(`${root}/${folder}/`)));
    const sourceHasRecords = holdsRecords(marker.from);
    const destinationHasRecords = holdsRecords(marker.to);
    const actual = resolveMigrationRoot(marker, (root) =>
      root === marker.from ? sourceHasRecords : destinationHasRecords
    );
    if (!actual && (sourceHasRecords || destinationHasRecords)) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      await this.saveData(this.withPendingMarker(this.settings));
      throw new Error(
        "Clinical Workspace could not determine where an interrupted folder move left the records. The recovery marker was preserved; inspect both folders before continuing."
      );
    }
    // A newly scaffolded workspace legitimately has no records at either path.
    // If its rename failed, the source remains authoritative; preserving the
    // marker would otherwise make every future activation fail forever.
    const resolvedRoot = actual ?? marker.from;
    if (resolvedRoot !== this.settings.rootFolder) {
      this.settings = { ...this.settings, rootFolder: resolvedRoot };
      setClinicalRoot(resolvedRoot);
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
    this.registerEvent(this.app.vault.on("create", (file) => {
      this.repository.invalidatePath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.repository.invalidatePath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.repository.invalidatePath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.repository.invalidatePath(file.path);
        this.repository.invalidatePath(oldPath);
        this.scheduleRefresh(file.path);
        this.scheduleRefresh(oldPath);
      })
    );
  }

  private scheduleRefresh(path: string): void {
    if (!path.startsWith(`${clinicalRootFolder()}/`)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    const refresh = () => {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      if (this.refreshMaxWaitTimer !== null) window.clearTimeout(this.refreshMaxWaitTimer);
      this.refreshTimer = null;
      this.refreshMaxWaitTimer = null;
      void this.refreshOpenViews();
    };
    this.refreshMaxWaitTimer ??= window.setTimeout(
      refresh,
      Math.max(2000, this.settings.refreshDebounceMs)
    );
    this.refreshTimer = window.setTimeout(() => {
      refresh();
    }, this.settings.refreshDebounceMs);
  }

  private async activateWorkspace(): Promise<ClinicalWorkspaceView> {
    this.activationPromise ??= this.doActivateWorkspace().finally(() => {
      this.activationPromise = null;
    });
    return this.activationPromise;
  }

  /** User-facing entry point: command and ribbon failures must never be silent. */
  private async openWorkspace(): Promise<void> {
    try {
      await this.activateWorkspace();
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Clinical Workspace could not be opened.",
        7000
      );
    }
  }

  private async doActivateWorkspace(): Promise<ClinicalWorkspaceView> {
    // Reconciliation runs FIRST. ensureStructure creates whatever root the
    // settings name, so running it first would manufacture an empty folder at
    // the interrupted destination and reconciliation would then "find" it.
    if (this.pendingMigrationMarker) {
      const marker = this.pendingMigrationMarker;
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
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
      }).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Integrity check failed.", 7000);
    }
  }
}
