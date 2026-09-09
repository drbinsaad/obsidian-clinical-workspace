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
  IntegrityReportModal,
  WhatsNewModal
} from "./ui/modals";
import { ClinicalSettingTab } from "./ui/settings-tab";
import {
  CLINICAL_WORKSPACE_VIEW,
  ClinicalWorkspaceView
} from "./ui/workspace-view";
import {
  CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE,
  CLINICAL_INITIALIZATION_CHANGED_MESSAGE,
  CLINICAL_INITIALIZATION_REQUIRED_MESSAGE,
  CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE,
  CLINICAL_ROOT_UNAVAILABLE_MESSAGE,
  hideClinicalRecoveryNotice,
  showClinicalNotice,
  showClinicalRecoveryNotice
} from "./ui/notices";
import {
  QUICK_ENTRY_COMMAND_IDS,
  QUICK_ENTRY_PROTOCOL_ACTIONS,
  isSafeQuickEntryProtocolInvocation
} from "./quick-entry";

export { compactClinicalRecoveryNotice } from "./ui/notices";

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
   * Durable fail-closed sentinel retained after a recovered root is accepted.
   * A restart must revalidate the exact committed inventory before enabling
   * writes, even if a later attempt to persist a re-armed barrier failed.
   */
  recoveryValidationRequired: boolean;
  /** A conflicting/incomplete synced commitment requires typed adoption. */
  baselineReviewRequired: boolean;
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

interface TrustedInventoryJournalEntry {
  /** One-way, domain-separated binding to the normalized configured root. */
  rootFingerprint: string;
  expectedManagedRecordCount: number;
  expectedEntityCounts: ExpectedEntityCounts;
  expectedRecordDigest: string;
}

interface TrustedInventoryJournal {
  version: 1;
  /** Stale-clear token incremented synchronously for every external callback. */
  generation: number;
  /** True from external callback receipt until its final exact verification. */
  pending: boolean;
  /**
   * Canonical, path-free commitment to every retired root known when this
   * journal generation was written. A later synced snapshot may add entries,
   * but it may not omit any of these fingerprints and still reopen writes.
   * Absent only on journals written before this commitment was introduced.
   */
  retiredRootFingerprints?: string[] | undefined;
  trustedInventory?: TrustedInventoryJournalEntry | undefined;
}

type TrustedInventoryJournalRead =
  | { status: "missing"; journal: null }
  | { status: "valid"; journal: TrustedInventoryJournal }
  | { status: "invalid"; journal: null };

export const TRUSTED_INVENTORY_JOURNAL_KEY =
  "clinical-workspace:trusted-inventory-journal:v1";

const MAX_RETIRED_ROOT_FOLDERS = 64;

interface BaselineAdoptionCandidate {
  root: string;
  rawCount: number;
  expectedCountAtPreview: number;
  recoveryRevision: number;
  inventory: RecordInventory;
}

function completeSafetyInventory(
  safety: PersistedWorkspaceSafety | null
): RecordInventory | null {
  const counts = safety?.expectedEntityCounts;
  const digest = safety?.expectedRecordDigest;
  if (!counts || !digest) return null;
  const total = counts.patient + counts.episode + counts.task + counts.procedure;
  if (total !== safety.expectedManagedRecordCount) return null;
  return { counts: { ...counts }, digest, total };
}

function sameRecordInventory(left: RecordInventory, right: RecordInventory): boolean {
  return left.total === right.total &&
    left.digest === right.digest &&
    ENTITY_FOLDER_NAMES.every(([entity]) => left.counts[entity] === right.counts[entity]);
}

function recordInventoryFromJournalEntry(
  entry: TrustedInventoryJournalEntry
): RecordInventory {
  return {
    counts: { ...entry.expectedEntityCounts },
    digest: entry.expectedRecordDigest,
    total: entry.expectedManagedRecordCount
  };
}

function parseTrustedInventoryJournal(value: unknown): TrustedInventoryJournal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const journal = value as Record<string, unknown>;
  if (
    journal.version !== 1 ||
    typeof journal.generation !== "number" ||
    !Number.isSafeInteger(journal.generation) ||
    journal.generation < 0 ||
    typeof journal.pending !== "boolean"
  ) return null;

  const rawRetiredRootFingerprints = journal.retiredRootFingerprints;
  let retiredRootFingerprints: string[] | undefined;
  if (rawRetiredRootFingerprints !== undefined) {
    if (
      !Array.isArray(rawRetiredRootFingerprints) ||
      rawRetiredRootFingerprints.length > MAX_RETIRED_ROOT_FOLDERS
    ) return null;
    retiredRootFingerprints = [];
    let previous: string | null = null;
    for (const candidate of rawRetiredRootFingerprints) {
      if (
        typeof candidate !== "string" ||
        !/^[0-9a-f]{64}$/.test(candidate) ||
        (previous !== null && candidate <= previous)
      ) return null;
      retiredRootFingerprints.push(candidate);
      previous = candidate;
    }
  }

  const rawInventory = journal.trustedInventory;
  if (rawInventory === undefined) {
    return journal.pending
      ? {
          version: 1,
          generation: journal.generation,
          pending: true,
          ...(retiredRootFingerprints !== undefined ? { retiredRootFingerprints } : {})
        }
      : null;
  }
  if (!rawInventory || typeof rawInventory !== "object" || Array.isArray(rawInventory)) {
    return null;
  }
  const entry = rawInventory as Record<string, unknown>;
  const counts = entry.expectedEntityCounts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  const countRecord = counts as Record<string, unknown>;
  const validCount = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (
    !validCount(entry.expectedManagedRecordCount) ||
    !validCount(countRecord.patient) ||
    !validCount(countRecord.episode) ||
    !validCount(countRecord.task) ||
    !validCount(countRecord.procedure) ||
    typeof entry.rootFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.rootFingerprint) ||
    typeof entry.expectedRecordDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.expectedRecordDigest)
  ) return null;
  const expectedEntityCounts: ExpectedEntityCounts = {
    patient: countRecord.patient,
    episode: countRecord.episode,
    task: countRecord.task,
    procedure: countRecord.procedure
  };
  const total = expectedEntityCounts.patient + expectedEntityCounts.episode +
    expectedEntityCounts.task + expectedEntityCounts.procedure;
  if (total !== entry.expectedManagedRecordCount) return null;
  return {
    version: 1,
    generation: journal.generation,
    pending: journal.pending,
    ...(retiredRootFingerprints !== undefined ? { retiredRootFingerprints } : {}),
    trustedInventory: {
      rootFingerprint: entry.rootFingerprint,
      expectedManagedRecordCount: entry.expectedManagedRecordCount,
      expectedEntityCounts,
      expectedRecordDigest: entry.expectedRecordDigest
    }
  };
}

function sameTrustedInventoryJournal(
  left: TrustedInventoryJournal,
  right: TrustedInventoryJournal
): boolean {
  if (
    left.version !== right.version ||
    left.generation !== right.generation ||
    left.pending !== right.pending ||
    left.retiredRootFingerprints?.length !== right.retiredRootFingerprints?.length ||
    left.retiredRootFingerprints?.some(
      (fingerprint, index) => fingerprint !== right.retiredRootFingerprints?.[index]
    ) === true
  ) return false;
  const leftEntry = left.trustedInventory;
  const rightEntry = right.trustedInventory;
  if (!leftEntry || !rightEntry) return leftEntry === rightEntry;
  return leftEntry.rootFingerprint === rightEntry.rootFingerprint &&
    leftEntry.expectedManagedRecordCount === rightEntry.expectedManagedRecordCount &&
    leftEntry.expectedRecordDigest === rightEntry.expectedRecordDigest &&
    ENTITY_FOLDER_NAMES.every(
      ([entity]) =>
        leftEntry.expectedEntityCounts[entity] === rightEntry.expectedEntityCounts[entity]
    );
}

const ENTITY_FOLDER_NAMES: ReadonlyArray<[keyof ExpectedEntityCounts, string]> = [
  ["patient", "Patients"],
  ["episode", "Episodes"],
  ["task", "Tasks"],
  ["procedure", "Procedures"]
];

