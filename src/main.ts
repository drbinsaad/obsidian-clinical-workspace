import { MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { clinicalRootFolder, setClinicalRoot } from "./data/paths";
import {
  CLINICAL_WRITES_BLOCKED_MESSAGE,
  ClinicalRepository
} from "./data/repository";
import { markdownFilesInFolder } from "./data/vault-scope";
import {
  LEGACY_PATIENT_BODY_PATTERN,
  parseClinicalRecord,
  recordBody
} from "./data/markdown";
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
  normalizeFolderPath,
  normalizeSettings,
  validateRootFolder,
  type ClinicalSettings
} from "./domain/settings";
import {
  ConfirmMaintenanceModal,
  InitializeWorkspaceModal,
  IntegrityReportModal
} from "./ui/modals";
import { ClinicalSettingTab } from "./ui/settings-tab";
import {
  CLINICAL_WORKSPACE_VIEW,
  ClinicalWorkspaceView
} from "./ui/workspace-view";
import {
  QUICK_ENTRY_COMMAND_IDS,
  QUICK_ENTRY_PROTOCOL_ACTIONS,
  isSafeQuickEntryProtocolInvocation
} from "./quick-entry";

const CLINICAL_ROOT_UNAVAILABLE_MESSAGE =
  "Clinical Workspace is temporarily read-only because the configured folder is unavailable. After Sync finishes or the folder is restored, run “Retry pending folder move recovery” from the Command Palette.";
const CLINICAL_INITIALIZATION_REQUIRED_MESSAGE =
  "Clinical Workspace needs a trusted baseline. After Sync finishes, use “Initialize new workspace” to adopt the current records or initialize a genuinely new workspace.";
const CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE =
  "Clinical Workspace could not save its initialization state. No workspace folders were created; the plugin remains read-only.";

interface ExpectedEntityCounts {
  patient: number;
  episode: number;
  task: number;
  procedure: number;
}

interface PersistedWorkspaceSafety {
  version: 1;
  initialized: boolean;
  initializationApproved: boolean;
  managedRecordsExpected: boolean;
  expectedManagedRecordCount: number;
  rootRecoveryRequired: boolean;
  recoveryRequiresRecords: boolean;
  /**
   * Parsed-record commitment: per-entity counts of records that actually
   * parse, plus a SHA-256 over the sorted opaque record ids. A raw file
   * count cannot tell a healthy root from one whose files were replaced,
   * misplaced, or id-duplicated by a Sync conflict; this can. Ids are
   * opaque (PAT-/EPI-/TSK-/PRC- tokens), so the commitment carries no
   * patient information. Absent on state written before 0.5.0.
   */
  expectedEntityCounts?: ExpectedEntityCounts | undefined;
  expectedRecordDigest?: string | undefined;
}

interface RecordInventory {
  counts: ExpectedEntityCounts;
  digest: string;
  total: number;
}

