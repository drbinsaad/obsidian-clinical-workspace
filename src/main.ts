import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CLINICAL_ROOT } from "./data/paths";
import { ClinicalRepository } from "./data/repository";
import { ClinicalService } from "./services/clinical-service";
import { IntegrityService } from "./services/integrity";
import { seedSyntheticFixtures } from "./services/synthetic-fixtures";
import { IntegrityReportModal } from "./ui/modals";
import {
  CLINICAL_WORKSPACE_VIEW,
  ClinicalWorkspaceView
} from "./ui/workspace-view";

export default class ClinicalWorkspacePlugin extends Plugin {
  private repository!: ClinicalRepository;
  private service!: ClinicalService;
  private integrity!: IntegrityService;
  private refreshTimer: number | null = null;
  private structureReady = false;

  async onload(): Promise<void> {
    this.repository = new ClinicalRepository(this.app);
    this.service = new ClinicalService(this.repository);
    this.integrity = new IntegrityService(this.repository);

    this.registerView(
      CLINICAL_WORKSPACE_VIEW,
      (leaf: WorkspaceLeaf) => new ClinicalWorkspaceView(leaf, this.repository, this.service, this.integrity)
    );

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

  /**
   * Folders and database views are created the first time the user actually
   * opens the workspace, not on load. A plugin that writes into a vault before
   * the user has asked it to do anything is both surprising and contrary to
   * Obsidian's community plugin guidelines.
   */
  private async ensureStructure(): Promise<void> {
    await this.repository.ensureStructure();
    this.structureReady = true;
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
    if (!path.startsWith(`${CLINICAL_ROOT}/`)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(CLINICAL_WORKSPACE_VIEW)) {
        const view = leaf.view;
        if (view instanceof ClinicalWorkspaceView) void view.refresh();
      }
    }, 180);
  }

  private async activateWorkspace(): Promise<ClinicalWorkspaceView> {
    if (!this.structureReady) await this.ensureStructure();
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

  private async runIntegrityCheck(): Promise<void> {
    try {
      if (!this.structureReady) await this.ensureStructure();
      const issues = await this.integrity.scan();
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