function parseRetiredRootFolders(value: unknown): {
  valid: boolean;
  roots: string[];
} {
  const raw = (value as { retiredRootFolders?: unknown } | null)?.retiredRootFolders;
  if (raw === undefined) return { valid: true, roots: [] };
  if (!Array.isArray(raw) || raw.length > MAX_RETIRED_ROOT_FOLDERS) {
    return { valid: false, roots: [] };
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (typeof candidate !== "string") return { valid: false, roots: [] };
    const normalized = normalizeFolderPath(candidate);
    if (
      candidate !== normalized ||
      validateRootFolder(normalized) ||
      seen.has(normalized)
    ) {
      return { valid: false, roots: [] };
    }
    seen.add(normalized);
    roots.push(normalized);
  }
  return { valid: true, roots };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rootFingerprint(root: string): Promise<string> {
  return sha256Hex(`clinical-workspace/root/v1\0${normalizeFolderPath(root)}`);
}

async function retiredRootFingerprint(root: string): Promise<string> {
  return sha256Hex(`clinical-workspace/retired-root/v1\0${normalizeFolderPath(root)}`);
}

/** Static, identifier-free highlights shown once after an update. */
const WHATS_NEW_HIGHLIGHTS: readonly string[] = [
  "Cross-device folder recovery now verifies the exact clinical record inventory before reopening writes after Sync or a folder move.",
  "Retired clinical folders remain protected, so a late old-folder delivery on another Mac safely reopens recovery instead of being treated as unrelated notes.",
  "Clinical record writes now settle their recovery metadata durably before reporting success or allowing a folder move to proceed.",
  "Recovery messages are compact, deduplicated, and responsive on phones and narrow desktop panes."
];

/**
 * Decides whether the what's-new window should appear. It shows only when a
 * previously recorded version differs from the running one — or, for updates
 * from versions that predate the record, when the workspace was already in
 * use. A genuinely fresh install records the version silently.
 */
export function shouldShowWhatsNew(
  storedVersion: string | null,
  currentVersion: string,
  workspaceInitialized: boolean
): boolean {
  if (storedVersion === currentVersion) return false;
  if (storedVersion === null) return workspaceInitialized;
  return true;
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
  /** Shared by concurrent entry points so one confirmation runs one initialization. */
  private initializationCompletionPromise: Promise<void> | null = null;
  /** Managed-record count shown when the adoption confirmation opened. */
  private pendingAdoptionRecordCount: number | null = null;
  private pendingAdoptionRoot: string | null = null;
  private pendingAdoptionDataFingerprint: string | null = null;
  private pendingAdoptionInventory: RecordInventory | null = null;
  private pendingAdoptionRootFingerprint: string | null = null;
  private workspaceInitialized = false;
  /** Once true, deletion recovery must not accept an empty parent folder. */
  private managedRecordsExpected = false;
  private expectedManagedRecordCount = 0;
  /** Parsed-record commitment; null until first computed or for pre-0.5 state. */
  private expectedEntityCounts: ExpectedEntityCounts | null = null;
  private expectedRecordDigest: string | null = null;
  /** Version the what's-new window was last shown for; null before 0.5.0. */
  private whatsNewVersion: string | null = null;
  private whatsNewShownThisSession = false;
  /** True until path-free v1 safety metadata is durably saved. */
  private workspaceSafetyNeedsPersistence = false;
  /** Distinguishes overlapping safety saves so an older completion cannot clear a newer retry. */
  private workspaceSafetyRevision = 0;
  private recoveryBlockMessage = CLINICAL_WRITES_BLOCKED_MESSAGE;
  private migrationReconciliationPromise: Promise<boolean> | null = null;
  private exactRootRecoveryPromise: Promise<boolean> | null = null;
  /** A final Sync event must trigger another scan even when one is already running. */
  private exactRootRecoveryRetryRequested = false;
  /** Serializes automatic and explicit marker-free recovery checks. */
  private markerFreeRecoveryQueue: Promise<void> = Promise.resolve();
  private markerFreeRecoveryOperations = 0;
  private markerFreeRecoveryRevision = 0;
  /** Delay unblocking until every already-queued marker-free operation settles. */
  private markerFreeRecoveryReleaseRequested = false;
  private markerFreeRecoveryReleaseRevision: number | null = null;
  private markerFreeRecoveryReleaseJournalGeneration: number | null = null;
  private markerFreeRecoveryReleaseAllowsJournalReplacement = false;
  /** Keeps writes closed while a synced data.json read is awaiting filesystem I/O. */
  private externalSettingsApplyOperations = 0;
  /** Applies external data.json snapshots in callback order. */
  private externalSettingsApplyQueue: Promise<void> = Promise.resolve();
  /** Monotonic receipt order used to reject stale async reconciliation work. */
  private externalSettingsEpoch = 0;
  /** Marker that existed before the current overlapping callback batch began. */
  private externalSettingsBatchInitialMarker: MigrationMarker | null = null;
  /** Any admitted vault mutation makes a marker-free root rebind ambiguous. */
  private externalSettingsDrainedManagedMutation = false;
  /** Persists across successful recovery so every restart verifies the commitment. */
  private recoveryValidationRequired = false;
  /** True when Sync delivered a commitment that only typed adoption may resolve. */
  private baselineReviewRequired = false;
  /** Precomputed so an external callback can arm its journal before any await. */
  private activeRootFingerprint: string | null = null;
  /** Serializes data.json writes so a delayed older snapshot cannot win. */
  private pluginDataWriteQueue: Promise<unknown> = Promise.resolve();
  private localMigrationRunning = false;
  /** External path snapshots captured mid-move apply only after that move settles. */
  private localMigrationCompletion: Promise<void> | null = null;
  /** Synced folder-name tombstones used to recognize a late old-root delivery. */
  private readonly retiredRootFolders = new Set<string>();
  /**
   * Device-local, one-way counterparts kept in lockstep with the synced names.
   * Precomputation lets a Sync callback durably arm its journal before await.
   */
  private readonly retiredRootFingerprintByFolder = new Map<string, string>();
  /**
   * Roots participating in a move remain watched for the rest of the session.
   * A late Sync record in a retired root must reconstruct recovery instead of
   * becoming invisible merely because the marker was just cleared.
   */
  private readonly managedDeliveryWatchRoots = new Set<string>();
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
    this.repository.setManagedRecordWriteObserver((paths) =>
      this.noteManagedRecordWrite(paths)
    );
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
    this.addCommand({
      id: "search-clinical-records",
      name: "Search clinical records",
      icon: "search",
      callback: () =>
        void this.runWorkspaceEntry(
          (view) => view.openSearch(),
          "Could not open clinical search."
        )
    });
    this.addCommand({
      id: "generate-handover-note",
      name: "Generate ward handover note",
      icon: "clipboard-list",
      callback: () =>
        void this.runWorkspaceEntry(
          (view) => view.generateHandover(),
          "Could not generate the handover note."
        )
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
      // Perf regressions should be measurable before users feel them. The
      // numbers reported are timings and counts only.
      this.addCommand({
        id: "run-scale-benchmark",
        name: "Development: run scale benchmark",
        callback: () =>
          void (async () => {
            try {
              await this.ensureStructure();
              const started = performance.now();
              const target = 100;
              for (let index = 0; index < target; index += 1) {
                const suffix = String(1000 + index);
                await this.service.createEpisode({
                  mrn: `9000${suffix}`,
                  patientName: `Benchmark Patient ${suffix}`,
                  phone: "",
                  caseName: `Benchmark case ${suffix}`,
                  careSetting: index % 3 === 0 ? "inpatient" : "outpatient",
                  pathway: "assessment",
                  priority: "routine",
                  nextAction: `Benchmark review ${suffix}`,
                  dueDate: "2026-12-01"
                });
              }
              const seeded = performance.now() - started;
              const timeOf = async (label: string, run: () => Promise<unknown>): Promise<string> => {
                const start = performance.now();
                await run();
                return `${label} ${Math.round(performance.now() - start)}ms`;
              };
              const snapshotTime = await timeOf("snapshot", () => this.repository.snapshot());
              const integrityTime = await timeOf("integrity", () => this.integrity.report());
              new Notice(
                `Benchmark: seeded ${target} episodes in ${Math.round(seeded)}ms; warm ${snapshotTime}; ${integrityTime}.`,
                12000
              );
              await this.refreshOpenViews();
            } catch (error) {
              this.showUserFacingNotice(
                error instanceof Error ? error.message : "The benchmark failed.",
                9000
              );
            }
          })()
      });
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
              this.showUserFacingNotice(
                error instanceof Error ? error.message : "Synthetic data could not be created.",
                7000
              );
            }
          })()
      });
    }

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      // The complete folder can arrive between loadSettings and listener
      // registration. Recheck the exact trusted commitment once the vault is
      // ready so that startup ordering cannot leave a stale read-only barrier.
      void this.retryExactRestoredRootRecovery();
      // The what's-new window appears as soon as the UPDATED plugin loads,
      // not only when the workspace is next opened: an update the user never
      // hears about is an update they cannot judge. Layout-ready keeps it
      // from interrupting app startup itself.
      void this.maybeShowWhatsNew();
    });
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.refreshMaxWaitTimer !== null) window.clearTimeout(this.refreshMaxWaitTimer);
    this.hideRecoveryNotice();
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
    this.activeRootFingerprint = await rootFingerprint(this.settings.rootFolder);
    const retiredRootsRead = parseRetiredRootFolders(stored);
    const retiredRootFingerprintEntries = retiredRootsRead.valid
      ? await Promise.all(
          retiredRootsRead.roots.map(async (root) => [
            root,
            await retiredRootFingerprint(root)
          ] as const)
        )
      : [];
    // No await may follow this read before the journal is interpreted. A Sync
    // callback can increment its generation synchronously while a hash is in
    // flight; reading only after every startup fingerprint avoids trusting a
    // stale pre-callback snapshot.
    const journalRead = this.readTrustedInventoryJournal();
    this.retiredRootFolders.clear();
    this.retiredRootFingerprintByFolder.clear();
    if (retiredRootsRead.valid) {
      for (const [root, fingerprint] of retiredRootFingerprintEntries) {
        this.retiredRootFolders.add(root);
        this.retiredRootFingerprintByFolder.set(root, fingerprint);
        this.managedDeliveryWatchRoots.add(root);
      }
    }
    this.pendingMigrationMarker = marker ? { migrationInProgress: marker } : null;
    this.pendingMigrationConfiguredRoot = marker ? incoming.rootFolder : null;
    if (marker) this.watchMigrationRoots(marker);
    const retiredRootConflictDetected =
      !marker && this.armRetiredRootConflictIfPresent();
    const safety = this.workspaceSafetyFrom(stored);
    const rootRecordCount = this.rootManagedRecordCount(this.settings.rootFolder);
    const rootHasRecords = rootRecordCount > 0;
    const rootExists = this.rootExists(this.settings.rootFolder);
    const initializationApproved =
      safety?.initializationApproved === true && safety.initialized !== true;
    const trustedSafety = this.isWorkspaceSafetyTrusted(safety, this.settings.rootFolder);
    const approvedInitializationInventory = initializationApproved
      ? completeSafetyInventory(safety)
      : null;
    const journalEntry = journalRead.journal?.trustedInventory ?? null;
    const journalRootMatches = journalEntry?.rootFingerprint === this.activeRootFingerprint;
    const journalRetiredRootFingerprints = journalRead.journal?.retiredRootFingerprints;
    const currentRetiredRootFingerprints = new Set(
      this.retiredRootFingerprintByFolder.values()
    );
    // A synced snapshot may legitimately add tombstones. It may never omit a
    // tombstone already committed by this device. A legacy clean journal is
    // upgraded after exact validation; an interrupted legacy generation has
    // no proof of the pre-callback set and therefore remains fail-closed.
    const journalRetiredRootsCompatible = journalRetiredRootFingerprints === undefined
      ? journalRead.journal?.pending !== true
      : journalRetiredRootFingerprints.every(
          (fingerprint) => currentRetiredRootFingerprints.has(fingerprint)
        );
    const journalEstablishesTrust = journalEntry !== null &&
      journalRootMatches && journalRetiredRootsCompatible;
    let approvedEmptyInitializationLocallyCommitted = false;
    // A count-only startup check cannot detect N records replaced by N other
    // files while Obsidian was closed. Every initialized workspace therefore
    // begins read-only. Complete commitments release after layout-ready exact
    // validation; legacy count-only state needs one explicit Retry to upgrade
    // it to the parsed-count and digest commitment.
    const exactStartupValidationRequired =
      safety?.initialized === true ||
      approvedInitializationInventory !== null ||
      journalEstablishesTrust ||
      journalRead.journal?.pending === true;
    const storedDurableRecoveryBarrier =
      safety?.rootRecoveryRequired === true ||
      safety?.recoveryValidationRequired === true ||
      safety?.baselineReviewRequired === true;
    const storedRecoveryBarrier =
      storedDurableRecoveryBarrier || exactStartupValidationRequired;
    // Pre-0.3.6 workspaces have no trusted aggregate count. Whatever is visible
    // may be a partial Sync delivery, so the current baseline must be adopted
    // explicitly even when records or an empty scaffold are already present.
    this.firstUseInitializationPending = !trustedSafety && !journalEstablishesTrust;
    this.initializationScaffoldApproved = initializationApproved && trustedSafety;
    this.workspaceInitialized = safety?.initialized === true;
    const storedExpectedCount = safety?.expectedManagedRecordCount ?? 0;
    this.managedRecordsExpected = storedRecoveryBarrier
      ? safety?.managedRecordsExpected === true ||
        safety?.recoveryRequiresRecords === true ||
        storedExpectedCount > 0
      : safety?.managedRecordsExpected === true || rootHasRecords;
    this.expectedManagedRecordCount = storedRecoveryBarrier
      ? storedExpectedCount
      : Math.max(storedExpectedCount, rootRecordCount, this.managedRecordsExpected ? 1 : 0);
    this.expectedEntityCounts = safety?.expectedEntityCounts ?? null;
    this.expectedRecordDigest = safety?.expectedRecordDigest ?? null;
    this.recoveryValidationRequired =
      safety?.recoveryValidationRequired === true || exactStartupValidationRequired;
    this.baselineReviewRequired =
      safety?.baselineReviewRequired === true || !retiredRootsRead.valid;
    if (!retiredRootsRead.valid) this.firstUseInitializationPending = false;
    if (journalEntry && journalRootMatches && journalRetiredRootsCompatible) {
      const journalInventory = recordInventoryFromJournalEntry(journalEntry);
      const syncedInventory = completeSafetyInventory(safety);
      const syncedExpectedCount = safety?.expectedManagedRecordCount ?? 0;
      const higherSyncedCommitment = syncedExpectedCount > journalInventory.total;
      const equalSyncedConflict =
        syncedExpectedCount === journalInventory.total &&
        syncedInventory !== null &&
        !sameRecordInventory(journalInventory, syncedInventory);
      // The device-local tuple is the trust anchor. A synced tuple may raise
      // the aggregate floor, but cannot replace counts/digest until ADOPT.
      this.expectedManagedRecordCount = Math.max(
        this.expectedManagedRecordCount,
        journalInventory.total,
        syncedExpectedCount
      );
      this.expectedEntityCounts = { ...journalInventory.counts };
      this.expectedRecordDigest = journalInventory.digest;
      this.managedRecordsExpected ||= journalInventory.total > 0;
      this.recoveryValidationRequired = true;
      this.baselineReviewRequired ||= higherSyncedCommitment || equalSyncedConflict;
    } else if (
      journalRead.status === "invalid" ||
      (
        journalRead.status === "valid" &&
        (!journalEntry || !journalRootMatches || !journalRetiredRootsCompatible)
      )
    ) {
      // Unknown/corrupt state, a tuple-less interrupted bootstrap, or a tuple
      // bound to another root is not equivalent to a genuinely absent journal.
      this.recoveryValidationRequired = true;
      this.baselineReviewRequired = true;
      this.firstUseInitializationPending = false;
    }
    if (
      retiredRootConflictDetected &&
      this.armTrustedInventoryJournal() === null
    ) {
      this.recoveryValidationRequired = true;
      this.baselineReviewRequired = true;
      this.firstUseInitializationPending = false;
    }
    if (
      initializationApproved &&
      approvedInitializationInventory?.total === 0 &&
      rootRecordCount === 0 &&
      !this.baselineReviewRequired &&
      (
        (journalEstablishesTrust && journalRead.journal?.pending === false) ||
        (journalRead.status === "missing" && this.commitTrustedInventoryJournal())
      )
    ) {
      // A deliberately approved empty workspace has no record tree to wait
      // for. Its exact empty commitment is sufficient to resume scaffolding.
      approvedEmptyInitializationLocallyCommitted = true;
      this.recoveryValidationRequired = true;
    }
    const storedWhatsNew = (stored as { whatsNewVersion?: unknown } | null)?.whatsNewVersion;
    this.whatsNewVersion = typeof storedWhatsNew === "string" ? storedWhatsNew : null;
    this.missingRootRequiresRecords =
      safety?.recoveryRequiresRecords === true || this.managedRecordsExpected;
    const inferredRootLoss =
      !marker &&
      !this.firstUseInitializationPending &&
      !initializationApproved &&
      this.workspaceInitialized &&
      (
        !rootExists ||
        (rootExists && this.expectedManagedRecordCount > rootRecordCount)
      );
    if (inferredRootLoss && !storedDurableRecoveryBarrier) {
      // The loss happened while Obsidian was closed, so no live vault event
      // had a chance to persist the barrier. Make the exact-validation sentinel
      // durable during onload before Sync can replace the evidence.
      this.recoveryValidationRequired = true;
    }
    this.missingRootRecoveryBlocked = (
      !marker && !this.firstUseInitializationPending && (
        storedRecoveryBarrier ||
        inferredRootLoss
      ) &&
      (!initializationApproved || exactStartupValidationRequired) &&
      !approvedEmptyInitializationLocallyCommitted
    );
    this.migrationRecoveryBlocked =
      Boolean(this.pendingMigrationMarker) ||
      this.missingRootRecoveryBlocked ||
      this.baselineReviewRequired ||
      this.firstUseInitializationPending;
    this.recoveryBlockMessage = this.firstUseInitializationPending
      ? CLINICAL_INITIALIZATION_REQUIRED_MESSAGE
      : this.baselineReviewRequired
        ? CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
        : this.missingRootRecoveryBlocked
          ? CLINICAL_ROOT_UNAVAILABLE_MESSAGE
          : CLINICAL_WRITES_BLOCKED_MESSAGE;
    this.workspaceSafetyNeedsPersistence =
      (inferredRootLoss && !storedDurableRecoveryBarrier) ||
      this.baselineReviewRequired !== (safety?.baselineReviewRequired === true) ||
      !retiredRootsRead.valid ||
      retiredRootConflictDetected;
  }

  /** Applies data.json changes delivered by Obsidian Sync without a restart. */
  async onExternalSettingsChange(): Promise<void> {
    if (this.externalSettingsApplyOperations === 0) {
      this.externalSettingsBatchInitialMarker = this.currentMigrationMarker();
      this.externalSettingsDrainedManagedMutation = false;
    }
    this.externalSettingsApplyOperations += 1;
    // Close repository admission in this synchronous stack. Existing writes
    // are allowed to finish against the root they captured, but a root rebind
    // cannot evaluate or reopen until they have drained.
    const mutationPausePromise = this.repository.pauseManagedRecordMutations();
    let mutationPause: Awaited<typeof mutationPausePromise> | null = null;
    let operationCountReleased = false;
    // A settings delivery received during a local move owns a later path
    // transition. Capture its snapshot now, but do not let it rewrite the
    // shared marker/root state until the local transition has left that state.
    const localMigrationCompletion = this.localMigrationCompletion;
    const externalEpoch = ++this.externalSettingsEpoch;
    const journalGeneration = this.armTrustedInventoryJournal();
    try {
      if (journalGeneration === null) {
        mutationPause = await mutationPausePromise;
        this.failClosedForTrustedInventoryJournal();
        return;
      }
      // Invalidate active recovery/preview work and close writes synchronously
      // before the settings read can suspend. Preserve any stronger blocker.
      this.markerFreeRecoveryRevision += 1;
      // This is a temporary in-memory barrier, not evidence that the configured
      // folder is missing. A real recovery flag is armed below only after the
      // delivered safety state and current root have been compared.
      this.setMigrationRecoveryBlocked(true, this.recoveryBlockMessage);
      // Capture the snapshot at receipt, before an older queued application can
      // save over the data.json version that triggered this callback.
      const storedPromise = this.loadData() as Promise<unknown>;
      const apply = async (): Promise<void> => {
        mutationPause = await mutationPausePromise;
        this.externalSettingsDrainedManagedMutation ||=
          mutationPause.drainedExisting;
        const stored = await storedPromise;
        if (localMigrationCompletion) await localMigrationCompletion;
        // loadData is asynchronous. Invalidate a candidate captured while that
        // read was suspended before applying the delivered state synchronously.
        this.markerFreeRecoveryRevision += 1;
        await this.applyExternalSettingsChange(
          stored,
          externalEpoch,
          this.externalSettingsBatchInitialMarker,
          this.externalSettingsDrainedManagedMutation
        );
      };
      const run = this.externalSettingsApplyQueue.then(apply, apply);
      this.externalSettingsApplyQueue = run.then(
        () => undefined,
        () => undefined
      );
      await run;
      this.externalSettingsApplyOperations -= 1;
      operationCountReleased = true;

      if (
        this.externalSettingsApplyOperations === 0 &&
        this.armRetiredRootConflictIfPresent()
      ) {
        // Persist the reconstructed marker before any exact active-root scan
        // can clear the callback journal.
        await this.persistPluginData();
      }

      // The callback itself is a write barrier. Release only after the entire
      // merge and its canonical queued save have finished, and only through the
      // exact inventory check when a same-root delivery armed recovery.
      if (this.externalSettingsApplyOperations === 0) {
        if (
          this.missingRootRecoveryBlocked &&
          !this.baselineReviewRequired &&
          !this.firstUseInitializationPending &&
          !this.currentMigrationMarker()
        ) {
          await this.retryExactRestoredRootRecovery();
        } else if (
          !this.missingRootRecoveryBlocked &&
          !this.baselineReviewRequired &&
          !this.firstUseInitializationPending &&
          !this.currentMigrationMarker()
        ) {
          const latestJournal = this.readTrustedInventoryJournal();
          const finalJournalGeneration =
            latestJournal.status === "valid" && latestJournal.journal.pending
              ? latestJournal.journal.generation
              : journalGeneration;
          if (!this.commitTrustedInventoryJournal(finalJournalGeneration)) {
            this.blockAfterTrustedInventoryJournalCommitFailure();
          } else {
            this.setMigrationRecoveryBlocked(false);
          }
        }
      }
    } finally {
      if (!operationCountReleased) {
        this.externalSettingsApplyOperations = Math.max(
          0,
          this.externalSettingsApplyOperations - 1
        );
      }
      mutationPause ??= await mutationPausePromise;
      mutationPause.release();
      if (this.externalSettingsApplyOperations === 0) {
        this.externalSettingsBatchInitialMarker = null;
        this.externalSettingsDrainedManagedMutation = false;
      }
    }
  }

  /** Merge one fully-read external snapshot while the callback barrier is armed. */
  private async applyExternalSettingsChange(
    stored: unknown,
    externalEpoch: number,
    batchInitialMarker: MigrationMarker | null,
    drainedManagedMutation: boolean
  ): Promise<void> {
    const incoming = normalizeSettings(stored, {
      careSettings: CARE_SETTINGS,
      pathways: PATHWAYS,
      priorities: PRIORITIES
    });
    const deliveredRetiredRoots = parseRetiredRootFolders(stored);
    const retiredRootFingerprintsBeforeMerge = this.currentRetiredRootFingerprints();
    if (deliveredRetiredRoots.valid) {
      if (!await this.mergeRetiredRootFolders(deliveredRetiredRoots.roots)) {
        // Each input may be valid on its own while their monotonic union is
        // not. Never truncate the local history or persist a partial merge.
        this.baselineReviewRequired = true;
      }
    } else {
      // This list is safety metadata: silently dropping a malformed or
      // over-limit value could make a late old-root delivery invisible.
      this.baselineReviewRequired = true;
    }
    const retiredRootFingerprintsAfterMerge = this.currentRetiredRootFingerprints();
    const retiredRootCommitmentChanged =
      retiredRootFingerprintsBeforeMerge !== null &&
      retiredRootFingerprintsAfterMerge !== null &&
      (
        retiredRootFingerprintsBeforeMerge.length !==
          retiredRootFingerprintsAfterMerge.length ||
        retiredRootFingerprintsBeforeMerge.some(
          (fingerprint, index) => fingerprint !== retiredRootFingerprintsAfterMerge[index]
        )
      );
    if (
      retiredRootCommitmentChanged &&
      this.armTrustedInventoryJournal() === null
    ) {
      // The names remain in memory, but without a verified local commitment a
      // crash could let a newer synced snapshot erase this just-delivered root.
      this.baselineReviewRequired = true;
    }
    const previousRoot = clinicalRootFolder();
    const previousSettingsRoot = this.settings.rootFolder;
    const previousPendingMigrationMarker = this.pendingMigrationMarker;
    const previousPendingMigrationConfiguredRoot = this.pendingMigrationConfiguredRoot;
    const restoreSupersededPathState = (): boolean => {
      if (externalEpoch === this.externalSettingsEpoch) return false;
      // External applies are serialized, so the newer callback has been
      // captured but has not started mutating state yet. Restore only this
      // callback's speculative path intent; its monotonic safety floors and
      // review barriers intentionally remain merged.
      this.pendingMigrationMarker = previousPendingMigrationMarker;
      this.pendingMigrationConfiguredRoot = previousPendingMigrationConfiguredRoot;
      this.settings = { ...this.settings, rootFolder: previousSettingsRoot };
      setClinicalRoot(previousRoot);
      return true;
    };
    const deliveredMarker = this.markerFrom(stored);
    // Never inherit a marker created speculatively by an older callback in
    // this same batch. A newer marker-free data.json snapshot supersedes it;
    // only a marker that predated the entire batch *and actually names the
    // delivered root* is a valid fallback. Otherwise an overlapping local
    // A -> B move could reinterpret a marker-free C delivery as A -> B and
    // erase C from every durable recovery edge.
    const existingMarker = batchInitialMarker;
    const existingMarkerIncludesIncomingRoot = Boolean(
      existingMarker &&
      (
        incoming.rootFolder === existingMarker.from ||
        incoming.rootFolder === existingMarker.to
      )
    );
    const marker = deliveredMarker ?? (
      existingMarkerIncludesIncomingRoot ? existingMarker : null
    );
    if (deliveredMarker) {
      const deliveredEdge = new Set([deliveredMarker.from, deliveredMarker.to]);
      const displacedRoots = [
        previousRoot,
        ...(existingMarker ? [existingMarker.from, existingMarker.to] : [])
      ].filter((root, index, roots) =>
        !deliveredEdge.has(root) && roots.indexOf(root) === index
      );
      if (displacedRoots.length > 0) {
        const retained = await this.mergeRetiredRootFolders(displacedRoots);
        const journalArmed = retained && this.armTrustedInventoryJournal() !== null;
        if (!journalArmed) {
          // Replacing an A -> B transition with an explicit A -> C marker must
          // never make B undiscoverable after restart. If its bounded durable
          // commitment cannot be established, preserve the older path state
          // and require typed review instead of applying the competing edge.
          this.pendingMigrationMarker = previousPendingMigrationMarker;
          this.pendingMigrationConfiguredRoot = previousPendingMigrationConfiguredRoot;
          this.settings = { ...this.settings, rootFolder: previousSettingsRoot };
          setClinicalRoot(previousRoot);
          this.setBaselineReviewBlocked(this.managedRecordsExpected);
          try {
            await this.persistPluginData();
          } catch {
            this.workspaceSafetyNeedsPersistence = true;
          }
          this.showMigrationRecoveryNotice(
            12000,
            CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
          );
          return;
        }
      }
    }
    if (marker) this.watchMigrationRoots(marker);
    const deliveredSafety = this.workspaceSafetyFrom(stored);
    const deliveredInitializationApproved =
      deliveredSafety?.initializationApproved === true &&
      deliveredSafety.initialized !== true;
    const deliveredTrustedSafety = this.isWorkspaceSafetyTrusted(
      deliveredSafety,
      incoming.rootFolder
    );
    const wasFirstUseInitializationPending = this.firstUseInitializationPending;
    const localExpectedCount = this.expectedManagedRecordCount;
    const deliveredExpectedCount = deliveredSafety?.expectedManagedRecordCount ?? 0;
    const localCounts = this.expectedEntityCounts;
    const localCountTotal = localCounts
      ? localCounts.patient + localCounts.episode + localCounts.task + localCounts.procedure
      : -1;
    const localInventory = localCounts && this.expectedRecordDigest &&
      localCountTotal === localExpectedCount
      ? {
          counts: { ...localCounts },
          digest: this.expectedRecordDigest,
          total: localExpectedCount
        }
      : null;
    const deliveredInventory = completeSafetyInventory(deliveredSafety);
    const deliveredIsHigher = deliveredExpectedCount > localExpectedCount;
    const deliveredIsEqual = deliveredExpectedCount === localExpectedCount;
    const localCommitmentEstablished =
      this.workspaceInitialized ||
      this.managedRecordsExpected ||
      localExpectedCount > 0 ||
      localInventory !== null;
    const seedTrustedFirstUseInventory =
      (wasFirstUseInitializationPending || !localCommitmentEstablished) &&
      deliveredTrustedSafety &&
      deliveredInventory !== null;
    const adoptDeliveredInventory =
      seedTrustedFirstUseInventory;
    // A larger count plus one aggregate digest cannot prove set inclusion: a
    // replacement plus growth can look like a harmless extension. Once this
    // device has a trusted baseline, every higher commitment needs typed
    // review rather than silently accepting possible record loss.
    const higherCommitmentNeedsReview =
      deliveredIsHigher && localCommitmentEstablished && !adoptDeliveredInventory;
    const equalCommitmentConflicts =
      deliveredIsEqual &&
      localInventory !== null &&
      deliveredInventory !== null &&
      !sameRecordInventory(localInventory, deliveredInventory);
    const equalCompleteUpgradesIncompleteLocal =
      deliveredIsEqual &&
      localCommitmentEstablished &&
      localInventory === null &&
      deliveredInventory !== null;
    const drainedRootRebind =
      drainedManagedMutation && incoming.rootFolder !== previousRoot;

    this.workspaceInitialized ||= deliveredSafety?.initialized === true;
    this.managedRecordsExpected ||= deliveredSafety?.managedRecordsExpected === true;
    if (adoptDeliveredInventory && deliveredInventory) {
      // A first-use device has no competing local baseline; seed the complete
      // synced tuple atomically rather than pairing its count with no digest.
      this.expectedManagedRecordCount = deliveredInventory.total;
      this.expectedEntityCounts = { ...deliveredInventory.counts };
      this.expectedRecordDigest = deliveredInventory.digest;
    } else {
      this.expectedManagedRecordCount = Math.max(
        localExpectedCount,
        deliveredExpectedCount,
        this.managedRecordsExpected ? 1 : 0
      );
    }
    if (equalCompleteUpgradesIncompleteLocal && deliveredInventory) {
      // Retain the stronger tuple as pending evidence, but never call it
      // trusted without typed review: the legacy local baseline had no digest
      // with which to prove the delivered ids are the same set.
      this.expectedEntityCounts = { ...deliveredInventory.counts };
      this.expectedRecordDigest = deliveredInventory.digest;
    }
    this.recoveryValidationRequired ||=
      deliveredSafety?.recoveryValidationRequired === true;
    this.baselineReviewRequired ||=
      deliveredSafety?.baselineReviewRequired === true ||
      higherCommitmentNeedsReview ||
      equalCommitmentConflicts ||
      equalCompleteUpgradesIncompleteLocal;
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
    if (
      (deliveredSafety?.rootRecoveryRequired === true ||
        deliveredSafety?.recoveryValidationRequired === true) &&
      !marker
    ) {
      this.setMissingRootRecoveryBlocked(
        deliveredSafety.recoveryRequiresRecords || this.managedRecordsExpected
      );
    }
    if (
      wasFirstUseInitializationPending &&
      deliveredSafety?.initialized === true &&
      deliveredInventory === null &&
      !marker
    ) {
      // A newly synced legacy count-only state is trusted configuration, not
      // enough evidence to open writes. One explicit Retry parses the exact
      // expected count and upgrades it to a digest-bearing commitment.
      this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
    }
    if (this.baselineReviewRequired) {
      this.setBaselineReviewBlocked(
        deliveredExpectedCount > 0 || this.managedRecordsExpected
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
      restoreSupersededPathState();
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
      }, { externalSettingsEpoch: externalEpoch });
      if (restoreSupersededPathState()) return;
      if (!settled) {
        // A safety-state write can already be in flight when Sync delivers the
        // marker. Queue a canonical marker-bearing snapshot behind it so that
        // the older write cannot be the final data.json state.
        await this.persistPluginData();
        if (restoreSupersededPathState()) return;
        this.showMigrationRecoveryNotice();
      }
    } else if (drainedRootRebind) {
      // The admitted operation captured the previous root before this Sync
      // callback closed admission. Even after it drains, a marker-free rebind
      // cannot prove whether the filesystem rename included that write. Keep
      // both locations visible to recovery instead of silently stranding it.
      const inferred = { from: previousRoot, to: incoming.rootFolder };
      this.watchMigrationRoots(inferred);
      this.pendingMigrationMarker = { migrationInProgress: inferred };
      this.pendingMigrationConfiguredRoot = incoming.rootFolder;
      this.setMigrationRecoveryBlocked(true);
      await this.persistPluginData();
      if (restoreSupersededPathState()) return;
      this.showMigrationRecoveryNotice();
    } else if (incoming.rootFolder === previousRoot) {
      this.settings = incoming;
      setClinicalRoot(incoming.rootFolder);
      const expectedCounts = this.expectedEntityCounts;
      const expectedTotal = expectedCounts
        ? expectedCounts.patient + expectedCounts.episode +
          expectedCounts.task + expectedCounts.procedure
        : -1;
      if (
        !this.missingRootRecoveryBlocked &&
        expectedCounts &&
        this.expectedRecordDigest &&
        expectedTotal === this.expectedManagedRecordCount
      ) {
        // Even a benign same-root data.json delivery can be one half of a
        // split Sync update. Persist a real barrier, then let the callback
        // wrapper reopen only through an exact record commitment check.
        this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      }
      // Serialize the canonical merged snapshot behind any older local save.
      // This makes the stronger count/review barrier durable before the
      // callback can finish or exact recovery can run.
      await this.persistPluginData();
      if (restoreSupersededPathState()) return;
    } else {
      const canActivateIncomingRoot = this.canActivateSyncedRoot(
        previousRoot,
        incoming.rootFolder
      );
      const incomingRootFingerprint = canActivateIncomingRoot
        ? await rootFingerprint(incoming.rootFolder)
        : null;
      const incomingVerification = canActivateIncomingRoot
        ? await this.verifyRecordInventory(incoming.rootFolder)
        : null;
      // A later callback has already captured its own data.json snapshot.
      // Leave this older application blocked and let that queued snapshot win.
      if (restoreSupersededPathState()) return;
      const incomingRootUsableForReads = incomingVerification !== null &&
        (
          incomingVerification.ok ||
          this.inventoryHasNoExpectedCountRegression(incomingVerification.inventory)
        );
      const inferred = { from: previousRoot, to: incoming.rootFolder };
      let rootChangeCanCommit =
        canActivateIncomingRoot &&
        incomingRootUsableForReads &&
        await this.rememberResolvedMigration(
          inferred,
          incoming.rootFolder,
          () => externalEpoch === this.externalSettingsEpoch
        );
      if (restoreSupersededPathState()) return;
      if (rootChangeCanCommit && this.armTrustedInventoryJournal() === null) {
        // Marker-free Sync has no durable move edge to reconstruct after a
        // crash. Commit the newly retired source fingerprint locally before
        // attempting the first marker-free canonical save.
        this.failClosedForTrustedInventoryJournal();
        rootChangeCanCommit = false;
      }

      if (rootChangeCanCommit) {
        if (
          incomingVerification &&
          !this.inventoryExactlyMatchesExpected(
            incoming.rootFolder,
            incomingVerification.inventory
          )
        ) {
          // The destination can be selected for reads, but growth or a changed
          // digest cannot prove that every previously trusted id survived.
          this.setBaselineReviewBlocked(this.managedRecordsExpected);
        }
        this.settings = incoming;
        setClinicalRoot(incoming.rootFolder);
        this.workspaceInitialized = true;
        const deliveredRecordCount = this.rootManagedRecordCount(incoming.rootFolder);
        this.managedRecordsExpected ||= deliveredRecordCount > 0;
        this.expectedManagedRecordCount = Math.max(
          this.expectedManagedRecordCount,
          deliveredRecordCount
        );
        if (!this.baselineReviewRequired) {
          this.missingRootRecoveryBlocked = false;
          this.missingRootRequiresRecords = false;
          if (incomingRootFingerprint && this.currentCompleteInventory()) {
            this.activeRootFingerprint = incomingRootFingerprint;
            // Reopen only through the callback wrapper's final exact rescan.
            this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
          }
        }
        this.setMigrationRecoveryBlocked(false);
        // The incoming data may still carry a recovery flag from the old root.
        // Persist the proven root change so a restart cannot re-arm that stale
        // barrier after this device has already reconciled safely.
        await this.persistPluginData();
        if (restoreSupersededPathState()) return;
      } else {
        // A final data.json can overtake the folder rename and arrive without the
        // intermediate marker. Reconstruct recovery metadata, but persist the
        // *incoming* configured root so another restart cannot manufacture it.
        this.watchMigrationRoots(inferred);
        this.pendingMigrationMarker = { migrationInProgress: inferred };
        this.pendingMigrationConfiguredRoot = incoming.rootFolder;
        this.setMigrationRecoveryBlocked(true);
        await this.persistPluginData();
        if (restoreSupersededPathState()) return;
        this.showMigrationRecoveryNotice();
      }
    }

    if (!this.repository) return;
    this.repository.setActor(auditActor(this.settings));
    this.structureReady = false;
    this.integrityChecked = false;
    await this.refreshOpenViews();
    restoreSupersededPathState();
  }

  private markerFrom(value: unknown): MigrationMarker | null {
    const marker = (value as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress;
    if (typeof marker?.from !== "string" || typeof marker.to !== "string") return null;
    const from = normalizeFolderPath(marker.from);
    const to = normalizeFolderPath(marker.to);
    if (from === to || validateRootFolder(from) || validateRootFolder(to)) return null;
    return { from, to };
  }

  private watchMigrationRoots(marker: MigrationMarker): void {
    this.managedDeliveryWatchRoots.add(marker.from);
    this.managedDeliveryWatchRoots.add(marker.to);
  }

  /** Returns the canonical local commitment, or null if the caches diverged. */
  private currentRetiredRootFingerprints(): string[] | null {
    if (this.retiredRootFolders.size !== this.retiredRootFingerprintByFolder.size) {
      return null;
    }
    const fingerprints: string[] = [];
    for (const root of this.retiredRootFolders) {
      const fingerprint = this.retiredRootFingerprintByFolder.get(root);
      if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
      fingerprints.push(fingerprint);
    }
    fingerprints.sort();
    if (fingerprints.some((fingerprint, index) => fingerprint === fingerprints[index - 1])) {
      return null;
    }
    return fingerprints;
  }

  /** Monotonically unions a delivered synced list without exposing raw paths locally. */
  private async mergeRetiredRootFolders(roots: readonly string[]): Promise<boolean> {
    if (new Set([...this.retiredRootFolders, ...roots]).size > MAX_RETIRED_ROOT_FOLDERS) {
      return false;
    }
    const fingerprintEntries = await Promise.all(
      roots.map(async (root) => [
        root,
        this.retiredRootFingerprintByFolder.get(root) ?? await retiredRootFingerprint(root)
      ] as const)
    );
    // Another awaited safety operation may have enlarged the monotonic set.
    if (new Set([...this.retiredRootFolders, ...roots]).size > MAX_RETIRED_ROOT_FOLDERS) {
      return false;
    }
    for (const [root, fingerprint] of fingerprintEntries) {
      this.managedDeliveryWatchRoots.add(root);
      this.retiredRootFolders.add(root);
      this.retiredRootFingerprintByFolder.set(root, fingerprint);
    }
    return this.currentRetiredRootFingerprints() !== null;
  }

  /**
   * Records the losing path before a migration marker is cleared. The bounded
   * synced list is what lets another Mac—or this Mac after restart—recognize a
   * very late file delivery into an obsolete root.
   */
  private async rememberResolvedMigration(
    marker: MigrationMarker,
    resolvedRoot: string,
    remainsCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (!remainsCurrent() || !this.canRememberResolvedMigration(marker, resolvedRoot)) {
      return false;
    }
    const retiredRoot = resolvedRoot === marker.from ? marker.to : marker.from;
    const fingerprint = await retiredRootFingerprint(retiredRoot);
    // Recheck after the digest await: another callback may have expanded the
    // bounded monotonic set or superseded this recovery while it was blocked.
    // The guard must run inside this method before mutation; a caller-side
    // epoch check would be too late to restore a tombstone deleted here.
    if (!remainsCurrent() || !this.canRememberResolvedMigration(marker, resolvedRoot)) {
      return false;
    }
    this.retiredRootFolders.delete(resolvedRoot);
    this.retiredRootFingerprintByFolder.delete(resolvedRoot);
    this.retiredRootFolders.add(retiredRoot);
    this.retiredRootFingerprintByFolder.set(retiredRoot, fingerprint);
    this.watchMigrationRoots(marker);
    return this.currentRetiredRootFingerprints() !== null;
  }

  private canRememberResolvedMigration(
    marker: MigrationMarker,
    resolvedRoot: string
  ): boolean {
    if (resolvedRoot !== marker.from && resolvedRoot !== marker.to) return false;
    const retiredRoot = resolvedRoot === marker.from ? marker.to : marker.from;
    const nextSize = this.retiredRootFolders.size -
      (this.retiredRootFolders.has(resolvedRoot) ? 1 : 0) +
      (this.retiredRootFolders.has(retiredRoot) ? 0 : 1);
    return nextSize <= MAX_RETIRED_ROOT_FOLDERS;
  }

  private retiredRootForPath(path: string): string | null {
    const activeRoot = clinicalRootFolder();
    for (const root of [...this.retiredRootFolders]
      .filter((candidate) => candidate !== activeRoot)
      .sort((left, right) => right.length - left.length)) {
      if (path === root || path.startsWith(`${root}/`)) return root;
    }
    return null;
  }

  private retiredRootConflict(activeRoot = clinicalRootFolder()): string | null {
    for (const root of [...this.retiredRootFolders].sort()) {
      if (root === activeRoot) continue;
      if (
        this.rootExists(root) ||
        markdownFilesInFolder(this.app.vault, root).length > 0
      ) return root;
    }
    return null;
  }

  /** Converts an already-present retired root into an explicit retry path. */
  private armRetiredRootConflictIfPresent(): boolean {
    if (this.currentMigrationMarker()) return false;
    const activeRoot = clinicalRootFolder();
    const retiredRoot = this.retiredRootConflict(activeRoot);
    if (!retiredRoot) return false;
    const marker = { from: retiredRoot, to: activeRoot };
    this.watchMigrationRoots(marker);
    this.pendingMigrationMarker = { migrationInProgress: marker };
    this.pendingMigrationConfiguredRoot = activeRoot;
    this.setMigrationRecoveryBlocked(true);
    return true;
  }

  /** Returns the active or known move root that owns a managed record path. */
  private managedRecordRootForPath(path: string): string | null {
    const roots = new Set<string>([
      clinicalRootFolder(),
      ...this.managedDeliveryWatchRoots
    ]);
    const marker = this.currentMigrationMarker();
    if (marker) {
      roots.add(marker.from);
      roots.add(marker.to);
    }
    // Prefer the longest root should a user have configured nested names in
    // different migrations during one session.
    for (const root of [...roots].sort((left, right) => right.length - left.length)) {
      if (ENTITY_FOLDER_NAMES.some(([, folder]) => path.startsWith(`${root}/${folder}/`))) {
        return root;
      }
    }
    return null;
  }

  /** Reads the device-local trust anchor without ever repairing malformed data. */
  private readTrustedInventoryJournal(): TrustedInventoryJournalRead {
    let raw: unknown;
    try {
      raw = this.app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY);
    } catch {
      return { status: "invalid", journal: null };
    }
    if (raw === null || raw === undefined) return { status: "missing", journal: null };
    const journal = parseTrustedInventoryJournal(raw);
    return journal
      ? { status: "valid", journal }
      : { status: "invalid", journal: null };
  }

  /** Saves synchronously and verifies the exact value read back from Obsidian. */
  private writeTrustedInventoryJournal(journal: TrustedInventoryJournal): boolean {
    try {
      this.app.saveLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY, journal);
      const verified = this.readTrustedInventoryJournal();
      if (
        verified.status !== "valid" ||
        !sameTrustedInventoryJournal(verified.journal, journal)
      ) return false;
      return true;
    } catch {
      return false;
    }
  }

  private currentCompleteInventory(): RecordInventory | null {
    const counts = this.expectedEntityCounts;
    const digest = this.expectedRecordDigest;
    if (!counts || !digest || !/^[0-9a-f]{64}$/.test(digest)) return null;
    const total = counts.patient + counts.episode + counts.task + counts.procedure;
    if (total !== this.expectedManagedRecordCount) return null;
    return { counts: { ...counts }, digest, total };
  }

  private journalEntryForCurrentInventory(): TrustedInventoryJournalEntry | null {
    const inventory = this.currentCompleteInventory();
    if (!inventory || !this.activeRootFingerprint) return null;
    return {
      rootFingerprint: this.activeRootFingerprint,
      expectedManagedRecordCount: inventory.total,
      expectedEntityCounts: { ...inventory.counts },
      expectedRecordDigest: inventory.digest
    };
  }

  /**
   * Binds the current trusted tuple to `root` only after a fresh exact scan.
   * The fingerprint is prepared before that scan, leaving no await between
   * the verified local write and the caller's barrier release.
   */
  private async commitTrustedInventoryJournalForExactRoot(
    root: string,
    expectedGeneration?: number
  ): Promise<boolean> {
    if (this.retiredRootConflict(root)) return false;
    const deliveryRevision = this.markerFreeRecoveryRevision;
    const fingerprint = await rootFingerprint(root);
    let inventory: RecordInventory;
    try {
      inventory = await this.parsedRecordInventory(root);
    } catch {
      return false;
    }
    if (
      this.markerFreeRecoveryRevision !== deliveryRevision ||
      clinicalRootFolder() !== root ||
      !this.rootExists(root) ||
      !this.inventoryExactlyMatchesExpected(root, inventory)
    ) return false;
    this.activeRootFingerprint = fingerprint;
    return this.commitTrustedInventoryJournal(expectedGeneration);
  }

  /**
   * First executable safety action for an external data.json callback. It is
   * intentionally synchronous: a process exit while loadData is suspended
   * must leave the previous trust anchor marked pending on this device.
   */
  private armTrustedInventoryJournal(): number | null {
    const read = this.readTrustedInventoryJournal();
    if (read.status === "invalid") return null;
    const retiredRootFingerprints = this.currentRetiredRootFingerprints();
    if (!retiredRootFingerprints) return null;
    const generation = (read.journal?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) return null;
    const trustedInventory = read.journal?.trustedInventory ??
      (!this.baselineReviewRequired ? this.journalEntryForCurrentInventory() ?? undefined : undefined);
    const pending: TrustedInventoryJournal = {
      version: 1,
      generation,
      pending: true,
      retiredRootFingerprints,
      ...(trustedInventory ? { trustedInventory } : {})
    };
    return this.writeTrustedInventoryJournal(pending) ? generation : null;
  }

  /**
   * Advances/clears the local anchor only after a trusted operation's final
   * exact scan. Supplying a generation prevents an older callback from
   * clearing a newer callback's pending marker.
   */
  private commitTrustedInventoryJournal(
    expectedGeneration?: number,
    allowInvalidReplacement = false
  ): boolean {
    if (this.retiredRootConflict()) return false;
    const retiredRootFingerprints = this.currentRetiredRootFingerprints();
    if (!retiredRootFingerprints) return false;
    const read = this.readTrustedInventoryJournal();
    if (read.status === "invalid" && !allowInvalidReplacement) return false;
    const generation = read.journal?.generation ?? 0;
    if (expectedGeneration !== undefined && generation !== expectedGeneration) return false;
    const trustedInventory = this.journalEntryForCurrentInventory();
    if (!trustedInventory || this.baselineReviewRequired) return false;
    return this.writeTrustedInventoryJournal({
      version: 1,
      generation,
      pending: false,
      retiredRootFingerprints,
      trustedInventory
    });
  }

  private failClosedForTrustedInventoryJournal(): void {
    this.recoveryValidationRequired = true;
    this.workspaceSafetyNeedsPersistence = true;
    this.setBaselineReviewBlocked(this.managedRecordsExpected);
    this.showMigrationRecoveryNotice(12000, CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
  }

  /** Legacy count-only state may be upgraded by explicit exact Retry, not opened. */
  private blockAfterTrustedInventoryJournalCommitFailure(): void {
    const journal = this.readTrustedInventoryJournal();
    if (
      journal.status === "valid" &&
      journal.journal.pending &&
      !journal.journal.trustedInventory &&
      !this.currentCompleteInventory()
    ) {
      this.workspaceSafetyNeedsPersistence = true;
      this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      this.showMigrationRecoveryNotice();
      return;
    }
    this.failClosedForTrustedInventoryJournal();
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
    const validCount = (candidate: unknown): candidate is number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
    const countRecord = rawCounts && typeof rawCounts === "object"
      ? rawCounts as Record<string, unknown>
      : null;
    const expectedEntityCounts = countRecord &&
      validCount(countRecord.patient) &&
      validCount(countRecord.episode) &&
      validCount(countRecord.task) &&
      validCount(countRecord.procedure)
      ? {
          patient: countRecord.patient,
          episode: countRecord.episode,
          task: countRecord.task,
          procedure: countRecord.procedure
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
      recoveryValidationRequired: state.recoveryValidationRequired === true,
      baselineReviewRequired: state.baselineReviewRequired === true,
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
      recoveryValidationRequired: this.recoveryValidationRequired,
      baselineReviewRequired: this.baselineReviewRequired,
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
   * Non-regressing growth is usable only to select a physical Sync root; the
   * separate exact predicate still requires typed ADOPT before writes reopen.
   */
  private async verifyRecordInventory(
    root: string
  ): Promise<{ ok: boolean; reason: string | null; inventory: RecordInventory }> {
    const expected = this.expectedEntityCounts;
    const current = await this.parsedRecordInventory(root);
    if (!expected) return { ok: true, reason: null, inventory: current };
    for (const [entity] of ENTITY_FOLDER_NAMES) {
      if (current.counts[entity] < expected[entity]) {
        return {
          ok: false,
          reason:
            "Some previously confirmed records are missing or no longer readable. Wait for Sync to finish or restore your backup, then retry — or confirm the current records as the new baseline.",
          inventory: current
        };
      }
    }
    const sameCounts = ENTITY_FOLDER_NAMES.every(([entity]) => current.counts[entity] === expected[entity]);
    if (sameCounts && this.expectedRecordDigest && current.digest !== this.expectedRecordDigest) {
      return {
        ok: false,
        reason:
          "The records on disk differ from the trusted baseline even though their count matches. Wait for Sync to finish or restore your backup, then retry — or confirm the current records as the new baseline.",
        inventory: current
      };
    }
    return { ok: true, reason: null, inventory: current };
  }

  private inventoryHasNoExpectedCountRegression(current: RecordInventory): boolean {
    const expected = this.expectedEntityCounts;
    return !expected || ENTITY_FOLDER_NAMES.every(
      ([entity]) => current.counts[entity] >= expected[entity]
    );
  }

  /** Only this predicate is strong enough to authorize writes again. */
  private inventoryExactlyMatchesExpected(root: string, current: RecordInventory): boolean {
    const expected = this.expectedEntityCounts;
    const expectedDigest = this.expectedRecordDigest;
    const rawCount = this.rootManagedRecordCount(root);
    if (!expected || !expectedDigest) {
      // Legacy count-only migrations remain compatible, but malformed Markdown
      // or growth beyond the stored floor can never be called an exact match.
      return current.total === rawCount && rawCount === this.expectedManagedRecordCount;
    }
    const expectedTotal = expected.patient + expected.episode +
      expected.task + expected.procedure;
    return expectedTotal === this.expectedManagedRecordCount &&
      rawCount === this.expectedManagedRecordCount &&
      current.total === this.expectedManagedRecordCount &&
      current.digest === expectedDigest &&
      ENTITY_FOLDER_NAMES.every(
        ([entity]) => current.counts[entity] === expected[entity]
      );
  }

  /** Ratchets the parsed-record commitment forward from the current root. */
  private async ratchetRecordInventory(root: string): Promise<boolean> {
    const current = await this.parsedRecordInventory(root);
    return this.ratchetRecordInventoryFrom(current);
  }

  private ratchetRecordInventoryFrom(current: RecordInventory): boolean {
    const previous = this.expectedEntityCounts;
    // A depleted root must never become the new commitment. Rebasing the
    // digest from fewer records than were confirmed would teach recovery to
    // trust exactly the loss it exists to detect; the ratchet moves forward
    // or not at all.
    if (
      previous &&
      ENTITY_FOLDER_NAMES.some(([entity]) => current.counts[entity] < previous[entity])
    ) {
      return false;
    }
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
    const initializationBlocked = !blocked && this.firstUseInitializationPending;
    const reviewBlocked = !blocked && this.baselineReviewRequired;
    const missingRootBlocked = !blocked && this.missingRootRecoveryBlocked;
    const markerBlocked = !blocked && Boolean(this.currentMigrationMarker());
    const externalSettingsBlocked = !blocked && this.externalSettingsApplyOperations > 0;
    const effectiveBlocked = blocked || initializationBlocked || reviewBlocked ||
      missingRootBlocked || markerBlocked || externalSettingsBlocked;
    const effectiveMessage = initializationBlocked
      ? CLINICAL_INITIALIZATION_REQUIRED_MESSAGE
      : reviewBlocked
        ? CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
        : missingRootBlocked
          ? CLINICAL_ROOT_UNAVAILABLE_MESSAGE
          : message;
    this.migrationRecoveryBlocked = effectiveBlocked;
    this.recoveryBlockMessage = effectiveBlocked
      ? effectiveMessage
      : CLINICAL_WRITES_BLOCKED_MESSAGE;
    if (!effectiveBlocked) {
      this.missingRootRecoveryBlocked = false;
      this.missingRootRequiresRecords = false;
    }
    if (this.repository) {
      this.repository.setWriteBlock(effectiveBlocked ? effectiveMessage : null);
    }
    if (!effectiveBlocked) this.hideRecoveryNotice();
  }

  private hideRecoveryNotice(): void {
    hideClinicalRecoveryNotice();
  }

  private showMigrationRecoveryNotice(
    duration = 12000,
    message = this.recoveryBlockMessage
  ): void {
    showClinicalRecoveryNotice(message, duration);
  }

  private showUserFacingNotice(message: string, duration: number): void {
    showClinicalNotice(message, duration);
  }

  private setMissingRootRecoveryBlocked(
    requiresRecords = this.managedRecordsExpected
  ): void {
    // This sentinel stays durable after recovery. If a later re-arm write
    // fails, the next launch still performs an exact inventory check rather
    // than trusting the cleared rootRecoveryRequired flag on disk.
    this.recoveryValidationRequired = true;
    // An in-flight recovery may already have requested release. Preserve that
    // request until the queue finalizer can reject its result honestly; clearing
    // it here could return success while this method keeps writes blocked.
    if (this.markerFreeRecoveryOperations === 0) {
      this.markerFreeRecoveryReleaseRequested = false;
      this.markerFreeRecoveryReleaseRevision = null;
      this.markerFreeRecoveryReleaseJournalGeneration = null;
      this.markerFreeRecoveryReleaseAllowsJournalReplacement = false;
    }
    this.missingRootRecoveryBlocked = true;
    this.missingRootRequiresRecords = requiresRecords;
    this.setMigrationRecoveryBlocked(true, CLINICAL_ROOT_UNAVAILABLE_MESSAGE);
  }

  private setBaselineReviewBlocked(
    requiresRecords = this.managedRecordsExpected
  ): void {
    this.baselineReviewRequired = true;
    this.setMissingRootRecoveryBlocked(requiresRecords);
    this.setMigrationRecoveryBlocked(true, CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
  }

  /** Run automatic and user-confirmed marker-free recovery one at a time. */
  private enqueueMarkerFreeRecovery(operation: () => Promise<boolean>): Promise<boolean> {
    this.markerFreeRecoveryOperations += 1;
    const execute = async (): Promise<boolean> => {
      let result: boolean;
      try {
        result = await operation();
      } catch (error) {
        this.markerFreeRecoveryOperations -= 1;
        this.finalizeMarkerFreeRecoveryRelease();
        throw error;
      }
      this.markerFreeRecoveryOperations -= 1;
      return this.finalizeMarkerFreeRecoveryRelease() ? false : result;
    };
    const run = this.markerFreeRecoveryQueue.then(execute, execute);
    this.markerFreeRecoveryQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Returns true when a last-moment Sync delivery rejected the requested release. */
  private finalizeMarkerFreeRecoveryRelease(): boolean {
    if (!this.markerFreeRecoveryReleaseRequested) return false;
    if (this.armRetiredRootConflictIfPresent()) {
      void this.persistPluginData().catch(() => {
        this.workspaceSafetyNeedsPersistence = true;
      });
    }
    const releaseRevision = this.markerFreeRecoveryReleaseRevision;
    const stateChanged =
      releaseRevision !== this.markerFreeRecoveryRevision ||
      this.missingRootRecoveryBlocked ||
      this.baselineReviewRequired ||
      this.externalSettingsApplyOperations > 0 ||
      this.firstUseInitializationPending ||
      Boolean(this.currentMigrationMarker());
    if (stateChanged) {
      this.markerFreeRecoveryReleaseRequested = false;
      this.markerFreeRecoveryReleaseRevision = null;
      this.markerFreeRecoveryReleaseJournalGeneration = null;
      this.markerFreeRecoveryReleaseAllowsJournalReplacement = false;
      if (
        releaseRevision !== this.markerFreeRecoveryRevision &&
        this.externalSettingsApplyOperations === 0 &&
        !this.firstUseInitializationPending &&
        !this.currentMigrationMarker()
      ) {
        // A Sync callback can run in the microtask between the operation's
        // final scan and this queue finalizer. Re-arm synchronously; the
        // durable validation sentinel already on disk keeps a failed follow-up
        // save safe across restart.
        if (!this.missingRootRecoveryBlocked) {
          this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
        }
        void this.persistWorkspaceSafety();
        // The event may have joined an exact-recovery promise that is now
        // finishing. Retry in the next microtask, after that guard is released,
        // so an unchanged final Sync delivery does not leave a stale barrier.
        queueMicrotask(() => {
          void this.retryExactRestoredRootRecovery();
        });
      }
      return true;
    }
    if (this.markerFreeRecoveryOperations !== 0) return false;
    const journalGeneration = this.markerFreeRecoveryReleaseJournalGeneration ?? undefined;
    const allowJournalReplacement = this.markerFreeRecoveryReleaseAllowsJournalReplacement;
    this.markerFreeRecoveryReleaseRequested = false;
    this.markerFreeRecoveryReleaseRevision = null;
    this.markerFreeRecoveryReleaseJournalGeneration = null;
    this.markerFreeRecoveryReleaseAllowsJournalReplacement = false;
    if (!this.commitTrustedInventoryJournal(journalGeneration, allowJournalReplacement)) {
      this.blockAfterTrustedInventoryJournalCommitFailure();
      return true;
    }
    this.setMigrationRecoveryBlocked(false);
    return false;
  }

  /** The queue releases the barrier in its finalizer before callers observe success. */
  private requestMarkerFreeRecoveryRelease(allowJournalReplacement = false): void {
    this.markerFreeRecoveryReleaseRequested = true;
    this.markerFreeRecoveryReleaseRevision = this.markerFreeRecoveryRevision;
    this.markerFreeRecoveryReleaseAllowsJournalReplacement ||= allowJournalReplacement;
    const journal = this.readTrustedInventoryJournal();
    this.markerFreeRecoveryReleaseJournalGeneration =
      journal.status === "valid" && journal.journal.pending
        ? journal.journal.generation
        : null;
  }

  /**
   * Clears a marker-free missing-root barrier only when the exact committed
   * record set has returned. Unlike the explicit recovery command, this never
   * accepts growth or legacy count-only safety data: either case needs a human
   * decision rather than being inferred from Sync timing.
   */
  private retryExactRestoredRootRecovery(): Promise<boolean> {
    this.exactRootRecoveryRetryRequested = true;
    if (this.exactRootRecoveryPromise) return this.exactRootRecoveryPromise;
    const run = this.enqueueMarkerFreeRecovery(() => this.drainExactRootRecoveryRequests());
    this.exactRootRecoveryPromise = run;
    return run;
  }

  private async drainExactRootRecoveryRequests(): Promise<boolean> {
    let recovered = false;
    try {
      do {
        this.exactRootRecoveryRetryRequested = false;
        recovered = await this.tryExactRestoredRootRecovery();
      } while (this.exactRootRecoveryRetryRequested);
      return recovered;
    } finally {
      // No await occurs between the final retry check and releasing the guard,
      // so a later event either joined this drain or starts a fresh one.
      this.exactRootRecoveryPromise = null;
    }
  }

  private async tryExactRestoredRootRecovery(): Promise<boolean> {
    if (
      !this.missingRootRecoveryBlocked ||
      this.baselineReviewRequired ||
      this.externalSettingsApplyOperations > 0 ||
      this.firstUseInitializationPending ||
      this.currentMigrationMarker()
    ) {
      return !this.migrationRecoveryBlocked;
    }

    const root = clinicalRootFolder();
    const fingerprint = await rootFingerprint(root);
    if (
      clinicalRootFolder() !== root ||
      !this.missingRootRecoveryBlocked ||
      this.baselineReviewRequired ||
      this.externalSettingsApplyOperations > 0 ||
      this.firstUseInitializationPending ||
      this.currentMigrationMarker()
    ) return false;
    this.activeRootFingerprint = fingerprint;
    const expectedCount = this.expectedManagedRecordCount;
    const expectedCounts = this.expectedEntityCounts
      ? { ...this.expectedEntityCounts }
      : null;
    const expectedDigest = this.expectedRecordDigest;
    const requiresRecords = this.missingRootRequiresRecords;
    const expectedParsedTotal = expectedCounts
      ? expectedCounts.patient + expectedCounts.episode + expectedCounts.task + expectedCounts.procedure
      : -1;
    if (
      !this.rootExists(root) ||
      !expectedCounts ||
      !expectedDigest ||
      expectedParsedTotal !== expectedCount ||
      this.rootManagedRecordCount(root) !== expectedCount
    ) {
      return false;
    }

    let current: RecordInventory;
    try {
      current = await this.parsedRecordInventory(root);
    } catch {
      return false;
    }

    // Every awaited read is a race boundary. Recheck both the barrier and the
    // exact snapshot before changing any state.
    if (
      !this.missingRootRecoveryBlocked ||
      this.firstUseInitializationPending ||
      this.currentMigrationMarker() ||
      clinicalRootFolder() !== root ||
      this.expectedManagedRecordCount !== expectedCount ||
      this.expectedRecordDigest !== expectedDigest ||
      !this.expectedEntityCounts ||
      ENTITY_FOLDER_NAMES.some(
        ([entity]) => this.expectedEntityCounts?.[entity] !== expectedCounts[entity]
      ) ||
      this.rootManagedRecordCount(root) !== expectedCount ||
      current.total !== expectedCount ||
      current.digest !== expectedDigest ||
      ENTITY_FOLDER_NAMES.some(([entity]) => current.counts[entity] !== expectedCounts[entity])
    ) {
      return false;
    }

    // Keep both global and repository barriers armed while serializing the
    // cleared missing-root flag. Direct maintenance actions consult the global
    // boolean, so dropping it before the save would create a write window.
    this.recoveryValidationRequired = true;
    this.missingRootRecoveryBlocked = false;
    this.missingRootRequiresRecords = false;
    this.structureReady = false;
    this.repository?.setWriteBlock(CLINICAL_ROOT_UNAVAILABLE_MESSAGE);
    try {
      await this.persistPluginData();
    } catch {
      this.workspaceSafetyNeedsPersistence = true;
      this.setMissingRootRecoveryBlocked(requiresRecords);
      return false;
    }

    // Sync can change the root while the save is queued. Relevant events mark
    // this pass dirty; also rescan so a change delivered without an event
    // cannot inherit the just-validated result.
    let finalInventory: RecordInventory | null = null;
    if (!this.exactRootRecoveryRetryRequested) {
      try {
        finalInventory = await this.parsedRecordInventory(root);
      } catch {
        finalInventory = null;
      }
    }
    const finalMatches =
      !this.exactRootRecoveryRetryRequested &&
      finalInventory !== null &&
      !this.firstUseInitializationPending &&
      !this.currentMigrationMarker() &&
      clinicalRootFolder() === root &&
      this.expectedManagedRecordCount === expectedCount &&
      this.expectedRecordDigest === expectedDigest &&
      this.expectedEntityCounts !== null &&
      ENTITY_FOLDER_NAMES.every(
        ([entity]) => this.expectedEntityCounts?.[entity] === expectedCounts[entity]
      ) &&
      this.rootManagedRecordCount(root) === expectedCount &&
      finalInventory.total === expectedCount &&
      finalInventory.digest === expectedDigest &&
      ENTITY_FOLDER_NAMES.every(
        ([entity]) => finalInventory?.counts[entity] === expectedCounts[entity]
      );
    if (!finalMatches) {
      this.setMissingRootRecoveryBlocked(requiresRecords);
      try {
        await this.persistPluginData();
      } catch {
        this.workspaceSafetyNeedsPersistence = true;
      }
      return false;
    }

    this.requestMarkerFreeRecoveryRelease();
    // Do not await UI work after the final inventory check: a Sync event in
    // that gap could otherwise dirty the accepted snapshot before the queue
    // finalizer opens the barrier.
    void this.refreshOpenViews().catch(() => undefined);
    return true;
  }

  private async noteManagedRecordWrite(paths?: readonly string[]): Promise<boolean> {
    try {
      const durablyServiced = await this.noteManagedRecordWriteChecked(paths);
      if (!durablyServiced) {
        throw new Error(
          "Clinical record verification failed because an untrusted record delivery overlapped the write."
        );
      }
      return true;
    } catch (error) {
      // The vault write has already been verified by the repository. If its
      // whole-root inventory scan or safety save fails, preserve the previous
      // device-local anchor and close writes before the mutation claim can be
      // released; otherwise a later deletion could make the old tuple appear
      // exact again.
      this.markerFreeRecoveryRevision += 1;
      const journalArmed = this.armTrustedInventoryJournal() !== null;
      this.failClosedForTrustedInventoryJournal();
      if (journalArmed) {
        try {
          await this.persistWorkspaceSafety();
        } catch {
          this.workspaceSafetyNeedsPersistence = true;
        }
      }
      throw error;
    }
  }

  private async noteManagedRecordWriteChecked(paths?: readonly string[]): Promise<boolean> {
    if (this.repository.consumeUnclassifiedManagedMutationEvent(paths)) {
      this.markerFreeRecoveryRevision += 1;
      if (this.armTrustedInventoryJournal() === null) {
        this.failClosedForTrustedInventoryJournal();
        throw new Error("Clinical Workspace could not arm trusted record-write recovery.");
      }
      this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      await this.persistWorkspaceSafety(true);
      return false;
    }
    const root = clinicalRootFolder();
    const writeRevision = this.markerFreeRecoveryRevision;
    const [fingerprint, currentInventory] = await Promise.all([
      rootFingerprint(root),
      this.parsedRecordInventory(root)
    ]);
    // A same-path Sync event can arrive after the initial provenance check
    // while the exact inventory read is suspended. Re-check before changing
    // the trusted tuple; at this point the previous journal entry is still
    // intact and can be armed as the recovery anchor.
    if (this.repository.consumeUnclassifiedManagedMutationEvent(paths)) {
      this.markerFreeRecoveryRevision += 1;
      if (this.armTrustedInventoryJournal() === null) {
        this.failClosedForTrustedInventoryJournal();
        throw new Error("Clinical Workspace could not arm trusted record-write recovery.");
      }
      this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      await this.persistWorkspaceSafety(true);
      return false;
    }
    const currentCount = this.rootManagedRecordCount(root);
    const inventoryRegressed = this.expectedEntityCounts !== null &&
      ENTITY_FOLDER_NAMES.some(
        ([entity]) => currentInventory.counts[entity] < (this.expectedEntityCounts?.[entity] ?? 0)
      );
    if (
      clinicalRootFolder() !== root ||
      this.markerFreeRecoveryRevision !== writeRevision
    ) {
      throw new Error(
        "Clinical Workspace state changed during trusted record-write verification."
      );
    }
    if (currentInventory.total !== currentCount || inventoryRegressed) {
      // A verified append-only plugin write cannot make another managed note
      // unreadable or reduce an entity class. Even if a platform event was
      // missed, preserve the old anchor and require an exact recovery scan.
      if (this.armTrustedInventoryJournal() === null) {
        this.failClosedForTrustedInventoryJournal();
        throw new Error("Clinical Workspace could not arm trusted record-write recovery.");
      }
      this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      await this.persistWorkspaceSafety(true);
      return false;
    }
    this.activeRootFingerprint = fingerprint;
    const inventoryChanged = this.ratchetRecordInventoryFrom(currentInventory);
    if (
      this.workspaceInitialized &&
      this.managedRecordsExpected &&
      currentCount <= this.expectedManagedRecordCount &&
      !inventoryChanged &&
      !this.workspaceSafetyNeedsPersistence
    ) return true;
    this.workspaceInitialized = true;
    // Never downgraded: a momentary zero count (records still syncing in)
    // must not disarm the deletion detector for the records already trusted.
    this.managedRecordsExpected ||= currentCount > 0;
    this.expectedManagedRecordCount = Math.max(this.expectedManagedRecordCount, currentCount);
    this.workspaceSafetyNeedsPersistence = true;
    await this.persistWorkspaceSafety(true);
    return true;
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
      if (
        !destinationHasRecords ||
        sourceHasRecords ||
        this.rootExists(from)
      ) return false;
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
      showClinicalRecoveryNotice(
        "A legacy folder move is still pending. Let synchronization finish, then use the recovery command before adopting the current workspace baseline.",
        12000
      );
      return Promise.resolve(false);
    }
    this.firstUseInitializationPromise = (async () => {
      const previewRevision = this.markerFreeRecoveryRevision;
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
      const [inventory, fingerprint] = await Promise.all([
        this.parsedRecordInventory(root),
        rootFingerprint(root)
      ]);
      if (
        this.settings.rootFolder !== root ||
        this.markerFreeRecoveryRevision !== previewRevision ||
        this.rootManagedRecordCount(root) !== recordCount ||
        inventory.total !== recordCount
      ) {
        showClinicalRecoveryNotice(CLINICAL_INITIALIZATION_CHANGED_MESSAGE, 9000);
        return false;
      }
      this.pendingAdoptionRoot = root;
      this.pendingAdoptionRecordCount = recordCount;
      this.pendingAdoptionDataFingerprint = JSON.stringify(stored) ?? "undefined";
      this.pendingAdoptionInventory = inventory;
      this.pendingAdoptionRootFingerprint = fingerprint;
      return new Promise<boolean>((resolve) => {
        new InitializeWorkspaceModal(this.app, recordCount > 0, resolve).open();
      });
    })().finally(() => {
      this.firstUseInitializationPromise = null;
    });
    return this.firstUseInitializationPromise;
  }

  /**
   * Persists the one-time decision before creating any folder or note.
   * Concurrent entry points (ribbon tap plus command) share one run: both
   * awaited the same confirmation, so the second must join the first rather
   * than fail on the state the first has already consumed.
   */
  private initializeNewWorkspace(): Promise<void> {
    this.initializationCompletionPromise ??= this.doInitializeNewWorkspace().finally(() => {
      this.initializationCompletionPromise = null;
    });
    return this.initializationCompletionPromise;
  }

  private async doInitializeNewWorkspace(): Promise<void> {
    if (!this.firstUseInitializationPending) {
      throw new Error(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
    }

    // The modal may have remained open while Sync delivered old state. Never
    // reinterpret that changed vault as a new workspace.
    const verificationRevision = this.markerFreeRecoveryRevision;
    const latest = (await this.loadData()) as unknown;
    const latestSafety = this.workspaceSafetyFrom(latest);
    const latestTrustedSafety = this.isWorkspaceSafetyTrusted(
      latestSafety,
      this.settings.rootFolder
    );
    const root = this.settings.rootFolder;
    const previewInventory = this.pendingAdoptionInventory;
    const [currentInventory, currentRootFingerprint] = await Promise.all([
      this.parsedRecordInventory(root),
      rootFingerprint(root)
    ]);
    const latestAfterInventoryRead = (await this.loadData()) as unknown;
    const currentRecordCount = this.rootManagedRecordCount(root);
    if (
      latestTrustedSafety ||
      this.markerFrom(latest) ||
      this.markerFrom(latestAfterInventoryRead) ||
      this.markerFreeRecoveryRevision !== verificationRevision ||
      this.pendingAdoptionRecordCount === null ||
      previewInventory === null ||
      currentRecordCount !== this.pendingAdoptionRecordCount ||
      currentInventory.total !== currentRecordCount ||
      !sameRecordInventory(currentInventory, previewInventory) ||
      this.pendingAdoptionRoot !== root ||
      this.pendingAdoptionRootFingerprint !== currentRootFingerprint ||
      this.pendingAdoptionDataFingerprint !== (JSON.stringify(latest) ?? "undefined") ||
      this.pendingAdoptionDataFingerprint !==
        (JSON.stringify(latestAfterInventoryRead) ?? "undefined")
    ) {
      await this.loadSettings();
      this.repository.setWriteBlock(
        this.migrationRecoveryBlocked ? this.recoveryBlockMessage : null
      );
      throw new Error(CLINICAL_INITIALIZATION_CHANGED_MESSAGE);
    }

    const approvalRevision = verificationRevision;
    this.firstUseInitializationPending = false;
    this.initializationScaffoldApproved = true;
    this.workspaceInitialized = false;
    this.managedRecordsExpected = currentRecordCount > 0;
    this.expectedManagedRecordCount = currentRecordCount;
    this.expectedEntityCounts = { ...currentInventory.counts };
    this.expectedRecordDigest = currentInventory.digest;
    this.activeRootFingerprint = currentRootFingerprint;
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
      let finalInventory: RecordInventory | null = null;
      try {
        finalInventory = await this.parsedRecordInventory(root);
      } catch {
        finalInventory = null;
      }
      if (
        finalInventory === null ||
        this.externalSettingsApplyOperations > 0 ||
        this.currentMigrationMarker() ||
        this.markerFreeRecoveryRevision !== approvalRevision ||
        clinicalRootFolder() !== root ||
        this.settings.rootFolder !== root ||
        this.rootManagedRecordCount(root) !== currentRecordCount ||
        !sameRecordInventory(finalInventory, currentInventory)
      ) {
        this.setBaselineReviewBlocked(this.managedRecordsExpected);
        await this.persistPluginData().catch(() => {
          this.workspaceSafetyNeedsPersistence = true;
        });
        throw new Error(CLINICAL_INITIALIZATION_CHANGED_MESSAGE);
      }
      if (!this.commitTrustedInventoryJournal()) {
        this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
        this.repository.setWriteBlock(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
        throw new Error(CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE);
      }
      this.migrationRecoveryBlocked = false;
      this.recoveryBlockMessage = CLINICAL_WRITES_BLOCKED_MESSAGE;
      this.repository.setWriteBlock(null);
      this.pendingAdoptionRecordCount = null;
      this.pendingAdoptionRoot = null;
      this.pendingAdoptionDataFingerprint = null;
      this.pendingAdoptionInventory = null;
      this.pendingAdoptionRootFingerprint = null;
    } catch (error) {
      // A failed shared save means no approval was durable; a failed local
      // journal write after the shared save leaves the approved session
      // blocked so restart can exact-validate and seed the missing anchor.
      const approvalWasDurablySaved = this.missingRootRecoveryBlocked;
      if (!approvalWasDurablySaved) {
        this.firstUseInitializationPending = true;
        this.initializationScaffoldApproved = false;
        this.workspaceInitialized = false;
      }
      this.migrationRecoveryBlocked = true;
      this.recoveryBlockMessage = CLINICAL_INITIALIZATION_REQUIRED_MESSAGE;
      this.repository.setWriteBlock(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
      this.pendingAdoptionRecordCount = null;
      this.pendingAdoptionRoot = null;
      this.pendingAdoptionDataFingerprint = null;
      this.pendingAdoptionInventory = null;
      this.pendingAdoptionRootFingerprint = null;
      if (error instanceof Error && error.message === CLINICAL_INITIALIZATION_CHANGED_MESSAGE) {
        throw error;
      }
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
    if (this.migrationRecoveryBlocked || this.localMigrationRunning) {
      throw new Error(this.recoveryBlockMessage);
    }
    // Close repository admission before the first await, then drain writes
    // that were already accepted. They finish against the source root and are
    // included in the trusted tuple before the rename begins.
    this.localMigrationRunning = true;
    let resolveLocalMigrationCompletion!: () => void;
    const localMigrationCompletion = new Promise<void>((resolve) => {
      resolveLocalMigrationCompletion = resolve;
    });
    this.localMigrationCompletion = localMigrationCompletion;
    let localMigrationFinished = false;
    const finishLocalMigration = (): void => {
      if (localMigrationFinished) return;
      localMigrationFinished = true;
      this.localMigrationRunning = false;
      if (this.localMigrationCompletion === localMigrationCompletion) {
        this.localMigrationCompletion = null;
      }
      resolveLocalMigrationCompletion();
    };
    let releaseManagedMutationPause: (() => void) | null = null;
    try {
      const mutationPause = await this.repository.pauseManagedRecordMutations();
      releaseManagedMutationPause = mutationPause.release;
    } catch (error) {
      finishLocalMigration();
      throw error;
    }
    if (this.migrationRecoveryBlocked) {
      releaseManagedMutationPause();
      finishLocalMigration();
      throw new Error(this.recoveryBlockMessage);
    }
    const localJournal = this.readTrustedInventoryJournal();
    const journalRequired = this.currentCompleteInventory() !== null || localJournal.status !== "missing";
    const journalGeneration = journalRequired ? this.armTrustedInventoryJournal() : null;
    if (journalRequired && journalGeneration === null) {
      this.failClosedForTrustedInventoryJournal();
      releaseManagedMutationPause?.();
      finishLocalMigration();
      throw new Error(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
    }
    this.setMigrationRecoveryBlocked(true);
    const attempt: { plan?: MigrationPlan } = {};
    let recordsMoved = false;
    try {
      const result = await this.migration.run(target, async (plan) => {
        attempt.plan = plan;
        const marker = { from: plan.from, to: plan.to };
        if (!this.canRememberResolvedMigration(marker, plan.to)) {
          throw new Error(
            "Clinical Workspace has reached its retained folder-move safety limit. Resolve older retired folders before moving this workspace again."
          );
        }
        this.watchMigrationRoots(marker);
        this.settings = { ...this.settings, rootFolder: plan.to };
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.pendingMigrationConfiguredRoot = plan.to;
        await this.persistPluginData();
        setClinicalRoot(plan.to);
      });
      const finalDeliveryRevision = this.markerFreeRecoveryRevision;
      const sourceStayedRetired = (): boolean =>
        !this.rootExists(result.from) && this.rootManagedRecordCount(result.from) === 0;
      recordsMoved = true;
      if (!await this.rememberResolvedMigration(
        { from: result.from, to: result.to },
        result.to,
        () =>
          this.markerFreeRecoveryRevision === finalDeliveryRevision &&
          sourceStayedRetired()
      )) {
        throw new Error(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
      }
      // `MigrationService.run` never throws after the rename succeeds. Reaching
      // here therefore proves the destination holds the moved records and the
      // recovery marker can be retired.
      if (!sourceStayedRetired()) {
        throw new Error(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
      }
      this.pendingMigrationMarker = null;
      this.pendingMigrationConfiguredRoot = null;
      await this.persistPluginData();
      if (
        this.markerFreeRecoveryRevision !== finalDeliveryRevision ||
        !sourceStayedRetired()
      ) {
        throw new Error(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
      }
      if (
        journalGeneration !== null &&
        this.currentCompleteInventory() &&
        !await this.commitTrustedInventoryJournalForExactRoot(
          this.settings.rootFolder,
          journalGeneration
        )
      ) {
        throw new Error(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
      }
      if (
        this.markerFreeRecoveryRevision !== finalDeliveryRevision ||
        !sourceStayedRetired()
      ) {
        throw new Error(CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE);
      }
      this.setMigrationRecoveryBlocked(false);
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
        const restorationRevision = this.markerFreeRecoveryRevision;
        const restoredJournal = journalGeneration === null || !this.currentCompleteInventory()
          ? true
          : await this.commitTrustedInventoryJournalForExactRoot(
              clinicalRootFolder(),
              journalGeneration
            );
        if (
          restoredJournal &&
          this.markerFreeRecoveryRevision === restorationRevision
        ) {
          this.setMigrationRecoveryBlocked(false);
        } else if (this.markerFreeRecoveryRevision !== restorationRevision) {
          this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
          try {
            await this.persistWorkspaceSafety();
          } catch {
            this.workspaceSafetyNeedsPersistence = true;
          }
        } else {
          this.failClosedForTrustedInventoryJournal();
        }
      }
      throw error;
    } finally {
      releaseManagedMutationPause?.();
      finishLocalMigration();
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
    if (this.retiredRootFolders.size > 0) {
      data.retiredRootFolders = [...this.retiredRootFolders].sort();
    }
    if (this.whatsNewVersion) data.whatsNewVersion = this.whatsNewVersion;
    return data;
  }

  /**
   * Shows the what's-new window once after an update — at layout-ready on
   * the first load of the new version, with the workspace-open path kept as
   * a fallback. The shown-for version travels in data.json, so a device that
   * has seen it spares the user's other devices after Sync.
   */
  private async maybeShowWhatsNew(): Promise<void> {
    if (this.whatsNewShownThisSession) return;
    const currentVersion = this.manifest.version;
    if (!shouldShowWhatsNew(this.whatsNewVersion, currentVersion, this.workspaceInitialized)) {
      if (this.whatsNewVersion !== currentVersion) {
        this.whatsNewVersion = currentVersion;
        await this.persistPluginData().catch(() => undefined);
      }
      return;
    }
    this.whatsNewShownThisSession = true;
    this.whatsNewVersion = currentVersion;
    await this.persistPluginData().catch(() => undefined);
    new WhatsNewModal(
      this.app,
      currentVersion,
      WHATS_NEW_HIGHLIGHTS,
      `https://github.com/drbinsaad/obsidian-clinical-workspace/releases/tag/${currentVersion}`
    ).open();
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
    options: {
      allowSourceRollback?: boolean;
      externalSettingsEpoch?: number;
    } = {}
  ): Promise<boolean> {
    const marker = this.markerFrom(stored) ?? this.currentMigrationMarker();
    if (!marker) return true;
    this.watchMigrationRoots(marker);
    const deliveryRevision = this.markerFreeRecoveryRevision;
    const managedDeliveryChanged = (): boolean =>
      this.markerFreeRecoveryRevision !== deliveryRevision;
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

    let winningInventory: RecordInventory | null = null;
    // Same number of files is not the same records. Verify the winning root
    // against the parsed-record commitment before the barrier is lifted.
    if (actual) {
      const verification = await this.verifyRecordInventory(actual);
      if (
        options.externalSettingsEpoch !== undefined &&
        options.externalSettingsEpoch !== this.externalSettingsEpoch
      ) {
        return false;
      }
      if (managedDeliveryChanged()) return false;
      winningInventory = verification.inventory;
      if (
        !verification.ok &&
        !this.inventoryHasNoExpectedCountRegression(verification.inventory)
      ) {
        if (actual === marker.from) {
          this.settings = { ...this.settings, rootFolder: marker.from };
          setClinicalRoot(marker.from);
        }
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.setMigrationRecoveryBlocked(true);
        return false;
      }
      if (!this.inventoryExactlyMatchesExpected(actual, verification.inventory)) {
        // Path convergence and record-set trust are separate decisions. Point
        // reads at the only complete physical root, but keep every write closed
        // until a fresh typed baseline confirmation proves the intended set.
        this.setBaselineReviewBlocked(this.managedRecordsExpected);
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
    const candidateRoot = actual ?? (
      configuredRoot === marker.to && this.rootExists(marker.to) && !this.rootExists(marker.from)
        ? marker.to
        : marker.from
    );
    // A record-free workspace whose stored settings still name the
    // destination is the marker-before-folder Sync state, not a failed local
    // move: the folder rename may simply not have arrived yet. Settling at
    // the source here would clear the marker, scaffold a fresh source tree,
    // and greet the late-arriving destination as a permanent duplicate. Only
    // an explicit user retry may roll a destination-configured state back.
    if (
      !actual &&
      candidateRoot === marker.from &&
      configuredRoot !== marker.from &&
      !options.allowSourceRollback
    ) {
      this.settings = { ...this.settings, rootFolder: marker.from };
      setClinicalRoot(marker.from);
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }
    if (managedDeliveryChanged()) return false;
    const resolvedRoot = candidateRoot;
    const losingRoot = resolvedRoot === marker.from ? marker.to : marker.from;
    const losingRootIsAbsent = (): boolean =>
      !this.rootExists(losingRoot) && this.rootManagedRecordCount(losingRoot) === 0;
    if (
      !losingRootIsAbsent() ||
      !this.canRememberResolvedMigration(marker, resolvedRoot)
    ) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }

    if (!await this.rememberResolvedMigration(
      marker,
      resolvedRoot,
      () =>
        (
          options.externalSettingsEpoch === undefined ||
          options.externalSettingsEpoch === this.externalSettingsEpoch
        ) &&
        !managedDeliveryChanged() &&
        losingRootIsAbsent()
    )) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }
    if (
      options.externalSettingsEpoch !== undefined &&
      options.externalSettingsEpoch !== this.externalSettingsEpoch
    ) return false;
    if (managedDeliveryChanged()) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.setMigrationRecoveryBlocked(true);
      return false;
    }
    this.settings = { ...this.settings, rootFolder: resolvedRoot };
    setClinicalRoot(resolvedRoot);
    let upgradedLegacyInventory = false;
    if (!this.currentCompleteInventory()) {
      // Selecting the only complete physical root is safe, but legacy
      // count-only metadata cannot authorize writes. Persist a marker-free
      // exact-validation barrier; the user's explicit Retry then parses and
      // atomically upgrades the tuple and device journal.
      this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
      if (options.allowSourceRollback && !this.firstUseInitializationPending) {
        if (!winningInventory && this.rootExists(resolvedRoot)) {
          try {
            winningInventory = await this.parsedRecordInventory(resolvedRoot);
          } catch {
            winningInventory = null;
          }
        }
        const rawCount = this.rootManagedRecordCount(resolvedRoot);
        if (
          !winningInventory ||
          winningInventory.total !== rawCount ||
          rawCount !== this.expectedManagedRecordCount
        ) {
          this.setBaselineReviewBlocked(
            this.managedRecordsExpected || rawCount > 0
          );
          return false;
        }
        if (this.armTrustedInventoryJournal() === null) {
          this.failClosedForTrustedInventoryJournal();
          return false;
        }
        this.expectedEntityCounts = { ...winningInventory.counts };
        this.expectedRecordDigest = winningInventory.digest;
        this.expectedManagedRecordCount = winningInventory.total;
        this.managedRecordsExpected ||= winningInventory.total > 0;
        // The marker remains the live in-memory barrier. Save the complete
        // tuple with the durable validation sentinel; the pending local journal
        // still protects a crash before the final exact commit.
        this.missingRootRecoveryBlocked = false;
        this.missingRootRequiresRecords = false;
        upgradedLegacyInventory = true;
      }
    }
    const nextRetiredRoot = this.retiredRootConflict(resolvedRoot);
    if (nextRetiredRoot) {
      // Tombstones are monotonic, so settling one migration cannot reopen while
      // a different retired root is also present. Persist the next explicit
      // recovery edge and remain read-only.
      const nextMarker = { from: nextRetiredRoot, to: resolvedRoot };
      this.watchMigrationRoots(nextMarker);
      this.pendingMigrationMarker = { migrationInProgress: nextMarker };
      this.pendingMigrationConfiguredRoot = resolvedRoot;
      this.structureReady = false;
      this.setMigrationRecoveryBlocked(true);
      await this.persistPluginData();
      return false;
    }
    this.pendingMigrationMarker = null;
    this.pendingMigrationConfiguredRoot = null;
    this.structureReady = false;
    // Clearing the marker is a durable recovery commit. Keep both write
    // barriers armed until that marker-free snapshot has actually reached
    // data.json; otherwise a failed save creates a writable, non-retryable gap.
    try {
      await this.persistPluginData();
    } catch (error) {
      if (
        options.externalSettingsEpoch !== undefined &&
        options.externalSettingsEpoch !== this.externalSettingsEpoch
      ) {
        // A newer callback owns the path state and its queued save now.
        return false;
      }
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.pendingMigrationConfiguredRoot = configuredRoot;
      this.setMigrationRecoveryBlocked(true, this.recoveryBlockMessage);
      throw error;
    }
    if (
      options.externalSettingsEpoch !== undefined &&
      options.externalSettingsEpoch !== this.externalSettingsEpoch
    ) {
      // A newer settings delivery owns the shared marker/root state now. Its
      // canonical save is queued after this one, so leave that state untouched
      // and never report the older reconciliation as successful.
      return false;
    }
    if (managedDeliveryChanged() || !losingRootIsAbsent()) {
      this.pendingMigrationMarker = { migrationInProgress: marker };
      this.pendingMigrationConfiguredRoot = configuredRoot;
      this.setMigrationRecoveryBlocked(true, this.recoveryBlockMessage);
      try {
        await this.persistPluginData();
      } catch {
        this.workspaceSafetyNeedsPersistence = true;
      }
      return false;
    }
    if (this.armRetiredRootConflictIfPresent()) {
      // A different retired root may have arrived while the marker-clear save
      // was suspended. Make that conflict durable before any journal commit.
      try {
        await this.persistPluginData();
      } catch {
        this.workspaceSafetyNeedsPersistence = true;
      }
      return false;
    }
    if (!this.baselineReviewRequired && this.currentCompleteInventory()) {
      const localJournal = this.readTrustedInventoryJournal();
      const expectedGeneration =
        localJournal.status === "valid" && localJournal.journal.pending
          ? localJournal.journal.generation
          : undefined;
      const journalCommitted = await this.commitTrustedInventoryJournalForExactRoot(
        resolvedRoot,
        expectedGeneration
      );
      if (
        options.externalSettingsEpoch !== undefined &&
        options.externalSettingsEpoch !== this.externalSettingsEpoch
      ) return false;
      if (managedDeliveryChanged() || !losingRootIsAbsent()) {
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.pendingMigrationConfiguredRoot = configuredRoot;
        this.setMigrationRecoveryBlocked(true, this.recoveryBlockMessage);
        try {
          await this.persistPluginData();
        } catch {
          this.workspaceSafetyNeedsPersistence = true;
        }
        return false;
      }
      if (!journalCommitted) {
        this.failClosedForTrustedInventoryJournal();
        this.pendingMigrationMarker = { migrationInProgress: marker };
        this.pendingMigrationConfiguredRoot = configuredRoot;
        this.setMigrationRecoveryBlocked(true, this.recoveryBlockMessage);
        try {
          await this.persistPluginData();
        } catch {
          this.workspaceSafetyNeedsPersistence = true;
        }
        return false;
      }
    }
    if (upgradedLegacyInventory) {
      this.missingRootRecoveryBlocked = false;
      this.missingRootRequiresRecords = false;
    }
    this.setMigrationRecoveryBlocked(false);
    if (this.baselineReviewRequired) {
      this.showMigrationRecoveryNotice(
        12000,
        CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
      );
    } else {
      new Notice("Clinical Workspace recovered the interrupted folder move.", 12000);
    }
    return true;
  }

  /**
   * User-initiated retry after Sync reports completion. It may confirm a
   * source-only rollback, but still refuses to choose between two populated
   * roots. The settings UI/command can call this without exposing paths.
   */
  async retryPendingMigrationRecovery(): Promise<boolean> {
    const recoveryEpoch = this.externalSettingsEpoch;
    const marker = this.currentMigrationMarker();
    if (!marker) {
      const wasMissingRootBlocked = this.missingRootRecoveryBlocked;
      let operationRecovered = false;
      const recovered = await this.enqueueMarkerFreeRecovery(async () => {
        operationRecovered = await this.retryMissingRootRecoveryExplicitly();
        return operationRecovered;
      });
      if (wasMissingRootBlocked && recovered) {
        new Notice("Clinical Workspace folder access was restored.", 7000);
      } else if (wasMissingRootBlocked && operationRecovered) {
        // The scan itself succeeded, but a final Sync delivery invalidated its
        // release before the serialized guard opened. Replace a premature
        // success toast with honest recovery guidance.
        this.showMigrationRecoveryNotice();
      }
      return recovered;
    }
    const configuredRoot = this.pendingMigrationConfiguredRoot ?? this.settings.rootFolder;
    const settled = await this.reconcileMigration(
      { ...this.settings, rootFolder: configuredRoot, migrationInProgress: marker },
      { allowSourceRollback: true, externalSettingsEpoch: recoveryEpoch }
    );
    if (recoveryEpoch !== this.externalSettingsEpoch) return false;
    if (!settled || this.baselineReviewRequired) this.showMigrationRecoveryNotice();
    if (settled) await this.refreshOpenViews();
    return settled && !this.baselineReviewRequired;
  }

  /** User retry accepts only the exact trusted set; changed/grown sets need typed ADOPT. */
  private async retryMissingRootRecoveryExplicitly(): Promise<boolean> {
    if (this.baselineReviewRequired) {
      this.showMigrationRecoveryNotice(
        12000,
        CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
      );
      return false;
    }
    if (this.externalSettingsApplyOperations > 0) {
      this.showMigrationRecoveryNotice();
      return false;
    }
    const root = clinicalRootFolder();
    const fingerprint = await rootFingerprint(root);
    if (
      clinicalRootFolder() !== root ||
      this.externalSettingsApplyOperations > 0 ||
      this.firstUseInitializationPending ||
      this.currentMigrationMarker()
    ) {
      this.showMigrationRecoveryNotice();
      return false;
    }
    this.activeRootFingerprint = fingerprint;
    if (!this.missingRootRecoveryBlocked) {
      if (
        this.migrationRecoveryBlocked &&
        this.recoveryValidationRequired &&
        !this.firstUseInitializationPending &&
        !this.currentMigrationMarker()
      ) {
        this.requestMarkerFreeRecoveryRelease();
        return true;
      }
      return !this.migrationRecoveryBlocked;
    }
    if (this.firstUseInitializationPending || this.currentMigrationMarker()) {
      this.showMigrationRecoveryNotice();
      return false;
    }

    const requiresRecords = this.missingRootRequiresRecords;
    const expectedCount = this.expectedManagedRecordCount;
    const expectedDigest = this.expectedRecordDigest;
    const expectedCounts = this.expectedEntityCounts
      ? { ...this.expectedEntityCounts }
      : null;
    const recoveryRevision = this.markerFreeRecoveryRevision;
    const contextUnchanged = (): boolean =>
      !this.firstUseInitializationPending &&
      !this.currentMigrationMarker() &&
      clinicalRootFolder() === root &&
      this.expectedManagedRecordCount === expectedCount &&
      this.expectedRecordDigest === expectedDigest &&
      (
        expectedCounts === null
          ? this.expectedEntityCounts === null
          : this.expectedEntityCounts !== null &&
            ENTITY_FOLDER_NAMES.every(
              ([entity]) => this.expectedEntityCounts?.[entity] === expectedCounts[entity]
            )
      );

    // This is intentionally user-confirmed rather than automatic: Sync can
    // create the parent folder before delivering its child records.
    if (
      !this.rootExists(root) ||
      (requiresRecords && this.rootManagedRecordCount(root) < Math.max(1, expectedCount))
    ) {
      this.showMigrationRecoveryNotice();
      return false;
    }

    let verified: Awaited<ReturnType<ClinicalWorkspacePlugin["verifyRecordInventory"]>>;
    try {
      verified = await this.verifyRecordInventory(root);
    } catch {
      this.showMigrationRecoveryNotice();
      return false;
    }
    if (
      !this.missingRootRecoveryBlocked ||
      this.missingRootRequiresRecords !== requiresRecords ||
      this.markerFreeRecoveryRevision !== recoveryRevision ||
      !contextUnchanged()
    ) {
      this.showMigrationRecoveryNotice(
        12000,
        verified.reason ?? this.recoveryBlockMessage
      );
      return false;
    }
    if (
      !verified.ok &&
      !this.inventoryHasNoExpectedCountRegression(verified.inventory)
    ) {
      this.showMigrationRecoveryNotice(
        12000,
        verified.reason ?? this.recoveryBlockMessage
      );
      return false;
    }
    if (verified.inventory.total !== this.rootManagedRecordCount(root)) {
      showClinicalRecoveryNotice(
        "The managed record folders contain Markdown that is not a valid Clinical Workspace record. Move or repair those files, then retry; the recovery baseline was not changed.",
        12000
      );
      return false;
    }
    if (!this.inventoryExactlyMatchesExpected(root, verified.inventory)) {
      this.setBaselineReviewBlocked(requiresRecords || verified.inventory.total > 0);
      await this.persistWorkspaceSafety();
      this.showMigrationRecoveryNotice(
        12000,
        CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
      );
      return false;
    }

    // Commit the exact user-accepted snapshot. The durable validation flag is
    // deliberately retained: if a dirty-pass re-arm cannot be saved, restart
    // still compares this commitment before enabling writes.
    const acceptedInventory = verified.inventory;
    const acceptedRawCount = this.rootManagedRecordCount(root);
    if (acceptedInventory.total !== acceptedRawCount) {
      showClinicalRecoveryNotice(
        "The managed record folders contain Markdown that is not a valid Clinical Workspace record. Move or repair those files, then retry; the recovery baseline was not changed.",
        12000
      );
      return false;
    }
    this.expectedEntityCounts = { ...acceptedInventory.counts };
    this.expectedRecordDigest = acceptedInventory.digest;
    this.expectedManagedRecordCount = acceptedRawCount;
    this.managedRecordsExpected ||= acceptedInventory.total > 0;
    this.recoveryValidationRequired = true;
    this.missingRootRecoveryBlocked = false;
    this.missingRootRequiresRecords = false;
    this.structureReady = false;
    // Keep the global flag and repository barrier armed until both the clear
    // save and a post-save exact scan have completed.
    this.repository?.setWriteBlock(this.recoveryBlockMessage);
    try {
      await this.persistPluginData();
    } catch {
      this.workspaceSafetyNeedsPersistence = true;
      this.setMissingRootRecoveryBlocked(requiresRecords);
      this.showMigrationRecoveryNotice();
      return false;
    }

    let finalInventory: RecordInventory | null = null;
    try {
      finalInventory = await this.parsedRecordInventory(root);
    } catch {
      finalInventory = null;
    }
    const finalMatches =
      this.markerFreeRecoveryRevision === recoveryRevision &&
      finalInventory !== null &&
      !this.missingRootRecoveryBlocked &&
      !this.firstUseInitializationPending &&
      !this.currentMigrationMarker() &&
      clinicalRootFolder() === root &&
      this.rootManagedRecordCount(root) === acceptedRawCount &&
      finalInventory.total === acceptedInventory.total &&
      finalInventory.digest === acceptedInventory.digest &&
      ENTITY_FOLDER_NAMES.every(
        ([entity]) => finalInventory?.counts[entity] === acceptedInventory.counts[entity]
      );
    if (!finalMatches) {
      this.setMissingRootRecoveryBlocked(requiresRecords);
      try {
        await this.persistPluginData();
      } catch {
        this.workspaceSafetyNeedsPersistence = true;
      }
      this.showMigrationRecoveryNotice();
      return false;
    }

    this.requestMarkerFreeRecoveryRelease();
    void this.refreshOpenViews().catch(() => undefined);
    return true;
  }

  /** Automatic retries stay conservative: source-only is still in flight. */
  private async retryMigrationReconciliation(): Promise<boolean> {
    if (this.firstUseInitializationPending) return false;
    if (this.migrationReconciliationPromise) return this.migrationReconciliationPromise;
    const marker = this.currentMigrationMarker();
    if (!marker) return true;
    const recoveryEpoch = this.externalSettingsEpoch;
    const configuredRoot = this.pendingMigrationConfiguredRoot ?? this.settings.rootFolder;
    this.migrationReconciliationPromise = this.reconcileMigration({
      ...this.settings,
      rootFolder: configuredRoot,
      migrationInProgress: marker
    }, { externalSettingsEpoch: recoveryEpoch }).finally(() => {
      this.migrationReconciliationPromise = null;
    });
    const settled = await this.migrationReconciliationPromise;
    if (recoveryEpoch !== this.externalSettingsEpoch) return false;
    if (settled) await this.refreshOpenViews();
    return settled && !this.baselineReviewRequired;
  }

  /**
   * Folders and database views are created the first time the user actually
   * opens the workspace, not on load. A plugin that writes into a vault before
   * the user has asked it to do anything is both surprising and contrary to
   * Obsidian's community plugin guidelines.
   */
  private async ensureStructure(): Promise<void> {
    if (this.missingRootRecoveryBlocked) {
      await this.retryExactRestoredRootRecovery();
    }
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
      this.observeManagedRecordDelivery(file.path);
      this.retryMigrationForPath(file.path);
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.repository.invalidatePath(file.path);
      this.observeManagedRecordDelivery(file.path);
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
    if (oldPath !== file.path) this.observeManagedRecordDelivery(oldPath);
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
    const activeRoot = clinicalRootFolder();
    const managedRecordRoot = this.managedRecordRootForPath(path);
    const deliveredRoot = managedRecordRoot ?? this.retiredRootForPath(path);
    if (!deliveredRoot) return;
    if (
      managedRecordRoot !== null &&
      this.repository.isManagedRecordMutationInProgress(path)
    ) {
      // Vault events have no actor metadata. Keep the event untrusted until
      // the repository's fresh readback proves that the same record identity
      // survived the claimed plugin-owned mutation.
      this.repository.noteManagedRecordMutationEvent(path);
      return;
    }
    // Every delivery not owned by an active repository claim invalidates any
    // trust-advancing async scan, including one already running behind a
    // recovery barrier. Claimed events are provisional: their fresh readback
    // either confirms the plugin write or the observer increments this
    // revision when it consumes the event as external.
    this.markerFreeRecoveryRevision += 1;
    if (this.armTrustedInventoryJournal() === null) {
      this.failClosedForTrustedInventoryJournal();
      return;
    }
    if (deliveredRoot !== activeRoot && !this.currentMigrationMarker()) {
      // A record delivered into a root retired earlier in this session is a
      // split migration, not an unrelated Markdown file. Reconstruct the move
      // marker so exact recovery must account for both roots.
      const inferred = { from: deliveredRoot, to: activeRoot };
      this.watchMigrationRoots(inferred);
      this.pendingMigrationMarker = { migrationInProgress: inferred };
      this.pendingMigrationConfiguredRoot = activeRoot;
      this.setMigrationRecoveryBlocked(true);
      void this.persistPluginData();
      return;
    }
    // An existing recovery owns its retry path, but the new journal generation
    // and revision still make its in-flight exact scan fail. An unblocked
    // workspace additionally needs the shared missing-root sentinel.
    if (this.migrationRecoveryBlocked) return;
    // A vault event does not reveal whether it came from Sync or another
    // plugin. Preserve the local tuple, persist a barrier, and let an exact
    // rescan clear benign edits. Growth/replacement requires typed ADOPT.
    this.setMissingRootRecoveryBlocked(this.managedRecordsExpected);
    void this.persistWorkspaceSafety();
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
    this.watchMigrationRoots(marker);
    this.pendingMigrationMarker = { migrationInProgress: marker };
    this.pendingMigrationConfiguredRoot = marker.to;
    this.setMigrationRecoveryBlocked(true);
    if (this.firstUseInitializationPending) {
      showClinicalRecoveryNotice(
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

  private async persistWorkspaceSafety(throwOnFailure = false): Promise<void> {
    this.workspaceSafetyNeedsPersistence = true;
    const revision = ++this.workspaceSafetyRevision;
    try {
      await this.persistPluginData();
      if (this.workspaceSafetyRevision === revision) {
        this.workspaceSafetyNeedsPersistence = false;
      }
      if (
        !this.migrationRecoveryBlocked &&
        !this.missingRootRecoveryBlocked &&
        !this.baselineReviewRequired &&
        !this.firstUseInitializationPending &&
        !this.currentMigrationMarker() &&
        this.currentCompleteInventory() &&
        !this.commitTrustedInventoryJournal()
      ) {
        this.failClosedForTrustedInventoryJournal();
        let recoveryBarrierPersisted = true;
        try {
          await this.persistPluginData();
        } catch {
          recoveryBarrierPersisted = false;
          this.workspaceSafetyNeedsPersistence = true;
        }
        if (throwOnFailure) {
          throw new Error(
            recoveryBarrierPersisted
              ? "Clinical Workspace could not commit its trusted record inventory."
              : "Clinical Workspace could not persist its trusted record recovery barrier."
          );
        }
      }
    } catch (error) {
      this.workspaceSafetyNeedsPersistence = true;
      showClinicalRecoveryNotice(
        "Clinical Workspace could not save its folder-recovery state. Keep the plugin open and do not edit records.",
        12000
      );
      if (throwOnFailure) throw error;
    }
  }

  private retryMigrationForPath(path: string): void {
    if (this.localMigrationRunning || this.firstUseInitializationPending) return;
    const marker = this.currentMigrationMarker();
    const touches = (root: string) => path === root || path.startsWith(`${root}/`);
    if (!marker) {
      if (
        (this.missingRootRecoveryBlocked || this.markerFreeRecoveryOperations > 0) &&
        touches(clinicalRootFolder())
      ) {
        this.markerFreeRecoveryRevision += 1;
        void this.retryExactRestoredRootRecovery();
      }
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
        // A concurrent entry point may have already consumed this approval.
        // Join its in-flight run instead of starting a second one.
        if (this.firstUseInitializationPending || this.initializationCompletionPromise) {
          await this.initializeNewWorkspace();
        }
      }
      await this.activateWorkspace();
    } catch (error) {
      this.showUserFacingNotice(
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
    if (this.missingRootRecoveryBlocked) {
      await this.retryExactRestoredRootRecovery();
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
    await this.maybeShowWhatsNew();
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
        // Same join-don't-duplicate rule as openWorkspace.
        if (this.firstUseInitializationPending || this.initializationCompletionPromise) {
          await this.initializeNewWorkspace();
        }
      }
      const view = await this.activateWorkspace();
      await action(view);
    } catch (error) {
      this.showUserFacingNotice(
        error instanceof Error ? error.message : fallbackMessage,
        7000
      );
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
      this.showUserFacingNotice(
        error instanceof Error ? error.message : "Integrity check failed.",
        7000
      );
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
      this.showMigrationRecoveryNotice(9000, CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
      return;
    }
    if (this.currentMigrationMarker()) {
      showClinicalRecoveryNotice(
        "A folder move is still pending. Resolve it with the pending folder move recovery command before adopting a new baseline.",
        9000
      );
      return;
    }
    const root = clinicalRootFolder();
    if (!this.rootExists(root)) {
      showClinicalRecoveryNotice(
        "The configured clinical folder does not exist, so there is nothing to adopt.",
        9000
      );
      return;
    }
    let candidate: BaselineAdoptionCandidate | null;
    try {
      candidate = await this.captureBaselineAdoptionCandidate(root);
    } catch {
      showClinicalRecoveryNotice(
        "The current records could not be verified, so the baseline confirmation was not opened.",
        9000
      );
      return;
    }
    if (!candidate) {
      showClinicalRecoveryNotice(
        "Clinical Workspace records changed while the baseline preview was prepared. Review the current records and try again.",
        9000
      );
      return;
    }
    const inventory = candidate.inventory;
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
        void this.confirmCurrentBaselineAdoption(root, candidate)
          .then((adopted) => {
            if (adopted) new Notice("The current records are now the recovery baseline.", 7000);
          })
          .catch((error) => {
            showClinicalNotice(
              error instanceof Error ? error.message : "The baseline could not be adopted.",
              9000
            );
          });
      }
    }).open();
  }

  /** Freeze the exact record set represented by a typed confirmation modal. */
  private async captureBaselineAdoptionCandidate(
    root: string
  ): Promise<BaselineAdoptionCandidate | null> {
    if (this.externalSettingsApplyOperations > 0) return null;
    const recoveryRevision = this.markerFreeRecoveryRevision;
    const expectedCountAtPreview = this.expectedManagedRecordCount;
    const rawCountBefore = this.rootManagedRecordCount(root);
    const inventory = await this.parsedRecordInventory(root);
    const rawCountAfter = this.rootManagedRecordCount(root);
    if (
      this.firstUseInitializationPending ||
      this.externalSettingsApplyOperations > 0 ||
      this.currentMigrationMarker() ||
      clinicalRootFolder() !== root ||
      !this.rootExists(root) ||
      this.markerFreeRecoveryRevision !== recoveryRevision ||
      this.expectedManagedRecordCount !== expectedCountAtPreview ||
      rawCountBefore !== rawCountAfter
    ) {
      return null;
    }
    return {
      root,
      rawCount: rawCountAfter,
      expectedCountAtPreview,
      recoveryRevision,
      inventory: {
        counts: { ...inventory.counts },
        digest: inventory.digest,
        total: inventory.total
      }
    };
  }

  /** Serialize the typed confirmation with every other marker-free recovery. */
  private async confirmCurrentBaselineAdoption(
    root: string,
    preview?: BaselineAdoptionCandidate
  ): Promise<boolean> {
    let candidate = preview;
    if (!candidate) {
      try {
        candidate = await this.captureBaselineAdoptionCandidate(root) ?? undefined;
      } catch {
        candidate = undefined;
      }
    }
    if (!candidate) {
      showClinicalRecoveryNotice(
        "Clinical Workspace records changed before they could be verified. Review the current records and confirm the baseline again.",
        9000
      );
      return false;
    }
    let deferredFailure: { message: string; duration: number } | null = null;
    let operationAdopted = false;
    const adopted = await this.enqueueMarkerFreeRecovery(async () => {
      operationAdopted = await this.commitCurrentBaselineAdoption(
        candidate,
        (message, duration) => {
          deferredFailure = { message, duration };
        }
      );
      return operationAdopted;
    });
    // A healthy workspace is temporarily guarded while its new baseline is
    // scanned and saved. Present failures only after the queue finalizer has
    // released that guard, otherwise setMigrationRecoveryBlocked(false) would
    // immediately hide the actionable notice.
    if (!adopted && deferredFailure) {
      const failure: { message: string; duration: number } = deferredFailure;
      showClinicalRecoveryNotice(failure.message, failure.duration);
    } else if (!adopted && operationAdopted) {
      // The candidate committed, but a last-moment Sync delivery invalidated
      // the queue release. Do not report success while the follow-up exact
      // pass is deciding whether the new on-disk state is complete.
      this.showMigrationRecoveryNotice();
    }
    return adopted;
  }

  /** Persist and revalidate the confirmed snapshot before either barrier opens. */
  private async commitCurrentBaselineAdoption(
    candidate: BaselineAdoptionCandidate,
    deferFailure: (message: string, duration: number) => void
  ): Promise<boolean> {
    const { root } = candidate;
    if (
      this.firstUseInitializationPending ||
      this.externalSettingsApplyOperations > 0 ||
      this.currentMigrationMarker() ||
      clinicalRootFolder() !== root ||
      !this.rootExists(root) ||
      this.expectedManagedRecordCount !== candidate.expectedCountAtPreview
    ) {
      showClinicalRecoveryNotice(
        "Clinical Workspace state changed while the confirmation was open. The baseline was not adopted; resolve the pending recovery first.",
        9000
      );
      return false;
    }
    const adoptedRootFingerprint = await rootFingerprint(root);
    if (
      this.firstUseInitializationPending ||
      this.externalSettingsApplyOperations > 0 ||
      this.currentMigrationMarker() ||
      clinicalRootFolder() !== root ||
      !this.rootExists(root) ||
      this.expectedManagedRecordCount !== candidate.expectedCountAtPreview
    ) {
      showClinicalRecoveryNotice(
        "Clinical Workspace state changed while the confirmation was open. The baseline was not adopted; resolve the pending recovery first.",
        9000
      );
      return false;
    }

    const wasMissingRootBlocked = this.missingRootRecoveryBlocked;
    const wasBaselineReviewRequired = this.baselineReviewRequired;
    const requiresRecords = this.missingRootRequiresRecords || this.managedRecordsExpected;
    // Baseline adoption itself changes the trusted safety state. Block all
    // record writes for its scan/save/rescan window, even when it began from a
    // healthy workspace.
    this.setMigrationRecoveryBlocked(
      true,
      wasBaselineReviewRequired
        ? CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE
        : CLINICAL_INITIALIZATION_REQUIRED_MESSAGE
    );
    const recoveryRevision = this.markerFreeRecoveryRevision;

    let acceptedInventory: RecordInventory;
    try {
      acceptedInventory = await this.parsedRecordInventory(root);
    } catch {
      const message = "The current records could not be verified, so the baseline was not changed.";
      if (!wasMissingRootBlocked) {
        this.requestMarkerFreeRecoveryRelease();
        deferFailure(message, 9000);
      } else {
        showClinicalRecoveryNotice(message, 9000);
      }
      return false;
    }
    if (
      this.firstUseInitializationPending ||
      this.externalSettingsApplyOperations > 0 ||
      this.currentMigrationMarker() ||
      clinicalRootFolder() !== root ||
      !this.rootExists(root) ||
      this.markerFreeRecoveryRevision !== recoveryRevision
    ) {
      if (!this.firstUseInitializationPending && !this.currentMigrationMarker()) {
        this.setMissingRootRecoveryBlocked(requiresRecords);
      }
      showClinicalRecoveryNotice(
        "Clinical Workspace state changed while the confirmation was open. The baseline was not adopted; resolve the pending recovery first.",
        9000
      );
      return false;
    }

    const acceptedRawCount = this.rootManagedRecordCount(root);
    const previewMatches =
      candidate.recoveryRevision === recoveryRevision &&
      candidate.rawCount === acceptedRawCount &&
      candidate.inventory.total === acceptedInventory.total &&
      candidate.inventory.digest === acceptedInventory.digest &&
      ENTITY_FOLDER_NAMES.every(
        ([entity]) => candidate.inventory.counts[entity] === acceptedInventory.counts[entity]
      );
    if (!previewMatches) {
      // Preserve the prior commitment. Any delivery after the preview—loss,
      // replacement, or growth—requires a fresh typed confirmation instead of
      // silently changing what the user's ADOPT decision meant.
      this.setMissingRootRecoveryBlocked(
        requiresRecords || candidate.inventory.total > 0
      );
      await this.persistWorkspaceSafety();
      if (!this.workspaceSafetyNeedsPersistence) {
        showClinicalRecoveryNotice(
          "Clinical Workspace records changed after the baseline confirmation was shown. The previous baseline remains trusted; review the current records and confirm again.",
          12000
        );
      }
      return false;
    }
    if (acceptedInventory.total !== acceptedRawCount) {
      const message = "The managed record folders contain Markdown that is not a valid Clinical Workspace record. Move or repair those files, then retry; the baseline was not changed.";
      if (!wasMissingRootBlocked) {
        this.requestMarkerFreeRecoveryRelease();
        deferFailure(message, 12000);
      } else {
        showClinicalRecoveryNotice(message, 12000);
      }
      return false;
    }
    this.expectedEntityCounts = { ...acceptedInventory.counts };
    this.expectedRecordDigest = acceptedInventory.digest;
    this.expectedManagedRecordCount = acceptedRawCount;
    this.managedRecordsExpected = acceptedInventory.total > 0;
    this.recoveryValidationRequired = true;
    // Typed ADOPT is the only sanctioned exit from a synced commitment
    // conflict. Clear the durable review sentinel in the same queued snapshot
    // as the newly accepted tuple.
    this.baselineReviewRequired = false;
    this.missingRootRecoveryBlocked = false;
    this.missingRootRequiresRecords = false;
    this.structureReady = false;
    this.repository?.setWriteBlock(CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
    try {
      await this.persistPluginData();
    } catch {
      this.workspaceSafetyNeedsPersistence = true;
      this.baselineReviewRequired ||= wasBaselineReviewRequired;
      this.setMissingRootRecoveryBlocked(requiresRecords || acceptedInventory.total > 0);
      this.showMigrationRecoveryNotice();
      return false;
    }

    let finalInventory: RecordInventory | null = null;
    try {
      finalInventory = await this.parsedRecordInventory(root);
    } catch {
      finalInventory = null;
    }
    const finalMatches =
      this.markerFreeRecoveryRevision === recoveryRevision &&
      finalInventory !== null &&
      !this.firstUseInitializationPending &&
      this.externalSettingsApplyOperations === 0 &&
      !this.baselineReviewRequired &&
      !this.currentMigrationMarker() &&
      clinicalRootFolder() === root &&
      this.rootManagedRecordCount(root) === acceptedRawCount &&
      finalInventory.total === acceptedInventory.total &&
      finalInventory.digest === acceptedInventory.digest &&
      ENTITY_FOLDER_NAMES.every(
        ([entity]) => finalInventory?.counts[entity] === acceptedInventory.counts[entity]
      );
    if (!finalMatches) {
      if (!this.firstUseInitializationPending && !this.currentMigrationMarker()) {
        this.baselineReviewRequired ||= wasBaselineReviewRequired;
        this.setMissingRootRecoveryBlocked(requiresRecords || acceptedInventory.total > 0);
        try {
          await this.persistPluginData();
        } catch {
          this.workspaceSafetyNeedsPersistence = true;
        }
      }
      this.showMigrationRecoveryNotice();
      return false;
    }

    this.activeRootFingerprint = adoptedRootFingerprint;
    this.requestMarkerFreeRecoveryRelease(true);
    void this.refreshOpenViews().catch(() => undefined);
    return true;
  }

  /**
   * Rewrites patient note bodies that are still exactly the identifier-
   * bearing scaffold generated by versions up to 0.4.x. Anything the user has
   * edited fails the byte-level pattern and is never touched; every rewrite
   * happens inside Vault.process so a concurrent Sync delivery wins.
   */
  private async migrateGeneratedBodies(): Promise<void> {
    if (this.migrationRecoveryBlocked) {
      this.showMigrationRecoveryNotice(9000);
      return;
    }
    const folder = `${clinicalRootFolder()}/Patients`;
    const candidates: TFile[] = [];
    for (const file of markdownFilesInFolder(this.app.vault, folder)) {
      const content = await this.app.vault.cachedRead(file);
      const record = parseClinicalRecord(content);
      if (record?.entity !== "patient") continue;
      // CRLF-normalized copies of the generated scaffold (a Windows sync or
      // editor round-trip) are still unmistakably plugin text; matching only
      // LF would report "Nothing to change" while identifiers remain.
      const body = bodyAfterFrontmatter(content).replace(/\r\n/g, "\n");
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
          // The confirmation can stay open while Sync arms the write
          // barrier. These writes go through Vault.process directly, so the
          // repository's own barrier cannot intercept them — re-check here.
          if (this.migrationRecoveryBlocked) {
            this.showMigrationRecoveryNotice(9000);
            return;
          }
          let rewritten = 0;
          await this.repository.withManagedRecordMutation(
            candidates.map((file) => file.path),
            async () => {
              for (const file of candidates) {
                try {
                  await this.app.vault.process(file, (current) => {
                    const rawBody = bodyAfterFrontmatter(current);
                    // Re-check inside the transform: Sync may have delivered an
                    // edited version since the preview was computed. The slice
                    // offset uses the RAW body length; the CRLF normalization is
                    // for pattern matching only.
                    if (!LEGACY_PATIENT_BODY_PATTERN.test(rawBody.replace(/\r\n/g, "\n").trim() + "\n")) {
                      return current;
                    }
                    const record = parseClinicalRecord(current);
                    if (record?.entity !== "patient") return current;
                    const frontmatterEnd = current.length - rawBody.length;
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
            }
          );
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