const ENTITY_FOLDER_NAMES: ReadonlyArray<[keyof ExpectedEntityCounts, string]> = [
  ["patient", "Patients"],
  ["episode", "Episodes"],
  ["task", "Tasks"],
  ["procedure", "Procedures"]
];

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  /** Root named by the data.json version that supplied the pending marker. */
  private pendingMigrationConfiguredRoot: string | null = null;
  private migrationRecoveryBlocked = false;
  private missingRootRecoveryBlocked = false;
  private missingRootRequiresRecords = false;
  /** True only when data.json is absent and no managed record proves prior use. */
  private firstUseInitializationPending = false;
  /** A durable first-use approval whose scaffolding has not fully finalized. */
  private initializationScaffoldApproved = false;
  private firstUseInitializationPromise: Promise<boolean> | null = null;
  /** Managed-record count shown when the adoption confirmation opened. */
  private pendingAdoptionRecordCount: number | null = null;
  private pendingAdoptionRoot: string | null = null;
  private pendingAdoptionDataFingerprint: string | null = null;
  private workspaceInitialized = false;
  /** Once true, deletion recovery must not accept an empty parent folder. */
  private managedRecordsExpected = false;
  private expectedManagedRecordCount = 0;
  /** Parsed-record commitment; null until first computed or for pre-0.5 state. */
  private expectedEntityCounts: ExpectedEntityCounts | null = null;
  private expectedRecordDigest: string | null = null;
  /** True until path-free v1 safety metadata is durably saved. */
  private workspaceSafetyNeedsPersistence = false;
  /** Distinguishes overlapping safety saves so an older completion cannot clear a newer retry. */
  private workspaceSafetyRevision = 0;
  private recoveryBlockMessage = CLINICAL_WRITES_BLOCKED_MESSAGE;
  private migrationReconciliationPromise: Promise<boolean> | null = null;
  /** Serializes data.json writes so a delayed older snapshot cannot win. */
  private pluginDataWriteQueue: Promise<unknown> = Promise.resolve();
  private localMigrationRunning = false;
  /** In-flight guards: concurrent first-run calls otherwise race on createFolder. */
  private structurePromise: Promise<void> | null = null;
  private activationPromise: Promise<ClinicalWorkspaceView> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.repository = new ClinicalRepository(this.app);
    this.repository.setActor(auditActor(this.settings));
    this.repository.setWriteBlock(
      this.migrationRecoveryBlocked ? this.recoveryBlockMessage : null
    );
    this.repository.setManagedRecordWriteObserver(() => this.noteManagedRecordWrite());
    if (this.workspaceSafetyNeedsPersistence) await this.persistWorkspaceSafety();
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
    this.addRibbonIcon("square-pen", "Clinical Workspace quick entry", () => {
      void this.openQuickEntry();
    });

    this.addCommand({
      id: "open-workspace",
      name: "Open workspace",
      callback: () => void this.openWorkspace()
    });
    this.addCommand({
      id: QUICK_ENTRY_COMMAND_IDS["new-patient-episode"],
      name: "Quick entry: new patient / episode",
      icon: "user-plus",
      callback: () => void this.openAddPatient()
    });
    this.addCommand({
      id: QUICK_ENTRY_COMMAND_IDS.hub,
      name: "Quick entry",
      icon: "square-pen",
      callback: () => void this.openQuickEntry()
    });
    this.addCommand({
      id: QUICK_ENTRY_COMMAND_IDS["add-task-follow-up"],
      name: "Quick entry: add task / follow-up",
      icon: "list-plus",
      callback: () => void this.openAddTask()
    });
    this.addCommand({
      id: QUICK_ENTRY_COMMAND_IDS["record-procedure"],
      name: "Quick entry: record procedure",
      icon: "clipboard-plus",
      callback: () => void this.openRecordProcedure()
    });
    this.addCommand({
      id: QUICK_ENTRY_COMMAND_IDS.today,
      name: "Open today's pending work",
      icon: "calendar-clock",
      callback: () => void this.openTodayPendingWork()
    });
    this.addCommand({
      id: "run-integrity-check",
      name: "Run clinical data integrity check",
      callback: () => void this.runIntegrityCheck()
    });

    this.registerQuickEntryProtocol(QUICK_ENTRY_PROTOCOL_ACTIONS.hub, () => this.openQuickEntry());
    this.registerQuickEntryProtocol(
      QUICK_ENTRY_PROTOCOL_ACTIONS["new-patient-episode"],
      () => this.openAddPatient()
    );
    this.registerQuickEntryProtocol(
      QUICK_ENTRY_PROTOCOL_ACTIONS["add-task-follow-up"],
      () => this.openAddTask()
    );
    this.registerQuickEntryProtocol(
      QUICK_ENTRY_PROTOCOL_ACTIONS["record-procedure"],
      () => this.openRecordProcedure()
    );
    this.registerQuickEntryProtocol(
      QUICK_ENTRY_PROTOCOL_ACTIONS.today,
      () => this.openTodayPendingWork()
    );
    this.addCommand({
      id: "initialize-new-workspace",
      name: "Initialize new workspace",
      checkCallback: (checking) => {
        if (!this.firstUseInitializationPending) return false;
        if (!checking) void this.openWorkspace();
        return true;
      }
    });
    this.addCommand({
      id: "retry-folder-move-recovery",
      name: "Retry pending folder move recovery",
      checkCallback: (checking) => {
        if (!this.currentMigrationMarker() && !this.missingRootRecoveryBlocked) return false;
        if (!checking) {
          void this.retryPendingMigrationRecovery().catch(() => {
            this.showMigrationRecoveryNotice();
          });
        }
        return true;
      }
    });
    this.addCommand({
      id: "adopt-current-baseline",
      name: "Confirm current records as the recovery baseline",
      callback: () => void this.adoptCurrentBaseline()
    });
    this.addCommand({
      id: "remove-identifiers-from-generated-bodies",
      name: "Remove identifiers from generated note bodies",
      callback: () => void this.migrateGeneratedBodies()
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
    const incoming = normalizeSettings(stored, {
      careSettings: CARE_SETTINGS,
      pathways: PATHWAYS,
      priorities: PRIORITIES
    });
    const marker = this.markerFrom(stored);
    // A restored view can refresh before the command-driven activation path.
    // Keep it on the source while a valid marker is unresolved; the stored
    // destination remains intent, not proof that its folder has arrived.
    this.settings = marker ? { ...incoming, rootFolder: marker.from } : incoming;
    setClinicalRoot(this.settings.rootFolder);
    this.pendingMigrationMarker = marker ? { migrationInProgress: marker } : null;
    this.pendingMigrationConfiguredRoot = marker ? incoming.rootFolder : null;
    const safety = this.workspaceSafetyFrom(stored);
    const rootRecordCount = this.rootManagedRecordCount(this.settings.rootFolder);
    const rootHasRecords = rootRecordCount > 0;
    const rootExists = this.rootExists(this.settings.rootFolder);
    const initializationApproved =
      safety?.initializationApproved === true && safety.initialized !== true;
    const trustedSafety = this.isWorkspaceSafetyTrusted(safety, this.settings.rootFolder);
    // Pre-0.3.6 workspaces have no trusted aggregate count. Whatever is visible
    // may be a partial Sync delivery, so the current baseline must be adopted
    // explicitly even when records or an empty scaffold are already present.
    this.firstUseInitializationPending = !trustedSafety;
    this.initializationScaffoldApproved = initializationApproved && trustedSafety;
    this.workspaceInitialized = safety?.initialized === true;
    this.managedRecordsExpected =
      safety?.managedRecordsExpected === true || rootHasRecords;
    this.expectedManagedRecordCount = Math.max(
      safety?.expectedManagedRecordCount ?? 0,
      rootRecordCount,
      this.managedRecordsExpected ? 1 : 0
    );
    this.expectedEntityCounts = safety?.expectedEntityCounts ?? null;
    this.expectedRecordDigest = safety?.expectedRecordDigest ?? null;
    this.missingRootRequiresRecords =
      safety?.recoveryRequiresRecords === true || this.managedRecordsExpected;
    this.missingRootRecoveryBlocked = (
      !marker && !this.firstUseInitializationPending && !initializationApproved && (
        safety?.rootRecoveryRequired === true ||
        (this.workspaceInitialized && !rootExists)
      )
    );
    this.migrationRecoveryBlocked =
      Boolean(this.pendingMigrationMarker) ||
      this.missingRootRecoveryBlocked ||
      this.firstUseInitializationPending;
    this.recoveryBlockMessage = this.firstUseInitializationPending
      ? CLINICAL_INITIALIZATION_REQUIRED_MESSAGE
      : this.missingRootRecoveryBlocked
        ? CLINICAL_ROOT_UNAVAILABLE_MESSAGE
        : CLINICAL_WRITES_BLOCKED_MESSAGE;
    this.workspaceSafetyNeedsPersistence = false;
  }

  /** Applies data.json changes delivered by Obsidian Sync without a restart. */
  async onExternalSettingsChange(): Promise<void> {
    const stored = (await this.loadData()) as unknown;
    const incoming = normalizeSettings(stored, {
      careSettings: CARE_SETTINGS,
      pathways: PATHWAYS,
      priorities: PRIORITIES
    });
    const previousRoot = clinicalRootFolder();
    const deliveredMarker = this.markerFrom(stored);
    const existingMarker = this.currentMigrationMarker();
    const marker = deliveredMarker ?? existingMarker;
    const deliveredSafety = this.workspaceSafetyFrom(stored);
    const deliveredInitializationApproved =
      deliveredSafety?.initializationApproved === true &&
      deliveredSafety.initialized !== true;
    const deliveredTrustedSafety = this.isWorkspaceSafetyTrusted(
      deliveredSafety,
      incoming.rootFolder
    );
    this.workspaceInitialized ||= deliveredSafety?.initialized === true;
    this.managedRecordsExpected ||= deliveredSafety?.managedRecordsExpected === true;
    this.expectedManagedRecordCount = Math.max(
      this.expectedManagedRecordCount,
      deliveredSafety?.expectedManagedRecordCount ?? 0,
      this.managedRecordsExpected ? 1 : 0
    );
    // A versioned safety state supersedes the one-time legacy adoption prompt.
    // A safetyless file remains ambiguous and is handled below without saving.
    if (this.firstUseInitializationPending && deliveredTrustedSafety) {
      this.firstUseInitializationPending = false;
      this.initializationScaffoldApproved = deliveredInitializationApproved;
      this.workspaceInitialized = !deliveredInitializationApproved;
      const incomingRootExists = this.rootExists(incoming.rootFolder);
      const incomingRecordCount = this.rootManagedRecordCount(incoming.rootFolder);
      const deliveredExpectedCount = deliveredSafety?.expectedManagedRecordCount ?? 0;
      if (deliveredInitializationApproved && !marker) {
        if (incomingRecordCount < deliveredExpectedCount) {
          this.setMissingRootRecoveryBlocked(deliveredExpectedCount > 0);
        } else {
          this.missingRootRecoveryBlocked = false;
          this.missingRootRequiresRecords = false;
          this.setMigrationRecoveryBlocked(false);
        }
      } else if (!marker && !incomingRootExists) {
        const unknownLegacyRecordCount = !deliveredSafety;
        this.managedRecordsExpected ||=
          deliveredSafety?.managedRecordsExpected === true || unknownLegacyRecordCount;
        this.expectedManagedRecordCount = Math.max(
          this.expectedManagedRecordCount,
          this.managedRecordsExpected ? 1 : 0
        );
        this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      } else if (
        !marker &&
        deliveredExpectedCount > 0 &&
        incomingRecordCount < deliveredExpectedCount
      ) {
        this.setMissingRootRecoveryBlocked(true);
      } else if (!marker) {
        this.setMigrationRecoveryBlocked(false);
      }
    }
    if (deliveredSafety?.rootRecoveryRequired === true && !marker) {
      this.setMissingRootRecoveryBlocked(
        deliveredSafety.recoveryRequiresRecords || this.managedRecordsExpected
      );
    }

    // Apply non-path settings immediately, but keep reads pointed at the last
    // safe root until the folder delivery itself proves the new root usable.
    this.settings = { ...incoming, rootFolder: previousRoot };

    if (this.firstUseInitializationPending && !deliveredTrustedSafety) {
      // A safetyless settings file or migration marker is another pre-0.3.6
      // candidate, not proof that Sync is complete. Preserve any marker intent
      // but never reconcile or baseline it automatically.
      if (marker) {
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.pendingMigrationConfiguredRoot = incoming.rootFolder;
      }
      this.setMigrationRecoveryBlocked(true, CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
      if (!this.repository) return;
      this.repository.setActor(auditActor(this.settings));
      await this.refreshOpenViews();
      return;
    }

    if (marker) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      const configuredRoot = deliveredMarker
        ? incoming.rootFolder
        : (this.pendingMigrationConfiguredRoot ?? incoming.rootFolder);
      this.pendingMigrationConfiguredRoot = configuredRoot;
      this.setMigrationRecoveryBlocked(true);
      const settled = await this.reconcileMigration({
        ...incoming,
        rootFolder: configuredRoot,
        migrationInProgress: marker
      });
      if (!settled) {
        // A safety-state write can already be in flight when Sync delivers the
        // marker. Queue a canonical marker-bearing snapshot behind it so that
        // the older write cannot be the final data.json state.
        await this.persistPluginData();
        this.showMigrationRecoveryNotice();
      }
    } else if (incoming.rootFolder === previousRoot) {
      this.settings = incoming;
      setClinicalRoot(incoming.rootFolder);
      // Do not let an unrelated data.json update clear a barrier armed because
      // the configured root disappeared during a split Sync delivery.
      if (!this.migrationRecoveryBlocked) {
        this.setMigrationRecoveryBlocked(false);
      }
    } else if (
      this.canActivateSyncedRoot(previousRoot, incoming.rootFolder) &&
      (await this.verifyRecordInventory(incoming.rootFolder)).ok
    ) {
      this.settings = incoming;
      setClinicalRoot(incoming.rootFolder);
      this.workspaceInitialized = true;
      const deliveredRecordCount = this.rootManagedRecordCount(incoming.rootFolder);
      this.managedRecordsExpected ||= deliveredRecordCount > 0;
      this.expectedManagedRecordCount = Math.max(
        this.expectedManagedRecordCount,
        deliveredRecordCount
      );
      this.setMigrationRecoveryBlocked(false);
      // The incoming data may still carry a recovery flag from the old root.
      // Persist the proven root change so a restart cannot re-arm that stale
      // barrier after this device has already reconciled safely.
      await this.persistPluginData();
    } else {
      // A final data.json can overtake the folder rename and arrive without the
      // intermediate marker. Reconstruct recovery metadata, but persist the
      // *incoming* configured root so another restart cannot manufacture it.
      const inferred = { from: previousRoot, to: incoming.rootFolder };
      this.pendingMigrationMarker = { migrationInProgress: inferred };
      this.pendingMigrationConfiguredRoot = incoming.rootFolder;
      this.setMigrationRecoveryBlocked(true);
      await this.persistPluginData();
      this.showMigrationRecoveryNotice();
    }

    if (!this.repository) return;
    this.repository.setActor(auditActor(this.settings));
    this.structureReady = false;
    this.integrityChecked = false;
    await this.refreshOpenViews();
  }

  private markerFrom(value: unknown): MigrationMarker | null {
    const marker = (value as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress;
    if (typeof marker?.from !== "string" || typeof marker.to !== "string") return null;
    const from = normalizeFolderPath(marker.from);
    const to = normalizeFolderPath(marker.to);
    if (from === to || validateRootFolder(from) || validateRootFolder(to)) return null;
    return { from, to };
  }

  private workspaceSafetyFrom(value: unknown): PersistedWorkspaceSafety | null {
    const state = (value as { workspaceSafety?: Partial<PersistedWorkspaceSafety> } | null)
      ?.workspaceSafety;
    if (!state || state.version !== 1) return null;
    const count = (candidate: unknown): number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
        ? candidate
        : 0;
    const rawCounts = state.expectedEntityCounts as unknown;
    const expectedEntityCounts =
      rawCounts && typeof rawCounts === "object"
        ? {
            patient: count((rawCounts as Record<string, unknown>).patient),
            episode: count((rawCounts as Record<string, unknown>).episode),
            task: count((rawCounts as Record<string, unknown>).task),
            procedure: count((rawCounts as Record<string, unknown>).procedure)
          }
        : undefined;
    return {
      version: 1,
      initialized: state.initialized === true,
      initializationApproved: state.initializationApproved === true,
      managedRecordsExpected: state.managedRecordsExpected === true,
      expectedManagedRecordCount: count(state.expectedManagedRecordCount),
      rootRecoveryRequired: state.rootRecoveryRequired === true,
      recoveryRequiresRecords: state.recoveryRequiresRecords === true,
      expectedEntityCounts,
      expectedRecordDigest:
        typeof state.expectedRecordDigest === "string" && /^[0-9a-f]{64}$/.test(state.expectedRecordDigest)
          ? state.expectedRecordDigest
          : undefined
    };
  }

  private isWorkspaceSafetyTrusted(
    safety: PersistedWorkspaceSafety | null,
    root: string
  ): boolean {
    if (safety?.initialized === true) return true;
    if (safety?.initializationApproved !== true) return false;
    // A crash-resumable approval applies only to the exact record count the
    // user saw. A Sync change requires a fresh adoption confirmation.
    return this.rootManagedRecordCount(root) === safety.expectedManagedRecordCount;
  }

  private workspaceSafety(): PersistedWorkspaceSafety {
    return {
      version: 1,
      initialized: this.workspaceInitialized,
      initializationApproved: this.initializationScaffoldApproved,
      managedRecordsExpected: this.managedRecordsExpected,
      expectedManagedRecordCount: this.expectedManagedRecordCount,
      rootRecoveryRequired: this.missingRootRecoveryBlocked,
      recoveryRequiresRecords: this.missingRootRequiresRecords,
      expectedEntityCounts: this.expectedEntityCounts ?? undefined,
      expectedRecordDigest: this.expectedRecordDigest ?? undefined
    };
  }

  /**
   * Parses every managed record under `root` and reduces it to an
   * identifier-free commitment: per-entity parsed counts and a SHA-256 over
   * the sorted opaque record ids. Parsing is memoized by content, so this
   * stays cheap on repeated calls.
   */
  private async parsedRecordInventory(root: string): Promise<RecordInventory> {
    const counts: ExpectedEntityCounts = { patient: 0, episode: 0, task: 0, procedure: 0 };
    const ids: string[] = [];
    for (const [entity, folderName] of ENTITY_FOLDER_NAMES) {
      for (const file of markdownFilesInFolder(this.app.vault, `${root}/${folderName}`)) {
        const content = await this.app.vault.cachedRead(file);
        const record = parseClinicalRecord(content);
        if (record?.entity !== entity) continue;
        counts[entity] += 1;
        ids.push(`${entity}:${record.id}`);
      }
    }
    const digest = await sha256Hex(ids.sort().join("\n"));
    return {
      counts,
      digest,
      total: counts.patient + counts.episode + counts.task + counts.procedure
    };
  }

  /**
   * Verifies a root against the stored parsed-record commitment before any
   * fail-closed barrier is lifted. An equal raw file count can hide records
   * replaced with unparseable content, filed in the wrong entity folder, or
   * swapped under duplicate ids; parsed counts and the id digest cannot.
   * Growth is accepted: another device may legitimately have added records.
   */
  private async verifyRecordInventory(root: string): Promise<{ ok: boolean; reason: string | null }> {
    const expected = this.expectedEntityCounts;
    if (!expected) return { ok: true, reason: null };
    const current = await this.parsedRecordInventory(root);
    for (const [entity] of ENTITY_FOLDER_NAMES) {
      if (current.counts[entity] < expected[entity]) {
        return {
          ok: false,
          reason:
            "Some previously confirmed records are missing or no longer readable. Wait for Sync to finish or restore your backup, then retry — or confirm the current records as the new baseline."
        };
      }
    }
    const sameCounts = ENTITY_FOLDER_NAMES.every(([entity]) => current.counts[entity] === expected[entity]);
    if (sameCounts && this.expectedRecordDigest && current.digest !== this.expectedRecordDigest) {
      return {
        ok: false,
        reason:
          "The records on disk differ from the trusted baseline even though their count matches. Wait for Sync to finish or restore your backup, then retry — or confirm the current records as the new baseline."
      };
    }
    return { ok: true, reason: null };
  }

  /** Ratchets the parsed-record commitment forward from the current root. */
  private async ratchetRecordInventory(root: string): Promise<boolean> {
    const current = await this.parsedRecordInventory(root);
    const previous = this.expectedEntityCounts;
    const next: ExpectedEntityCounts = previous
      ? {
          patient: Math.max(previous.patient, current.counts.patient),
          episode: Math.max(previous.episode, current.counts.episode),
          task: Math.max(previous.task, current.counts.task),
          procedure: Math.max(previous.procedure, current.counts.procedure)
        }
      : current.counts;
    const changed =
      !previous ||
      JSON.stringify(next) !== JSON.stringify(previous) ||
      this.expectedRecordDigest !== current.digest;
    this.expectedEntityCounts = next;
    this.expectedRecordDigest = current.digest;
    return changed;
  }

  private currentMigrationMarker(): MigrationMarker | null {
    return this.markerFrom(this.pendingMigrationMarker);
  }

  private setMigrationRecoveryBlocked(
    blocked: boolean,
    message = CLINICAL_WRITES_BLOCKED_MESSAGE
  ): void {
    const baselineBlocked = !blocked && this.firstUseInitializationPending;
    const effectiveBlocked = blocked || baselineBlocked;
    const effectiveMessage = baselineBlocked
      ? CLINICAL_INITIALIZATION_REQUIRED_MESSAGE
      : message;
    this.migrationRecoveryBlocked = effectiveBlocked;
    this.recoveryBlockMessage = effectiveBlocked
      ? effectiveMessage
      : CLINICAL_WRITES_BLOCKED_MESSAGE;
    if (!effectiveBlocked || effectiveMessage === CLINICAL_WRITES_BLOCKED_MESSAGE) {
      this.missingRootRecoveryBlocked = false;
      this.missingRootRequiresRecords = false;
    }
    if (this.repository) {
      this.repository.setWriteBlock(effectiveBlocked ? effectiveMessage : null);
    }
  }

  private showMigrationRecoveryNotice(): void {
    new Notice(this.recoveryBlockMessage, 12000);
  }

  private setMissingRootRecoveryBlocked(
    requiresRecords = this.managedRecordsExpected
  ): void {
    this.missingRootRecoveryBlocked = true;
    this.missingRootRequiresRecords = requiresRecords;
    this.setMigrationRecoveryBlocked(true, CLINICAL_ROOT_UNAVAILABLE_MESSAGE);
  }

  private async noteManagedRecordWrite(): Promise<void> {
    const root = clinicalRootFolder();
    const currentCount = this.rootManagedRecordCount(root);
    const inventoryChanged = await this.ratchetRecordInventory(root);
    if (
      this.workspaceInitialized &&
      this.managedRecordsExpected &&
      currentCount <= this.expectedManagedRecordCount &&
      !inventoryChanged &&
      !this.workspaceSafetyNeedsPersistence
    ) return;
    this.workspaceInitialized = true;
    this.managedRecordsExpected = currentCount > 0;
    this.expectedManagedRecordCount = Math.max(this.expectedManagedRecordCount, currentCount);
    this.workspaceSafetyNeedsPersistence = true;
    await this.persistWorkspaceSafety();
  }

  private rootManagedRecordCount(root: string): number {
    const RECORD_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"];
    return markdownFilesInFolder(this.app.vault, root)
      .filter((file) => RECORD_FOLDERS.some((folder) => file.path.startsWith(`${root}/${folder}/`)))
      .length;
  }

  private rootExists(root: string): boolean {
    return this.app.vault.getAbstractFileByPath(root) instanceof TFolder;
  }

  /** A marker-free root change is safe only after one complete root wins. */
  private canActivateSyncedRoot(from: string, to: string): boolean {
    const sourceRecordCount = this.rootManagedRecordCount(from);
    const destinationRecordCount = this.rootManagedRecordCount(to);
    const sourceHasRecords = sourceRecordCount > 0;
    const destinationHasRecords = destinationRecordCount > 0;
    if (sourceHasRecords || destinationHasRecords) {
      if (!destinationHasRecords || sourceHasRecords) return false;
      return !this.managedRecordsExpected ||
        destinationRecordCount >= Math.max(1, this.expectedManagedRecordCount);
    }
    if (this.managedRecordsExpected) return false;
    // A record-free workspace may legitimately contain only scaffolding. Wait
    // until the old root is gone so a folder-before-file delivery cannot make
    // the plugin create a second tree.
    return this.rootExists(to) && !this.rootExists(from);
  }

  /**
   * Requires a deliberate user decision before any pre-safety workspace can
   * become writable. The visible root and record count are frozen while the
   * confirmation is open so late Sync cannot be silently baselined.
   */
  private requestFirstUseInitialization(): Promise<boolean> {
    if (!this.firstUseInitializationPending) return Promise.resolve(false);
    if (this.firstUseInitializationPromise) return this.firstUseInitializationPromise;
    if (this.currentMigrationMarker()) {
      new Notice(
        "A legacy folder move is still pending. Let synchronization finish, then use the recovery command before adopting the current workspace baseline.",
        12000
      );
      return Promise.resolve(false);
    }
    this.firstUseInitializationPromise = (async () => {
      const stored = (await this.loadData()) as unknown;
      const safety = this.workspaceSafetyFrom(stored);
      const trustedSafety = this.isWorkspaceSafetyTrusted(safety, this.settings.rootFolder);
      if (trustedSafety || this.markerFrom(stored)) {
        await this.loadSettings();
        this.repository.setWriteBlock(
          this.migrationRecoveryBlocked ? this.recoveryBlockMessage : null
        );
        return false;
      }
      const root = this.settings.rootFolder;
      const recordCount = this.rootManagedRecordCount(root);
      this.pendingAdoptionRoot = root;
      this.pendingAdoptionRecordCount = recordCount;
      this.pendingAdoptionDataFingerprint = JSON.stringify(stored) ?? "undefined";
      return new Promise<boolean>((resolve) => {
        new InitializeWorkspaceModal(this.app, recordCount > 0, resolve).open();
      });
    })().finally(() => {
      this.firstUseInitializationPromise = null;
    });
    return this.firstUseInitializationPromise;
  }

  /** Persists the one-time decision before creating any folder or note. */
  private async initializeNewWorkspace(): Promise<void> {
    if (!this.firstUseInitializationPending) {
      throw new Error(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
    }

    // The modal may have remained open while Sync delivered old state. Never
    // reinterpret that changed vault as a new workspace.
    const latest = (await this.loadData()) as unknown;
    const latestSafety = this.workspaceSafetyFrom(latest);
    const latestTrustedSafety = this.isWorkspaceSafetyTrusted(
      latestSafety,
      this.settings.rootFolder
    );
    const currentRecordCount = this.rootManagedRecordCount(this.settings.rootFolder);
    if (
      latestTrustedSafety ||
      this.markerFrom(latest) ||
      this.pendingAdoptionRecordCount === null ||
      currentRecordCount !== this.pendingAdoptionRecordCount ||
      this.pendingAdoptionRoot !== this.settings.rootFolder ||
      this.pendingAdoptionDataFingerprint !== (JSON.stringify(latest) ?? "undefined")
    ) {
      await this.loadSettings();
      this.repository.setWriteBlock(
        this.migrationRecoveryBlocked ? this.recoveryBlockMessage : null
      );
      throw new Error(
        "Clinical Workspace state changed while the confirmation was open. Initialization was cancelled; wait for Sync to finish, then open the workspace again."
      );
    }

    this.firstUseInitializationPending = false;
    this.initializationScaffoldApproved = true;
    this.workspaceInitialized = false;
    this.managedRecordsExpected = currentRecordCount > 0;
    this.expectedManagedRecordCount = currentRecordCount;
    this.missingRootRecoveryBlocked = false;
    this.missingRootRequiresRecords = false;
    // Keep the write barrier armed until the durable approval has completed;
    // a second ribbon tap must not race ahead and scaffold early.
    this.migrationRecoveryBlocked = true;
    this.recoveryBlockMessage = CLINICAL_INITIALIZATION_REQUIRED_MESSAGE;
    try {
      // This must finish before ensureStructure is reachable. If it fails, no
      // folder is created and the original fail-closed state is restored.
      await this.persistPluginData();
      this.migrationRecoveryBlocked = false;
      this.recoveryBlockMessage = CLINICAL_WRITES_BLOCKED_MESSAGE;
      this.repository.setWriteBlock(null);
      this.pendingAdoptionRecordCount = null;
      this.pendingAdoptionRoot = null;
      this.pendingAdoptionDataFingerprint = null;
    } catch {
      this.firstUseInitializationPending = true;
      this.initializationScaffoldApproved = false;
      this.workspaceInitialized = false;
      this.migrationRecoveryBlocked = true;
      this.recoveryBlockMessage = CLINICAL_INITIALIZATION_REQUIRED_MESSAGE;
      this.repository.setWriteBlock(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
      this.pendingAdoptionRecordCount = null;
      this.pendingAdoptionRoot = null;
      this.pendingAdoptionDataFingerprint = null;
      throw new Error(CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE);
    }
  }

  async updateSettings(patch: Partial<ClinicalSettings>): Promise<void> {
    if (this.firstUseInitializationPending || this.initializationScaffoldApproved) {
      throw new Error(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
    }
    const previous = this.settings;
    this.settings = normalizeSettings(
      { ...this.settings, ...patch },
      { careSettings: CARE_SETTINGS, pathways: PATHWAYS, priorities: PRIORITIES }
    );
    try {
      // The queued persistence helper preserves any in-flight marker and its
      // configured destination while applying this unrelated settings change.
      await this.persistPluginData();
    } catch (error) {
      // A failed save must not leave the interface claiming a value that
      // data.json does not hold. Roll back and let the caller re-render.
      this.settings = previous;
      setClinicalRoot(previous.rootFolder);
      this.repository.setActor(auditActor(previous));
      new Notice("The setting could not be saved and was rolled back.", 7000);
      throw error;
    }
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
    if (this.migrationRecoveryBlocked) throw new Error(this.recoveryBlockMessage);
    this.setMigrationRecoveryBlocked(true);
    this.localMigrationRunning = true;
    const attempt: { plan?: MigrationPlan } = {};
    let recordsMoved = false;
    try {
      const result = await this.migration.run(target, async (plan) => {
        attempt.plan = plan;
        const marker = { from: plan.from, to: plan.to };
        this.settings = { ...this.settings, rootFolder: plan.to };
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.pendingMigrationConfiguredRoot = plan.to;
        await this.persistPluginData();
        setClinicalRoot(plan.to);
      });
      recordsMoved = true;
      // `MigrationService.run` never throws after the rename succeeds. Reaching
      // here therefore proves the destination holds the moved records and the
      // recovery marker can be retired.
      this.pendingMigrationMarker = null;
      this.pendingMigrationConfiguredRoot = null;
      this.setMigrationRecoveryBlocked(false);
      await this.persistPluginData();
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
      // MigrationService itself never throws after rename, but the subsequent
      // marker-clear save or view refresh can. Never point back at the source
      // after records have physically moved; retain a marker on the proven
      // destination and keep writes blocked until recovery can persist cleanly.
      const failedPlan = attempt.plan;
      if (failedPlan) {
        const marker = { from: failedPlan.from, to: failedPlan.to };
        const recoveryRoot = recordsMoved ? failedPlan.to : failedPlan.from;
        this.settings = { ...this.settings, rootFolder: recoveryRoot };
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.pendingMigrationConfiguredRoot = recoveryRoot;
        setClinicalRoot(recoveryRoot);
        this.setMigrationRecoveryBlocked(true);
        try {
          await this.persistPluginData();
        } catch {
          // The in-memory barrier remains armed. Preserve the original failure,
          // which is the actionable error the initiating UI should report.
        }
      } else {
        this.setMigrationRecoveryBlocked(false);
      }
      throw error;
    } finally {
      this.localMigrationRunning = false;
    }
  }

  /** Re-attaches an in-flight migration marker to whatever is being saved. */
  private withPendingMarker(settings: ClinicalSettings): Record<string, unknown> {
    const marker = (this.pendingMigrationMarker as { migrationInProgress?: MigrationMarker } | null)
      ?.migrationInProgress;
    const data: Record<string, unknown> = {
      ...settings,
      workspaceSafety: this.workspaceSafety()
    };
    if (marker) data.migrationInProgress = marker;
    return data;
  }

  /** Builds the snapshot only when its turn reaches the head of the queue. */
  private persistPluginData(): Promise<void> {
    const write = this.pluginDataWriteQueue
      .catch(() => undefined)
      .then(async () => {
        const marker = this.currentMigrationMarker();
        const settings = marker && this.pendingMigrationConfiguredRoot
          ? { ...this.settings, rootFolder: this.pendingMigrationConfiguredRoot }
          : this.settings;
        await this.saveData(this.withPendingMarker(settings));
      });
    this.pluginDataWriteQueue = write;
    return write;
  }

  /**
   * Settles an interrupted/synced move only when exactly one record root wins.
   * A source-only state whose stored settings still name the destination is
   * deliberately pending: Sync may have delivered data.json before the folder.
   */
  private async reconcileMigration(
    stored: unknown,
    options: { allowSourceRollback?: boolean } = {}
  ): Promise<boolean> {
    const marker = this.markerFrom(stored) ?? this.currentMigrationMarker();
    if (!marker) return true;
    const configuredRoot = normalizeSettings(stored, {
      careSettings: CARE_SETTINGS,
      pathways: PATHWAYS,
      priorities: PRIORITIES
    }).rootFolder;
    this.pendingMigrationConfiguredRoot = configuredRoot;

    const sourceRecordCount = this.rootManagedRecordCount(marker.from);
    const destinationRecordCount = this.rootManagedRecordCount(marker.to);
    const sourceHasRecords = sourceRecordCount > 0;
    const destinationHasRecords = destinationRecordCount > 0;
    const actual = resolveMigrationRoot(marker, (root) =>
      root === marker.from ? sourceHasRecords : destinationHasRecords
    );

    // Both populated roots are ambiguous. Neither can be made writable until
    // Sync removes one or the user explicitly resolves the duplicate records.
    if (!actual && (sourceHasRecords || destinationHasRecords)) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }

    const requiredRecordCount = this.managedRecordsExpected
      ? Math.max(1, this.expectedManagedRecordCount)
      : 0;
    const actualRecordCount = actual === marker.from
      ? sourceRecordCount
      : actual === marker.to
        ? destinationRecordCount
        : 0;
    // A single early-delivered file is not convergence. Require the complete
    // previously healthy count at either destination or explicit source
    // rollback; true record-free workspaces retain folder-presence recovery.
    if (requiredRecordCount > 0 && actualRecordCount < requiredRecordCount) {
      if (actual === marker.from) {
        this.settings = { ...this.settings, rootFolder: marker.from };
        setClinicalRoot(marker.from);
      }
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }

    // Same number of files is not the same records. Verify the winning root
    // against the parsed-record commitment before the barrier is lifted.
    if (actual) {
      const inventory = await this.verifyRecordInventory(actual);
      if (!inventory.ok) {
        if (actual === marker.from) {
          this.settings = { ...this.settings, rootFolder: marker.from };
          setClinicalRoot(marker.from);
        }
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.setMigrationRecoveryBlocked(true);
        return false;
      }
    }

    // Source-only + destination-configured is the marker-before-folder state.
    // Keep reads on the source, preserve the marker, and wait. An explicit user
    // retry may instead confirm that Sync has settled and roll back to source.
    if (
      actual === marker.from &&
      configuredRoot !== marker.from &&
      !options.allowSourceRollback
    ) {
      this.settings = { ...this.settings, rootFolder: marker.from };
      setClinicalRoot(marker.from);
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }

    // With no records at either path, a completed folder rename is still
    // observable from folder presence. Otherwise retain the established
    // record-free failed-move recovery and return to the source.
    const resolvedRoot = actual ?? (
      configuredRoot === marker.to && this.rootExists(marker.to) && !this.rootExists(marker.from)
        ? marker.to
        : marker.from
    );
    this.settings = { ...this.settings, rootFolder: resolvedRoot };
    setClinicalRoot(resolvedRoot);
    this.pendingMigrationMarker = null;
    this.pendingMigrationConfiguredRoot = null;
    this.setMigrationRecoveryBlocked(false);
    this.structureReady = false;
    await this.persistPluginData();
    new Notice("Clinical Workspace recovered the interrupted folder move.", 12000);
    return true;
  }

  /**
   * User-initiated retry after Sync reports completion. It may confirm a
   * source-only rollback, but still refuses to choose between two populated
   * roots. The settings UI/command can call this without exposing paths.
   */
  async retryPendingMigrationRecovery(): Promise<boolean> {
    const marker = this.currentMigrationMarker();
    if (!marker) {
      if (!this.missingRootRecoveryBlocked) return true;
      // This is intentionally user-confirmed rather than automatic: Sync can
      // create the parent folder before delivering its child records.
      if (
        !this.rootExists(clinicalRootFolder()) ||
        (
          this.missingRootRequiresRecords &&
          this.rootManagedRecordCount(clinicalRootFolder()) <
            Math.max(1, this.expectedManagedRecordCount)
        )
      ) {
        this.showMigrationRecoveryNotice();
        return false;
      }
      if (this.missingRootRequiresRecords) {
        // The file count alone cannot prove these are the confirmed records.
        const inventory = await this.verifyRecordInventory(clinicalRootFolder());
        if (!inventory.ok) {
          new Notice(inventory.reason ?? this.recoveryBlockMessage, 12000);
          return false;
        }
      }
      this.setMigrationRecoveryBlocked(false);
      this.structureReady = false;
      await this.persistPluginData();
      await this.refreshOpenViews();
      new Notice("Clinical Workspace folder access was restored.", 7000);
      return true;
    }
    const configuredRoot = this.pendingMigrationConfiguredRoot ?? this.settings.rootFolder;
    const settled = await this.reconcileMigration(
      { ...this.settings, rootFolder: configuredRoot, migrationInProgress: marker },
      { allowSourceRollback: true }
    );
    if (!settled) this.showMigrationRecoveryNotice();
    else await this.refreshOpenViews();
    return settled;
  }

  /** Automatic retries stay conservative: source-only is still in flight. */
  private async retryMigrationReconciliation(): Promise<boolean> {
    if (this.firstUseInitializationPending) return false;
    if (this.migrationReconciliationPromise) return this.migrationReconciliationPromise;
    const marker = this.currentMigrationMarker();
    if (!marker) return true;
    const configuredRoot = this.pendingMigrationConfiguredRoot ?? this.settings.rootFolder;
    this.migrationReconciliationPromise = this.reconcileMigration({
      ...this.settings,
      rootFolder: configuredRoot,
      migrationInProgress: marker
    }).finally(() => {
      this.migrationReconciliationPromise = null;
    });
    const settled = await this.migrationReconciliationPromise;
    if (settled) await this.refreshOpenViews();
    return settled;
  }

  /**
   * Folders and database views are created the first time the user actually
   * opens the workspace, not on load. A plugin that writes into a vault before
   * the user has asked it to do anything is both surprising and contrary to
   * Obsidian's community plugin guidelines.
   */
  private async ensureStructure(): Promise<void> {
    if (this.structureReady) return;
    if (
      this.initializationScaffoldApproved &&
      this.rootManagedRecordCount(clinicalRootFolder()) !== this.expectedManagedRecordCount
    ) {
      // Sync changed the record set after approval but before scaffolding. The
      // persisted approval remains as crash evidence, while this session goes
      // back to an explicit re-adoption prompt without writing anything.
      this.initializationScaffoldApproved = false;
      this.firstUseInitializationPending = true;
      this.setMigrationRecoveryBlocked(true, CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
      throw new Error(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
    }
    // Shared promise rather than a boolean: two callers arriving together would
    // both see structureReady === false and both start creating folders.
    this.structurePromise ??= (async () => {
      try {
        await this.repository.ensureStructure();
        this.structureReady = true;
        const rootRecordCount = this.rootManagedRecordCount(clinicalRootFolder());
        const rootHasRecords = rootRecordCount > 0;
        const completingApprovedInitialization = this.initializationScaffoldApproved;
        const inventoryChanged = await this.ratchetRecordInventory(clinicalRootFolder());
        const safetyChanged =
          this.workspaceSafetyNeedsPersistence ||
          !this.workspaceInitialized ||
          completingApprovedInitialization ||
          inventoryChanged ||
          (rootHasRecords && !this.managedRecordsExpected) ||
          rootRecordCount > this.expectedManagedRecordCount;
        this.workspaceInitialized = true;
        this.initializationScaffoldApproved = false;
        this.managedRecordsExpected ||= rootHasRecords;
        this.expectedManagedRecordCount = Math.max(
          this.expectedManagedRecordCount,
          rootRecordCount
        );
        if (safetyChanged) await this.persistWorkspaceSafety();
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
      this.observeManagedRecordDelivery(file.path);
      this.retryMigrationForPath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.repository.invalidatePath(file.path);
      this.retryMigrationForPath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.repository.invalidatePath(file.path);
      this.blockIfActiveRootDisappeared(file.path);
      this.retryMigrationForPath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.handleVaultRename(file, oldPath);
        this.scheduleRefresh(file.path);
        this.scheduleRefresh(oldPath);
      })
    );
  }

  /** Applies the safety-sensitive part of a vault rename synchronously. */
  private handleVaultRename(file: { path: string }, oldPath: string): void {
    this.repository.invalidatePath(file.path);
    this.repository.invalidatePath(oldPath);
    this.observeManagedRecordDelivery(file.path);
    const rootRenameHandled = this.handleExternalRootRename(file, oldPath);
    if (rootRenameHandled) return;

    // Obsidian reports a move as rename(newPath, oldPath). Deletion handling
    // therefore never sees a managed record or child folder moved out of the
    // active root. Re-use the count-based loss check on the old path. A rename
    // within managed folders keeps the count unchanged and remains writable.
    this.blockIfActiveRootDisappeared(oldPath);
    this.retryMigrationForPath(file.path);
    this.retryMigrationForPath(oldPath);
  }

  private observeManagedRecordDelivery(path: string): void {
    if (this.migrationRecoveryBlocked || !path.startsWith(`${clinicalRootFolder()}/`)) return;
    void this.noteManagedRecordWrite().catch(() => {
      new Notice(
        "Clinical Workspace could not save its folder-recovery state. Keep the plugin open and do not edit records.",
        12000
      );
    });
  }

  /**
   * Sync can deliver the folder rename before data.json. Arm the write barrier
   * synchronously in the event callback, then persist inferred intent before
   * attempting to activate the destination.
   */
  private handleExternalRootRename(file: unknown, oldPath: string): boolean {
    if (
      this.localMigrationRunning ||
      this.currentMigrationMarker() ||
      !(file instanceof TFolder) ||
      oldPath !== clinicalRootFolder() ||
      file.path === oldPath
    ) {
      return false;
    }
    const normalizedDestination = normalizeFolderPath(file.path);
    if (
      normalizedDestination !== file.path ||
      validateRootFolder(normalizedDestination)
    ) {
      this.setMissingRootRecoveryBlocked();
      void this.persistWorkspaceSafety();
      this.showMigrationRecoveryNotice();
      return true;
    }
    const marker = { from: oldPath, to: normalizedDestination };
    this.pendingMigrationMarker = { migrationInProgress: marker };
    this.pendingMigrationConfiguredRoot = marker.to;
    this.setMigrationRecoveryBlocked(true);
    if (this.firstUseInitializationPending) {
      new Notice(
        "A legacy folder move was detected. Let synchronization finish, then use the recovery command before adopting the current workspace baseline.",
        12000
      );
      return true;
    }
    void (async () => {
      await this.persistPluginData();
      const settled = await this.retryMigrationReconciliation();
      if (!settled) this.showMigrationRecoveryNotice();
    })().catch(() => this.showMigrationRecoveryNotice());
    return true;
  }

  /** A split delete/create delivery must never leave a depleted root writable. */
  private blockIfActiveRootDisappeared(path: string): void {
    const activeRoot = clinicalRootFolder();
    const isManagedPath = ["Patients", "Episodes", "Tasks", "Procedures"]
      .some((folder) =>
        path === `${activeRoot}/${folder}` ||
        path.startsWith(`${activeRoot}/${folder}/`)
      );
    const managedCountDropped =
      isManagedPath &&
      this.managedRecordsExpected &&
      this.rootManagedRecordCount(activeRoot) < Math.max(1, this.expectedManagedRecordCount);
    if (
      this.localMigrationRunning ||
      this.currentMigrationMarker() ||
      (path !== activeRoot && !managedCountDropped)
    ) {
      return;
    }
    this.setMissingRootRecoveryBlocked(this.managedRecordsExpected || managedCountDropped);
    void this.persistWorkspaceSafety();
    this.showMigrationRecoveryNotice();
  }

  private async persistWorkspaceSafety(): Promise<void> {
    this.workspaceSafetyNeedsPersistence = true;
    const revision = ++this.workspaceSafetyRevision;
    try {
      await this.persistPluginData();
      if (this.workspaceSafetyRevision === revision) {
        this.workspaceSafetyNeedsPersistence = false;
      }
    } catch {
      this.workspaceSafetyNeedsPersistence = true;
      new Notice(
        "Clinical Workspace could not save its folder-recovery state. Keep the plugin open and do not edit records.",
        12000
      );
    }
  }

  private retryMigrationForPath(path: string): void {
    if (this.localMigrationRunning || this.firstUseInitializationPending) return;
    const marker = this.currentMigrationMarker();
    const touches = (root: string) => path === root || path.startsWith(`${root}/`);
    if (!marker) {
      return;
    }
    if (!touches(marker.from) && !touches(marker.to)) return;
    void this.retryMigrationReconciliation().catch(() => {
      // The repository stays fail-closed. The next relevant Sync event or the
      // explicit retry command will try again; no clinical details are logged.
      this.showMigrationRecoveryNotice();
    });
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
      if (this.firstUseInitializationPending) {
        const confirmed = await this.requestFirstUseInitialization();
        if (!confirmed) return;
        await this.initializeNewWorkspace();
      }
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
      const settled = await this.retryMigrationReconciliation();
      if (!settled) throw new Error(CLINICAL_WRITES_BLOCKED_MESSAGE);
    }
    if (this.migrationRecoveryBlocked) throw new Error(this.recoveryBlockMessage);
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
    await this.runWorkspaceEntry(
      (view) => view.openAddPatient(),
      "Could not open the new patient / episode form."
    );
  }

  private async openQuickEntry(): Promise<void> {
    const activeEpisodePath = this.activeMarkdownPath();
    await this.runWorkspaceEntry(
      (view) => view.openQuickEntry(activeEpisodePath),
      "Could not open Clinical Workspace quick entry."
    );
  }

  private async openAddTask(): Promise<void> {
    const activeEpisodePath = this.activeMarkdownPath();
    await this.runWorkspaceEntry(
      (view) => view.openAddTaskQuickEntry(activeEpisodePath),
      "Could not open task / follow-up quick entry."
    );
  }

  private async openRecordProcedure(): Promise<void> {
    const activeEpisodePath = this.activeMarkdownPath();
    await this.runWorkspaceEntry(
      (view) => view.openProcedureQuickEntry(activeEpisodePath),
      "Could not open procedure quick entry."
    );
  }

  private async openTodayPendingWork(): Promise<void> {
    await this.runWorkspaceEntry(
      (view) => view.openTodayPendingWork(),
      "Could not open today's pending work."
    );
  }

  /** Shared fail-closed initialization and recovery gate for every quick action. */
  private async runWorkspaceEntry(
    action: (view: ClinicalWorkspaceView) => void | Promise<void>,
    fallbackMessage: string
  ): Promise<void> {
    try {
      if (this.firstUseInitializationPending) {
        const confirmed = await this.requestFirstUseInitialization();
        if (!confirmed) return;
        await this.initializeNewWorkspace();
      }
      const view = await this.activateWorkspace();
      await action(view);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : fallbackMessage, 7000);
    }
  }

  /** Capture visual context before activating the custom workspace view. */
  private activeMarkdownPath(): string {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? "";
  }

  /**
   * Registers a fixed, parameter-free Obsidian URI. Values are never read,
   * echoed, persisted, or logged; any query parameter rejects the invocation.
   */
  private registerQuickEntryProtocol(action: string, run: () => Promise<void>): void {
    this.registerObsidianProtocolHandler(action, (params) => {
      if (!isSafeQuickEntryProtocolInvocation(action, params)) {
        new Notice(
          "Clinical Workspace rejected this quick entry link because it contained parameters. Use the documented link without parameters.",
          7000
        );
        return;
      }
      void run();
    });
  }

  private async runIntegrityCheck(options: { onlyWhenIssuesFound?: boolean } = {}): Promise<void> {
    try {
      await this.ensureStructure();
      const report = await this.integrity.report();
      if (options.onlyWhenIssuesFound && !report.issues.length) return;
      // Results are rendered in the interface. They are never written to the
      // developer console, because the records they describe are identifiable.
      new IntegrityReportModal(
        this.app,
        report.issues,
        (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
        },
        { scannedRecords: report.scannedRecords, checkFamilies: report.checkFamilies }
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Integrity check failed.", 7000);
    }
  }

  /**
   * Explicit, typed-confirmation adoption of the current record set as the
   * recovery baseline. This is the sanctioned exit from the fail-closed
   * barrier after a deliberate record deletion or an accepted Sync outcome —
   * previously the only way out was restoring the missing files.
   */
  private async adoptCurrentBaseline(): Promise<void> {
    if (this.firstUseInitializationPending) {
      new Notice(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE, 9000);
      return;
    }
    if (this.currentMigrationMarker()) {
      new Notice(
        "A folder move is still pending. Resolve it with the pending folder move recovery command before adopting a new baseline.",
        9000
      );
      return;
    }
    const root = clinicalRootFolder();
    if (!this.rootExists(root)) {
      new Notice("The configured clinical folder does not exist, so there is nothing to adopt.", 9000);
      return;
    }
    const inventory = await this.parsedRecordInventory(root);
    const lines = [
      "The current records become the trusted recovery baseline, replacing the previous one. Do this only when the workspace is complete: synchronization has finished and any intentional deletions are accounted for.",
      `Parsed records now on disk: ${inventory.counts.patient} patients, ${inventory.counts.episode} episodes, ${inventory.counts.task} tasks, ${inventory.counts.procedure} procedures.`,
      "No note is created, changed, or deleted by this confirmation."
    ];
    new ConfirmMaintenanceModal(this.app, {
      title: "Confirm current records as the recovery baseline",
      lines,
      confirmWord: "ADOPT",
      confirmLabel: "Adopt this baseline",
      onDecide: (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            const fresh = await this.parsedRecordInventory(root);
            this.expectedEntityCounts = fresh.counts;
            this.expectedRecordDigest = fresh.digest;
            this.expectedManagedRecordCount = this.rootManagedRecordCount(root);
            this.managedRecordsExpected = fresh.total > 0;
            this.missingRootRecoveryBlocked = false;
            this.missingRootRequiresRecords = false;
            this.setMigrationRecoveryBlocked(false);
            await this.persistWorkspaceSafety();
            await this.refreshOpenViews();
            new Notice("The current records are now the recovery baseline.", 7000);
          } catch (error) {
            new Notice(
              error instanceof Error ? error.message : "The baseline could not be adopted.",
              9000
            );
          }
        })();
      }
    }).open();
  }

  /**
   * Rewrites patient note bodies that are still exactly the identifier-
   * bearing scaffold generated by versions up to 0.4.x. Anything the user has
   * edited fails the byte-level pattern and is never touched; every rewrite
   * happens inside Vault.process so a concurrent Sync delivery wins.
   */
  private async migrateGeneratedBodies(): Promise<void> {
    if (this.migrationRecoveryBlocked) {
      new Notice(this.recoveryBlockMessage, 9000);
      return;
    }
    const folder = `${clinicalRootFolder()}/Patients`;
    const candidates: TFile[] = [];
    for (const file of markdownFilesInFolder(this.app.vault, folder)) {
      const content = await this.app.vault.cachedRead(file);
      const record = parseClinicalRecord(content);
      if (record?.entity !== "patient") continue;
      const body = bodyAfterFrontmatter(content);
      if (LEGACY_PATIENT_BODY_PATTERN.test(body.trim() + "\n")) candidates.push(file);
    }
    if (!candidates.length) {
      new Notice(
        "No patient note carries an unmodified generated body from an older version. Nothing to change.",
        9000
      );
      return;
    }
    new ConfirmMaintenanceModal(this.app, {
      title: "Remove identifiers from generated note bodies",
      lines: [
        `${candidates.length} patient note${candidates.length === 1 ? " has" : "s have"} a plugin-generated body from an older version that duplicates the name, MRN and phone below the structured properties. Those copies go stale when an identity is corrected.`,
        "Only bodies still byte-identical to the old generated scaffold are rewritten to the new identifier-free scaffold. Any note you have edited is left untouched. Frontmatter is not changed.",
        "This cannot be undone from inside the plugin; your notes remain in the vault's file history."
      ],
      confirmWord: "REWRITE",
      confirmLabel: `Rewrite ${candidates.length} generated bod${candidates.length === 1 ? "y" : "ies"}`,
      onDecide: (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          let rewritten = 0;
          for (const file of candidates) {
            try {
              await this.app.vault.process(file, (current) => {
                const body = bodyAfterFrontmatter(current);
                // Re-check inside the transform: Sync may have delivered an
                // edited version since the preview was computed.
                if (!LEGACY_PATIENT_BODY_PATTERN.test(body.trim() + "\n")) return current;
                const record = parseClinicalRecord(current);
                if (record?.entity !== "patient") return current;
                const frontmatterEnd = current.length - body.length;
                rewritten += 1;
                return current.slice(0, frontmatterEnd) + recordBody(record);
              });
              this.repository.invalidatePath(file.path);
            } catch {
              // Identifier-free by construction; the per-note failure is
              // recoverable by rerunning the command.
              console.warn("Clinical Workspace: a generated body could not be rewritten.");
            }
          }
          new Notice(
            `${rewritten} generated bod${rewritten === 1 ? "y" : "ies"} rewritten without identifiers. Notes you have edited were not touched.`,
            9000
          );
          await this.refreshOpenViews();
        })();
      }
    }).open();
  }
}

/** Returns everything after the closing frontmatter fence (or the whole file). */
function bodyAfterFrontmatter(content: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? content.slice(match[0].length) : content;
}
