import assert from "node:assert/strict";
import test from "node:test";
import { App, TFile, TFolder } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import {
  CLINICAL_WRITES_BLOCKED_MESSAGE,
  ClinicalRepository
} from "../src/data/repository";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import type { EpisodeRecord, PatientRecord } from "../src/domain/types";
import {
  MigrationService,
  resolveMigrationRoot,
  type MigrationMarker,
  type MigrationResult
} from "../src/services/migration";
import { ClinicalService } from "../src/services/clinical-service";
import { Notice as StubNotice, type App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness } from "./support/harness";

type TestRecordInventory = {
  counts: { patient: number; episode: number; task: number; procedure: number };
  digest: string;
  total: number;
};

type TestTrustedInventoryJournal = {
  version: 1;
  generation: number;
  pending: boolean;
  retiredRootFingerprints?: string[];
  trustedInventory?: {
    rootFingerprint: string;
    expectedManagedRecordCount: number;
    expectedEntityCounts: TestRecordInventory["counts"];
    expectedRecordDigest: string;
  };
};

type TestBaselineAdoptionCandidate = {
  root: string;
  rawCount: number;
  recoveryRevision: number;
  inventory: TestRecordInventory;
};

type TestPlugin = {
  app: StubApp;
  repository: ClinicalRepository;
  migration: MigrationService;
  settings: ClinicalSettings;
  pendingMigrationMarker: unknown;
  pendingMigrationConfiguredRoot: string | null;
  migrationRecoveryBlocked: boolean;
  missingRootRecoveryBlocked: boolean;
  missingRootRequiresRecords: boolean;
  firstUseInitializationPending: boolean;
  pendingAdoptionRecordCount: number | null;
  pendingAdoptionRoot: string | null;
  pendingAdoptionDataFingerprint: string | null;
  pendingAdoptionInventory: TestRecordInventory | null;
  pendingAdoptionRootFingerprint: string | null;
  workspaceInitialized: boolean;
  managedRecordsExpected: boolean;
  expectedManagedRecordCount: number;
  expectedEntityCounts: {
    patient: number;
    episode: number;
    task: number;
    procedure: number;
  } | null;
  expectedRecordDigest: string | null;
  retiredRootFolders: Set<string>;
  workspaceSafetyNeedsPersistence: boolean;
  recoveryValidationRequired: boolean;
  baselineReviewRequired: boolean;
  recoveryBlockMessage: string;
  structureReady: boolean;
  externalSettingsApplyQueue: Promise<void>;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  loadSettings: () => Promise<void>;
  onExternalSettingsChange: () => Promise<void>;
  retryPendingMigrationRecovery: () => Promise<boolean>;
  retryExactRestoredRootRecovery: () => Promise<boolean>;
  captureBaselineAdoptionCandidate: (root: string) => Promise<TestBaselineAdoptionCandidate | null>;
  confirmCurrentBaselineAdoption: (
    root: string,
    preview?: TestBaselineAdoptionCandidate
  ) => Promise<boolean>;
  parsedRecordInventory: (root: string) => Promise<TestRecordInventory>;
  reconcileMigration: (stored: unknown) => Promise<boolean>;
  retryMigrationReconciliation: () => Promise<boolean>;
  ensureStructure: () => Promise<void>;
  migrateRootFolder: (target: string) => Promise<MigrationResult>;
  initializeNewWorkspace: () => Promise<void>;
  retryMigrationForPath: (path: string) => void;
  showMigrationRecoveryNotice: (duration?: number, message?: string) => void;
  handleVaultRename: (file: TFile | TFolder, oldPath: string) => void;
  handleExternalRootRename: (file: unknown, oldPath: string) => boolean;
  blockIfActiveRootDisappeared: (path: string) => void;
  observeManagedRecordDelivery: (path: string) => void;
  noteManagedRecordWrite: (paths?: readonly string[]) => Promise<boolean>;
  persistWorkspaceSafety: () => Promise<void>;
  commitTrustedInventoryJournalForExactRoot: (
    root: string,
    expectedGeneration?: number
  ) => Promise<boolean>;
};

function makePlugin(
  app: StubApp,
  repository: ClinicalRepository,
  readStored: () => unknown,
  onSave: (data: unknown) => void | Promise<void> = () => undefined
): TestPlugin {
  const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as TestPlugin;
  plugin.app = app;
  plugin.repository = repository;
  plugin.migration = new MigrationService(app as unknown as App);
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.pendingMigrationMarker = null;
  plugin.pendingMigrationConfiguredRoot = null;
  plugin.migrationRecoveryBlocked = false;
  plugin.missingRootRecoveryBlocked = false;
  plugin.missingRootRequiresRecords = false;
  plugin.firstUseInitializationPending = false;
  plugin.pendingAdoptionRecordCount = null;
  plugin.pendingAdoptionRoot = null;
  plugin.pendingAdoptionDataFingerprint = null;
  plugin.pendingAdoptionInventory = null;
  plugin.pendingAdoptionRootFingerprint = null;
  plugin.workspaceInitialized = app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder) !== null;
  plugin.expectedManagedRecordCount = [...app.vault.files.keys()].filter((path) =>
    ["Patients", "Episodes", "Tasks", "Procedures"].some((folder) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`)
    )
  ).length;
  plugin.managedRecordsExpected = plugin.expectedManagedRecordCount > 0;
  plugin.expectedEntityCounts = null;
  plugin.expectedRecordDigest = null;
  plugin.workspaceSafetyNeedsPersistence = false;
  plugin.structureReady = true;
  plugin.loadData = async () => structuredClone(readStored());
  plugin.saveData = async (data) => {
    await onSave(structuredClone(data));
  };
  plugin.refreshOpenViews = async () => undefined;
  repository.setManagedRecordWriteObserver((paths) => plugin.noteManagedRecordWrite(paths));
  return plugin;
}

function copyRoot(app: StubApp, from: string, to: string): void {
  for (const folder of [...app.vault.folders]) {
    if (folder === from || folder.startsWith(`${from}/`)) {
      app.vault.folders.add(`${to}${folder.slice(from.length)}`);
    }
  }
  for (const [path, content] of [...app.vault.files]) {
    if (path === from || path.startsWith(`${from}/`)) {
      app.vault.writeRaw(`${to}${path.slice(from.length)}`, content);
    }
  }
}

function deleteRoot(app: StubApp, root: string): void {
  for (const path of [...app.vault.files.keys()]) {
    if (path === root || path.startsWith(`${root}/`)) app.vault.deleteRaw(path);
  }
  for (const folder of [...app.vault.folders]) {
    if (folder === root || folder.startsWith(`${root}/`)) app.vault.folders.delete(folder);
  }
}

async function renameRoot(app: StubApp, from: string, to: string): Promise<void> {
  const source = app.vault.getAbstractFileByPath(from);
  assert.ok(source);
  await app.fileManager.renameFile(source, to);
}

const MANAGED_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"];
const TRUSTED_INVENTORY_JOURNAL_KEY = "clinical-workspace:trusted-inventory-journal:v1";

function managedRecordPaths(app: StubApp, root: string): string[] {
  return [...app.vault.files.keys()]
    .filter((path) => MANAGED_FOLDERS.some((folder) => path.startsWith(`${root}/${folder}/`)))
    .sort();
}

function retainManagedRecords(app: StubApp, root: string, count: number): void {
  for (const path of managedRecordPaths(app, root).slice(count)) app.vault.deleteRaw(path);
}

function addDistinctManagedRecord(app: StubApp, root: string, suffix: string): string {
  const sourcePath = managedRecordPaths(app, root).at(-1);
  assert.ok(sourcePath);
  const sourceContent = app.vault.files.get(sourcePath);
  assert.ok(sourceContent);
  assert.match(sourceContent, /^id:\s*.+$/m);
  const folder = sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1);
  const path = `${folder}external-${suffix}.md`;
  const content = sourceContent.replace(
    /^id:\s*(.+)$/m,
    (_line, id: string) => `id: ${id.trim()}-external-${suffix}`
  );
  app.vault.writeRaw(path, content);
  return path;
}

function persistedSafety(expectedManagedRecordCount: number): Record<string, unknown> {
  return {
    version: 1,
    initialized: true,
    managedRecordsExpected: expectedManagedRecordCount > 0,
    expectedManagedRecordCount,
    rootRecoveryRequired: false,
    recoveryRequiresRecords: expectedManagedRecordCount > 0
  };
}

async function assertInvalidTrustedJournalFailsClosed(journal: unknown): Promise<void> {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const seeded = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await seeded.noteManagedRecordWrite();

    app.saveLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY, journal);
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.firstUseInitializationPending, false);
    assert.equal(restarted.recoveryValidationRequired, true);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.workspaceSafetyNeedsPersistence, true);
    assert.deepEqual(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY),
      journal,
      "startup must not silently repair or bless an unreadable local trust anchor"
    );
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5221", caseName: "Invalid journal stays read-only" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
}

async function assertTrustedJournalArmFailureFailsClosed(
  breakSave: (app: StubApp) => void
): Promise<void> {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const trustedJournal = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY);
    assert.ok(trustedJournal);

    let externalSettingsReads = 0;
    plugin.loadData = async () => {
      externalSettingsReads += 1;
      return structuredClone(stored);
    };
    breakSave(app);

    await plugin.onExternalSettingsChange();

    assert.equal(
      externalSettingsReads,
      0,
      "a journal arm failure must stop before the external snapshot is read or applied"
    );
    assert.equal(plugin.recoveryValidationRequired, true);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.workspaceSafetyNeedsPersistence, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5222", caseName: "Journal arm failure stays read-only" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
}

async function primeAdoption(
  plugin: TestPlugin,
  stored: unknown,
  recordCount: number
): Promise<void> {
  plugin.pendingAdoptionRoot = plugin.settings.rootFolder;
  plugin.pendingAdoptionRecordCount = recordCount;
  plugin.pendingAdoptionDataFingerprint = JSON.stringify(stored) ?? "undefined";
  plugin.pendingAdoptionInventory = await plugin.parsedRecordInventory(plugin.settings.rootFolder);
  plugin.pendingAdoptionRootFingerprint = await sha256ForTest(
    `clinical-workspace/root/v1\0${plugin.settings.rootFolder}`
  );
}

async function sha256ForTest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertLegacyCountOnlyEqualCommitmentRequiresReview(
  conflictingDisk: boolean
): Promise<void> {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const recordCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    let stored: unknown = {
      ...DEFAULT_SETTINGS,
      workspaceSafety: persistedSafety(recordCount)
    };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    // Model an already-running pre-digest session. A count-only state loaded
    // at startup is intentionally blocked until explicit upgrade, while the
    // overlap at issue happens when Sync reaches a legacy session already in
    // memory and supplies its first complete tuple.
    assert.equal(plugin.expectedManagedRecordCount, recordCount);
    assert.equal(plugin.expectedEntityCounts, null);
    assert.equal(plugin.expectedRecordDigest, null);
    assert.equal(plugin.migrationRecoveryBlocked, false);

    const diskInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    let deliveredInventory = diskInventory;
    if (conflictingDisk) {
      const changedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
      assert.ok(changedPath);
      const originalContent = app.vault.files.get(changedPath);
      assert.ok(originalContent);
      const changedContent = originalContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-equal-external-conflict`
      );
      assert.notEqual(changedContent, originalContent);
      app.vault.writeRaw(changedPath, changedContent);
      deliveredInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
      app.vault.writeRaw(changedPath, originalContent);
      assert.equal(deliveredInventory.total, diskInventory.total);
      assert.deepEqual(deliveredInventory.counts, diskInventory.counts);
      assert.notEqual(deliveredInventory.digest, diskInventory.digest);
    }

    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...persistedSafety(recordCount),
        expectedEntityCounts: { ...deliveredInventory.counts },
        expectedRecordDigest: deliveredInventory.digest,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };

    await plugin.onExternalSettingsChange();

    assert.equal(plugin.expectedManagedRecordCount, recordCount);
    assert.deepEqual(
      plugin.expectedEntityCounts,
      deliveredInventory.counts,
      "the delivered complete tuple must not be discarded"
    );
    assert.equal(plugin.expectedRecordDigest, deliveredInventory.digest);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(await plugin.retryPendingMigrationRecovery(), false);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({
          mrn: conflictingDisk ? "5211" : "5210",
          caseName: "Legacy equal commitment needs typed review"
        })
      ),
      /synchronized recovery information conflicts/
    );

    const persisted = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(persisted?.expectedManagedRecordCount, recordCount);
    assert.deepEqual(persisted?.expectedEntityCounts, deliveredInventory.counts);
    assert.equal(persisted?.expectedRecordDigest, deliveredInventory.digest);
    assert.equal(persisted?.rootRecoveryRequired, true);
    assert.equal(persisted?.recoveryValidationRequired, true);
    assert.equal(persisted?.baselineReviewRequired, true);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.deepEqual(restarted.expectedEntityCounts, deliveredInventory.counts);
    assert.equal(restarted.expectedRecordDigest, deliveredInventory.digest);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
}

test("resolveMigrationRoot refuses to choose when both roots hold records", () => {
  const marker = { from: "Clinical Workspace", to: "Ward Records" };
  assert.equal(resolveMigrationRoot(marker, () => true), null);
  assert.equal(resolveMigrationRoot(marker, (root) => root === marker.from), marker.from);
  assert.equal(resolveMigrationRoot(marker, (root) => root === marker.to), marker.to);
  assert.equal(resolveMigrationRoot(marker, () => false), null);
});

test("marker-before-folder keeps source readable and blocks an already-open service until destination wins", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput({ patientName: "Private Name", mrn: "991122" }));
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    let stored: unknown = { ...DEFAULT_SETTINGS, rootFolder: marker.to, migrationInProgress: marker };
    let saved: unknown = null;
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      saved = data;
      stored = data;
    });

    await plugin.onExternalSettingsChange();

    assert.equal(clinicalRootFolder(), marker.from);
    assert.equal((await repository.list<EpisodeRecord>("episode")).length, 1, "reads remain available");
    await assert.rejects(
      () => service.createEpisode(episodeInput({ patientName: "Blocked Person", mrn: "884433" })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, CLINICAL_WRITES_BLOCKED_MESSAGE);
        assert.doesNotMatch(error.message, /Private|Blocked|991122|884433|Ward Records/);
        return true;
      }
    );
    assert.deepEqual(
      (saved as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress,
      marker,
      "the canonical queued save makes the delivered marker the final data.json state"
    );
    assert.equal((saved as { rootFolder?: string } | null)?.rootFolder, marker.to);

    await renameRoot(app, marker.from, marker.to);
    assert.equal(await plugin.retryMigrationReconciliation(), true);
    assert.equal(clinicalRootFolder(), marker.to);
    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(
      plugin.migrationRecoveryBlocked,
      true,
      "count-only recovery remains closed until an explicit exact Retry"
    );
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    await service.createEpisode(episodeInput({ patientName: "Allowed Person", mrn: "773322" }));
    assert.equal((await repository.list<EpisodeRecord>("episode")).length, 2);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("folder-before-marker with two populated roots stays read-only until only destination remains", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    copyRoot(app, marker.from, marker.to);
    const stored = { ...DEFAULT_SETTINGS, rootFolder: marker.to, migrationInProgress: marker };
    const plugin = makePlugin(app, repository, () => stored);

    await plugin.onExternalSettingsChange();
    assert.equal(await plugin.retryMigrationReconciliation(), false);
    assert.equal(await plugin.retryPendingMigrationRecovery(), false, "explicit retry also refuses both roots");
    await assert.rejects(() => service.createEpisode(episodeInput()), new RegExp("temporarily read-only"));

    deleteRoot(app, marker.from);
    assert.equal(await plugin.retryMigrationReconciliation(), true);
    assert.equal(clinicalRootFolder(), marker.to);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    await service.createEpisode(episodeInput({ mrn: "5002", caseName: "After convergence" }));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("source-only recovery remains conservative automatically and explicit retry confirms rollback", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    const stored = { ...DEFAULT_SETTINGS, rootFolder: marker.to, migrationInProgress: marker };
    const plugin = makePlugin(app, repository, () => stored);

    await plugin.onExternalSettingsChange();
    assert.equal(await plugin.retryMigrationReconciliation(), false);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    assert.equal(clinicalRootFolder(), marker.from);
    assert.equal(plugin.pendingMigrationMarker, null);
    await service.createEpisode(episodeInput({ mrn: "5003", caseName: "After rollback" }));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a marker-free synced root arriving before its folder is persisted as pending and does not create it", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const incoming = { ...DEFAULT_SETTINGS, rootFolder: "Ward Records", confirmBeforeDischarge: true };
    let saved: Record<string, unknown> | null = null;
    const plugin = makePlugin(app, repository, () => incoming, (data) => {
      saved = data as Record<string, unknown>;
    });

    await plugin.onExternalSettingsChange();

    assert.equal(clinicalRootFolder(), DEFAULT_SETTINGS.rootFolder);
    assert.equal(app.vault.getAbstractFileByPath("Ward Records"), null, "no destination tree is manufactured");
    const savedData = saved as Record<string, unknown> | null;
    assert.deepEqual(savedData?.migrationInProgress, {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    });
    assert.equal(savedData?.rootFolder, "Ward Records");
    await assert.rejects(() => service.createEpisode(episodeInput()), new RegExp("temporarily read-only"));

    await renameRoot(app, DEFAULT_SETTINGS.rootFolder, "Ward Records");
    assert.equal(await plugin.retryMigrationReconciliation(), true);
    assert.equal(plugin.settings.confirmBeforeDischarge, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("folder rename arriving before settings fails closed synchronously and then activates destination", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let saved: unknown = null;
    const plugin = makePlugin(app, repository, () => DEFAULT_SETTINGS, (data) => {
      saved = data;
    });
    await plugin.noteManagedRecordWrite();

    await renameRoot(app, "Clinical Workspace", "Ward Records");
    const deliveredFolder = app.vault.getAbstractFileByPath("Ward Records");
    assert.ok(deliveredFolder);
    assert.equal(plugin.handleExternalRootRename(deliveredFolder, "Clinical Workspace"), true);

    // The event callback arms the barrier before its first await.
    assert.equal(plugin.migrationRecoveryBlocked, true);
    // Reconciliation now also verifies the parsed-record inventory (reads +
    // a SHA-256), so wait on its outcome instead of counting microtasks.
    for (
      let index = 0;
      index < 200 && (plugin.pendingMigrationMarker !== null || plugin.migrationRecoveryBlocked);
      index += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assert.ok(saved);
    assert.equal(clinicalRootFolder(), "Ward Records");
    assert.equal(plugin.pendingMigrationMarker, null);
    await service.createEpisode(episodeInput({ mrn: "5004", caseName: "After folder-first delivery" }));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("deleting the configured root blocks writes immediately", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const backedUpFolders = [...app.vault.folders].filter((path) =>
      path === DEFAULT_SETTINGS.rootFolder || path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    let stored: unknown = DEFAULT_SETTINGS;
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);

    plugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    await assert.rejects(() => service.createEpisode(episodeInput()), new RegExp("temporarily read-only"));
    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);

    await plugin.onExternalSettingsChange();
    await assert.rejects(
      () => service.createEpisode(episodeInput()),
      new RegExp("configured folder is unavailable")
    );

    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    plugin.retryMigrationForPath(DEFAULT_SETTINGS.rootFolder);
    await assert.rejects(
      () => service.createEpisode(episodeInput()),
      new RegExp("configured folder is unavailable")
    );

    assert.equal(
      await plugin.retryPendingMigrationRecovery(),
      false,
      "an empty parent is not proof that previously managed records returned"
    );
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    await service.createEpisode(episodeInput({ mrn: "5005", caseName: "Root delivered again" }));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("deleting one managed child fails closed until the full healthy count returns", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = DEFAULT_SETTINGS;
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    const deletedPath = [...app.vault.files.keys()].find((path) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/Episodes/`)
    );
    assert.ok(deletedPath);
    const deletedContent = app.vault.files.get(deletedPath);
    assert.ok(deletedContent);

    app.vault.deleteRaw(deletedPath);
    plugin.blockIfActiveRootDisappeared(deletedPath);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    await assert.rejects(
      () => service.createEpisode(episodeInput({ mrn: "6001" })),
      new RegExp("configured folder is unavailable")
    );
    assert.equal(await plugin.retryPendingMigrationRecovery(), false);

    app.vault.writeRaw(deletedPath, deletedContent);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    await service.createEpisode(episodeInput({ mrn: "6002", caseName: "After child restore" }));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("deleting Events or unrelated files does not arm managed-root recovery", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const plugin = makePlugin(app, repository, () => DEFAULT_SETTINGS);
    const eventPath = [...app.vault.files.keys()].find((path) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/Events/`)
    );
    assert.ok(eventPath);

    app.vault.deleteRaw(eventPath);
    plugin.blockIfActiveRootDisappeared(eventPath);
    app.vault.writeRaw("Unrelated note.md", "# Unrelated");
    plugin.blockIfActiveRootDisappeared("Unrelated note.md");

    assert.equal(plugin.migrationRecoveryBlocked, false);
    await service.createEpisode(episodeInput({ mrn: "6003", caseName: "Unaffected" }));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an invalid externally renamed destination stays blocked without arming a false marker", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    let writes = 0;
    const plugin = makePlugin(app, repository, () => DEFAULT_SETTINGS, () => {
      writes += 1;
    });

    const unsafeFolder = Object.assign(Object.create(TFolder.prototype) as TFolder, {
      path: "../Unsafe"
    });
    assert.equal(plugin.handleExternalRootRename(unsafeFolder, DEFAULT_SETTINGS.rootFolder), true);

    assert.equal(plugin.pendingMigrationMarker, null);
    for (let index = 0; index < 4 && writes === 0; index += 1) await Promise.resolve();
    assert.equal(writes, 1, "only path-free recovery state is persisted");
    await assert.rejects(() => service.createEpisode(episodeInput()), new RegExp("temporarily read-only"));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("persisted missing-root recovery survives restart and prevents empty scaffolding", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = DEFAULT_SETTINGS;
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    const safety = (stored as { workspaceSafety?: Record<string, unknown> }).workspaceSafety;
    assert.equal(safety?.rootRecoveryRequired, true);
    assert.equal(safety?.recoveryRequiresRecords, true);
    assert.ok(Number(safety?.expectedManagedRecordCount) > 0);
    assert.doesNotMatch(JSON.stringify(safety), /Clinical Workspace|Ward Records|Test Patient|5001/);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restarted.structureReady = false;
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRequiresRecords, true);
    await assert.rejects(
      () => restarted.ensureStructure(),
      new RegExp("configured folder is unavailable")
    );
    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an exact trusted root restored before listeners register clears the stale barrier", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();

    const committed = (stored as {
      workspaceSafety?: { expectedEntityCounts?: unknown; expectedRecordDigest?: unknown };
    }).workspaceSafety;
    assert.ok(committed?.expectedEntityCounts);
    assert.match(String(committed?.expectedRecordDigest), /^[0-9a-f]{64}$/);

    const backedUpFolders = [...app.vault.folders].filter((path) =>
      path === DEFAULT_SETTINGS.rootFolder || path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    assert.equal(
      (stored as { workspaceSafety?: { rootRecoveryRequired?: boolean } })
        .workspaceSafety?.rootRecoveryRequired,
      true
    );

    // Model the startup race: loadSettings sees no root, then Sync restores
    // every file before onLayoutReady has attached vault listeners.
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );
    assert.equal(restarted.missingRootRecoveryBlocked, true);

    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    StubNotice.history.length = 0;
    restarted.showMigrationRecoveryNotice();
    const recoveryNotice = StubNotice.history.at(-1);
    assert.ok(recoveryNotice);

    await restarted.ensureStructure();
    assert.equal(restarted.migrationRecoveryBlocked, false);
    assert.equal(restarted.missingRootRecoveryBlocked, false);
    assert.equal(recoveryNotice.hidden, true, "successful startup recovery dismisses stale guidance");
    assert.equal(
      (stored as { workspaceSafety?: { rootRecoveryRequired?: boolean } })
        .workspaceSafety?.rootRecoveryRequired,
      false
    );
    assert.equal(
      (stored as { workspaceSafety?: { recoveryValidationRequired?: boolean } })
        .workspaceSafety?.recoveryValidationRequired,
      true,
      "restart validation remains durable after the runtime barrier clears"
    );

    const restoredService = new ClinicalService(restartedRepository);
    await restoredService.createEpisode(
      episodeInput({ mrn: "5006", caseName: "After exact startup restore" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("startup validation blocks an equal-count replacement delivered before layout-ready", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const safety = (stored as {
      workspaceSafety?: {
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(safety?.rootRecoveryRequired, false);
    assert.equal(safety?.recoveryValidationRequired, false);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );
    assert.equal(
      restarted.migrationRecoveryBlocked,
      true,
      "a complete commitment is guarded until layout-ready validates its exact disk tuple"
    );
    assert.equal(restarted.missingRootRecoveryBlocked, true);

    // No vault listener is called: this is the gap after loadSettings and
    // before registerVaultEvents/onLayoutReady performs its exact retry.
    const replacementPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(replacementPath);
    const originalContent = app.vault.files.get(replacementPath);
    assert.ok(originalContent);
    assert.match(originalContent, /^id:\s*.+$/m);
    app.vault.writeRaw(
      replacementPath,
      originalContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-startup-replacement`
      )
    );
    const replacementInventory = await restarted.parsedRecordInventory(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.equal(replacementInventory.total, restarted.expectedManagedRecordCount);
    assert.notEqual(replacementInventory.digest, restarted.expectedRecordDigest);

    assert.equal(await restarted.retryExactRestoredRootRecovery(), false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5110", caseName: "Startup replacement must stay blocked" })
      ),
      /configured folder is unavailable/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("startup validation catches a managed deletion before listeners and creates no scaffold", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restarted.structureReady = false;
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRecoveryBlocked, true);

    // Again, intentionally omit blockIfActiveRootDisappeared/retryMigrationForPath:
    // listeners are not registered yet when these Sync deletions land.
    const deletedRecord = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(deletedRecord);
    app.vault.deleteRaw(deletedRecord);
    const homePath = `${DEFAULT_SETTINGS.rootFolder}/00 Home/Clinical Workspace.md`;
    assert.ok(app.vault.getAbstractFileByPath(homePath));
    app.vault.deleteRaw(homePath);

    assert.equal(await restarted.retryExactRestoredRootRecovery(), false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    const filesBeforeEnsure = [...app.vault.files.keys()].sort();
    await assert.rejects(
      () => restarted.ensureStructure(),
      /configured folder is unavailable/
    );
    assert.deepEqual([...app.vault.files.keys()].sort(), filesBeforeEnsure);
    assert.equal(
      app.vault.getAbstractFileByPath(homePath),
      null,
      "the blocked ensure path must not recreate even non-record scaffolding"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a pending UI refresh cannot extend the post-validation barrier window", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders];
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    let signalRefreshStarted: () => void = () => undefined;
    let releaseRefresh: () => void = () => undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    restarted.refreshOpenViews = async () => {
      signalRefreshStarted();
      await refreshGate;
    };

    let recoverySettled = false;
    const recovery = restarted.retryExactRestoredRootRecovery().then((value) => {
      recoverySettled = true;
      return value;
    });
    await refreshStarted;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    assert.equal(
      recoverySettled,
      true,
      "UI rendering must not be awaited after the last inventory validation"
    );
    assert.equal(await recovery, true);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    releaseRefresh();
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("the final Sync event reruns an in-flight exact-root scan", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders];
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);

    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    const finalManagedPath = backedUpFiles
      .map(([path]) => path)
      .filter((path) => MANAGED_FOLDERS.some((folder) =>
        path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`)
      ))
      .sort()
      .at(-1);
    const finalFile = backedUpFiles.find(([path]) => path === finalManagedPath);
    assert.ok(finalFile);
    for (const [path, content] of backedUpFiles) {
      if (path === finalFile[0]) continue;
      app.vault.writeRaw(path, content);
    }
    const placeholder = `${DEFAULT_SETTINGS.rootFolder}/Patients/sync-placeholder.md`;
    app.vault.writeRaw(placeholder, "# Still syncing");
    app.vault.latency = 2;

    const firstScan = restarted.retryExactRestoredRootRecovery();
    // Let the queued recovery enter its latency-backed parsed scan before the
    // final Sync delivery arrives.
    await Promise.resolve();
    app.vault.deleteRaw(placeholder);
    app.vault.writeRaw(finalFile[0], finalFile[1]);
    const joinedScan = restarted.retryExactRestoredRootRecovery();

    assert.equal(firstScan, joinedScan, "overlapping events share one recovery drain");
    assert.equal(await firstScan, true);
    assert.equal(restarted.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("automatic and explicit recovery serialize while Sync changes a pending save", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders];
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    let signalSaveStarted: () => void = () => undefined;
    let releaseSave: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let holdNextSave = true;
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, async (data) => {
      if (holdNextSave) {
        holdNextSave = false;
        signalSaveStarted();
        await saveGate;
      }
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    const recovery = restarted.retryExactRestoredRootRecovery();
    await saveStarted;
    assert.equal(
      restarted.migrationRecoveryBlocked,
      true,
      "the global guard stays armed until the clear is durable and revalidated"
    );

    const beforeGrowth = new Set(managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder));
    const syncRepository = new ClinicalRepository(app as unknown as App);
    await new ClinicalService(syncRepository).createEpisode(
      episodeInput({ mrn: "5099", caseName: "Synced growth" })
    );
    const deliveredPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => !beforeGrowth.has(path));
    assert.ok(deliveredPath, "the simulated Sync delivery must add a valid record with a fresh id");
    restarted.retryMigrationForPath(deliveredPath);
    let explicitSettled = false;
    const explicitRecovery = restarted.retryPendingMigrationRecovery().then((value) => {
      explicitSettled = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(explicitSettled, false, "the explicit command queues behind automatic recovery");
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5100", caseName: "Must stay blocked" })
      ),
      /configured folder is unavailable/
    );
    releaseSave();

    assert.equal(await recovery, false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(
      (stored as { workspaceSafety?: { rootRecoveryRequired?: boolean } })
        .workspaceSafety?.rootRecoveryRequired,
      true,
      "a dirty recovery pass restores the durable barrier before stopping"
    );
    assert.equal(
      await explicitRecovery,
      false,
      "ordinary Retry must not adopt growth that could conceal replacement"
    );
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(
      (stored as { workspaceSafety?: { baselineReviewRequired?: boolean } })
        .workspaceSafety?.baselineReviewRequired,
      true,
      "growth transitions durably to typed baseline review"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a failed dirty-pass re-arm remains blocked after restart", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders];
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    let signalSaveStarted: () => void = () => undefined;
    let releaseSave: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveAttempt = 0;
    const recoveringRepository = new ClinicalRepository(app as unknown as App);
    const recovering = makePlugin(app, recoveringRepository, () => stored, async (data) => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        signalSaveStarted();
        await saveGate;
        stored = data;
        return;
      }
      throw new Error("simulated re-arm save failure");
    });
    await recovering.loadSettings();
    recoveringRepository.setWriteBlock(recovering.recoveryBlockMessage);
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    const recovery = recovering.retryExactRestoredRootRecovery();
    await saveStarted;
    const beforeGrowth = new Set(managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder));
    const syncRepository = new ClinicalRepository(app as unknown as App);
    await new ClinicalService(syncRepository).createEpisode(
      episodeInput({ mrn: "5101", caseName: "Late synced growth" })
    );
    const deliveredPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => !beforeGrowth.has(path));
    assert.ok(deliveredPath);
    recovering.retryMigrationForPath(deliveredPath);
    releaseSave();

    assert.equal(await recovery, false);
    assert.equal(recovering.migrationRecoveryBlocked, true);
    assert.equal(
      (stored as { workspaceSafety?: { rootRecoveryRequired?: boolean } })
        .workspaceSafety?.rootRecoveryRequired,
      false,
      "the intentionally failed re-arm leaves the earlier clear snapshot on disk"
    );
    assert.equal(
      (stored as { workspaceSafety?: { recoveryValidationRequired?: boolean } })
        .workspaceSafety?.recoveryValidationRequired,
      true,
      "the durable validation sentinel survives even when re-arm persistence fails"
    );

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(await restarted.retryExactRestoredRootRecovery(), false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5102", caseName: "Restart must stay blocked" })
      ),
      /configured folder is unavailable/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("closed-app root loss persists exact validation before an equal-count changed restore", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();

    const backedUpFolders = [...app.vault.folders].filter((path) =>
      path === DEFAULT_SETTINGS.rootFolder || path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const originalExpectedCount = Number(
      (stored as { workspaceSafety?: { expectedManagedRecordCount?: number } })
        .workspaceSafety?.expectedManagedRecordCount
    );
    assert.ok(originalExpectedCount > 0);

    // Obsidian was closed when the root vanished, so no live delete callback
    // had an opportunity to persist rootRecoveryRequired.
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    const firstRestartRepository = new ClinicalRepository(app as unknown as App);
    const firstRestart = makePlugin(app, firstRestartRepository, () => stored, (data) => {
      stored = data;
    });
    await firstRestart.loadSettings();
    firstRestartRepository.setWriteBlock(firstRestart.recoveryBlockMessage);

    assert.equal(firstRestart.missingRootRecoveryBlocked, true);
    assert.equal(firstRestart.recoveryValidationRequired, true);
    assert.equal(firstRestart.workspaceSafetyNeedsPersistence, true);
    await firstRestart.persistWorkspaceSafety();
    assert.equal(
      (stored as { workspaceSafety?: { rootRecoveryRequired?: boolean } })
        .workspaceSafety?.rootRecoveryRequired,
      true
    );
    assert.equal(
      (stored as { workspaceSafety?: { recoveryValidationRequired?: boolean } })
        .workspaceSafety?.recoveryValidationRequired,
      true,
      "the inferred closed-app loss must become durable before Sync can restore the root"
    );

    const changedFile = backedUpFiles.find(([path]) =>
      MANAGED_FOLDERS.some((folder) => path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`))
    );
    assert.ok(changedFile);
    assert.match(changedFile[1], /^id:\s*.+$/m);
    const changedContent = changedFile[1].replace(
      /^id:\s*(.+)$/m,
      (_line, id: string) => `id: ${id.trim()}-changed-after-closed-loss`
    );
    assert.notEqual(changedContent, changedFile[1]);
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) {
      app.vault.writeRaw(path, path === changedFile[0] ? changedContent : content);
    }
    assert.equal(
      managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length,
      originalExpectedCount,
      "the changed restore deliberately preserves the raw Markdown count"
    );

    const secondRestartRepository = new ClinicalRepository(app as unknown as App);
    const secondRestart = makePlugin(app, secondRestartRepository, () => stored);
    await secondRestart.loadSettings();
    secondRestartRepository.setWriteBlock(secondRestart.recoveryBlockMessage);

    const changedInventory = await secondRestart.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(
      changedInventory.total,
      originalExpectedCount,
      "the replacement remains a valid parsed record set, not merely an equal raw count"
    );
    assert.notEqual(changedInventory.digest, secondRestart.expectedRecordDigest);
    assert.equal(secondRestart.missingRootRecoveryBlocked, true);
    assert.equal(secondRestart.recoveryValidationRequired, true);
    assert.equal(await secondRestart.retryExactRestoredRootRecovery(), false);
    assert.equal(secondRestart.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(secondRestartRepository).createEpisode(
        episodeInput({ mrn: "5104", caseName: "Changed closed-app restore" })
      ),
      /configured folder is unavailable/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("non-record Markdown cannot become a recovery baseline and exact cleanup recovers", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();

    const invalidPath = `${DEFAULT_SETTINGS.rootFolder}/Patients/sync-conflict.md`;
    app.vault.writeRaw(invalidPath, "# This is Markdown, but not a Clinical Workspace record\n");
    StubNotice.history.length = 0;
    assert.equal(
      await firstPlugin.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder),
      false,
      "a healthy workspace must not ratchet its trusted baseline over invalid Markdown"
    );
    assert.equal(firstPlugin.migrationRecoveryBlocked, false);
    const adoptionFailure = StubNotice.history.at(-1);
    assert.ok(adoptionFailure);
    assert.match(adoptionFailure.message, /not a valid Clinical Workspace record/);
    assert.equal(
      adoptionFailure.hidden,
      false,
      "the actionable adoption failure must remain visible after the recovery queue releases"
    );

    const backedUpFolders = [...app.vault.folders].filter((path) =>
      path === DEFAULT_SETTINGS.rootFolder || path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    await firstPlugin.persistWorkspaceSafety();
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    StubNotice.history.length = 0;

    assert.equal(await restarted.retryPendingMigrationRecovery(), false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    const explicitFailure = StubNotice.history.at(-1);
    assert.ok(explicitFailure);
    assert.match(explicitFailure.message, /not a valid Clinical Workspace record/);
    assert.equal(explicitFailure.hidden, false);

    app.vault.deleteRaw(invalidPath);
    assert.equal(
      await restarted.retryExactRestoredRootRecovery(),
      true,
      "removing the invalid extra Markdown restores the exact committed inventory"
    );
    assert.equal(restarted.migrationRecoveryBlocked, false);
    assert.equal(explicitFailure.hidden, true, "successful exact recovery dismisses stale guidance");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a frozen baseline preview rejects record loss before typed confirmation commits", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const expectedCount = plugin.expectedManagedRecordCount;
    const expectedDigest = plugin.expectedRecordDigest;
    assert.ok(expectedCount > 0);
    assert.match(String(expectedDigest), /^[0-9a-f]{64}$/);
    const candidate = await plugin.captureBaselineAdoptionCandidate(DEFAULT_SETTINGS.rootFolder);
    assert.ok(candidate);
    assert.equal(candidate.rawCount, expectedCount);
    assert.equal(candidate.inventory.total, expectedCount);
    assert.equal(candidate.inventory.digest, expectedDigest);

    // Model the modal remaining open while Sync removes a trusted record. The
    // delete callback arms recovery, and its path callback advances the frozen
    // revision before the user's already-previewed ADOPT decision is queued.
    const deletedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(deletedPath);
    app.vault.deleteRaw(deletedPath);
    plugin.blockIfActiveRootDisappeared(deletedPath);
    plugin.retryMigrationForPath(deletedPath);
    await plugin.persistWorkspaceSafety();

    StubNotice.history.length = 0;
    assert.equal(
      await plugin.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder, candidate),
      false,
      "confirmation must apply only to the exact full set shown in the modal preview"
    );
    assert.equal(plugin.expectedManagedRecordCount, expectedCount);
    assert.equal(plugin.expectedRecordDigest, expectedDigest);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.workspaceSafetyNeedsPersistence, false);

    const safety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(safety?.expectedManagedRecordCount, expectedCount);
    assert.equal(safety?.expectedRecordDigest, expectedDigest);
    assert.equal(safety?.rootRecoveryRequired, true);
    assert.equal(safety?.recoveryValidationRequired, true);

    const guidance = StubNotice.history.at(-1);
    assert.ok(guidance);
    assert.match(guidance.message, /changed after the baseline confirmation was shown/);
    assert.equal(guidance.hidden, false);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5107", caseName: "Frozen-preview deletion must stay blocked" })
      ),
      /configured folder is unavailable/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("externally strengthened safety invalidates an open baseline preview before it queues", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const diskCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    const expectedDigest = plugin.expectedRecordDigest;
    assert.equal(plugin.expectedManagedRecordCount, diskCount);
    assert.match(String(expectedDigest), /^[0-9a-f]{64}$/);
    const candidate = await plugin.captureBaselineAdoptionCandidate(DEFAULT_SETTINGS.rootFolder);
    assert.ok(candidate);
    assert.equal(candidate.rawCount, diskCount);
    assert.equal(candidate.inventory.digest, expectedDigest);

    // data.json from another device can commit N+1 before its matching record
    // file arrives. The already-open N-record modal must not be allowed to
    // replace this stricter safety state when the user later confirms it.
    const externalExpectedCount = diskCount + 1;
    const priorSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(priorSafety);
    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...priorSafety,
        expectedManagedRecordCount: externalExpectedCount,
        rootRecoveryRequired: true,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: true
      }
    };

    await plugin.onExternalSettingsChange();
    assert.equal(managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length, diskCount);
    assert.equal(plugin.expectedManagedRecordCount, externalExpectedCount);
    assert.equal(plugin.expectedRecordDigest, expectedDigest);
    assert.equal(plugin.missingRootRecoveryBlocked, true);

    StubNotice.history.length = 0;
    assert.equal(
      await plugin.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder, candidate),
      false,
      "an external settings revision invalidates the earlier typed preview before enqueue"
    );
    assert.equal(plugin.expectedManagedRecordCount, externalExpectedCount);
    assert.equal(plugin.expectedRecordDigest, expectedDigest);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.workspaceSafetyNeedsPersistence, false);

    const safety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(safety?.expectedManagedRecordCount, externalExpectedCount);
    assert.equal(safety?.expectedRecordDigest, expectedDigest);
    assert.equal(safety?.rootRecoveryRequired, true);
    assert.equal(safety?.recoveryValidationRequired, true);

    const guidance = StubNotice.history.at(-1);
    assert.ok(guidance);
    assert.match(
      guidance.message,
      /state changed while the confirmation was open|changed after the baseline confirmation was shown/
    );
    assert.equal(guidance.hidden, false);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5108", caseName: "External safety must stay blocked" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("only fresh typed adoption clears a persisted baseline-review barrier", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const priorSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(priorSafety);
    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...priorSafety,
        rootRecoveryRequired: true,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: true,
        baselineReviewRequired: true
      }
    };

    const reviewingRepository = new ClinicalRepository(app as unknown as App);
    const reviewing = makePlugin(app, reviewingRepository, () => stored, (data) => {
      stored = data;
    });
    await reviewing.loadSettings();
    reviewingRepository.setWriteBlock(reviewing.recoveryBlockMessage);
    assert.equal(reviewing.baselineReviewRequired, true);
    assert.equal(await reviewing.retryPendingMigrationRecovery(), false);
    assert.equal(reviewing.baselineReviewRequired, true);
    assert.equal(reviewing.migrationRecoveryBlocked, true);

    const freshCandidate = await reviewing.captureBaselineAdoptionCandidate(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(freshCandidate);
    assert.equal(
      await reviewing.confirmCurrentBaselineAdoption(
        DEFAULT_SETTINGS.rootFolder,
        freshCandidate
      ),
      true,
      "a fresh frozen typed confirmation is the only sanctioned review exit"
    );
    assert.equal(reviewing.baselineReviewRequired, false);
    assert.equal(reviewing.migrationRecoveryBlocked, false);
    const adoptedSafety = (stored as {
      workspaceSafety?: {
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(adoptedSafety?.rootRecoveryRequired, false);
    assert.equal(adoptedSafety?.recoveryValidationRequired, true);
    assert.equal(adoptedSafety?.baselineReviewRequired, false);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.baselineReviewRequired, false);
    assert.equal(await restarted.retryExactRestoredRootRecovery(), true);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    await new ClinicalService(restartedRepository).createEpisode(
      episodeInput({ mrn: "5109", caseName: "Writable after reviewed baseline restart" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("typed ADOPT stays in review when its shared save succeeds but the local journal update fails", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const seeded = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await seeded.noteManagedRecordWrite();
    const trustedInventory = await seeded.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const trustedSafety = (stored as { workspaceSafety?: Record<string, unknown> })
      .workspaceSafety;
    assert.ok(trustedSafety);
    const oldJournal = structuredClone(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY)
    ) as TestTrustedInventoryJournal | null;
    assert.ok(oldJournal?.trustedInventory);
    assert.equal(oldJournal.pending, false);
    assert.equal(
      oldJournal.trustedInventory.expectedRecordDigest,
      trustedInventory.digest
    );

    // Sync presents an equal-count replacement B while this device still has
    // the clean A anchor. That correctly starts in typed review.
    const replacedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(replacedPath);
    const replacedContent = app.vault.files.get(replacedPath);
    assert.ok(replacedContent);
    app.vault.writeRaw(
      replacedPath,
      replacedContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-adopt-journal-failure`
      )
    );
    const replacementInventory = await seeded.parsedRecordInventory(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.equal(replacementInventory.total, trustedInventory.total);
    assert.notEqual(replacementInventory.digest, trustedInventory.digest);
    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...trustedSafety,
        expectedManagedRecordCount: replacementInventory.total,
        expectedEntityCounts: { ...replacementInventory.counts },
        expectedRecordDigest: replacementInventory.digest,
        rootRecoveryRequired: true,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: true,
        baselineReviewRequired: true
      }
    };

    let sharedSaves = 0;
    const reviewingRepository = new ClinicalRepository(app as unknown as App);
    const reviewing = makePlugin(app, reviewingRepository, () => stored, (data) => {
      sharedSaves += 1;
      stored = data;
    });
    await reviewing.loadSettings();
    reviewingRepository.setWriteBlock(reviewing.recoveryBlockMessage);
    assert.equal(reviewing.baselineReviewRequired, true);
    assert.equal(reviewing.expectedRecordDigest, trustedInventory.digest);
    const candidate = await reviewing.captureBaselineAdoptionCandidate(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(candidate);
    assert.equal(candidate.inventory.digest, replacementInventory.digest);

    const saveLocalStorage = app.saveLocalStorage.bind(app);
    app.saveLocalStorage = (key, data) => {
      const journal = data as TestTrustedInventoryJournal;
      if (
        key === TRUSTED_INVENTORY_JOURNAL_KEY &&
        journal.pending === false &&
        journal.trustedInventory?.expectedRecordDigest === replacementInventory.digest
      ) {
        throw new Error("simulated post-ADOPT journal failure");
      }
      saveLocalStorage(key, data);
    };

    assert.equal(
      await reviewing.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder, candidate),
      false,
      "ADOPT cannot report success until its local anchor is durably updated"
    );
    assert.ok(sharedSaves > 0, "the accepted replacement reached shared plugin data first");
    assert.equal(
      (stored as { workspaceSafety?: { expectedRecordDigest?: string } })
        .workspaceSafety?.expectedRecordDigest,
      replacementInventory.digest
    );
    assert.deepEqual(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY),
      oldJournal,
      "a failed update must leave the previous trusted A anchor untouched"
    );
    assert.equal(reviewing.baselineReviewRequired, true);
    assert.equal(reviewing.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(reviewingRepository).createEpisode(
        episodeInput({ mrn: "5224", caseName: "Post-ADOPT journal failure blocked" })
      ),
      /synchronized recovery information conflicts/
    );

    // A restart merges shared B only as evidence; clean local A remains the
    // trust anchor and the equal-count conflict is still a typed-review gate.
    app.saveLocalStorage = saveLocalStorage;
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.expectedRecordDigest, trustedInventory.digest);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5225", caseName: "Restart after failed ADOPT journal blocked" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("typed adoption can deliberately accept a lower record baseline and restart exact", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const trustedCount = plugin.expectedManagedRecordCount;
    const trustedDigest = plugin.expectedRecordDigest;
    assert.ok(trustedCount > 1);
    assert.match(String(trustedDigest), /^[0-9a-f]{64}$/);

    const deletedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/Episodes/`));
    assert.ok(deletedPath);
    app.vault.deleteRaw(deletedPath);
    plugin.blockIfActiveRootDisappeared(deletedPath);
    await plugin.persistWorkspaceSafety();
    assert.equal(plugin.expectedManagedRecordCount, trustedCount);
    assert.equal(plugin.expectedRecordDigest, trustedDigest);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);

    const lowerCandidate = await plugin.captureBaselineAdoptionCandidate(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(lowerCandidate);
    assert.equal(lowerCandidate.rawCount, trustedCount - 1);
    assert.equal(lowerCandidate.inventory.total, trustedCount - 1);
    assert.notEqual(lowerCandidate.inventory.digest, trustedDigest);
    assert.equal(
      await plugin.confirmCurrentBaselineAdoption(
        DEFAULT_SETTINGS.rootFolder,
        lowerCandidate
      ),
      true,
      "typed ADOPT explicitly authorizes replacing the prior commitment with the lower set"
    );
    assert.equal(plugin.expectedManagedRecordCount, lowerCandidate.inventory.total);
    assert.deepEqual(plugin.expectedEntityCounts, lowerCandidate.inventory.counts);
    assert.equal(plugin.expectedRecordDigest, lowerCandidate.inventory.digest);
    assert.equal(plugin.baselineReviewRequired, false);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.migrationRecoveryBlocked, false);

    const adoptedSafety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(adoptedSafety?.expectedManagedRecordCount, lowerCandidate.inventory.total);
    assert.deepEqual(adoptedSafety?.expectedEntityCounts, lowerCandidate.inventory.counts);
    assert.equal(adoptedSafety?.expectedRecordDigest, lowerCandidate.inventory.digest);
    assert.equal(adoptedSafety?.rootRecoveryRequired, false);
    assert.equal(adoptedSafety?.recoveryValidationRequired, true);
    assert.equal(adoptedSafety?.baselineReviewRequired, false);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(
      restarted.migrationRecoveryBlocked,
      true,
      "restart begins fail-closed until the committed lower set is parsed exactly"
    );
    assert.equal(await restarted.retryExactRestoredRootRecovery(), true);
    assert.equal(restarted.expectedManagedRecordCount, lowerCandidate.inventory.total);
    assert.deepEqual(restarted.expectedEntityCounts, lowerCandidate.inventory.counts);
    assert.equal(restarted.expectedRecordDigest, lowerCandidate.inventory.digest);
    assert.equal(restarted.missingRootRecoveryBlocked, false);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    await new ClinicalService(restartedRepository).createEpisode(
      episodeInput({ mrn: "5214", caseName: "Writable after deliberate lower baseline" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a final-handoff delete and complete restore triggers a fresh exact recovery pass", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders].filter((path) =>
      path === DEFAULT_SETTINGS.rootFolder || path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    const finalFile = backedUpFiles.find(([path]) =>
      MANAGED_FOLDERS.some((folder) => path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`))
    );
    assert.ok(finalFile);
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    await firstPlugin.persistWorkspaceSafety();
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    const recoveringRepository = new ClinicalRepository(app as unknown as App);
    const recovering = makePlugin(app, recoveringRepository, () => stored, (data) => {
      stored = data;
    });
    await recovering.loadSettings();
    recoveringRepository.setWriteBlock(recovering.recoveryBlockMessage);

    const automaticRecoveries: Promise<boolean>[] = [];
    const automaticRecovery = recovering.retryExactRestoredRootRecovery.bind(recovering);
    recovering.retryExactRestoredRootRecovery = () => {
      const recovery = automaticRecovery();
      automaticRecoveries.push(recovery);
      return recovery;
    };
    const readInventory = recovering.parsedRecordInventory.bind(recovering);
    let inventoryScans = 0;
    recovering.parsedRecordInventory = async (root) => {
      const inventory = await readInventory(root);
      inventoryScans += 1;
      if (inventoryScans === 2) {
        // The first microtask lets the explicit operation consume its final
        // scan and request release. The nested microtask then models Obsidian's
        // delete/create callbacks immediately before the queue finalizer.
        queueMicrotask(() => {
          queueMicrotask(() => {
            app.vault.deleteRaw(finalFile[0]);
            recovering.blockIfActiveRootDisappeared(finalFile[0]);
            recovering.retryMigrationForPath(finalFile[0]);
            app.vault.writeRaw(finalFile[0], finalFile[1]);
            recovering.retryMigrationForPath(finalFile[0]);
          });
        });
      }
      return inventory;
    };

    StubNotice.history.length = 0;
    const explicitResult = await recovering.retryPendingMigrationRecovery();
    assert.equal(
      explicitResult,
      false,
      "the explicit command must not report success for the invalidated handoff snapshot"
    );
    assert.equal(
      StubNotice.history.some((notice) =>
        notice.message === "Clinical Workspace folder access was restored."
      ),
      false,
      "no success Notice may be emitted before the fresh exact pass completes"
    );
    assert.ok(automaticRecoveries.length > 0, "the late Sync callbacks queue exact recovery");
    assert.equal(await automaticRecoveries.at(-1), true);
    assert.ok(inventoryScans > 2, "the restored root is parsed again after the handoff race");
    assert.equal(recovering.migrationRecoveryBlocked, false);
    assert.equal(recovering.missingRootRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("late valid growth invalidates baseline-adoption success and stays fail-closed", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const acceptedInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);

    // Build a valid Sync delivery ahead of time, then remove it so adoption's
    // accepted and final scans both see the original trusted record set.
    const beforeGrowth = new Set(managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder));
    const syncRepository = new ClinicalRepository(app as unknown as App);
    await new ClinicalService(syncRepository).createEpisode(
      episodeInput({ mrn: "5105", caseName: "Final-handoff baseline growth" })
    );
    const growthFiles = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .filter((path) => !beforeGrowth.has(path))
      .map((path) => [path, app.vault.files.get(path)] as const);
    assert.ok(growthFiles.length > 0);
    assert.ok(growthFiles.every(([, content]) => content !== undefined));
    for (const [path] of growthFiles) app.vault.deleteRaw(path);
    assert.equal(
      (await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder)).total,
      acceptedInventory.total
    );

    const automaticRecoveries: Promise<boolean>[] = [];
    const automaticRecovery = plugin.retryExactRestoredRootRecovery.bind(plugin);
    plugin.retryExactRestoredRootRecovery = () => {
      const recovery = automaticRecovery();
      automaticRecoveries.push(recovery);
      return recovery;
    };
    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let adoptionScans = 0;
    plugin.parsedRecordInventory = async (root) => {
      const inventory = await readInventory(root);
      adoptionScans += 1;
      if (adoptionScans === 3) {
        // Let commitCurrentBaselineAdoption accept its final scan and request
        // release, then deliver valid growth before the queue finalizer runs.
        queueMicrotask(() => {
          queueMicrotask(() => {
            for (const [path, content] of growthFiles) {
              assert.ok(content);
              app.vault.writeRaw(path, content);
            }
            plugin.retryMigrationForPath(growthFiles[0]![0]);
          });
        });
      }
      return inventory;
    };

    StubNotice.history.length = 0;
    const adopted = await plugin.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder);
    assert.equal(
      adopted,
      false,
      "a committed candidate cannot report success after the final handoff revision changes"
    );
    assert.equal(
      StubNotice.history.some((notice) =>
        notice.message === "The current records are now the recovery baseline."
      ),
      false,
      "the false adoption result cannot drive the caller's success Notice"
    );
    assert.ok(automaticRecoveries.length > 0, "the late create queues a conservative exact pass");
    assert.equal(
      await automaticRecoveries.at(-1),
      false,
      "valid growth is not exact and therefore cannot auto-confirm a new baseline"
    );

    const deliveredInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(deliveredInventory.total, acceptedInventory.total + growthFiles.length);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    const guidance = StubNotice.history.at(-1);
    assert.ok(guidance);
    assert.match(guidance.message, /read-only/);
    assert.equal(guidance.hidden, false, "state-changed guidance survives queue finalization");
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5106", caseName: "Must remain blocked after late growth" })
      ),
      /configured folder is unavailable/
    );

    // The failed final handoff must survive a restart before any command can
    // reinterpret the grown root. Ordinary Retry only moves the durable state
    // into typed review; a fresh preview plus ADOPT is the sole release path.
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const rearmedSafety = (stored as {
      workspaceSafety?: {
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(rearmedSafety?.rootRecoveryRequired, true);
    assert.equal(rearmedSafety?.recoveryValidationRequired, true);
    assert.equal(rearmedSafety?.baselineReviewRequired, false);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.baselineReviewRequired, false);
    assert.equal(
      await restarted.retryPendingMigrationRecovery(),
      false,
      "ordinary Retry cannot accept the late grown record set"
    );
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(
      (stored as { workspaceSafety?: { baselineReviewRequired?: boolean } })
        .workspaceSafety?.baselineReviewRequired,
      true,
      "the typed-review requirement is durable before the user sees a new preview"
    );

    const freshCandidate = await restarted.captureBaselineAdoptionCandidate(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(freshCandidate);
    assert.equal(freshCandidate.inventory.total, deliveredInventory.total);
    assert.equal(
      await restarted.confirmCurrentBaselineAdoption(
        DEFAULT_SETTINGS.rootFolder,
        freshCandidate
      ),
      true,
      "only a fresh typed confirmation adopts the late growth"
    );
    assert.equal(restarted.baselineReviewRequired, false);
    assert.equal(restarted.missingRootRecoveryBlocked, false);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    const adoptedSafety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(adoptedSafety?.expectedManagedRecordCount, deliveredInventory.total);
    assert.equal(adoptedSafety?.expectedRecordDigest, deliveredInventory.digest);
    assert.equal(adoptedSafety?.rootRecoveryRequired, false);
    assert.equal(adoptedSafety?.recoveryValidationRequired, true);
    assert.equal(adoptedSafety?.baselineReviewRequired, false);
    await new ClinicalService(restartedRepository).createEpisode(
      episodeInput({ mrn: "5212", caseName: "Writable after fresh typed adoption" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("baseline adoption queues behind exact recovery and keeps writes blocked", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders];
    const backedUpFiles = [...app.vault.files].filter(([path]) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/`)
    );
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    let releaseAutomaticSave: () => void = () => undefined;
    let releaseAdoptionSave: () => void = () => undefined;
    let signalAutomaticSave: () => void = () => undefined;
    let signalAdoptionSave: () => void = () => undefined;
    const automaticSaveStarted = new Promise<void>((resolve) => {
      signalAutomaticSave = resolve;
    });
    const adoptionSaveStarted = new Promise<void>((resolve) => {
      signalAdoptionSave = resolve;
    });
    const automaticSaveGate = new Promise<void>((resolve) => {
      releaseAutomaticSave = resolve;
    });
    const adoptionSaveGate = new Promise<void>((resolve) => {
      releaseAdoptionSave = resolve;
    });
    let saveAttempt = 0;
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, async (data) => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        signalAutomaticSave();
        await automaticSaveGate;
      } else if (saveAttempt === 2) {
        signalAdoptionSave();
        await adoptionSaveGate;
      }
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    const automaticRecovery = restarted.retryExactRestoredRootRecovery();
    await automaticSaveStarted;
    let adoptionSettled = false;
    const adoption = restarted.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder)
      .then((value) => {
        adoptionSettled = true;
        return value;
      });
    await Promise.resolve();
    assert.equal(adoptionSettled, false);
    assert.equal(restarted.migrationRecoveryBlocked, true);

    releaseAutomaticSave();
    assert.equal(await automaticRecovery, true);
    await adoptionSaveStarted;
    assert.equal(adoptionSettled, false);
    assert.equal(
      restarted.migrationRecoveryBlocked,
      true,
      "the automatic success cannot open a gap before queued adoption commits"
    );
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5103", caseName: "Adoption barrier" })
      ),
      /trusted baseline/
    );

    releaseAdoptionSave();
    assert.equal(await adoption, true);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    assert.equal(
      (stored as { workspaceSafety?: { recoveryValidationRequired?: boolean } })
        .workspaceSafety?.recoveryValidationRequired,
      true
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("legacy count-only safety data never auto-unlocks a recovered root", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    const stored = {
      ...DEFAULT_SETTINGS,
      workspaceSafety: {
        ...persistedSafety(expectedCount),
        rootRecoveryRequired: true,
        recoveryRequiresRecords: true
      }
    };
    const plugin = makePlugin(app, repository, () => stored);
    await plugin.loadSettings();
    repository.setWriteBlock(plugin.recoveryBlockMessage);

    assert.equal(plugin.expectedEntityCounts, null);
    assert.equal(plugin.expectedRecordDigest, null);
    assert.equal(await plugin.retryExactRestoredRootRecovery(), false);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("automatic root recovery rejects a changed equal-count record set", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    plugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    // Restore the same number of files, but replace one parsed record. A raw
    // count match must never be enough to unlock writes automatically.
    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    for (const folder of MANAGED_FOLDERS) {
      await app.vault.createFolder(`${DEFAULT_SETTINGS.rootFolder}/${folder}`);
    }
    const expectedCount = Number(
      (stored as { workspaceSafety?: { expectedManagedRecordCount?: number } })
        .workspaceSafety?.expectedManagedRecordCount
    );
    for (let index = 0; index < expectedCount; index += 1) {
      app.vault.writeRaw(
        `${DEFAULT_SETTINGS.rootFolder}/Patients/replacement-${index}.md`,
        "# Not a managed clinical record"
      );
    }

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);

    assert.equal(await restarted.retryExactRestoredRootRecovery(), false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(episodeInput({ mrn: "5007" })),
      /configured folder is unavailable/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("automatic root recovery stays blocked when its cleared state cannot be saved", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const firstPlugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await firstPlugin.noteManagedRecordWrite();
    const backedUpFolders = [...app.vault.folders];
    const backedUpFiles = [...app.vault.files];
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    firstPlugin.blockIfActiveRootDisappeared(DEFAULT_SETTINGS.rootFolder);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, () => {
      throw new Error("simulated recovery-state save failure");
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    for (const folder of backedUpFolders) app.vault.folders.add(folder);
    for (const [path, content] of backedUpFiles) app.vault.writeRaw(path, content);

    assert.equal(await restarted.retryExactRestoredRootRecovery(), false);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.workspaceSafetyNeedsPersistence, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(episodeInput({ mrn: "5008" })),
      /configured folder is unavailable/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("0.3.5 settings require an explicit complete-baseline adoption before upgrade", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const upgrading = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });

    await upgrading.loadSettings();
    repository.setWriteBlock(upgrading.recoveryBlockMessage);
    upgrading.structureReady = false;
    const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    assert.ok(expectedCount > 0);
    assert.equal(upgrading.firstUseInitializationPending, true);
    assert.equal(upgrading.workspaceSafetyNeedsPersistence, false);
    await primeAdoption(upgrading, stored, expectedCount);
    await upgrading.initializeNewWorkspace();
    assert.equal(
      (stored as { workspaceSafety?: { expectedManagedRecordCount?: number } })
        .workspaceSafety?.expectedManagedRecordCount,
      expectedCount
    );
    await upgrading.ensureStructure();
    assert.equal(
      (stored as { workspaceSafety?: { initialized?: boolean } }).workspaceSafety?.initialized,
      true
    );

    // The folder disappears while the plugin is closed, so no delete callback
    // is available to persist an additional recovery flag.
    deleteRoot(app, DEFAULT_SETTINGS.rootFolder);
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restarted.structureReady = false;
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRequiresRecords, true);
    await assert.rejects(
      () => restarted.ensureStructure(),
      new RegExp("configured folder is unavailable")
    );
    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("initialization approval journals the exact baseline before a restart can trust it", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const approving = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await approving.loadSettings();
    repository.setWriteBlock(approving.recoveryBlockMessage);
    const approvedInventory = await approving.parsedRecordInventory(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(approvedInventory.total > 0);
    await primeAdoption(approving, stored, approvedInventory.total);

    await approving.initializeNewWorkspace();
    const approvedJournal = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      pending?: unknown;
      trustedInventory?: {
        expectedManagedRecordCount?: unknown;
        expectedEntityCounts?: unknown;
        expectedRecordDigest?: unknown;
      };
    } | null;
    assert.equal(approvedJournal?.pending, false);
    assert.deepEqual(
      approvedJournal?.trustedInventory && {
        expectedManagedRecordCount:
          approvedJournal.trustedInventory.expectedManagedRecordCount,
        expectedEntityCounts: approvedJournal.trustedInventory.expectedEntityCounts,
        expectedRecordDigest: approvedJournal.trustedInventory.expectedRecordDigest
      },
      {
        expectedManagedRecordCount: approvedInventory.total,
        expectedEntityCounts: approvedInventory.counts,
        expectedRecordDigest: approvedInventory.digest
      },
      "the exact approved tuple must be device-local before initialization opens writes"
    );

    const replacedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(replacedPath);
    const replacedContent = app.vault.files.get(replacedPath);
    assert.ok(replacedContent);
    assert.match(replacedContent, /^id:\s*.+$/m);
    app.vault.writeRaw(
      replacedPath,
      replacedContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-after-approval`
      )
    );
    assert.equal(
      managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length,
      approvedInventory.total,
      "the replacement preserves the raw count"
    );

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.expectedRecordDigest, approvedInventory.digest);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(
      await restarted.retryPendingMigrationRecovery(),
      false,
      "exact Retry detects the equal-count replacement without trusting it"
    );
    assert.equal(restarted.baselineReviewRequired, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5220", caseName: "Replacement after approval stays blocked" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("first-use approval stays blocked when its shared save succeeds but its local journal write fails", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = null;
    let sharedSaves = 0;
    const approving = makePlugin(app, repository, () => stored, (data) => {
      sharedSaves += 1;
      stored = data;
    });
    await approving.loadSettings();
    repository.setWriteBlock(approving.recoveryBlockMessage);
    const approvedInventory = await approving.parsedRecordInventory(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(approvedInventory.total > 0);
    await primeAdoption(approving, stored, approvedInventory.total);

    const saveLocalStorage = app.saveLocalStorage.bind(app);
    app.saveLocalStorage = () => {
      throw new Error("simulated first-use journal failure");
    };
    await assert.rejects(
      () => approving.initializeNewWorkspace(),
      /could not save its initialization state/
    );

    assert.ok(sharedSaves > 0, "the approval reached shared plugin data before journal failure");
    const approvedSafety = (stored as {
      workspaceSafety?: {
        initialized?: boolean;
        initializationApproved?: boolean;
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
      };
    } | null)?.workspaceSafety;
    assert.equal(approvedSafety?.initialized, false);
    assert.equal(approvedSafety?.initializationApproved, true);
    assert.equal(approvedSafety?.expectedManagedRecordCount, approvedInventory.total);
    assert.deepEqual(approvedSafety?.expectedEntityCounts, approvedInventory.counts);
    assert.equal(approvedSafety?.expectedRecordDigest, approvedInventory.digest);
    assert.equal(app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY), null);
    assert.equal(approving.firstUseInitializationPending, false);
    assert.equal(approving.missingRootRecoveryBlocked, true);
    assert.equal(approving.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5226", caseName: "First-use journal failure blocked" })
      ),
      /needs a trusted baseline/
    );

    // Device-local storage becomes available after restart. The shared
    // approval is still only a candidate: startup begins read-only, scans the
    // exact approved tuple twice around its canonical save, then seeds a clean
    // local journal before reopening writes.
    app.saveLocalStorage = saveLocalStorage;
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    restarted.structureReady = false;
    assert.equal(app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY), null);
    assert.equal(restarted.firstUseInitializationPending, false);
    assert.equal(restarted.baselineReviewRequired, false);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);

    const parsedRecordInventory = restarted.parsedRecordInventory.bind(restarted);
    let exactScans = 0;
    restarted.parsedRecordInventory = async (root) => {
      exactScans += 1;
      return parsedRecordInventory(root);
    };
    assert.equal(await restarted.retryExactRestoredRootRecovery(), true);
    assert.ok(exactScans >= 2, "restart rescans after its shared recovery save");
    assert.equal(restarted.migrationRecoveryBlocked, false);
    const recoveredJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(recoveredJournal?.pending, false);
    assert.deepEqual(
      recoveredJournal?.trustedInventory && {
        expectedManagedRecordCount:
          recoveredJournal.trustedInventory.expectedManagedRecordCount,
        expectedEntityCounts: recoveredJournal.trustedInventory.expectedEntityCounts,
        expectedRecordDigest: recoveredJournal.trustedInventory.expectedRecordDigest
      },
      {
        expectedManagedRecordCount: approvedInventory.total,
        expectedEntityCounts: approvedInventory.counts,
        expectedRecordDigest: approvedInventory.digest
      }
    );

    await restarted.ensureStructure();
    await new ClinicalService(restartedRepository).createEpisode(
      episodeInput({ mrn: "5227", caseName: "Writable after exact approval recovery" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a safety-metadata save failure rejects the verified write and arms recovery", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const trustedBefore = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(trustedBefore?.pending, false);
    assert.ok(trustedBefore?.trustedInventory);

    const record: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-safety-save-failure`,
      case: "Safety persistence failure"
    };
    const path = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${record.id}.md`;
    plugin.saveData = async () => {
      throw new Error("simulated settings write failure");
    };

    await assert.rejects(() => repository.create(record));

    assert.ok(
      app.vault.getAbstractFileByPath(path),
      "the repository verified the record before its safety observer failed"
    );
    assert.equal(repository.isManagedRecordMutationInProgress(path), false);
    const mutationPause = await repository.pauseManagedRecordMutations();
    assert.equal(mutationPause.drainedExisting, false, "the rejected write drains its claim");
    mutationPause.release();
    const pendingJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingJournal?.pending, true);
    assert.deepEqual(pendingJournal?.trustedInventory, trustedBefore.trustedInventory);
    assert.equal(plugin.workspaceSafetyNeedsPersistence, true);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    await assert.rejects(
      () => repository.create({ ...record, id: `${record.id}-blocked` }),
      /recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("null plugin data and a missing root stay read-only until explicit initialization", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    const repository = new ClinicalRepository(app as unknown as App);
    let saved: unknown = null;
    const plugin = makePlugin(app, repository, () => null, (data) => {
      saved = data;
    });

    await plugin.loadSettings();
    repository.setWriteBlock(
      plugin.migrationRecoveryBlocked ? plugin.recoveryBlockMessage : null
    );
    plugin.structureReady = false;

    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(() => plugin.ensureStructure(), /needs a trusted baseline/);
    assert.equal(
      app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder),
      null,
      "cancelling or taking no action creates nothing"
    );

    await primeAdoption(plugin, null, 0);
    await plugin.initializeNewWorkspace();
    assert.equal(
      app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder),
      null,
      "the initialization decision is persisted before scaffolding"
    );
    assert.equal(
      (saved as { workspaceSafety?: { initialized?: boolean; initializationApproved?: boolean } } | null)
        ?.workspaceSafety?.initializationApproved,
      true,
      "the durable approval is saved before scaffolding"
    );
    await plugin.ensureStructure();
    assert.ok(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder));
    assert.equal(
      (saved as { workspaceSafety?: { initialized?: boolean; initializationApproved?: boolean } } | null)
        ?.workspaceSafety?.initialized,
      true
    );
    assert.equal(
      (saved as { workspaceSafety?: { initializationApproved?: boolean } } | null)
        ?.workspaceSafety?.initializationApproved,
      false
    );
    assert.equal(plugin.firstUseInitializationPending, false);
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a failed initialization-state save creates no folders and remains blocked", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    const repository = new ClinicalRepository(app as unknown as App);
    const plugin = makePlugin(app, repository, () => null, () => {
      throw new Error("simulated settings write failure");
    });

    await plugin.loadSettings();
    repository.setWriteBlock(plugin.recoveryBlockMessage);
    plugin.structureReady = false;

    await assert.rejects(
      async () => {
        await primeAdoption(plugin, null, 0);
        return plugin.initializeNewWorkspace();
      },
      /could not save its initialization state/
    );
    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);
    await assert.rejects(() => plugin.ensureStructure(), /needs a trusted baseline/);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("records changing after approval require a fresh adoption before scaffolding", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    const repository = new ClinicalRepository(app as unknown as App);
    let stored: unknown = null;
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });

    await plugin.loadSettings();
    repository.setWriteBlock(plugin.recoveryBlockMessage);
    plugin.structureReady = false;
    await primeAdoption(plugin, stored, 0);
    await plugin.initializeNewWorkspace();

    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    await app.vault.createFolder(`${DEFAULT_SETTINGS.rootFolder}/Episodes`);
    app.vault.writeRaw(
      `${DEFAULT_SETTINGS.rootFolder}/Episodes/EPI-late.md`,
      "---\nentity: episode\nid: EPI-late\n---\n"
    );

    await assert.rejects(() => plugin.ensureStructure(), /needs a trusted baseline/);
    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(app.vault.getAbstractFileByPath(`${DEFAULT_SETTINGS.rootFolder}/Patients`), null);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an approved initialization resumes safely after restart before scaffolding", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    const repository = new ClinicalRepository(app as unknown as App);
    let stored: unknown = null;
    const approving = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await approving.loadSettings();
    repository.setWriteBlock(approving.recoveryBlockMessage);
    approving.structureReady = false;
    await primeAdoption(approving, stored, 0);
    await approving.initializeNewWorkspace();

    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });

    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );
    restarted.structureReady = false;
    assert.equal(restarted.firstUseInitializationPending, false);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    await restarted.ensureStructure();

    assert.ok(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder));
    assert.equal(
      (stored as { workspaceSafety?: { initialized?: boolean; initializationApproved?: boolean } })
        .workspaceSafety?.initialized,
      true
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("null plugin data with managed records still requires explicit baseline adoption", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const plugin = makePlugin(app, repository, () => null);

    await plugin.loadSettings();

    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.workspaceInitialized, false);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("null plugin data with only an empty parent remains ambiguous", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    const repository = new ClinicalRepository(app as unknown as App);
    const plugin = makePlugin(app, repository, () => null);

    await plugin.loadSettings();

    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a safetyless settings change while adoption is open cancels instead of overwriting Sync", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    const repository = new ClinicalRepository(app as unknown as App);
    let stored: unknown = null;
    let saves = 0;
    const plugin = makePlugin(app, repository, () => stored, () => {
      saves += 1;
    });
    await plugin.loadSettings();
    repository.setWriteBlock(plugin.recoveryBlockMessage);
    await primeAdoption(plugin, stored, 0);

    stored = {
      ...DEFAULT_SETTINGS,
      rootFolder: "Ward Records",
      clinicianName: "Synced clinician"
    };

    await assert.rejects(
      () => plugin.initializeNewWorkspace(),
      /state changed while the confirmation was open/
    );
    assert.equal(saves, 0);
    assert.equal(plugin.settings.rootFolder, "Ward Records");
    assert.equal(plugin.settings.clinicianName, "Synced clinician");
    assert.equal(plugin.firstUseInitializationPending, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("restart with marker-before-folder remains blocked and does not scaffold the destination", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    const stored = { ...DEFAULT_SETTINGS, rootFolder: marker.to, migrationInProgress: marker };
    const plugin = makePlugin(app, repository, () => stored);

    await plugin.loadSettings();
    assert.equal(clinicalRootFolder(), marker.from, "startup does not activate the stored destination");
    assert.equal((await repository.list<EpisodeRecord>("episode")).length, 1, "restored views can still read source");
    repository.setWriteBlock(CLINICAL_WRITES_BLOCKED_MESSAGE);
    assert.equal(await plugin.retryMigrationReconciliation(), false);

    assert.equal(clinicalRootFolder(), marker.from);
    assert.equal(app.vault.getAbstractFileByPath(marker.to), null);
    await assert.rejects(() => repository.ensureStructure(), new RegExp("temporarily read-only"));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a benign external settings read blocks writes until its callback fully applies", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    assert.equal(plugin.migrationRecoveryBlocked, false);

    const benignSnapshot = structuredClone(stored);
    let signalLoadStarted: () => void = () => undefined;
    let releaseLoad: () => void = () => undefined;
    const loadStarted = new Promise<void>((resolve) => {
      signalLoadStarted = resolve;
    });
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    plugin.loadData = async () => {
      signalLoadStarted();
      await loadGate;
      return structuredClone(benignSnapshot);
    };

    let callbackSettled = false;
    const callback = plugin.onExternalSettingsChange().then(() => {
      callbackSettled = true;
    });
    await loadStarted;

    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(callbackSettled, false);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5201", caseName: "Blocked during external settings read" })
      ),
      /temporarily read-only/
    );

    releaseLoad();
    await callback;
    assert.equal(plugin.migrationRecoveryBlocked, false);
    await new ClinicalService(repository).createEpisode(
      episodeInput({ mrn: "5202", caseName: "Writable after benign external settings" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a canonical external settings write wins over an older local safety save", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localCount = plugin.expectedManagedRecordCount;
    const localSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(localSafety);

    let signalOldSaveStarted: () => void = () => undefined;
    let releaseOldSave: () => void = () => undefined;
    const oldSaveStarted = new Promise<void>((resolve) => {
      signalOldSaveStarted = resolve;
    });
    const oldSaveGate = new Promise<void>((resolve) => {
      releaseOldSave = resolve;
    });
    let saveAttempt = 0;
    plugin.saveData = async (data) => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        signalOldSaveStarted();
        await oldSaveGate;
      }
      stored = structuredClone(data);
    };

    const olderLocalSave = plugin.persistWorkspaceSafety();
    await oldSaveStarted;
    const externalCount = localCount + 1;
    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...localSafety,
        expectedManagedRecordCount: externalCount,
        rootRecoveryRequired: true,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: true
      }
    };

    let callbackSettled = false;
    const callback = plugin.onExternalSettingsChange().then(() => {
      callbackSettled = true;
    });
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const settledBeforeOldSave = callbackSettled;
    releaseOldSave();
    await Promise.all([olderLocalSave, callback]);

    assert.equal(
      settledBeforeOldSave,
      false,
      "the callback must queue a canonical snapshot behind the older in-flight save"
    );
    assert.ok(saveAttempt >= 2, "external application persists a canonical final snapshot");
    const finalSafety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(finalSafety?.expectedManagedRecordCount, externalCount);
    assert.equal(finalSafety?.rootRecoveryRequired, true);
    assert.equal(finalSafety?.recoveryValidationRequired, true);
    assert.equal(finalSafety?.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("legacy count-only safety reviews an equal complete snapshot that matches disk", async () => {
  await assertLegacyCountOnlyEqualCommitmentRequiresReview(false);
});

test("legacy count-only safety reviews an equal complete snapshot that conflicts with disk", async () => {
  await assertLegacyCountOnlyEqualCommitmentRequiresReview(true);
});

test("an initialization-approved higher incomplete snapshot cannot weaken a trusted running baseline", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(plugin.workspaceInitialized, true);
    assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);

    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        version: 1,
        initialized: false,
        initializationApproved: true,
        managedRecordsExpected: true,
        expectedManagedRecordCount: localInventory.total + 1,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };

    await plugin.onExternalSettingsChange();

    assert.equal(plugin.workspaceInitialized, true, "the trusted local state is not downgraded");
    assert.equal(plugin.expectedManagedRecordCount, localInventory.total + 1);
    assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5213", caseName: "Incomplete initialization snapshot blocked" })
      ),
      /synchronized recovery information conflicts/
    );

    const persisted = (stored as {
      workspaceSafety?: {
        initialized?: boolean;
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(persisted?.initialized, true);
    assert.equal(persisted?.expectedManagedRecordCount, localInventory.total + 1);
    assert.deepEqual(persisted?.expectedEntityCounts, localInventory.counts);
    assert.equal(persisted?.expectedRecordDigest, localInventory.digest);
    assert.equal(persisted?.rootRecoveryRequired, true);
    assert.equal(persisted?.recoveryValidationRequired, true);
    assert.equal(persisted?.baselineReviewRequired, true);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.workspaceInitialized, true);
    assert.equal(restarted.expectedManagedRecordCount, localInventory.total + 1);
    assert.deepEqual(restarted.expectedEntityCounts, localInventory.counts);
    assert.equal(restarted.expectedRecordDigest, localInventory.digest);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("startup treats a corrupt current-version trusted journal as a write barrier", async () => {
  await assertInvalidTrustedJournalFailsClosed({
    version: 1,
    generation: -1,
    pending: false
  });
});

test("startup treats an unknown trusted-journal version as a write barrier", async () => {
  await assertInvalidTrustedJournalFailsClosed({
    version: 2,
    generation: 0,
    pending: false
  });
});

test("startup rejects a noncanonical retired-root fingerprint commitment", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const seeded = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await seeded.noteManagedRecordWrite();
    const clean = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(clean?.trustedInventory);

    const malformed = {
      ...clean,
      retiredRootFingerprints: ["b".repeat(64), "a".repeat(64)]
    };
    app.saveLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY, malformed);
    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);

    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.deepEqual(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY),
      malformed,
      "startup never normalizes or blesses an invalid local commitment"
    );
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5223", caseName: "Malformed tombstone commitment" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a throwing device-local journal save fails closed before external settings load", async () => {
  await assertTrustedJournalArmFailureFailsClosed((app) => {
    app.saveLocalStorage = () => {
      throw new Error("device-local storage unavailable");
    };
  });
});

test("a device-local journal read-back mismatch fails closed before external settings load", async () => {
  await assertTrustedJournalArmFailureFailsClosed((app) => {
    // Model a storage layer that reports success but silently drops the new
    // pending generation. The implementation must verify its write-back.
    app.saveLocalStorage = () => undefined;
  });
});

test("a device-local trusted inventory survives interruption before conflict review is saved", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const trustedA = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const trustedASafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(trustedASafety);

    // Replace one trusted record and add two different records. B has a higher
    // count than A, but its digest cannot prove that A is a subset of B.
    const replacedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(replacedPath);
    const replacedContent = app.vault.files.get(replacedPath);
    assert.ok(replacedContent);
    assert.match(replacedContent, /^id:\s*.+$/m);
    const replacedFolder = replacedPath.slice(0, replacedPath.lastIndexOf("/") + 1);
    app.vault.deleteRaw(replacedPath);
    for (const suffix of ["restart-conflict-b1", "restart-conflict-b2"]) {
      app.vault.writeRaw(
        `${replacedFolder}external-${suffix}.md`,
        replacedContent.replace(
          /^id:\s*(.+)$/m,
          (_line, id: string) => `id: ${id.trim()}-${suffix}`
        )
      );
    }
    const externalB = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(externalB.total, trustedA.total + 1);
    assert.notEqual(externalB.digest, trustedA.digest);

    // Sync has already replaced data.json with B. Suspend the callback at its
    // first canonical review save, then model process termination by creating a
    // fresh plugin instance on the same App/device without releasing that save.
    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...trustedASafety,
        expectedManagedRecordCount: externalB.total,
        expectedEntityCounts: { ...externalB.counts },
        expectedRecordDigest: externalB.digest,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };
    let signalCanonicalSaveStarted: () => void = () => undefined;
    const canonicalSaveStarted = new Promise<void>((resolve) => {
      signalCanonicalSaveStarted = resolve;
    });
    const interruptedSave = new Promise<void>(() => undefined);
    plugin.saveData = async () => {
      signalCanonicalSaveStarted();
      await interruptedSave;
    };

    const interruptedCallback = plugin.onExternalSettingsChange();
    await canonicalSaveStarted;
    const stillPending = await Promise.race([
      interruptedCallback.then(() => false),
      Promise.resolve(true)
    ]);
    assert.equal(stillPending, true, "the old plugin is interrupted inside its canonical save");

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    const journalAtRestart = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      version?: unknown;
      generation?: unknown;
      pending?: unknown;
      trustedInventory?: {
        rootFingerprint?: unknown;
        expectedManagedRecordCount?: unknown;
        expectedEntityCounts?: unknown;
        expectedRecordDigest?: unknown;
      };
    } | null;
    assert.deepEqual(
      {
        expectedFloor: restarted.expectedManagedRecordCount,
        trustedCounts: restarted.expectedEntityCounts,
        trustedDigest: restarted.expectedRecordDigest,
        baselineReviewRequired: restarted.baselineReviewRequired,
        writesBlocked: restarted.migrationRecoveryBlocked,
        journalAtRestart: journalAtRestart && {
          version: journalAtRestart.version,
          generationIsPositiveSafeInteger:
            Number.isSafeInteger(journalAtRestart.generation) &&
            (journalAtRestart.generation as number) > 0,
          pending: journalAtRestart.pending,
          trustedInventory: journalAtRestart.trustedInventory && {
            rootFingerprintIsSha256:
              typeof journalAtRestart.trustedInventory.rootFingerprint === "string" &&
              /^[0-9a-f]{64}$/.test(journalAtRestart.trustedInventory.rootFingerprint),
            expectedManagedRecordCount:
              journalAtRestart.trustedInventory.expectedManagedRecordCount,
            expectedEntityCounts: journalAtRestart.trustedInventory.expectedEntityCounts,
            expectedRecordDigest: journalAtRestart.trustedInventory.expectedRecordDigest
          }
        }
      },
      {
        expectedFloor: externalB.total,
        trustedCounts: trustedA.counts,
        trustedDigest: trustedA.digest,
        baselineReviewRequired: true,
        writesBlocked: true,
        journalAtRestart: {
          version: 1,
          generationIsPositiveSafeInteger: true,
          pending: true,
          trustedInventory: {
            rootFingerprintIsSha256: true,
            expectedManagedRecordCount: trustedA.total,
            expectedEntityCounts: trustedA.counts,
            expectedRecordDigest: trustedA.digest
          }
        }
      },
      "restart must merge B only as a floor while the device-local A tuple remains trusted"
    );
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5219", caseName: "Interrupted conflict stays read-only" })
      ),
      /synchronized recovery information conflicts/
    );
    assert.equal(
      await restarted.retryPendingMigrationRecovery(),
      false,
      "ordinary Retry cannot accept conflicting B"
    );

    const candidate = await restarted.captureBaselineAdoptionCandidate(
      DEFAULT_SETTINGS.rootFolder
    );
    assert.ok(candidate);
    assert.equal(candidate.inventory.digest, externalB.digest);
    assert.equal(
      await restarted.confirmCurrentBaselineAdoption(DEFAULT_SETTINGS.rootFolder, candidate),
      true,
      "only the separately typed ADOPT path can replace trusted A with B"
    );
    assert.equal(restarted.baselineReviewRequired, false);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    assert.equal(restarted.expectedManagedRecordCount, externalB.total);
    assert.deepEqual(restarted.expectedEntityCounts, externalB.counts);
    assert.equal(restarted.expectedRecordDigest, externalB.digest);
    const journalAfterAdopt = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      version?: unknown;
      generation?: unknown;
      pending?: unknown;
      trustedInventory?: {
        rootFingerprint?: unknown;
        expectedManagedRecordCount?: unknown;
        expectedEntityCounts?: unknown;
        expectedRecordDigest?: unknown;
      };
    } | null;
    assert.deepEqual(
      journalAfterAdopt && {
        version: journalAfterAdopt.version,
        generation: journalAfterAdopt.generation,
        pending: journalAfterAdopt.pending,
        trustedInventory: journalAfterAdopt.trustedInventory && {
          rootFingerprint: journalAfterAdopt.trustedInventory.rootFingerprint,
          expectedManagedRecordCount:
            journalAfterAdopt.trustedInventory.expectedManagedRecordCount,
          expectedEntityCounts: journalAfterAdopt.trustedInventory.expectedEntityCounts,
          expectedRecordDigest: journalAfterAdopt.trustedInventory.expectedRecordDigest
        }
      },
      {
        version: 1,
        generation: journalAtRestart?.generation,
        pending: false,
        trustedInventory: {
          rootFingerprint: journalAtRestart?.trustedInventory?.rootFingerprint,
          expectedManagedRecordCount: externalB.total,
          expectedEntityCounts: externalB.counts,
          expectedRecordDigest: externalB.digest
        }
      },
      "successful typed adoption replaces the clean local journal only after verification"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an older external callback cannot clear a newer journal generation", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const externalSnapshot = structuredClone(stored);
    let resolveFirstRead: (value: unknown) => void = () => undefined;
    let resolveSecondRead: (value: unknown) => void = () => undefined;
    const firstRead = new Promise<unknown>((resolve) => {
      resolveFirstRead = resolve;
    });
    const secondRead = new Promise<unknown>((resolve) => {
      resolveSecondRead = resolve;
    });
    let reads = 0;
    plugin.loadData = () => {
      reads += 1;
      return reads === 1 ? firstRead : secondRead;
    };

    const firstCallback = plugin.onExternalSettingsChange();
    const firstPending = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      generation?: unknown;
      pending?: unknown;
    } | null;
    assert.ok(firstPending);
    assert.equal(firstPending.pending, true);
    assert.equal(typeof firstPending.generation, "number");

    const secondCallback = plugin.onExternalSettingsChange();
    const secondPending = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      generation?: unknown;
      pending?: unknown;
    } | null;
    assert.ok(secondPending);
    assert.equal(secondPending.pending, true);
    assert.equal(
      secondPending.generation,
      (firstPending.generation as number) + 1,
      "each callback owns a distinct stale-clear token"
    );

    resolveFirstRead(structuredClone(externalSnapshot));
    await firstCallback;
    assert.deepEqual(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY),
      secondPending,
      "finishing the older callback must leave the newer generation pending"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);

    resolveSecondRead(structuredClone(externalSnapshot));
    await secondCallback;
    const settled = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      generation?: unknown;
      pending?: unknown;
    } | null;
    assert.ok(settled);
    assert.equal(settled.generation, secondPending.generation);
    assert.equal(settled.pending, false);
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a benign external callback clears its journal only after canonical save and final exact scan", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    let signalCanonicalSaveStarted: () => void = () => undefined;
    let releaseCanonicalSave: () => void = () => undefined;
    const canonicalSaveStarted = new Promise<void>((resolve) => {
      signalCanonicalSaveStarted = resolve;
    });
    const canonicalSaveGate = new Promise<void>((resolve) => {
      releaseCanonicalSave = resolve;
    });
    let saves = 0;
    plugin.saveData = async (data) => {
      saves += 1;
      if (saves === 1) {
        signalCanonicalSaveStarted();
        await canonicalSaveGate;
      }
      stored = structuredClone(data);
    };

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let scans = 0;
    let signalFinalScanReady: () => void = () => undefined;
    let releaseFinalScan: () => void = () => undefined;
    const finalScanReady = new Promise<void>((resolve) => {
      signalFinalScanReady = resolve;
    });
    const finalScanGate = new Promise<void>((resolve) => {
      releaseFinalScan = resolve;
    });
    plugin.parsedRecordInventory = async (root) => {
      scans += 1;
      const inventory = await readInventory(root);
      if (scans === 2) {
        signalFinalScanReady();
        await finalScanGate;
      }
      return inventory;
    };

    const callback = plugin.onExternalSettingsChange();
    await canonicalSaveStarted;
    const pendingDuringCanonicalSave = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as { generation?: unknown; pending?: unknown } | null;
    assert.ok(pendingDuringCanonicalSave);
    assert.equal(pendingDuringCanonicalSave.pending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);

    releaseCanonicalSave();
    await finalScanReady;
    assert.equal(saves, 2, "the canonical merge and recovery-barrier save both completed");
    assert.equal(scans, 2, "the final exact inventory scan is suspended before returning");
    assert.deepEqual(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY),
      pendingDuringCanonicalSave,
      "the journal remains pending until the final exact scan returns"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);

    releaseFinalScan();
    await callback;
    const settled = app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      generation?: unknown;
      pending?: unknown;
    } | null;
    assert.ok(settled);
    assert.equal(settled.generation, pendingDuringCanonicalSave.generation);
    assert.equal(settled.pending, false);
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a higher complete same-root commitment requires durable typed baseline review", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localCount = plugin.expectedManagedRecordCount;
    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(localInventory.total, localCount);
    const localPaths = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder);
    const sourcePath = localPaths.at(-1);
    assert.ok(sourcePath);
    const sourceContent = app.vault.files.get(sourcePath);
    assert.ok(sourceContent);
    assert.match(sourceContent, /^id:\s*.+$/m);
    const healthierPath = `${sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)}external-healthier-record.md`;
    const healthierContent = sourceContent.replace(
      /^id:\s*(.+)$/m,
      (_line, id: string) => `id: ${id.trim()}-external-healthier`
    );
    app.vault.writeRaw(healthierPath, healthierContent);
    const healthierInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(healthierInventory.total, localCount + 1);
    app.vault.deleteRaw(healthierPath);
    assert.equal(managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length, localCount);

    const localSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(localSafety);
    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...localSafety,
        expectedManagedRecordCount: healthierInventory.total,
        expectedEntityCounts: { ...healthierInventory.counts },
        expectedRecordDigest: healthierInventory.digest,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };

    await plugin.onExternalSettingsChange();
    assert.equal(plugin.expectedManagedRecordCount, localCount + 1);
    assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.baselineReviewRequired, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5203", caseName: "Record has not synced yet" })
      ),
      /synchronized recovery information conflicts/
    );

    const persistedSafety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(persistedSafety?.expectedManagedRecordCount, localCount + 1);
    assert.deepEqual(persistedSafety?.expectedEntityCounts, localInventory.counts);
    assert.equal(persistedSafety?.expectedRecordDigest, localInventory.digest);
    assert.equal(persistedSafety?.rootRecoveryRequired, true);
    assert.equal(persistedSafety?.recoveryValidationRequired, true);
    assert.equal(persistedSafety?.baselineReviewRequired, true);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.deepEqual(restarted.expectedEntityCounts, localInventory.counts);
    assert.equal(restarted.expectedRecordDigest, localInventory.digest);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "5204", caseName: "Durable healthier safety barrier" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("replacement plus growth cannot masquerade as an automatically trusted higher baseline", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const localSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(localSafety);

    const replacedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).at(-1);
    assert.ok(replacedPath);
    const replacedContent = app.vault.files.get(replacedPath);
    assert.ok(replacedContent);
    assert.match(replacedContent, /^id:\s*.+$/m);
    const folder = replacedPath.slice(0, replacedPath.lastIndexOf("/") + 1);
    app.vault.deleteRaw(replacedPath);
    for (const suffix of ["replacement-a", "replacement-b"]) {
      app.vault.writeRaw(
        `${folder}external-${suffix}.md`,
        replacedContent.replace(
          /^id:\s*(.+)$/m,
          (_line, id: string) => `id: ${id.trim()}-external-${suffix}`
        )
      );
    }
    const replacementGrowth = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(replacementGrowth.total, localInventory.total + 1);
    assert.ok(
      Object.keys(localInventory.counts).every((entity) =>
        replacementGrowth.counts[entity as keyof TestRecordInventory["counts"]] >=
          localInventory.counts[entity as keyof TestRecordInventory["counts"]]
      ),
      "aggregate per-entity counts look like growth even though one trusted id was replaced"
    );
    assert.notEqual(replacementGrowth.digest, localInventory.digest);

    stored = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...localSafety,
        expectedManagedRecordCount: replacementGrowth.total,
        expectedEntityCounts: { ...replacementGrowth.counts },
        expectedRecordDigest: replacementGrowth.digest,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };

    await plugin.onExternalSettingsChange();

    assert.equal(plugin.expectedManagedRecordCount, replacementGrowth.total);
    assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(await plugin.retryPendingMigrationRecovery(), false);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5205", caseName: "Replacement plus growth needs review" })
      ),
      /synchronized recovery information conflicts/
    );

    const persisted = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(persisted?.expectedManagedRecordCount, replacementGrowth.total);
    assert.deepEqual(persisted?.expectedEntityCounts, localInventory.counts);
    assert.equal(persisted?.expectedRecordDigest, localInventory.digest);
    assert.equal(persisted?.rootRecoveryRequired, true);
    assert.equal(persisted?.recoveryValidationRequired, true);
    assert.equal(persisted?.baselineReviewRequired, true);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.expectedManagedRecordCount, replacementGrowth.total);
    assert.deepEqual(restarted.expectedEntityCounts, localInventory.counts);
    assert.equal(restarted.expectedRecordDigest, localInventory.digest);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a newer external commitment wins when an older root verification is still suspended", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const localSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(localSafety);

    const growthPath = addDistinctManagedRecord(app, DEFAULT_SETTINGS.rootFolder, "queued-newer");
    const higherInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(higherInventory.total, localInventory.total + 1);
    app.vault.deleteRaw(growthPath);
    await renameRoot(app, DEFAULT_SETTINGS.rootFolder, "Ward Records");

    const olderSnapshot = {
      ...(stored as Record<string, unknown>),
      rootFolder: "Ward Records"
    };
    const strongerSnapshot = {
      ...(stored as Record<string, unknown>),
      rootFolder: "Ward Records",
      workspaceSafety: {
        ...localSafety,
        expectedManagedRecordCount: higherInventory.total,
        expectedEntityCounts: { ...higherInventory.counts },
        expectedRecordDigest: higherInventory.digest,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };
    const snapshots = [olderSnapshot, strongerSnapshot];
    let reads = 0;
    plugin.loadData = async () => {
      const snapshot = snapshots[reads];
      reads += 1;
      assert.ok(snapshot);
      return structuredClone(snapshot);
    };

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let signalVerificationStarted: () => void = () => undefined;
    let releaseVerification: () => void = () => undefined;
    const verificationStarted = new Promise<void>((resolve) => {
      signalVerificationStarted = resolve;
    });
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let gated = false;
    plugin.parsedRecordInventory = async (root) => {
      if (root === "Ward Records" && !gated) {
        gated = true;
        signalVerificationStarted();
        await verificationGate;
      }
      return readInventory(root);
    };

    const olderCallback = plugin.onExternalSettingsChange();
    await verificationStarted;
    const newerCallback = plugin.onExternalSettingsChange();
    assert.equal(reads, 2, "the newer callback captures its own snapshot before it queues");
    releaseVerification();
    await Promise.all([olderCallback, newerCallback]);

    assert.equal(plugin.expectedManagedRecordCount, higherInventory.total);
    assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: { from: DEFAULT_SETTINGS.rootFolder, to: "Ward Records" }
    });
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5206", caseName: "Newer queued commitment remains blocked" })
      ),
      /read-only/
    );

    const persisted = stored as {
      rootFolder?: string;
      migrationInProgress?: MigrationMarker;
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    };
    assert.equal(persisted.rootFolder, "Ward Records");
    assert.deepEqual(persisted.migrationInProgress, {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    });
    assert.equal(persisted.workspaceSafety?.expectedManagedRecordCount, higherInventory.total);
    assert.deepEqual(persisted.workspaceSafety?.expectedEntityCounts, localInventory.counts);
    assert.equal(persisted.workspaceSafety?.expectedRecordDigest, localInventory.digest);
    assert.equal(persisted.workspaceSafety?.rootRecoveryRequired, true);
    assert.equal(persisted.workspaceSafety?.recoveryValidationRequired, true);
    assert.equal(persisted.workspaceSafety?.baselineReviewRequired, true);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    assert.equal(restarted.expectedManagedRecordCount, higherInventory.total);
    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a marker-free third-root delivery cannot be forgotten by an overlapping local migration", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const localDestination = "Local Concurrent Target";
    const deliveredDestination = "Synced Concurrent Target";
    copyRoot(app, DEFAULT_SETTINGS.rootFolder, deliveredDestination);
    const deliveredOnlyPath = addDistinctManagedRecord(
      app,
      deliveredDestination,
      "overlapping-third-root"
    );
    const deliveredSnapshot = {
      ...(structuredClone(stored) as Record<string, unknown>),
      rootFolder: deliveredDestination,
      retiredRootFolders: [DEFAULT_SETTINGS.rootFolder]
    };
    delete (deliveredSnapshot as { migrationInProgress?: MigrationMarker })
      .migrationInProgress;

    const renameFile = app.fileManager.renameFile.bind(app.fileManager);
    let signalRenameStarted: () => void = () => undefined;
    let releaseRename: () => void = () => undefined;
    const renameStarted = new Promise<void>((resolve) => {
      signalRenameStarted = resolve;
    });
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    app.fileManager.renameFile = async (file, newPath) => {
      if (file.path === DEFAULT_SETTINGS.rootFolder && newPath === localDestination) {
        signalRenameStarted();
        await renameGate;
      }
      return renameFile(file, newPath);
    };

    const localMigration = plugin.migrateRootFolder(localDestination).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await renameStarted;

    // Sync has delivered C's folder contents and a marker-free C data.json
    // after the local A -> B marker was saved, but before A is renamed to B.
    // Capture that callback before letting the local rename continue so the
    // callback cannot accidentally read a later canonical A -> B save.
    stored = deliveredSnapshot;
    const externalCallback = plugin.onExternalSettingsChange().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    releaseRename();
    await Promise.all([localMigration, externalCallback]);

    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);
    assert.ok(app.vault.getAbstractFileByPath(localDestination));
    assert.ok(app.vault.getAbstractFileByPath(deliveredDestination));
    assert.ok(
      app.vault.getAbstractFileByPath(deliveredOnlyPath),
      "the competing root still contains a record that exists nowhere in the local destination"
    );

    const durableBeforeRetry = JSON.stringify(stored).includes(
      JSON.stringify(deliveredDestination)
    );
    const blockedBeforeRetry = plugin.migrationRecoveryBlocked;
    const retrySettled = await plugin.retryPendingMigrationRecovery();
    const durableAfterRetry = JSON.stringify(stored).includes(
      JSON.stringify(deliveredDestination)
    );

    assert.deepEqual(
      {
        durableBeforeRetry,
        blockedBeforeRetry,
        retrySettled,
        durableAfterRetry,
        blockedAfterRetry: plugin.migrationRecoveryBlocked,
        deliveredOnlyRecordSurvives:
          app.vault.getAbstractFileByPath(deliveredOnlyPath) !== null
      },
      {
        durableBeforeRetry: true,
        blockedBeforeRetry: true,
        retrySettled: false,
        durableAfterRetry: true,
        blockedAfterRetry: true,
        deliveredOnlyRecordSurvives: true
      },
      "C must remain a durable unresolved root; ordinary Retry cannot silently choose B and reopen"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an explicit competing marker cannot forget an overlapping local destination", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const localDestination = "Explicit Local Target";
    const deliveredDestination = "Explicit Synced Target";
    copyRoot(app, DEFAULT_SETTINGS.rootFolder, deliveredDestination);
    const deliveredOnlyPath = addDistinctManagedRecord(
      app,
      deliveredDestination,
      "explicit-competing-c"
    );
    const localOnlySourcePath = addDistinctManagedRecord(
      app,
      DEFAULT_SETTINGS.rootFolder,
      "explicit-competing-b"
    );
    await plugin.noteManagedRecordWrite([localOnlySourcePath]);

    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const deliveredInventory = await plugin.parsedRecordInventory(deliveredDestination);
    assert.equal(localInventory.total, deliveredInventory.total);
    assert.notEqual(
      localInventory.digest,
      deliveredInventory.digest,
      "B and C carry different unique records despite having the same record count"
    );

    const deliveredMarker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: deliveredDestination
    };
    const deliveredSnapshot = {
      ...(structuredClone(stored) as Record<string, unknown>),
      rootFolder: deliveredDestination,
      migrationInProgress: deliveredMarker
    };

    const renameFile = app.fileManager.renameFile.bind(app.fileManager);
    let signalRenameStarted: () => void = () => undefined;
    let releaseRename: () => void = () => undefined;
    const renameStarted = new Promise<void>((resolve) => {
      signalRenameStarted = resolve;
    });
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    app.fileManager.renameFile = async (file, newPath) => {
      if (file.path === DEFAULT_SETTINGS.rootFolder && newPath === localDestination) {
        signalRenameStarted();
        await renameGate;
      }
      return renameFile(file, newPath);
    };

    const localMigration = plugin.migrateRootFolder(localDestination).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await renameStarted;

    // Capture an explicit A -> C Sync marker while local A -> B is between
    // marker persistence and physical rename. The callback may apply later,
    // but it must retain B as a durable competing root when it replaces the
    // local edge with the delivered edge.
    stored = deliveredSnapshot;
    const externalCallback = plugin.onExternalSettingsChange().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    releaseRename();
    await Promise.all([localMigration, externalCallback]);

    const localOnlyDestinationPath =
      `${localDestination}${localOnlySourcePath.slice(DEFAULT_SETTINGS.rootFolder.length)}`;
    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);
    assert.ok(app.vault.getAbstractFileByPath(localDestination));
    assert.ok(app.vault.getAbstractFileByPath(deliveredDestination));
    assert.ok(app.vault.getAbstractFileByPath(localOnlyDestinationPath));
    assert.ok(app.vault.getAbstractFileByPath(deliveredOnlyPath));

    const durableLocalBeforeRetry = JSON.stringify(stored).includes(
      JSON.stringify(localDestination)
    );
    const blockedBeforeRetry = plugin.migrationRecoveryBlocked;
    const retrySettled = await plugin.retryPendingMigrationRecovery();
    const durableLocalAfterRetry = JSON.stringify(stored).includes(
      JSON.stringify(localDestination)
    );

    assert.deepEqual(
      {
        durableLocalBeforeRetry,
        blockedBeforeRetry,
        retrySettled,
        durableLocalAfterRetry,
        blockedAfterRetry: plugin.migrationRecoveryBlocked,
        localOnlyRecordSurvives:
          app.vault.getAbstractFileByPath(localOnlyDestinationPath) !== null,
        deliveredOnlyRecordSurvives:
          app.vault.getAbstractFileByPath(deliveredOnlyPath) !== null
      },
      {
        durableLocalBeforeRetry: true,
        blockedBeforeRetry: true,
        retrySettled: false,
        durableLocalAfterRetry: true,
        blockedAfterRetry: true,
        localOnlyRecordSurvives: true,
        deliveredOnlyRecordSurvives: true
      },
      "an explicit A -> C delivery must not erase B from durable recovery state"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a suspended local migration reconciliation cannot overwrite a newer ambiguous marker", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const firstMarker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    const newerMarker: MigrationMarker = {
      from: "Ward Records",
      to: "Archive Records"
    };
    await renameRoot(app, firstMarker.from, firstMarker.to);
    copyRoot(app, newerMarker.from, newerMarker.to);
    plugin.pendingMigrationMarker = { migrationInProgress: firstMarker };
    plugin.pendingMigrationConfiguredRoot = firstMarker.to;
    plugin.migrationRecoveryBlocked = true;
    repository.setWriteBlock(CLINICAL_WRITES_BLOCKED_MESSAGE);

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let signalFirstVerificationStarted: () => void = () => undefined;
    let releaseFirstVerification: () => void = () => undefined;
    const firstVerificationStarted = new Promise<void>((resolve) => {
      signalFirstVerificationStarted = resolve;
    });
    const firstVerificationGate = new Promise<void>((resolve) => {
      releaseFirstVerification = resolve;
    });
    let firstVerificationGated = false;
    plugin.parsedRecordInventory = async (root) => {
      if (root === firstMarker.to && !firstVerificationGated) {
        firstVerificationGated = true;
        signalFirstVerificationStarted();
        await firstVerificationGate;
      }
      return readInventory(root);
    };

    const firstReconciliation = plugin.retryMigrationReconciliation();
    await firstVerificationStarted;

    stored = {
      ...(stored as Record<string, unknown>),
      rootFolder: newerMarker.to,
      migrationInProgress: newerMarker
    };
    await plugin.onExternalSettingsChange();
    assert.deepEqual(plugin.pendingMigrationMarker, { migrationInProgress: newerMarker });
    assert.equal(clinicalRootFolder(), DEFAULT_SETTINGS.rootFolder);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      newerMarker,
      "the ambiguous newer callback is durable before the older scan resumes"
    );

    releaseFirstVerification();
    const firstResult = await firstReconciliation;
    const persisted = stored as {
      rootFolder?: string;
      migrationInProgress?: MigrationMarker;
    };
    assert.deepEqual(
      {
        firstResult,
        pendingMarker: plugin.pendingMigrationMarker,
        activeRoot: clinicalRootFolder(),
        settingsRoot: plugin.settings.rootFolder,
        persistedRoot: persisted.rootFolder,
        persistedMarker: persisted.migrationInProgress,
        writesBlocked: plugin.migrationRecoveryBlocked
      },
      {
        firstResult: false,
        pendingMarker: { migrationInProgress: newerMarker },
        activeRoot: DEFAULT_SETTINGS.rootFolder,
        settingsRoot: DEFAULT_SETTINGS.rootFolder,
        persistedRoot: newerMarker.to,
        persistedMarker: newerMarker,
        writesBlocked: true
      },
      "an obsolete local reconciliation must not clear or overwrite the newer ambiguous marker"
    );
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5215", caseName: "Newer ambiguous marker remains blocked" })
      ),
      /read-only/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a rejected marker-clear save restores retryable recovery without opening writes", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const marker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    await renameRoot(app, marker.from, marker.to);
    stored = {
      ...(stored as Record<string, unknown>),
      rootFolder: marker.to,
      migrationInProgress: marker
    };
    plugin.pendingMigrationMarker = { migrationInProgress: marker };
    plugin.pendingMigrationConfiguredRoot = marker.to;
    plugin.migrationRecoveryBlocked = true;
    repository.setWriteBlock(CLINICAL_WRITES_BLOCKED_MESSAGE);

    let signalClearSaveStarted: () => void = () => undefined;
    let releaseClearSave: () => void = () => undefined;
    const clearSaveStarted = new Promise<void>((resolve) => {
      signalClearSaveStarted = resolve;
    });
    const clearSaveGate = new Promise<void>((resolve) => {
      releaseClearSave = resolve;
    });
    let saveAttempts = 0;
    plugin.saveData = async (data) => {
      saveAttempts += 1;
      if (saveAttempts === 1) {
        signalClearSaveStarted();
        await clearSaveGate;
        throw new Error("simulated marker-clear save rejection");
      }
      stored = structuredClone(data);
    };

    const reconciliation = plugin.retryMigrationReconciliation().then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await clearSaveStarted;

    // This attempt begins while marker clearing is waiting for durability. It
    // must observe the recovery barrier, not the tentative in-memory root.
    const writeAttempt = new ClinicalService(repository).createEpisode(
      episodeInput({ mrn: "5216", caseName: "Blocked during marker-clear save" })
    ).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    releaseClearSave();
    const [reconciliationOutcome, writeOutcome] = await Promise.all([
      reconciliation,
      writeAttempt
    ]);

    const persistedAfterFailure = stored as {
      rootFolder?: string;
      migrationInProgress?: MigrationMarker;
    };
    assert.deepEqual(
      {
        reconciliationReportedSuccess:
          reconciliationOutcome.status === "resolved" && reconciliationOutcome.value,
        writeRejectedReadOnly:
          writeOutcome.status === "rejected" &&
          writeOutcome.error instanceof Error &&
          /read-only/.test(writeOutcome.error.message),
        pendingMarker: plugin.pendingMigrationMarker,
        pendingConfiguredRoot: plugin.pendingMigrationConfiguredRoot,
        settingsRoot: plugin.settings.rootFolder,
        activeRoot: clinicalRootFolder(),
        persistedRoot: persistedAfterFailure.rootFolder,
        persistedMarker: persistedAfterFailure.migrationInProgress,
        writesBlocked: plugin.migrationRecoveryBlocked
      },
      {
        reconciliationReportedSuccess: false,
        writeRejectedReadOnly: true,
        pendingMarker: { migrationInProgress: marker },
        pendingConfiguredRoot: marker.to,
        settingsRoot: marker.to,
        activeRoot: marker.to,
        persistedRoot: marker.to,
        persistedMarker: marker,
        writesBlocked: true
      },
      "a failed marker-clear save must restore the marker and keep every write path closed"
    );

    const attemptsBeforeRetry = saveAttempts;
    assert.equal(
      await plugin.retryMigrationReconciliation(),
      true,
      "the restored marker remains available for a clean retry"
    );
    assert.ok(saveAttempts > attemptsBeforeRetry, "retry attempts a fresh durable marker clear");
    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(plugin.pendingMigrationConfiguredRoot, null);
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      undefined
    );
    await new ClinicalService(repository).createEpisode(
      episodeInput({ mrn: "5217", caseName: "Writable after marker-clear retry" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a local folder move keeps writes blocked until its marker-clear save succeeds", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    let signalMarkerClearStarted: () => void = () => undefined;
    let releaseMarkerClear: () => void = () => undefined;
    const markerClearStarted = new Promise<void>((resolve) => {
      signalMarkerClearStarted = resolve;
    });
    const markerClearGate = new Promise<void>((resolve) => {
      releaseMarkerClear = resolve;
    });
    let saveAttempts = 0;
    plugin.saveData = async (data) => {
      saveAttempts += 1;
      if (saveAttempts === 2) {
        signalMarkerClearStarted();
        await markerClearGate;
      }
      stored = structuredClone(data);
    };

    const migration = plugin.migrateRootFolder("Ward Records").then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await markerClearStarted;

    const blockedDuringMarkerClear = plugin.migrationRecoveryBlocked;
    const writeAttempt = new ClinicalService(repository).createEpisode(
      episodeInput({ mrn: "5218", caseName: "Blocked during local marker clear" })
    ).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    releaseMarkerClear();
    const [migrationOutcome, writeOutcome] = await Promise.all([migration, writeAttempt]);

    assert.equal(blockedDuringMarkerClear, true);
    assert.equal(migrationOutcome.status, "resolved");
    assert.equal(writeOutcome.status, "rejected");
    if (writeOutcome.status === "rejected") {
      assert.ok(writeOutcome.error instanceof Error);
      assert.match(writeOutcome.error.message, /read-only/);
    }
    assert.equal(saveAttempts, 2, "the rejected service write queues no safety save");
    assert.equal(clinicalRootFolder(), "Ward Records");
    assert.equal(plugin.settings.rootFolder, "Ward Records");
    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(plugin.pendingMigrationConfiguredRoot, null);
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal((stored as { rootFolder?: string }).rootFolder, "Ward Records");
    assert.equal(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      undefined
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a successful local folder move rebinds its journal only after an exact destination scan", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);
    assert.equal(before.pending, false);

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let signalDestinationScanStarted: () => void = () => undefined;
    let releaseDestinationScan: () => void = () => undefined;
    const destinationScanStarted = new Promise<void>((resolve) => {
      signalDestinationScanStarted = resolve;
    });
    const destinationScanGate = new Promise<void>((resolve) => {
      releaseDestinationScan = resolve;
    });
    let gated = false;
    plugin.parsedRecordInventory = async (root) => {
      const inventory = await readInventory(root);
      if (root === "Ward Records" && !gated) {
        gated = true;
        signalDestinationScanStarted();
        await destinationScanGate;
      }
      return inventory;
    };

    const migration = plugin.migrateRootFolder("Ward Records");
    await destinationScanStarted;

    const duringScan = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(duringScan?.trustedInventory);
    assert.equal(duringScan.pending, true);
    assert.equal(
      duringScan.trustedInventory.rootFingerprint,
      before.trustedInventory.rootFingerprint,
      "the source-bound anchor remains authoritative until the destination scan returns"
    );
    assert.equal(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      undefined,
      "the shared marker-free commit precedes the device-local root rebind"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);

    releaseDestinationScan();
    await migration;

    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(after?.trustedInventory);
    assert.equal(after.pending, false);
    assert.notEqual(
      after.trustedInventory.rootFingerprint,
      before.trustedInventory.rootFingerprint
    );
    assert.match(after.trustedInventory.rootFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(after.trustedInventory.expectedManagedRecordCount, before.trustedInventory.expectedManagedRecordCount);
    assert.deepEqual(after.trustedInventory.expectedEntityCounts, before.trustedInventory.expectedEntityCounts);
    assert.equal(after.trustedInventory.expectedRecordDigest, before.trustedInventory.expectedRecordDigest);
    assert.equal(clinicalRootFolder(), "Ward Records");
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a failed local-move journal rebind restores the marker and keeps writes blocked", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);
    const sourceFingerprint = before.trustedInventory.rootFingerprint;
    const saveLocalStorage = app.saveLocalStorage.bind(app);
    app.saveLocalStorage = (key, data) => {
      const journal = data as TestTrustedInventoryJournal;
      if (
        key === TRUSTED_INVENTORY_JOURNAL_KEY &&
        journal.pending === false &&
        journal.trustedInventory?.rootFingerprint !== sourceFingerprint
      ) {
        throw new Error("simulated destination journal failure");
      }
      saveLocalStorage(key, data);
    };

    await assert.rejects(
      () => plugin.migrateRootFolder("Ward Records"),
      /trusted baseline|recovery information conflicts/i
    );

    const marker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    const pending = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(pending?.trustedInventory);
    assert.equal(pending.pending, true);
    assert.equal(pending.trustedInventory.rootFingerprint, sourceFingerprint);
    assert.deepEqual(plugin.pendingMigrationMarker, { migrationInProgress: marker });
    assert.deepEqual(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      marker,
      "the marker is restored durably when the local trust commit fails"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5222", caseName: "Blocked after local journal failure" })
      ),
      /read-only|recovery information conflicts/i
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a replacement event during a local-move final scan cannot clear the journal", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let signalStaleScanCaptured: () => void = () => undefined;
    let releaseStaleScan: () => void = () => undefined;
    const staleScanCaptured = new Promise<void>((resolve) => {
      signalStaleScanCaptured = resolve;
    });
    const staleScanGate = new Promise<void>((resolve) => {
      releaseStaleScan = resolve;
    });
    let gated = false;
    plugin.parsedRecordInventory = async (root) => {
      const inventory = await readInventory(root);
      if (root === "Ward Records" && !gated) {
        gated = true;
        signalStaleScanCaptured();
        await staleScanGate;
      }
      return inventory;
    };

    const migration = plugin.migrateRootFolder("Ward Records").catch(() => undefined);
    await staleScanCaptured;
    const replacedPath = managedRecordPaths(app, "Ward Records")
      .find((path) => path.includes("/Episodes/"));
    assert.ok(replacedPath);
    const content = app.vault.files.get(replacedPath);
    assert.ok(content);
    app.vault.writeRaw(
      replacedPath,
      content.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-external-during-move-scan`
      )
    );
    plugin.observeManagedRecordDelivery(replacedPath);
    plugin.retryMigrationForPath(replacedPath);
    releaseStaleScan();
    await migration;

    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(after?.pending, true);
    assert.deepEqual(after?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a delivery after failed-move journal restoration cannot reopen writes", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const replacedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => path.includes("/Episodes/"));
    assert.ok(replacedPath);
    const commit = plugin.commitTrustedInventoryJournalForExactRoot.bind(plugin);
    let replacementQueued = false;
    plugin.commitTrustedInventoryJournalForExactRoot = async (...args) => {
      const committed = await commit(...args);
      if (!replacementQueued) {
        replacementQueued = true;
        queueMicrotask(() => {
          const content = app.vault.files.get(replacedPath);
          assert.ok(content);
          app.vault.writeRaw(
            replacedPath,
            content.replace(
              /^id:\s*(.+)$/m,
              (_line, id: string) => `id: ${id.trim()}-external-after-restore`
            )
          );
          plugin.observeManagedRecordDelivery(replacedPath);
        });
      }
      return committed;
    };

    await assert.rejects(
      () => plugin.migrateRootFolder(DEFAULT_SETTINGS.rootFolder),
      /already the current folder/i
    );

    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(replacementQueued, true);
    assert.equal(after?.pending, true);
    assert.deepEqual(after?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => service.createEpisode(
        episodeInput({ mrn: "5227", caseName: "Blocked after failed move race" })
      ),
      /read-only|recovery information conflicts/i
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("external marker reconciliation rebinds its journal only after an exact destination scan", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const marker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    await renameRoot(app, marker.from, marker.to);
    stored = {
      ...(stored as Record<string, unknown>),
      rootFolder: marker.to,
      migrationInProgress: marker
    };

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let destinationScans = 0;
    let signalFinalDestinationScanStarted: () => void = () => undefined;
    let releaseFinalDestinationScan: () => void = () => undefined;
    const finalDestinationScanStarted = new Promise<void>((resolve) => {
      signalFinalDestinationScanStarted = resolve;
    });
    const finalDestinationScanGate = new Promise<void>((resolve) => {
      releaseFinalDestinationScan = resolve;
    });
    plugin.parsedRecordInventory = async (root) => {
      const inventory = await readInventory(root);
      if (root === marker.to) {
        destinationScans += 1;
        if (destinationScans === 2) {
          signalFinalDestinationScanStarted();
          await finalDestinationScanGate;
        }
      }
      return inventory;
    };

    const reconciliation = plugin.onExternalSettingsChange();
    await finalDestinationScanStarted;

    const duringScan = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(duringScan?.trustedInventory);
    assert.equal(duringScan.pending, true);
    assert.equal(
      duringScan.trustedInventory.rootFingerprint,
      before.trustedInventory.rootFingerprint
    );
    assert.equal(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      undefined,
      "the canonical marker clear is durable before the local root is rebound"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);

    releaseFinalDestinationScan();
    await reconciliation;

    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(after?.trustedInventory);
    assert.equal(after.pending, false);
    assert.notEqual(
      after.trustedInventory.rootFingerprint,
      before.trustedInventory.rootFingerprint
    );
    assert.match(after.trustedInventory.rootFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(after.trustedInventory.expectedManagedRecordCount, before.trustedInventory.expectedManagedRecordCount);
    assert.deepEqual(after.trustedInventory.expectedEntityCounts, before.trustedInventory.expectedEntityCounts);
    assert.equal(after.trustedInventory.expectedRecordDigest, before.trustedInventory.expectedRecordDigest);
    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(clinicalRootFolder(), marker.to);
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a failed external-reconciliation journal rebind preserves its marker and write barrier", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);
    const sourceFingerprint = before.trustedInventory.rootFingerprint;

    const marker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    await renameRoot(app, marker.from, marker.to);
    stored = {
      ...(stored as Record<string, unknown>),
      rootFolder: marker.to,
      migrationInProgress: marker
    };
    const saveLocalStorage = app.saveLocalStorage.bind(app);
    app.saveLocalStorage = (key, data) => {
      const journal = data as TestTrustedInventoryJournal;
      if (
        key === TRUSTED_INVENTORY_JOURNAL_KEY &&
        journal.pending === false &&
        journal.trustedInventory?.rootFingerprint !== sourceFingerprint
      ) {
        throw new Error("simulated reconciled-root journal failure");
      }
      saveLocalStorage(key, data);
    };

    await plugin.onExternalSettingsChange();

    const pending = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(pending?.trustedInventory);
    assert.equal(pending.pending, true);
    assert.equal(pending.trustedInventory.rootFingerprint, sourceFingerprint);
    assert.deepEqual(plugin.pendingMigrationMarker, { migrationInProgress: marker });
    assert.deepEqual(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      marker,
      "a failed device-local rebind leaves a durable retry path"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5223", caseName: "Blocked after external journal failure" })
      ),
      /read-only|recovery information conflicts/i
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a stale marker callback cannot contaminate a newer marker-free snapshot", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const marker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    const olderMarkerSnapshot = {
      ...(stored as Record<string, unknown>),
      rootFolder: "Ward Records",
      migrationInProgress: marker
    };
    const newerMarkerFreeSnapshot: Record<string, unknown> = {
      ...(stored as Record<string, unknown>),
      rootFolder: DEFAULT_SETTINGS.rootFolder
    };
    delete newerMarkerFreeSnapshot.migrationInProgress;

    const snapshots = [olderMarkerSnapshot, newerMarkerFreeSnapshot];
    let reads = 0;
    plugin.loadData = async () => {
      const snapshot = snapshots[reads];
      reads += 1;
      assert.ok(snapshot);
      return structuredClone(snapshot);
    };

    let signalMarkerSaveStarted: () => void = () => undefined;
    let releaseMarkerSave: () => void = () => undefined;
    const markerSaveStarted = new Promise<void>((resolve) => {
      signalMarkerSaveStarted = resolve;
    });
    const markerSaveGate = new Promise<void>((resolve) => {
      releaseMarkerSave = resolve;
    });
    let saves = 0;
    plugin.saveData = async (data) => {
      saves += 1;
      if (saves === 1) {
        signalMarkerSaveStarted();
        await markerSaveGate;
      }
      stored = structuredClone(data);
    };

    const olderCallback = plugin.onExternalSettingsChange();
    // Let the stale callback pass its epoch check, then suspend its canonical
    // marker write. The newer callback is captured while the old marker still
    // occupies the in-memory fallback used for marker-free snapshots.
    await markerSaveStarted;
    const newerCallback = plugin.onExternalSettingsChange();
    assert.equal(reads, 2, "both Sync callbacks capture their own data.json snapshot");
    releaseMarkerSave();
    await Promise.all([olderCallback, newerCallback]);

    assert.equal(clinicalRootFolder(), DEFAULT_SETTINGS.rootFolder);
    assert.equal(plugin.settings.rootFolder, DEFAULT_SETTINGS.rootFolder);
    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(plugin.pendingMigrationConfiguredRoot, null);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.migrationRecoveryBlocked, false);

    const persisted = stored as {
      rootFolder?: string;
      migrationInProgress?: MigrationMarker;
      workspaceSafety?: {
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    };
    assert.equal(persisted.rootFolder, DEFAULT_SETTINGS.rootFolder);
    assert.equal(persisted.migrationInProgress, undefined);
    assert.equal(persisted.workspaceSafety?.rootRecoveryRequired, false);
    assert.equal(persisted.workspaceSafety?.recoveryValidationRequired, true);
    assert.equal(persisted.workspaceSafety?.baselineReviewRequired, false);

    await new ClinicalService(repository).createEpisode(
      episodeInput({ mrn: "5210", caseName: "Newer marker-free snapshot remains writable" })
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a queued lower external snapshot cannot weaken a captured higher commitment", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const localSafety = (stored as {
      workspaceSafety?: Record<string, unknown>;
    }).workspaceSafety;
    assert.ok(localSafety);

    const growthPath = addDistinctManagedRecord(app, DEFAULT_SETTINGS.rootFolder, "captured-higher");
    const higherInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(higherInventory.total, localInventory.total + 1);
    app.vault.deleteRaw(growthPath);
    const strongerSnapshot = {
      ...(stored as Record<string, unknown>),
      workspaceSafety: {
        ...localSafety,
        expectedManagedRecordCount: higherInventory.total,
        expectedEntityCounts: { ...higherInventory.counts },
        expectedRecordDigest: higherInventory.digest,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true,
        recoveryValidationRequired: false,
        baselineReviewRequired: false
      }
    };
    const staleSnapshot = structuredClone(stored);
    const snapshots = [strongerSnapshot, staleSnapshot];
    let reads = 0;
    let signalBothCaptured: () => void = () => undefined;
    const bothCaptured = new Promise<void>((resolve) => {
      signalBothCaptured = resolve;
    });
    plugin.loadData = async () => {
      const snapshot = snapshots[reads];
      reads += 1;
      if (reads === 2) signalBothCaptured();
      assert.ok(snapshot);
      return structuredClone(snapshot);
    };

    let releaseApplyQueue: () => void = () => undefined;
    plugin.externalSettingsApplyQueue = new Promise<void>((resolve) => {
      releaseApplyQueue = resolve;
    });
    const strongerCallback = plugin.onExternalSettingsChange();
    const staleCallback = plugin.onExternalSettingsChange();
    await bothCaptured;
    assert.equal(plugin.expectedManagedRecordCount, localInventory.total);
    releaseApplyQueue();
    await Promise.all([strongerCallback, staleCallback]);

    assert.equal(plugin.expectedManagedRecordCount, higherInventory.total);
    assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    const persistedSafety = (stored as {
      workspaceSafety?: {
        expectedManagedRecordCount?: number;
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
        recoveryValidationRequired?: boolean;
        baselineReviewRequired?: boolean;
      };
    }).workspaceSafety;
    assert.equal(persistedSafety?.expectedManagedRecordCount, higherInventory.total);
    assert.deepEqual(persistedSafety?.expectedEntityCounts, localInventory.counts);
    assert.equal(persistedSafety?.expectedRecordDigest, localInventory.digest);
    assert.equal(persistedSafety?.rootRecoveryRequired, true);
    assert.equal(persistedSafety?.recoveryValidationRequired, true);
    assert.equal(persistedSafety?.baselineReviewRequired, true);
    await assert.rejects(
      () => new ClinicalService(repository).createEpisode(
        episodeInput({ mrn: "5207", caseName: "Stale callback cannot weaken review" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("higher incomplete commitments stay in durable review after either root reconciliation path", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    for (const withMarker of [false, true]) {
      setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
      const { app, repository, service } = await harness();
      await service.createEpisode(episodeInput());
      let stored: unknown = { ...DEFAULT_SETTINGS };
      const plugin = makePlugin(app, repository, () => stored, (data) => {
        stored = data;
      });
      await plugin.noteManagedRecordWrite();
      const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
      const localSafety = (stored as {
        workspaceSafety?: Record<string, unknown>;
      }).workspaceSafety;
      assert.ok(localSafety);

      addDistinctManagedRecord(
        app,
        DEFAULT_SETTINGS.rootFolder,
        withMarker ? "marker-incomplete" : "marker-free-incomplete"
      );
      const higherInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
      assert.equal(higherInventory.total, localInventory.total + 1);
      await renameRoot(app, DEFAULT_SETTINGS.rootFolder, "Ward Records");

      const marker: MigrationMarker = {
        from: DEFAULT_SETTINGS.rootFolder,
        to: "Ward Records"
      };
      stored = {
        ...(stored as Record<string, unknown>),
        rootFolder: "Ward Records",
        ...(withMarker ? { migrationInProgress: marker } : {}),
        workspaceSafety: {
          ...localSafety,
          expectedManagedRecordCount: higherInventory.total,
          // Deliberately retain the N-record tuple beside an N+1 aggregate.
          // This is an incomplete commitment and can only establish a floor.
          expectedEntityCounts: { ...localInventory.counts },
          expectedRecordDigest: localInventory.digest,
          rootRecoveryRequired: false,
          recoveryRequiresRecords: true,
          recoveryValidationRequired: false,
          baselineReviewRequired: false
        }
      };

      await plugin.onExternalSettingsChange();

      assert.equal(
        clinicalRootFolder(),
        "Ward Records",
        `${withMarker ? "marker" : "marker-free"} reconciliation accepts the complete physical root`
      );
      assert.equal(plugin.settings.rootFolder, "Ward Records");
      assert.equal(plugin.pendingMigrationMarker, null);
      assert.equal(plugin.expectedManagedRecordCount, higherInventory.total);
      assert.deepEqual(plugin.expectedEntityCounts, localInventory.counts);
      assert.equal(plugin.expectedRecordDigest, localInventory.digest);
      assert.equal(plugin.baselineReviewRequired, true);
      assert.equal(plugin.missingRootRecoveryBlocked, true);
      assert.equal(plugin.migrationRecoveryBlocked, true);
      await assert.rejects(
        () => new ClinicalService(repository).createEpisode(
          episodeInput({
            mrn: withMarker ? "5208" : "5209",
            caseName: "Incomplete higher commitment remains under review"
          })
        ),
        /synchronized recovery information conflicts/
      );

      const persisted = stored as {
        rootFolder?: string;
        migrationInProgress?: MigrationMarker;
        workspaceSafety?: {
          expectedManagedRecordCount?: number;
          expectedEntityCounts?: TestRecordInventory["counts"];
          expectedRecordDigest?: string;
          rootRecoveryRequired?: boolean;
          recoveryValidationRequired?: boolean;
          baselineReviewRequired?: boolean;
        };
      };
      assert.equal(persisted.rootFolder, "Ward Records");
      assert.equal(persisted.migrationInProgress, undefined);
      assert.equal(persisted.workspaceSafety?.expectedManagedRecordCount, higherInventory.total);
      assert.deepEqual(persisted.workspaceSafety?.expectedEntityCounts, localInventory.counts);
      assert.equal(persisted.workspaceSafety?.expectedRecordDigest, localInventory.digest);
      assert.equal(persisted.workspaceSafety?.rootRecoveryRequired, true);
      assert.equal(persisted.workspaceSafety?.recoveryValidationRequired, true);
      assert.equal(persisted.workspaceSafety?.baselineReviewRequired, true);

      const restartedRepository = new ClinicalRepository(app as unknown as App);
      const restarted = makePlugin(app, restartedRepository, () => stored);
      await restarted.loadSettings();
      restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
      assert.equal(restarted.settings.rootFolder, "Ward Records");
      assert.equal(restarted.expectedManagedRecordCount, higherInventory.total);
      assert.deepEqual(restarted.expectedEntityCounts, localInventory.counts);
      assert.equal(restarted.expectedRecordDigest, localInventory.digest);
      assert.equal(restarted.baselineReviewRequired, true);
      assert.equal(restarted.migrationRecoveryBlocked, true);
    }
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("ordinary externally synced settings still apply immediately without a migration", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository } = await harness();
    const incoming = {
      ...DEFAULT_SETTINGS,
      clinicianName: "Synced device",
      confirmBeforeDischarge: true
    };
    const plugin = makePlugin(app, repository, () => incoming);

    await plugin.onExternalSettingsChange();

    assert.equal(plugin.settings.clinicianName, "Synced device");
    assert.equal(plugin.settings.confirmBeforeDischarge, true);
    assert.equal(clinicalRootFolder(), DEFAULT_SETTINGS.rootFolder);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a proven marker-free root change persists the cleared recovery state", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const expectedCount = [...app.vault.files.keys()].filter((path) =>
      ["Patients", "Episodes", "Tasks", "Procedures"].some((folder) =>
        path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`)
      )
    ).length;
    await renameRoot(app, DEFAULT_SETTINGS.rootFolder, "Ward Records");
    const incoming = {
      ...DEFAULT_SETTINGS,
      rootFolder: "Ward Records",
      workspaceSafety: {
        version: 1,
        initialized: true,
        managedRecordsExpected: true,
        expectedManagedRecordCount: expectedCount,
        rootRecoveryRequired: true,
        recoveryRequiresRecords: true
      }
    };
    let saved: Record<string, unknown> | null = null;
    const plugin = makePlugin(app, repository, () => incoming, (data) => {
      saved = data as Record<string, unknown>;
    });

    await plugin.onExternalSettingsChange();

    const savedData = saved as Record<string, unknown> | null;
    const savedState = savedData?.workspaceSafety as { rootRecoveryRequired?: boolean } | undefined;
    assert.equal(clinicalRootFolder(), "Ward Records");
    assert.equal(savedState?.rootRecoveryRequired, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("marker delivery accepts only a complete destination record set", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    for (const delivery of [0, 1, "all"] as const) {
      setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
      const { app, repository, service } = await harness();
      await service.createEpisode(episodeInput({
        nextAction: "Review",
        dueDate: "2026-08-12"
      }));
      const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
      assert.ok(expectedCount >= 3);
      const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
      copyRoot(app, marker.from, marker.to);
      deleteRoot(app, marker.from);
      const retainedCount = delivery === "all" ? expectedCount : delivery;
      retainManagedRecords(app, marker.to, retainedCount);
      let saved: unknown = null;
      const stored = {
        ...DEFAULT_SETTINGS,
        rootFolder: marker.to,
        migrationInProgress: marker,
        workspaceSafety: persistedSafety(expectedCount)
      };
      const plugin = makePlugin(app, repository, () => stored, (data) => {
        saved = data;
      });

      await plugin.onExternalSettingsChange();

      if (retainedCount < expectedCount) {
        assert.equal(plugin.migrationRecoveryBlocked, true, `${retainedCount}/${expectedCount} stays blocked`);
        assert.deepEqual(
          (saved as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress,
          marker
        );
        await assert.rejects(
          () => service.createEpisode(episodeInput({ mrn: `700${retainedCount}` })),
          new RegExp("temporarily read-only")
        );
      } else {
        assert.equal(clinicalRootFolder(), marker.to);
        assert.equal(
          plugin.migrationRecoveryBlocked,
          true,
          "count-only legacy safety stays closed until explicit exact upgrade"
        );
        assert.equal(plugin.pendingMigrationMarker, null);
        assert.equal(await plugin.retryPendingMigrationRecovery(), true);
        assert.equal(plugin.migrationRecoveryBlocked, false);
      }
    }
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("marker-free delivery accepts only a complete destination record set", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    for (const delivery of [0, 1, "all"] as const) {
      setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
      const { app, repository, service } = await harness();
      await service.createEpisode(episodeInput({
        nextAction: "Review",
        dueDate: "2026-08-12"
      }));
      const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
      const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
      copyRoot(app, marker.from, marker.to);
      deleteRoot(app, marker.from);
      const retainedCount = delivery === "all" ? expectedCount : delivery;
      retainManagedRecords(app, marker.to, retainedCount);
      let saved: unknown = null;
      const incoming = {
        ...DEFAULT_SETTINGS,
        rootFolder: marker.to,
        workspaceSafety: persistedSafety(expectedCount)
      };
      const plugin = makePlugin(app, repository, () => incoming, (data) => {
        saved = data;
      });

      await plugin.onExternalSettingsChange();

      if (retainedCount < expectedCount) {
        assert.equal(plugin.migrationRecoveryBlocked, true, `${retainedCount}/${expectedCount} stays blocked`);
        assert.deepEqual(
          (saved as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress,
          marker,
          "marker-free split delivery is reconstructed as pending"
        );
      } else {
        assert.equal(clinicalRootFolder(), marker.to);
        assert.equal(
          plugin.migrationRecoveryBlocked,
          true,
          "count-only legacy safety stays closed until explicit exact upgrade"
        );
        assert.equal(
          (saved as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress,
          undefined
        );
        assert.equal(await plugin.retryPendingMigrationRecovery(), true);
        assert.equal(plugin.migrationRecoveryBlocked, false);
      }
    }
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("explicit source rollback also waits for the complete healthy record count", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput({
      nextAction: "Review",
      dueDate: "2026-08-12"
    }));
    const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    const backup = new Map(
      managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).map((path) => [path, app.vault.files.get(path)!])
    );
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    const stored = {
      ...DEFAULT_SETTINGS,
      rootFolder: marker.to,
      migrationInProgress: marker,
      workspaceSafety: persistedSafety(expectedCount)
    };
    const plugin = makePlugin(app, repository, () => stored);
    retainManagedRecords(app, marker.from, 1);

    await plugin.onExternalSettingsChange();
    assert.equal(await plugin.retryPendingMigrationRecovery(), false, "1/N source is not rollback proof");
    assert.equal(plugin.migrationRecoveryBlocked, true);

    for (const [path, content] of backup) app.vault.writeRaw(path, content);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    assert.equal(clinicalRootFolder(), marker.from);
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("legacy non-null plugin data with an absent root requires explicit baseline confirmation", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const app = new App() as unknown as StubApp;
    const repository = new ClinicalRepository(app as unknown as App);
    const plugin = makePlugin(app, repository, () => ({ ...DEFAULT_SETTINGS }));

    await plugin.loadSettings();
    repository.setWriteBlock(
      plugin.migrationRecoveryBlocked ? plugin.recoveryBlockMessage : null
    );
    plugin.structureReady = false;

    assert.equal(plugin.workspaceInitialized, false);
    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => plugin.ensureStructure(),
      new RegExp("needs a trusted baseline")
    );
    assert.equal(app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder), null);

    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    await assert.rejects(() => plugin.ensureStructure(), /needs a trusted baseline/);
    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a delayed safety write cannot overwrite a newly delivered migration marker", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    let stored: unknown = { ...DEFAULT_SETTINGS };
    let releaseFirst!: () => void;
    let reportFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      reportFirstEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const saves: unknown[] = [];
    const plugin = makePlugin(app, repository, () => stored, async (data) => {
      saves.push(data);
      if (saves.length === 1) {
        reportFirstEntered();
        await firstRelease;
      }
    });

    const staleSafetyWrite = plugin.persistWorkspaceSafety();
    await firstEntered;
    stored = {
      ...DEFAULT_SETTINGS,
      rootFolder: marker.to,
      migrationInProgress: marker,
      workspaceSafety: persistedSafety(expectedCount)
    };
    const markerDelivery = plugin.onExternalSettingsChange();
    await Promise.resolve();
    releaseFirst();
    await Promise.all([staleSafetyWrite, markerDelivery]);

    assert.ok(saves.length >= 2);
    const finalSave = saves.at(-1) as {
      rootFolder?: string;
      migrationInProgress?: MigrationMarker;
      workspaceSafety?: { expectedManagedRecordCount?: number };
    };
    assert.equal(finalSave.rootFolder, marker.to);
    assert.deepEqual(finalSave.migrationInProgress, marker);
    assert.equal(finalSave.workspaceSafety?.expectedManagedRecordCount, expectedCount);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a safetyless marker preserves destination intent across restart without auto-baselining", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const marker: MigrationMarker = { from: "Clinical Workspace", to: "Ward Records" };
    let stored: unknown = {
      ...DEFAULT_SETTINGS,
      rootFolder: marker.to,
      migrationInProgress: marker
    };
    const upgrading = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });

    await upgrading.loadSettings();
    assert.equal(upgrading.workspaceSafetyNeedsPersistence, false);
    assert.equal(upgrading.firstUseInitializationPending, true);
    assert.equal((stored as { rootFolder?: string }).rootFolder, marker.to);
    assert.deepEqual(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      marker
    );

    repository.setWriteBlock(upgrading.recoveryBlockMessage);
    await renameRoot(app, marker.from, marker.to);
    upgrading.retryMigrationForPath(marker.to);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    assert.deepEqual(
      upgrading.pendingMigrationMarker,
      { migrationInProgress: marker },
      "vault delivery cannot auto-reconcile a safetyless marker"
    );
    assert.equal(await upgrading.retryPendingMigrationRecovery(), true);
    assert.equal(upgrading.pendingMigrationMarker, null);
    assert.equal(upgrading.firstUseInitializationPending, true);
    assert.equal(upgrading.migrationRecoveryBlocked, true);
    assert.equal(
      (stored as { workspaceSafety?: { initialized?: boolean } }).workspaceSafety?.initialized,
      false,
      "recovery alone does not silently adopt an untrusted count"
    );

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    assert.equal(clinicalRootFolder(), marker.to);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.firstUseInitializationPending, true);
    assert.equal(restarted.pendingMigrationMarker, null);

    restartedRepository.setWriteBlock(restarted.recoveryBlockMessage);
    const adoptedCount = managedRecordPaths(app, marker.to).length;
    await primeAdoption(restarted, stored, adoptedCount);
    await restarted.initializeNewWorkspace();
    restarted.structureReady = false;
    await restarted.ensureStructure();
    assert.equal(
      (stored as { workspaceSafety?: { initialized?: boolean } }).workspaceSafety?.initialized,
      true
    );

    deleteRoot(app, marker.to);
    const afterLossRepository = new ClinicalRepository(app as unknown as App);
    const afterLoss = makePlugin(app, afterLossRepository, () => stored);
    await afterLoss.loadSettings();
    afterLossRepository.setWriteBlock(
      afterLoss.migrationRecoveryBlocked ? afterLoss.recoveryBlockMessage : null
    );
    afterLoss.structureReady = false;
    await assert.rejects(() => afterLoss.ensureStructure(), /configured folder is unavailable/);
    assert.equal(app.vault.getAbstractFileByPath(marker.to), null);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("moving a managed record out of the active root blocks writes, while an internal rename does not", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const first = await harness();
    await first.service.createEpisode(episodeInput());
    const safePlugin = makePlugin(first.app, first.repository, () => DEFAULT_SETTINGS);
    await safePlugin.noteManagedRecordWrite();
    const internalOldPath = managedRecordPaths(first.app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => path.includes("/Episodes/"));
    assert.ok(internalOldPath);
    const internalFile = first.app.vault.getAbstractFileByPath(internalOldPath);
    assert.ok(internalFile instanceof TFile);
    const internalNewPath = internalOldPath.replace(/\.md$/, "-renamed.md");
    await first.app.fileManager.renameFile(internalFile, internalNewPath);
    const internallyRenamed = first.app.vault.getAbstractFileByPath(internalNewPath);
    assert.ok(internallyRenamed instanceof TFile);
    safePlugin.handleVaultRename(internallyRenamed, internalOldPath);
    assert.equal(await safePlugin.retryPendingMigrationRecovery(), true);
    assert.equal(safePlugin.migrationRecoveryBlocked, false);
    await first.service.createEpisode(episodeInput({ mrn: "7010" }));

    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const second = await harness();
    await second.service.createEpisode(episodeInput());
    const blockedPlugin = makePlugin(second.app, second.repository, () => DEFAULT_SETTINGS);
    await blockedPlugin.noteManagedRecordWrite();
    const movedOldPath = managedRecordPaths(second.app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => path.includes("/Episodes/"));
    assert.ok(movedOldPath);
    const movedFile = second.app.vault.getAbstractFileByPath(movedOldPath);
    assert.ok(movedFile instanceof TFile);
    const movedNewPath = "Archive/Moved episode.md";
    await second.app.fileManager.renameFile(movedFile, movedNewPath);
    const moved = second.app.vault.getAbstractFileByPath(movedNewPath);
    assert.ok(moved instanceof TFile);
    blockedPlugin.handleVaultRename(moved, movedOldPath);

    assert.equal(blockedPlugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => second.service.createEpisode(episodeInput({ mrn: "7011" })),
      new RegExp("configured folder is unavailable")
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("moving a managed child folder out of the active root blocks writes", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const plugin = makePlugin(app, repository, () => DEFAULT_SETTINGS);
    const oldPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes`;
    const folder = app.vault.getAbstractFileByPath(oldPath);
    assert.ok(folder instanceof TFolder);
    const newPath = "Archive/Episodes";
    await app.fileManager.renameFile(folder, newPath);
    const moved = app.vault.getAbstractFileByPath(newPath);
    assert.ok(moved instanceof TFolder);
    plugin.handleVaultRename(moved, oldPath);

    assert.equal(plugin.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => service.createEpisode(episodeInput({ mrn: "7012" })),
      new RegExp("configured folder is unavailable")
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("managed delivery provenance ignores plugin-owned creates but journals external edits and growth", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    let plugin!: TestPlugin;
    const create = app.vault.create.bind(app.vault);
    app.vault.create = async (path, content) => {
      const file = await create(path, content);
      plugin.observeManagedRecordDelivery(file.path);
      return file;
    };
    plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    await service.createEpisode(episodeInput({
      mrn: "5224",
      caseName: "Plugin-owned provenance"
    }));
    const afterPluginCreate = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(afterPluginCreate?.pending, false);

    const modifiedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => path.includes("/Episodes/"));
    assert.ok(modifiedPath);
    const modifiedContent = app.vault.files.get(modifiedPath);
    assert.ok(modifiedContent);
    app.vault.writeRaw(modifiedPath, `${modifiedContent}\nExternal annotation.\n`);
    plugin.observeManagedRecordDelivery(modifiedPath);

    const pendingModify = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(pendingModify?.pending, true);
    assert.equal(
      await plugin.retryPendingMigrationRecovery(),
      true,
      "a same-ID content edit is benign for the ID-set commitment after exact rescan"
    );
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(
      (app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as TestTrustedInventoryJournal | null)
        ?.pending,
      false
    );

    const internalOldPath = modifiedPath;
    const internalFile = app.vault.getAbstractFileByPath(internalOldPath);
    assert.ok(internalFile instanceof TFile);
    const internalNewPath = internalOldPath.replace(/\.md$/, "-internal-rename.md");
    await app.fileManager.renameFile(internalFile, internalNewPath);
    const internallyRenamed = app.vault.getAbstractFileByPath(internalNewPath);
    assert.ok(internallyRenamed instanceof TFile);
    plugin.handleVaultRename(internallyRenamed, internalOldPath);
    assert.equal(
      (app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as TestTrustedInventoryJournal | null)
        ?.pending,
      true,
      "even a benign internal rename is journaled until its exact rescan"
    );
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);
    assert.equal(plugin.migrationRecoveryBlocked, false);
    const beforeExternalGrowth = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(beforeExternalGrowth?.pending, false);

    const externalPath = addDistinctManagedRecord(
      app,
      DEFAULT_SETTINGS.rootFolder,
      "provenance-growth"
    );
    plugin.observeManagedRecordDelivery(externalPath);
    const pendingGrowth = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(pendingGrowth?.pending, true);
    assert.deepEqual(
      pendingGrowth?.trustedInventory,
      beforeExternalGrowth?.trustedInventory,
      "an external create cannot advance the clean local trust anchor"
    );
    assert.equal(await plugin.retryPendingMigrationRecovery(), false);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external equal-count replacement cannot advance the clean journal", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);
    assert.equal(before.pending, false);

    const replacedPath = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder)
      .find((path) => path.includes("/Episodes/"));
    assert.ok(replacedPath);
    const originalContent = app.vault.files.get(replacedPath);
    assert.ok(originalContent);
    assert.match(originalContent, /^id:\s*.+$/m);
    app.vault.writeRaw(
      replacedPath,
      originalContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-external-replacement`
      )
    );
    plugin.observeManagedRecordDelivery(replacedPath);

    const pending = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pending?.pending, true);
    assert.deepEqual(pending?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(await plugin.retryPendingMigrationRecovery(), false);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external same-path replacement during a plugin-owned create cannot be trusted", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const create = app.vault.create.bind(app.vault);
    let lastManagedCreatePath: string | null = null;
    app.vault.create = async (path, content) => {
      const file = await create(path, content);
      if (MANAGED_FOLDERS.some((folder) => file.path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`))) {
        lastManagedCreatePath = file.path;
      }
      return file;
    };
    const noteManagedRecordWrite = plugin.noteManagedRecordWrite.bind(plugin);
    let replacementInjected = false;
    plugin.noteManagedRecordWrite = async () => {
      if (!replacementInjected && lastManagedCreatePath) {
        const path = lastManagedCreatePath;
        const content = app.vault.files.get(path);
        assert.ok(content);
        assert.match(content, /^id:\s*.+$/m);
        app.vault.writeRaw(
          path,
          content.replace(
            /^id:\s*(.+)$/m,
            (_line, id: string) => `id: ${id.trim()}-external-race`
          )
        );
        plugin.observeManagedRecordDelivery(path);
        replacementInjected = true;
      }
      return noteManagedRecordWrite();
    };

    await service.createEpisode(episodeInput({
      mrn: "5225",
      caseName: "Concurrent create provenance"
    })).catch(() => undefined);

    assert.equal(replacementInjected, true);
    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(after?.pending, true);
    assert.deepEqual(
      after?.trustedInventory,
      before.trustedInventory,
      "the external replacement cannot be folded into the plugin-owned growth commitment"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a create readback captured before a replacement event cannot clear that event", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const record: EpisodeRecord = {
      ...created.episode.record,
      id: `${created.episode.record.id}-stale-readback`,
      case: "Stale readback provenance"
    };
    const path = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${record.id}.md`;
    const read = app.vault.read.bind(app.vault);
    let signalCaptured: () => void = () => undefined;
    let releaseCaptured: () => void = () => undefined;
    const captured = new Promise<void>((resolve) => {
      signalCaptured = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCaptured = resolve;
    });
    let gated = false;
    app.vault.read = async (file) => {
      const content = await read(file);
      if (file.path === path && !gated) {
        gated = true;
        signalCaptured();
        await gate;
      }
      return content;
    };

    const createRecord = repository.create(record);
    await captured;
    const content = app.vault.files.get(path);
    assert.ok(content);
    app.vault.writeRaw(
      path,
      content.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-external-after-read`
      )
    );
    plugin.observeManagedRecordDelivery(path);
    releaseCaptured();

    await assert.rejects(createRecord, /verification failed/i);
    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(after?.pending, true);
    assert.deepEqual(after?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a root migration drains a suspended create before moving its record", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const record: EpisodeRecord = {
      ...created.episode.record,
      id: `${created.episode.record.id}-old-root-race`,
      case: "Root migration create race"
    };
    const oldPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${record.id}.md`;
    const destinationPath = `Ward Records/Episodes/${record.id}.md`;
    const create = app.vault.create.bind(app.vault);
    let signalCreateStarted: () => void = () => undefined;
    let releaseCreate: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    app.vault.create = async (path, content) => {
      if (path === oldPath) {
        signalCreateStarted();
        await createGate;
      }
      return create(path, content);
    };

    const createRecord = repository.create(record);
    await createStarted;
    let migrationSettled = false;
    const migration = plugin.migrateRootFolder("Ward Records").then((result) => {
      migrationSettled = true;
      return result;
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    assert.equal(migrationSettled, false, "the root move waits for the admitted create");
    releaseCreate();

    await createRecord;
    await migration;
    assert.equal(app.vault.getAbstractFileByPath(oldPath), null);
    assert.ok(app.vault.getAbstractFileByPath(destinationPath));
    const journal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journal?.pending, false);
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a late managed delivery to the losing root cannot be excluded from the journal rebind", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let signalDestinationScanCaptured: () => void = () => undefined;
    let releaseDestinationScan: () => void = () => undefined;
    const destinationScanCaptured = new Promise<void>((resolve) => {
      signalDestinationScanCaptured = resolve;
    });
    const destinationScanGate = new Promise<void>((resolve) => {
      releaseDestinationScan = resolve;
    });
    let gated = false;
    plugin.parsedRecordInventory = async (root) => {
      const inventory = await readInventory(root);
      if (root === "Ward Records" && !gated) {
        gated = true;
        signalDestinationScanCaptured();
        await destinationScanGate;
      }
      return inventory;
    };

    const migration = plugin.migrateRootFolder("Ward Records");
    await destinationScanCaptured;

    const destinationEpisodePath = managedRecordPaths(app, "Ward Records")
      .find((path) => path.includes("/Episodes/"));
    assert.ok(destinationEpisodePath);
    const destinationContent = app.vault.files.get(destinationEpisodePath);
    assert.ok(destinationContent);
    const lateSourcePath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/late-source-record.md`;
    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    await app.vault.createFolder(`${DEFAULT_SETTINGS.rootFolder}/Episodes`);
    app.vault.writeRaw(
      lateSourcePath,
      destinationContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-late-source`
      )
    );
    plugin.observeManagedRecordDelivery(lateSourcePath);
    plugin.retryMigrationForPath(lateSourcePath);
    releaseDestinationScan();

    await assert.rejects(
      () => migration,
      /trusted baseline|recovery information conflicts|read-only/i
    );

    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(after?.pending, true);
    assert.deepEqual(after?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: {
        from: DEFAULT_SETTINGS.rootFolder,
        to: "Ward Records"
      }
    });
    assert.ok(app.vault.getAbstractFileByPath(lateSourcePath));
    assert.ok(app.vault.getAbstractFileByPath(destinationEpisodePath));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a retired root remains watched after restart for a late managed delivery", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    await plugin.migrateRootFolder("Ward Records");

    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [DEFAULT_SETTINGS.rootFolder],
      "the marker-free synced snapshot retains provenance for the losing root"
    );
    const destinationEpisodePath = managedRecordPaths(app, "Ward Records")
      .find((path) => path.includes("/Episodes/"));
    assert.ok(destinationEpisodePath);
    const destinationContent = app.vault.files.get(destinationEpisodePath);
    assert.ok(destinationContent);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );
    assert.equal(
      await restarted.retryExactRestoredRootRecovery(),
      true,
      "the destination passes its ordinary exact startup validation before the late delivery"
    );
    assert.equal(restarted.migrationRecoveryBlocked, false);
    const beforeLateDelivery = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(beforeLateDelivery?.pending, false);

    const lateSourcePath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/restart-late-source.md`;
    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    await app.vault.createFolder(`${DEFAULT_SETTINGS.rootFolder}/Episodes`);
    app.vault.writeRaw(
      lateSourcePath,
      destinationContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-restart-late-source`
      )
    );
    restarted.observeManagedRecordDelivery(lateSourcePath);

    const afterLateDelivery = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(afterLateDelivery?.pending, true);
    assert.deepEqual(afterLateDelivery?.trustedInventory, beforeLateDelivery?.trustedInventory);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.deepEqual(restarted.pendingMigrationMarker, {
      migrationInProgress: {
        from: DEFAULT_SETTINGS.rootFolder,
        to: "Ward Records"
      }
    });
    assert.equal(
      await restarted.retryMigrationReconciliation(),
      false,
      "both populated roots remain ambiguous after the automatic retry"
    );
    assert.equal(restarted.migrationRecoveryBlocked, true);
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "7013", caseName: "Restarted retired-root race" })
      ),
      /temporarily read-only|recovery information conflicts/i
    );
    assert.ok(app.vault.getAbstractFileByPath(lateSourcePath));
    assert.ok(app.vault.getAbstractFileByPath(destinationEpisodePath));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a retired root restored while closed prevents exact startup release", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    await plugin.migrateRootFolder("Ward Records");
    const cleanJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(cleanJournal?.pending, false);
    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [DEFAULT_SETTINGS.rootFolder]
    );

    const destinationEpisodePath = managedRecordPaths(app, "Ward Records")
      .find((path) => path.includes("/Episodes/"));
    assert.ok(destinationEpisodePath);
    const destinationContent = app.vault.files.get(destinationEpisodePath);
    assert.ok(destinationContent);
    const restoredSourcePath =
      `${DEFAULT_SETTINGS.rootFolder}/Episodes/restored-while-closed.md`;
    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    await app.vault.createFolder(`${DEFAULT_SETTINGS.rootFolder}/Episodes`);
    app.vault.writeRaw(
      restoredSourcePath,
      destinationContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-restored-while-closed`
      )
    );

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored, (data) => {
      stored = data;
    });
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    const startupJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(startupJournal?.pending, true);
    assert.deepEqual(startupJournal?.trustedInventory, cleanJournal?.trustedInventory);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.deepEqual(restarted.pendingMigrationMarker, {
      migrationInProgress: {
        from: DEFAULT_SETTINGS.rootFolder,
        to: "Ward Records"
      }
    });
    assert.equal(
      await restarted.retryExactRestoredRootRecovery(),
      false,
      "the active-root scan cannot release a split root that predates listener registration"
    );
    assert.equal(await restarted.retryMigrationReconciliation(), false);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(
      (app.loadLocalStorage(
        TRUSTED_INVENTORY_JOURNAL_KEY
      ) as TestTrustedInventoryJournal | null)?.pending,
      true
    );
    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [DEFAULT_SETTINGS.rootFolder],
      "startup recovery preserves the retired-root tombstone"
    );
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "7014", caseName: "Closed-app retired-root race" })
      ),
      /temporarily read-only|recovery information conflicts/i
    );
    assert.ok(app.vault.getAbstractFileByPath(restoredSourcePath));
    assert.ok(app.vault.getAbstractFileByPath(destinationEpisodePath));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a same-root settings delivery unions tombstones and catches an earlier old-root file", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    await plugin.migrateRootFolder("Ward Records");
    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [DEFAULT_SETTINGS.rootFolder]
    );

    const destinationEpisodePath = managedRecordPaths(app, "Ward Records")
      .find((path) => path.includes("/Episodes/"));
    assert.ok(destinationEpisodePath);
    const destinationContent = app.vault.files.get(destinationEpisodePath);
    assert.ok(destinationContent);
    const earlierRetiredRoot = "Earlier Clinical Root";
    const earlierDeliveryPath = `${earlierRetiredRoot}/Episodes/earlier-delivery.md`;
    await app.vault.createFolder(earlierRetiredRoot);
    await app.vault.createFolder(`${earlierRetiredRoot}/Episodes`);
    app.vault.writeRaw(
      earlierDeliveryPath,
      destinationContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-earlier-delivery`
      )
    );
    plugin.observeManagedRecordDelivery(earlierDeliveryPath);
    assert.equal(
      plugin.migrationRecoveryBlocked,
      false,
      "the file arrives before this device knows its root was retired"
    );
    const journalBeforeSettings = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journalBeforeSettings?.pending, false);

    stored = {
      ...(stored as Record<string, unknown>),
      retiredRootFolders: [earlierRetiredRoot]
    };
    await plugin.onExternalSettingsChange();

    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [DEFAULT_SETTINGS.rootFolder, earlierRetiredRoot],
      "the canonical save unions local and delivered tombstones"
    );
    const journalAfterSettings = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journalAfterSettings?.pending, true);
    assert.deepEqual(
      journalAfterSettings?.trustedInventory,
      journalBeforeSettings?.trustedInventory
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: {
        from: earlierRetiredRoot,
        to: "Ward Records"
      }
    });
    assert.equal(await plugin.retryMigrationReconciliation(), false);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(
      (app.loadLocalStorage(
        TRUSTED_INVENTORY_JOURNAL_KEY
      ) as TestTrustedInventoryJournal | null)?.pending,
      true
    );
    await assert.rejects(
      () => service.createEpisode(
        episodeInput({ mrn: "7015", caseName: "External tombstone merge race" })
      ),
      /temporarily read-only|recovery information conflicts/i
    );
    assert.ok(app.vault.getAbstractFileByPath(earlierDeliveryPath));
    assert.ok(app.vault.getAbstractFileByPath(destinationEpisodePath));
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a crash before a tombstone union save cannot forget the local retired root", async () => {
  const originalRoot = clinicalRootFolder();
  let releaseCanonicalSave: () => void = () => undefined;
  let interruptedCallback: Promise<void> | null = null;
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    await plugin.migrateRootFolder("Ward Records");

    const cleanJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(cleanJournal?.pending, false);
    assert.equal(cleanJournal?.retiredRootFingerprints?.length, 1);
    assert.match(cleanJournal?.retiredRootFingerprints?.[0] ?? "", /^[0-9a-f]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(cleanJournal),
      /Clinical Workspace|Ward Records/,
      "the device-local commitment contains no vault path"
    );

    const remoteRetiredRoot = "Remote Retired Root";
    stored = {
      ...(stored as Record<string, unknown>),
      retiredRootFolders: [remoteRetiredRoot]
    };
    let signalCanonicalSaveStarted: () => void = () => undefined;
    const canonicalSaveStarted = new Promise<void>((resolve) => {
      signalCanonicalSaveStarted = resolve;
    });
    const canonicalSaveGate = new Promise<void>((resolve) => {
      releaseCanonicalSave = resolve;
    });
    plugin.saveData = async (data) => {
      signalCanonicalSaveStarted();
      await canonicalSaveGate;
      stored = structuredClone(data);
    };

    interruptedCallback = plugin.onExternalSettingsChange();
    await canonicalSaveStarted;
    const pendingAtCrash = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingAtCrash?.pending, true);
    assert.equal(pendingAtCrash?.retiredRootFingerprints?.length, 2);
    assert.ok(
      cleanJournal?.retiredRootFingerprints?.every((fingerprint) =>
        pendingAtCrash?.retiredRootFingerprints?.includes(fingerprint)
      ),
      "the callback journal preserves the full pre-callback tombstone commitment"
    );
    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [remoteRetiredRoot],
      "the canonical union has not reached shared storage at the crash point"
    );

    const destinationEpisodePath = managedRecordPaths(app, "Ward Records")
      .find((path) => path.includes("/Episodes/"));
    assert.ok(destinationEpisodePath);
    const destinationContent = app.vault.files.get(destinationEpisodePath);
    assert.ok(destinationContent);
    const lateSourcePath =
      `${DEFAULT_SETTINGS.rootFolder}/Episodes/late-after-crash.md`;
    await app.vault.createFolder(DEFAULT_SETTINGS.rootFolder);
    await app.vault.createFolder(`${DEFAULT_SETTINGS.rootFolder}/Episodes`);
    app.vault.writeRaw(
      lateSourcePath,
      destinationContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-late-after-crash`
      )
    );

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(
      await restarted.retryExactRestoredRootRecovery(),
      false,
      "an exact active-root scan cannot clear a missing retired-root commitment"
    );
    const journalAfterRetry = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journalAfterRetry?.pending, true);
    assert.deepEqual(
      journalAfterRetry?.retiredRootFingerprints,
      pendingAtCrash?.retiredRootFingerprints
    );
    await assert.rejects(
      () => new ClinicalService(restartedRepository).createEpisode(
        episodeInput({ mrn: "7016", caseName: "Crash-lost tombstone remains blocked" })
      ),
      /synchronized recovery information conflicts/
    );
    assert.ok(app.vault.getAbstractFileByPath(lateSourcePath));
    assert.ok(app.vault.getAbstractFileByPath(destinationEpisodePath));
  } finally {
    releaseCanonicalSave();
    await interruptedCallback?.catch(() => undefined);
    setClinicalRoot(originalRoot);
  }
});

test("legacy clean tombstone journals upgrade, but interrupted legacy journals fail closed", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    await plugin.migrateRootFolder("Ward Records");
    assert.deepEqual(
      (stored as { retiredRootFolders?: unknown }).retiredRootFolders,
      [DEFAULT_SETTINGS.rootFolder]
    );

    const currentClean = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(currentClean?.pending, false);
    assert.equal(currentClean?.retiredRootFingerprints?.length, 1);
    const legacyClean = structuredClone(currentClean) as TestTrustedInventoryJournal;
    delete legacyClean.retiredRootFingerprints;
    app.saveLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY, legacyClean);

    const cleanRestartRepository = new ClinicalRepository(app as unknown as App);
    const cleanRestart = makePlugin(app, cleanRestartRepository, () => stored);
    await cleanRestart.loadSettings();
    cleanRestartRepository.setWriteBlock(
      cleanRestart.migrationRecoveryBlocked ? cleanRestart.recoveryBlockMessage : null
    );
    assert.equal(cleanRestart.baselineReviewRequired, false);
    assert.equal(await cleanRestart.retryExactRestoredRootRecovery(), true);
    const upgraded = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(upgraded?.pending, false);
    assert.equal(upgraded?.retiredRootFingerprints?.length, 1);

    const legacyPending = structuredClone(upgraded) as TestTrustedInventoryJournal;
    legacyPending.generation += 1;
    legacyPending.pending = true;
    delete legacyPending.retiredRootFingerprints;
    app.saveLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY, legacyPending);

    const pendingRestartRepository = new ClinicalRepository(app as unknown as App);
    const pendingRestart = makePlugin(app, pendingRestartRepository, () => stored);
    await pendingRestart.loadSettings();
    pendingRestartRepository.setWriteBlock(
      pendingRestart.migrationRecoveryBlocked ? pendingRestart.recoveryBlockMessage : null
    );
    assert.equal(pendingRestart.baselineReviewRequired, true);
    assert.equal(pendingRestart.migrationRecoveryBlocked, true);
    assert.equal(await pendingRestart.retryExactRestoredRootRecovery(), false);
    assert.deepEqual(
      app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY),
      legacyPending,
      "an interrupted pre-extension journal cannot prove which tombstones existed"
    );
    await assert.rejects(
      () => new ClinicalService(pendingRestartRepository).createEpisode(
        episodeInput({ mrn: "7017", caseName: "Legacy pending journal stays blocked" })
      ),
      /synchronized recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a root migration drains a suspended loose note and leaves it only at the destination", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const sourceFolder = `${DEFAULT_SETTINGS.rootFolder}/Documents`;
    const sourcePath = `${sourceFolder}/Handover migration race.md`;
    const destinationPath = "Ward Records/Documents/Handover migration race.md";
    const create = app.vault.create.bind(app.vault);
    let signalCreateStarted: () => void = () => undefined;
    let releaseCreate: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    app.vault.create = async (path, content) => {
      if (path === sourcePath) {
        signalCreateStarted();
        await createGate;
      }
      return create(path, content);
    };

    const createLooseNote = repository.createLooseNote(
      sourceFolder,
      "Handover migration race",
      "Clinical handover"
    );
    await createStarted;
    let migrationSettled = false;
    const migration = plugin.migrateRootFolder("Ward Records").then((result) => {
      migrationSettled = true;
      return result;
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const settledBeforeCreate = migrationSettled;
    releaseCreate();
    await createLooseNote;
    await migration;

    assert.equal(settledBeforeCreate, false, "the root move waits for the admitted loose note");
    assert.equal(app.vault.getAbstractFileByPath(sourcePath), null);
    assert.ok(app.vault.getAbstractFileByPath(destinationPath));
    assert.equal(plugin.migrationRecoveryBlocked, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external root rebind cannot strand an admitted create in the old root and reopen writes", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const record: EpisodeRecord = {
      ...created.episode.record,
      id: `${created.episode.record.id}-external-root-race`,
      case: "External root rebind create race"
    };
    const destinationRoot = "Ward Records";
    const oldPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${record.id}.md`;
    const destinationPath = `${destinationRoot}/Episodes/${record.id}.md`;
    const create = app.vault.create.bind(app.vault);
    let signalCreateStarted: () => void = () => undefined;
    let releaseCreate: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createReleased = false;
    const releaseCreateOnce = (): void => {
      if (createReleased) return;
      createReleased = true;
      releaseCreate();
    };
    app.vault.create = async (path, content) => {
      if (path !== oldPath) return create(path, content);
      signalCreateStarted();
      await createGate;
      return create(path, content);
    };

    const createRecord = repository.create(record).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await createStarted;

    // Model Sync's folder delivery before its marker-free data.json delivery.
    // The admitted create has already frozen its old-root path but has not yet
    // written the file.
    await renameRoot(app, DEFAULT_SETTINGS.rootFolder, destinationRoot);
    stored = {
      ...(stored as Record<string, unknown>),
      rootFolder: destinationRoot
    };
    delete (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress;

    // The callback drains the admitted write before it evaluates the rebind.
    // Releasing at that drain point keeps this regression finite without
    // requiring (or permitting) a destination scan to authorize the rebind.
    const pauseManagedRecordMutations = repository.pauseManagedRecordMutations.bind(repository);
    repository.pauseManagedRecordMutations = async () => {
      releaseCreateOnce();
      return pauseManagedRecordMutations();
    };

    const externalCallback = plugin.onExternalSettingsChange().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const [callbackOutcome, createOutcome] = await Promise.all([
      externalCallback,
      createRecord
    ]);

    assert.ok(app.vault.getAbstractFileByPath(oldPath), "the resumed write landed in the old root");
    assert.equal(
      app.vault.getAbstractFileByPath(destinationPath),
      null,
      "the resumed record was not part of the delivered destination"
    );
    assert.equal(
      callbackOutcome.status === "resolved" &&
        createOutcome.status === "rejected" &&
        !plugin.migrationRecoveryBlocked &&
        clinicalRootFolder() === destinationRoot,
      false,
      "the external callback must not finish clean and writable after stranding an admitted record"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: {
        from: DEFAULT_SETTINGS.rootFolder,
        to: destinationRoot
      }
    });
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external replacement during the post-create inventory scan cannot advance the journal", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const create = app.vault.create.bind(app.vault);
    let lastManagedCreatePath: string | null = null;
    app.vault.create = async (path, content) => {
      const file = await create(path, content);
      if (MANAGED_FOLDERS.some((folder) => file.path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`))) {
        lastManagedCreatePath = file.path;
      }
      return file;
    };
    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    let replacementInjected = false;
    plugin.parsedRecordInventory = async (root) => {
      if (!replacementInjected && lastManagedCreatePath) {
        const path = lastManagedCreatePath;
        const content = app.vault.files.get(path);
        assert.ok(content);
        app.vault.writeRaw(
          path,
          content.replace(
            /^id:\s*(.+)$/m,
            (_line, id: string) => `id: ${id.trim()}-external-during-scan`
          )
        );
        plugin.observeManagedRecordDelivery(path);
        replacementInjected = true;
      }
      return readInventory(root);
    };

    await service.createEpisode(episodeInput({
      mrn: "5226",
      caseName: "Post-create scan provenance"
    })).catch(() => undefined);

    assert.equal(replacementInjected, true);
    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(after?.pending, true);
    assert.deepEqual(after?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external replacement during the post-create safety save is consumed before mutation release", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    let signalSafetySaveStarted: () => void = () => undefined;
    let releaseSafetySave: () => void = () => undefined;
    const safetySaveStarted = new Promise<void>((resolve) => {
      signalSafetySaveStarted = resolve;
    });
    const safetySaveGate = new Promise<void>((resolve) => {
      releaseSafetySave = resolve;
    });
    plugin.saveData = async (data) => {
      signalSafetySaveStarted();
      await safetySaveGate;
      stored = structuredClone(data);
    };

    const ownedRecord: EpisodeRecord = {
      ...created.episode.record,
      id: `${created.episode.record.id}-owned-save-race`,
      case: "Post-scan safety-save provenance"
    };
    const createRecord = repository.create(ownedRecord);
    await safetySaveStarted;

    const ownedPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${ownedRecord.id}.md`;
    const ownedContent = app.vault.files.get(ownedPath);
    assert.ok(ownedContent);
    app.vault.writeRaw(
      ownedPath,
      ownedContent.replace(
        /^id:\s*(.+)$/m,
        (_line, id: string) => `id: ${id.trim()}-external-during-save`
      )
    );
    plugin.observeManagedRecordDelivery(ownedPath);

    releaseSafetySave();
    await createRecord.catch(() => undefined);

    const journal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journal?.pending, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(
      await plugin.retryPendingMigrationRecovery(),
      false,
      "the lost plugin-created id requires explicit review rather than another silent ratchet"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external same-path replacement during a plugin-owned update cannot evade the journal", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const before = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.ok(before?.trustedInventory);

    const processFrontMatter = app.fileManager.processFrontMatter.bind(app.fileManager);
    let replacementInjected = false;
    app.fileManager.processFrontMatter = async (file, transform) => {
      await processFrontMatter(file, transform);
      const content = app.vault.files.get(file.path);
      assert.ok(content);
      assert.match(content, /^id:\s*.+$/m);
      app.vault.writeRaw(
        file.path,
        content.replace(
          /^id:\s*(.+)$/m,
          (_line, id: string) => `id: ${id.trim()}-external-update-race`
        )
      );
      plugin.observeManagedRecordDelivery(file.path);
      replacementInjected = true;
    };

    await repository.update<EpisodeRecord>(created.episode.path, {
      priority: "urgent"
    }).catch(() => undefined);

    assert.equal(replacementInjected, true);
    const after = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(after?.pending, true);
    assert.deepEqual(after?.trustedInventory, before.trustedInventory);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("different-path concurrent plugin creates do not consume each other's provenance", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const baselineCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    const firstRecord: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-concurrent-first`,
      case: "Concurrent provenance first"
    };
    const secondRecord: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-concurrent-second`,
      case: "Concurrent provenance second"
    };
    const firstPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${firstRecord.id}.md`;
    const secondPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${secondRecord.id}.md`;

    const create = app.vault.create.bind(app.vault);
    app.vault.create = async (path, content) => {
      const file = await create(path, content);
      if (path === firstPath || path === secondPath) {
        plugin.observeManagedRecordDelivery(path);
      }
      return file;
    };

    const read = app.vault.read.bind(app.vault);
    let signalSecondReadStarted: () => void = () => undefined;
    let releaseSecondRead: () => void = () => undefined;
    const secondReadStarted = new Promise<void>((resolve) => {
      signalSecondReadStarted = resolve;
    });
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    let secondReadHeld = false;
    app.vault.read = async (file) => {
      if (file.path === secondPath && !secondReadHeld) {
        secondReadHeld = true;
        signalSecondReadStarted();
        await secondReadGate;
      }
      return read(file);
    };

    const secondCreate = repository.create(secondRecord);
    await secondReadStarted;
    const firstCreate = repository.create(firstRecord);
    // The vulnerable implementation lets the first create finish after its
    // observer globally consumes the second create's still-unverified event.
    // A safe implementation may instead defer or serialize it, so release the
    // held read after a bounded fallback without constraining that design.
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      firstCreate.then(() => undefined),
      new Promise<void>((resolve) => {
        fallbackTimer = setTimeout(resolve, 25);
      })
    ]);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    releaseSecondRead();
    await Promise.all([firstCreate, secondCreate]);

    assert.ok(app.vault.getAbstractFileByPath(firstPath));
    assert.ok(app.vault.getAbstractFileByPath(secondPath));
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.baselineReviewRequired, false);

    const inventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(inventory.total, baselineCount + 2);
    const journal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journal?.pending, false);
    assert.equal(journal?.trustedInventory?.expectedManagedRecordCount, inventory.total);
    assert.deepEqual(journal?.trustedInventory?.expectedEntityCounts, inventory.counts);
    assert.equal(journal?.trustedInventory?.expectedRecordDigest, inventory.digest);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a failed final claimant flushes a successful concurrent create's deferred inventory ratchet", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const baselineCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    const successfulRecord: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-deferred-success`,
      case: "Deferred inventory ratchet success"
    };
    const failingRecord: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-deferred-failure`,
      case: "Deferred inventory ratchet failure"
    };
    const successfulPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${successfulRecord.id}.md`;
    const failingPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${failingRecord.id}.md`;

    const create = app.vault.create.bind(app.vault);
    let signalFailingCreateStarted: () => void = () => undefined;
    let signalSuccessfulRecordWritten: () => void = () => undefined;
    let releaseFailingCreate: () => void = () => undefined;
    const failingCreateStarted = new Promise<void>((resolve) => {
      signalFailingCreateStarted = resolve;
    });
    const failingCreateGate = new Promise<void>((resolve) => {
      releaseFailingCreate = resolve;
    });
    const successfulRecordWritten = new Promise<void>((resolve) => {
      signalSuccessfulRecordWritten = resolve;
    });
    app.vault.create = async (path, content) => {
      if (path === failingPath) {
        signalFailingCreateStarted();
        await failingCreateGate;
        throw new Error("Injected pre-write create failure");
      }
      const file = await create(path, content);
      if (path === successfulPath) {
        plugin.observeManagedRecordDelivery(path);
        signalSuccessfulRecordWritten();
      }
      return file;
    };

    const failingCreate = repository.create(failingRecord);
    await failingCreateStarted;
    let successfulCreateSettled = false;
    const successfulCreate = repository.create(successfulRecord);
    void successfulCreate.then(
      () => {
        successfulCreateSettled = true;
      },
      () => {
        successfulCreateSettled = true;
      }
    );
    await successfulRecordWritten;
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    assert.ok(app.vault.getAbstractFileByPath(successfulPath));
    assert.equal(app.vault.getAbstractFileByPath(failingPath), null);
    assert.equal(
      successfulCreateSettled,
      false,
      "the successful writer cannot report success before its transferred ratchet is durable"
    );
    const journalBeforeHandoff = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(
      journalBeforeHandoff?.trustedInventory?.expectedManagedRecordCount,
      baselineCount,
      "the successful create deliberately leaves its ratchet to the remaining claimant"
    );

    releaseFailingCreate();
    await assert.rejects(() => failingCreate, /Injected pre-write create failure/);
    await successfulCreate;

    assert.equal(repository.isManagedRecordMutationInProgress(successfulPath), false);
    assert.equal(repository.isManagedRecordMutationInProgress(failingPath), false);
    const mutationPause = await repository.pauseManagedRecordMutations();
    assert.equal(mutationPause.drainedExisting, false, "every mutation claim has drained");
    mutationPause.release();

    const inventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(inventory.total, baselineCount + 1);
    const journal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journal?.pending, false);
    assert.equal(journal?.trustedInventory?.expectedManagedRecordCount, inventory.total);
    assert.deepEqual(journal?.trustedInventory?.expectedEntityCounts, inventory.counts);
    assert.equal(journal?.trustedInventory?.expectedRecordDigest, inventory.digest);
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.baselineReviewRequired, false);

    let callbackTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        plugin.onExternalSettingsChange(),
        new Promise<never>((_resolve, reject) => {
          callbackTimer = setTimeout(
            () => reject(new Error("The later settings callback did not drain")),
            250
          );
        })
      ]);
    } finally {
      if (callbackTimer !== null) clearTimeout(callbackTimer);
    }
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.baselineReviewRequired, false);
    const finalJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(finalJournal?.pending, false);
    assert.equal(finalJournal?.trustedInventory?.expectedManagedRecordCount, inventory.total);
    assert.equal(finalJournal?.trustedInventory?.expectedRecordDigest, inventory.digest);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a drained same-root external callback never creates a self-migration marker", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const saves: unknown[] = [];
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
      saves.push(data);
    });
    await plugin.noteManagedRecordWrite();
    saves.length = 0;

    const folder = `${DEFAULT_SETTINGS.rootFolder}/Documents`;
    const path = `${folder}/Same-root callback drain.md`;
    const create = app.vault.create.bind(app.vault);
    let signalCreateStarted: () => void = () => undefined;
    let releaseCreate: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    app.vault.create = async (candidate, content) => {
      if (candidate === path) {
        signalCreateStarted();
        await createGate;
      }
      return create(candidate, content);
    };

    const looseNote = repository.createLooseNote(
      folder,
      "Same-root callback drain",
      "Same-root callback drain"
    );
    await createStarted;
    let callbackSettled = false;
    const callback = plugin.onExternalSettingsChange().then(() => {
      callbackSettled = true;
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    assert.equal(callbackSettled, false, "the callback drains the admitted operation");

    releaseCreate();
    await Promise.all([looseNote, callback]);

    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.baselineReviewRequired, false);
    assert.equal(clinicalRootFolder(), DEFAULT_SETTINGS.rootFolder);
    assert.ok(app.vault.getAbstractFileByPath(path));
    assert.ok(
      saves.every(
        (save) => (save as { migrationInProgress?: MigrationMarker }).migrationInProgress === undefined
      ),
      "no durable snapshot may contain a from==to migration"
    );
    assert.equal(
      (app.loadLocalStorage(
        TRUSTED_INVENTORY_JOURNAL_KEY
      ) as TestTrustedInventoryJournal | null)?.pending,
      false,
      "the unchanged exact root clears the callback journal"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a drained root rebind preserves a delivered higher expected-count floor", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const localInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    addDistinctManagedRecord(app, DEFAULT_SETTINGS.rootFolder, "drained-higher-floor");
    const deliveredInventory = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(deliveredInventory.total, localInventory.total + 1);

    const folder = `${DEFAULT_SETTINGS.rootFolder}/Documents`;
    const path = `${folder}/Drained root rebind.md`;
    const create = app.vault.create.bind(app.vault);
    let signalCreateStarted: () => void = () => undefined;
    let releaseCreate: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    app.vault.create = async (candidate, content) => {
      if (candidate === path) {
        signalCreateStarted();
        await createGate;
      }
      return create(candidate, content);
    };

    const looseNote = repository.createLooseNote(folder, "Drained root rebind", "handover");
    await createStarted;
    await renameRoot(app, DEFAULT_SETTINGS.rootFolder, "Ward Records");
    const priorSafety = (stored as { workspaceSafety?: Record<string, unknown> }).workspaceSafety;
    assert.ok(priorSafety);
    stored = {
      ...(stored as Record<string, unknown>),
      rootFolder: "Ward Records",
      workspaceSafety: {
        ...priorSafety,
        expectedManagedRecordCount: deliveredInventory.total,
        expectedEntityCounts: { ...deliveredInventory.counts },
        expectedRecordDigest: deliveredInventory.digest
      }
    };

    const callback = plugin.onExternalSettingsChange();
    releaseCreate();
    await Promise.all([looseNote, callback]);

    assert.equal(plugin.expectedManagedRecordCount, deliveredInventory.total);
    assert.deepEqual(
      plugin.expectedEntityCounts,
      localInventory.counts,
      "the unreviewed delivery raises only the aggregate floor"
    );
    assert.equal(plugin.expectedRecordDigest, localInventory.digest);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: {
        from: DEFAULT_SETTINGS.rootFolder,
        to: "Ward Records"
      }
    });
    const persisted = (stored as {
      workspaceSafety?: { expectedManagedRecordCount?: number; baselineReviewRequired?: boolean };
    }).workspaceSafety;
    assert.equal(persisted?.expectedManagedRecordCount, deliveredInventory.total);
    assert.equal(persisted?.baselineReviewRequired, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an over-limit union of valid retired-root sets fails closed without a partial merge", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const saves: unknown[] = [];
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
      saves.push(data);
    });
    await plugin.noteManagedRecordWrite();

    const localRoots = Array.from(
      { length: 40 },
      (_unused, index) => `Retired local ${String(index).padStart(2, "0")}`
    );
    stored = {
      ...(stored as Record<string, unknown>),
      retiredRootFolders: localRoots
    };
    await plugin.onExternalSettingsChange();
    assert.deepEqual([...plugin.retiredRootFolders].sort(), localRoots);

    const deliveredRoots = Array.from(
      { length: 40 },
      (_unused, index) => `Retired delivered ${String(index).padStart(2, "0")}`
    );
    stored = {
      ...(stored as Record<string, unknown>),
      retiredRootFolders: deliveredRoots
    };
    saves.length = 0;
    await plugin.onExternalSettingsChange();

    assert.deepEqual(
      [...plugin.retiredRootFolders].sort(),
      localRoots,
      "the 80-root union is rejected atomically"
    );
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.ok(saves.length > 0);
    for (const save of saves) {
      assert.deepEqual(
        (save as { retiredRootFolders?: string[] }).retiredRootFolders,
        localRoots,
        "no canonical save may contain a prefix or truncation of the rejected union"
      );
    }
    assert.equal(
      (app.loadLocalStorage(
        TRUSTED_INVENTORY_JOURNAL_KEY
      ) as TestTrustedInventoryJournal | null)?.pending,
      true
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("resolving one retired-root marker cannot reopen while another retired root exists", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const firstRetiredRoot = "A Retired Workspace";
    const secondRetiredRoot = "B Retired Workspace";
    await app.vault.createFolder(firstRetiredRoot);
    await app.vault.createFolder(secondRetiredRoot);
    stored = {
      ...(stored as Record<string, unknown>),
      retiredRootFolders: [firstRetiredRoot, secondRetiredRoot]
    };
    await plugin.onExternalSettingsChange();
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: {
        from: firstRetiredRoot,
        to: DEFAULT_SETTINGS.rootFolder
      }
    });

    deleteRoot(app, firstRetiredRoot);
    assert.equal(
      await plugin.retryPendingMigrationRecovery(),
      false,
      "the next tombstone conflict keeps recovery closed"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.deepEqual(plugin.pendingMigrationMarker, {
      migrationInProgress: {
        from: secondRetiredRoot,
        to: DEFAULT_SETTINGS.rootFolder
      }
    });
    assert.deepEqual(
      (stored as { migrationInProgress?: MigrationMarker }).migrationInProgress,
      { from: secondRetiredRoot, to: DEFAULT_SETTINGS.rootFolder },
      "the next recovery edge is durable before the first one can release writes"
    );
    assert.equal(
      (app.loadLocalStorage(
        TRUSTED_INVENTORY_JOURNAL_KEY
      ) as TestTrustedInventoryJournal | null)?.pending,
      true
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("legacy count-only marker recovery requires explicit Retry to install an exact clean journal", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput());
    const expectedCount = managedRecordPaths(app, DEFAULT_SETTINGS.rootFolder).length;
    await renameRoot(app, DEFAULT_SETTINGS.rootFolder, "Ward Records");
    const marker: MigrationMarker = {
      from: DEFAULT_SETTINGS.rootFolder,
      to: "Ward Records"
    };
    let stored: unknown = {
      ...DEFAULT_SETTINGS,
      rootFolder: marker.to,
      migrationInProgress: marker,
      workspaceSafety: persistedSafety(expectedCount)
    };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });

    await plugin.onExternalSettingsChange();

    assert.equal(clinicalRootFolder(), marker.to);
    assert.equal(plugin.pendingMigrationMarker, null);
    assert.equal(plugin.expectedEntityCounts, null);
    assert.equal(plugin.expectedRecordDigest, null);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
    const pending = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pending?.pending, true);
    assert.equal(pending?.trustedInventory, undefined);

    const exact = await plugin.parsedRecordInventory(marker.to);
    assert.equal(await plugin.retryPendingMigrationRecovery(), true);

    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(plugin.missingRootRecoveryBlocked, false);
    assert.equal(plugin.expectedManagedRecordCount, exact.total);
    assert.deepEqual(plugin.expectedEntityCounts, exact.counts);
    assert.equal(plugin.expectedRecordDigest, exact.digest);
    const clean = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(clean?.pending, false);
    assert.equal(clean?.trustedInventory?.expectedManagedRecordCount, exact.total);
    assert.deepEqual(clean?.trustedInventory?.expectedEntityCounts, exact.counts);
    assert.equal(clean?.trustedInventory?.expectedRecordDigest, exact.digest);
    const persisted = (stored as {
      workspaceSafety?: {
        expectedEntityCounts?: TestRecordInventory["counts"];
        expectedRecordDigest?: string;
        rootRecoveryRequired?: boolean;
      };
    }).workspaceSafety;
    assert.deepEqual(persisted?.expectedEntityCounts, exact.counts);
    assert.equal(persisted?.expectedRecordDigest, exact.digest);
    assert.equal(persisted?.rootRecoveryRequired, false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an observer failure cannot re-trust the old tuple after deletion and restart", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const trustedBefore = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(trustedBefore?.pending, false);
    assert.ok(trustedBefore?.trustedInventory);

    const record: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-observer-failure`,
      case: "Post-create observer failure"
    };
    const path = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${record.id}.md`;
    const readInventory = plugin.parsedRecordInventory.bind(plugin);
    plugin.parsedRecordInventory = async () => {
      throw new Error("Injected post-create inventory failure");
    };

    await assert.rejects(
      () => repository.create(record),
      /Injected post-create inventory failure/
    );
    plugin.parsedRecordInventory = readInventory;

    assert.ok(
      app.vault.getAbstractFileByPath(path),
      "the record write completed before its whole-root observer failed"
    );
    assert.equal(repository.isManagedRecordMutationInProgress(path), false);
    const mutationPause = await repository.pauseManagedRecordMutations();
    assert.equal(mutationPause.drainedExisting, false, "every mutation claim has drained");
    mutationPause.release();

    const pendingJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingJournal?.pending, true);
    assert.deepEqual(
      pendingJournal?.trustedInventory,
      trustedBefore.trustedInventory,
      "the failed observer must preserve the prior device-local trust anchor"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(plugin.baselineReviewRequired, true);
    await assert.rejects(
      () => repository.create({ ...record, id: `${record.id}-blocked` }),
      /recovery information conflicts/
    );

    app.vault.deleteRaw(path);
    repository.invalidatePath(path);

    const restartedRepository = new ClinicalRepository(app as unknown as App);
    const restarted = makePlugin(app, restartedRepository, () => stored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(
      restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null
    );

    assert.equal(restarted.baselineReviewRequired, true);
    assert.equal(
      await restarted.retryPendingMigrationRecovery(),
      false,
      "deleting the uncommitted record must not make the old tuple silently trusted"
    );
    assert.equal(restarted.migrationRecoveryBlocked, true);
    assert.equal(restarted.missingRootRecoveryBlocked, true);
    const journalAfterRetry = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(journalAfterRetry?.pending, true);
    assert.deepEqual(journalAfterRetry?.trustedInventory, trustedBefore.trustedInventory);
    await assert.rejects(
      () => restartedRepository.create({ ...record, id: `${record.id}-restart-blocked` }),
      /configured folder is unavailable|recovery information conflicts/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a create joining an in-flight observer receives a final inventory ratchet", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const baseline = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);

    const first: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-observer-owner`,
      case: "Observer owner"
    };
    const second: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-observer-joiner`,
      case: "Observer joiner"
    };
    const firstPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${first.id}.md`;
    const secondPath = `${DEFAULT_SETTINGS.rootFolder}/Episodes/${second.id}.md`;
    const create = app.vault.create.bind(app.vault);
    let signalSecondWritten: () => void = () => undefined;
    const secondWritten = new Promise<void>((resolve) => {
      signalSecondWritten = resolve;
    });
    app.vault.create = async (path, content) => {
      const file = await create(path, content);
      if (path === secondPath) signalSecondWritten();
      return file;
    };

    let signalFirstSaveStarted: () => void = () => undefined;
    let releaseFirstSave: () => void = () => undefined;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSaveStarted = resolve;
    });
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let heldFirstRatchet = false;
    plugin.saveData = async (data) => {
      const expectedCount = (data as {
        workspaceSafety?: { expectedManagedRecordCount?: number };
      }).workspaceSafety?.expectedManagedRecordCount;
      if (!heldFirstRatchet && expectedCount === baseline.total + 1) {
        heldFirstRatchet = true;
        signalFirstSaveStarted();
        await firstSaveGate;
      }
      stored = structuredClone(data);
    };

    const firstCreate = repository.create(first);
    await firstSaveStarted;
    assert.ok(app.vault.getAbstractFileByPath(firstPath));
    assert.equal(app.vault.getAbstractFileByPath(secondPath), null);

    let secondSettled = false;
    const secondCreate = repository.create(second);
    void secondCreate.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      }
    );
    await secondWritten;
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    assert.ok(
      app.vault.getAbstractFileByPath(secondPath),
      "the joining create writes while the first whole-root observer is saving"
    );
    assert.equal(
      secondSettled,
      false,
      "a transferred create cannot report success before its shared ratchet is durable"
    );

    releaseFirstSave();
    await Promise.all([firstCreate, secondCreate]);
    assert.equal(secondSettled, true);
    assert.equal(heldFirstRatchet, true);

    const exact = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    assert.equal(exact.total, baseline.total + 2);
    const cleanJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(cleanJournal?.pending, false);
    assert.equal(cleanJournal?.trustedInventory?.expectedManagedRecordCount, exact.total);
    assert.deepEqual(cleanJournal?.trustedInventory?.expectedEntityCounts, exact.counts);
    assert.equal(cleanJournal?.trustedInventory?.expectedRecordDigest, exact.digest);

    app.vault.deleteRaw(secondPath);
    repository.invalidatePath(secondPath);
    plugin.observeManagedRecordDelivery(secondPath);
    plugin.blockIfActiveRootDisappeared(secondPath);
    await plugin.persistWorkspaceSafety();

    assert.equal(
      await plugin.retryPendingMigrationRecovery(),
      false,
      "deleting the joining create cannot exactly match the fully ratcheted baseline"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    const pendingJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingJournal?.pending, true);
    assert.equal(
      pendingJournal?.trustedInventory?.expectedManagedRecordCount,
      exact.total
    );
    assert.equal(pendingJournal?.trustedInventory?.expectedRecordDigest, exact.digest);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a transferred create rejects promptly when the owning observer fails", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const baseline = await plugin.parsedRecordInventory(DEFAULT_SETTINGS.rootFolder);
    const trustedBefore = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(trustedBefore?.pending, false);
    assert.ok(trustedBefore?.trustedInventory);

    const owner: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-failing-owner`,
      case: "Failing observer owner"
    };
    const transferred: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-failed-transfer`,
      case: "Failed observer transfer"
    };
    const transferredPath =
      `${DEFAULT_SETTINGS.rootFolder}/Episodes/${transferred.id}.md`;
    const create = app.vault.create.bind(app.vault);
    let signalTransferredWritten: () => void = () => undefined;
    const transferredWritten = new Promise<void>((resolve) => {
      signalTransferredWritten = resolve;
    });
    app.vault.create = async (path, content) => {
      const file = await create(path, content);
      if (path === transferredPath) signalTransferredWritten();
      return file;
    };

    let signalFailingSaveStarted: () => void = () => undefined;
    let releaseFailingSave: () => void = () => undefined;
    const failingSaveStarted = new Promise<void>((resolve) => {
      signalFailingSaveStarted = resolve;
    });
    const failingSaveGate = new Promise<void>((resolve) => {
      releaseFailingSave = resolve;
    });
    let failureInjected = false;
    plugin.saveData = async (data) => {
      const expectedCount = (data as {
        workspaceSafety?: { expectedManagedRecordCount?: number };
      }).workspaceSafety?.expectedManagedRecordCount;
      if (!failureInjected && expectedCount === baseline.total + 1) {
        failureInjected = true;
        signalFailingSaveStarted();
        await failingSaveGate;
        throw new Error("Injected owning observer persistence failure");
      }
      stored = structuredClone(data);
    };

    const ownerCreate = repository.create(owner);
    await failingSaveStarted;
    const transferredCreate = repository.create(transferred);
    await transferredWritten;
    const outcomesPromise = Promise.allSettled([ownerCreate, transferredCreate]);
    releaseFailingSave();

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const outcomes = await Promise.race([
      outcomesPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Transferred observer failure did not settle both writers")),
          250
        );
      })
    ]);
    if (timeout !== null) clearTimeout(timeout);

    assert.equal(failureInjected, true);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["rejected", "rejected"],
      "the observer error propagates to the writer that transferred its ratchet"
    );
    assert.equal(repository.isManagedRecordMutationInProgress(transferredPath), false);
    const mutationPause = await repository.pauseManagedRecordMutations();
    assert.equal(mutationPause.drainedExisting, false, "all transferred claims drain on rejection");
    mutationPause.release();
    const pendingJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingJournal?.pending, true);
    assert.deepEqual(pendingJournal?.trustedInventory, trustedBefore.trustedInventory);
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a transferred verified create rejected by an untrusted owner requires typed review", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const seeded = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const trustedBefore = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(trustedBefore?.pending, false);
    assert.ok(trustedBefore?.trustedInventory);

    const ownerPath = seeded.patient.path;
    const originalOwner = app.vault.files.get(ownerPath);
    assert.ok(originalOwner);
    const transferred: EpisodeRecord = {
      ...seeded.episode.record,
      id: `${seeded.episode.record.id}-dirty-transfer`,
      case: "Dirty owner transfer"
    };
    const transferredPath =
      `${DEFAULT_SETTINGS.rootFolder}/Episodes/${transferred.id}.md`;

    const read = app.vault.read.bind(app.vault);
    let ownerReadCount = 0;
    let signalOwnerVerificationRead: () => void = () => undefined;
    let releaseOwnerVerificationRead: () => void = () => undefined;
    const ownerVerificationRead = new Promise<void>((resolve) => {
      signalOwnerVerificationRead = resolve;
    });
    const ownerVerificationGate = new Promise<void>((resolve) => {
      releaseOwnerVerificationRead = resolve;
    });
    app.vault.read = async (file) => {
      if (file.path === ownerPath) {
        ownerReadCount += 1;
        if (ownerReadCount === 2) {
          signalOwnerVerificationRead();
          await ownerVerificationGate;
        }
      }
      return read(file);
    };

    const instrumentedRepository = repository as unknown as {
      confirmManagedMutationIdentity: (candidate: string, revision: number) => boolean;
    };
    const confirmManagedMutationIdentity =
      instrumentedRepository.confirmManagedMutationIdentity.bind(repository);
    const externalId = `${seeded.patient.record.id}-dirty-owner`;
    let replacementInjected = false;
    instrumentedRepository.confirmManagedMutationIdentity = (candidate, revision) => {
      const confirmed = confirmManagedMutationIdentity(candidate, revision);
      if (candidate === ownerPath && !replacementInjected) {
        replacementInjected = true;
        const content = app.vault.files.get(ownerPath);
        assert.ok(content);
        app.vault.writeRaw(
          ownerPath,
          content.replace(/^id:\s*(.+)$/m, `id: ${externalId}`)
        );
        repository.invalidatePath(ownerPath);
        plugin.observeManagedRecordDelivery(ownerPath);
      }
      return confirmed;
    };

    const ownerUpdate = repository.update<PatientRecord>(ownerPath, { phone: "123" });
    await ownerVerificationRead;
    const transferredCreate = repository.create(transferred);
    let transferredSettled = false;
    void transferredCreate.then(
      () => {
        transferredSettled = true;
      },
      () => {
        transferredSettled = true;
      }
    );
    for (
      let index = 0;
      index < 100 && !app.vault.getAbstractFileByPath(transferredPath);
      index += 1
    ) {
      await Promise.resolve();
    }
    assert.ok(
      app.vault.getAbstractFileByPath(transferredPath),
      "the transferred writer reaches its verified physical write"
    );
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    assert.equal(
      transferredSettled,
      false,
      "the verified create transfers its durability obligation to the active update"
    );

    releaseOwnerVerificationRead();
    const outcomes = await Promise.allSettled([ownerUpdate, transferredCreate]);
    assert.equal(replacementInjected, true);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["rejected", "rejected"],
      "the untrusted owner rejects both itself and the transferred verified writer"
    );
    assert.equal(repository.isManagedRecordMutationInProgress(ownerPath), false);
    assert.equal(repository.isManagedRecordMutationInProgress(transferredPath), false);
    assert.equal(
      plugin.baselineReviewRequired,
      true,
      "observer rejection after a verified write must require explicit baseline review"
    );
    const pendingJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingJournal?.pending, true);
    assert.deepEqual(pendingJournal?.trustedInventory, trustedBefore.trustedInventory);

    app.vault.writeRaw(ownerPath, originalOwner);
    app.vault.deleteRaw(transferredPath);
    repository.invalidatePath(ownerPath);
    repository.invalidatePath(transferredPath);
    plugin.observeManagedRecordDelivery(ownerPath);
    plugin.observeManagedRecordDelivery(transferredPath);
    await plugin.persistWorkspaceSafety();

    assert.equal(
      await plugin.retryPendingMigrationRecovery(),
      false,
      "removing a rejected verified write cannot silently make the old tuple trusted"
    );
    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.migrationRecoveryBlocked, true);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an external replacement after update confirmation is observed before claim release", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();
    const trustedBefore = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(trustedBefore?.pending, false);
    assert.ok(trustedBefore?.trustedInventory);

    const path = created.episode.path;
    const externalId = `${created.episode.record.id}-external-after-confirm`;
    const noteManagedRecordWrite = plugin.noteManagedRecordWrite.bind(plugin);
    let observerPasses = 0;
    plugin.noteManagedRecordWrite = async (paths) => {
      observerPasses += 1;
      return await noteManagedRecordWrite(paths);
    };

    const instrumentedRepository = repository as unknown as {
      confirmManagedMutationIdentity: (candidate: string, revision: number) => boolean;
    };
    const confirmManagedMutationIdentity =
      instrumentedRepository.confirmManagedMutationIdentity.bind(repository);
    let replacementInjected = false;
    let replacementSawClaim = false;
    instrumentedRepository.confirmManagedMutationIdentity = (candidate, revision) => {
      const confirmed = confirmManagedMutationIdentity(candidate, revision);
      if (candidate === path && !replacementInjected) {
        replacementInjected = true;
        const content = app.vault.files.get(path);
        assert.ok(content);
        app.vault.writeRaw(
          path,
          content.replace(/^id:\s*(.+)$/m, `id: ${externalId}`)
        );
        repository.invalidatePath(path);
        replacementSawClaim = repository.isManagedRecordMutationInProgress(path);
        plugin.observeManagedRecordDelivery(path);
      }
      return confirmed;
    };

    await assert.rejects(
      () => repository.update<EpisodeRecord>(path, { priority: "urgent" }),
      /untrusted record delivery/
    );

    assert.equal(replacementInjected, true);
    assert.equal(replacementSawClaim, true, "the replacement lands before claim release");
    assert.ok(observerPasses > 0, "the dirty post-confirmation path receives an observer pass");
    assert.equal(repository.hasUnclassifiedManagedMutationEvent(path), false);
    assert.equal(repository.isManagedRecordMutationInProgress(path), false);
    const changed = app.vault.files.get(path);
    assert.ok(changed);
    assert.match(changed, new RegExp(`^id:\\s*${externalId}$`, "m"));

    const pendingJournal = app.loadLocalStorage(
      TRUSTED_INVENTORY_JOURNAL_KEY
    ) as TestTrustedInventoryJournal | null;
    assert.equal(pendingJournal?.pending, true);
    assert.deepEqual(
      pendingJournal?.trustedInventory,
      trustedBefore.trustedInventory,
      "the changed identity cannot replace the clean trusted anchor"
    );
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.missingRootRecoveryBlocked, true);
    assert.equal(await plugin.retryPendingMigrationRecovery(), false);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("same-path update and managed maintenance cannot both resolve after clobbering one effect", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const created = await service.createEpisode(episodeInput());
    let stored: unknown = { ...DEFAULT_SETTINGS };
    const plugin = makePlugin(app, repository, () => stored, (data) => {
      stored = data;
    });
    await plugin.noteManagedRecordWrite();

    const path = created.patient.path;
    const file = app.vault.getAbstractFileByPath(path);
    assert.ok(file instanceof TFile);
    const tick = app.vault.tick.bind(app.vault);
    let tickCount = 0;
    let signalUpdateCaptured: () => void = () => undefined;
    let releaseUpdate: () => void = () => undefined;
    const updateCaptured = new Promise<void>((resolve) => {
      signalUpdateCaptured = resolve;
    });
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    app.vault.tick = async () => {
      tickCount += 1;
      // update() first performs one fresh read. FileManager.processFrontMatter
      // captures its source text synchronously, then reaches this second tick.
      if (tickCount === 2) {
        signalUpdateCaptured();
        await updateGate;
      }
      await tick();
    };

    const update = repository.update(path, { phone: "123" });
    await updateCaptured;

    const marker = "MANAGED_MAINTENANCE_EFFECT";
    let signalMaintenanceEntered: () => void = () => undefined;
    const maintenanceEntered = new Promise<void>((resolve) => {
      signalMaintenanceEntered = resolve;
    });
    const maintenance = repository.withManagedRecordMutation([path], async () => {
      signalMaintenanceEntered();
      await app.vault.process(file, (content) => `${content}\n${marker}\n`);
    });

    let entryTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      maintenanceEntered,
      new Promise<void>((resolve) => {
        entryTimer = setTimeout(resolve, 25);
      })
    ]);
    if (entryTimer !== null) clearTimeout(entryTimer);

    let maintenanceSettledBeforeRelease = false;
    const earlyMaintenance = maintenance.then(
      () => {
        maintenanceSettledBeforeRelease = true;
      },
      () => {
        maintenanceSettledBeforeRelease = true;
      }
    );
    if (maintenanceSettledBeforeRelease || tickCount > 2) {
      await earlyMaintenance;
      assert.match(app.vault.files.get(path) ?? "", new RegExp(marker));
    }

    releaseUpdate();
    const [updateResult, maintenanceResult] = await Promise.allSettled([update, maintenance]);
    const finalContent = app.vault.files.get(path) ?? "";
    if (updateResult.status === "fulfilled" && maintenanceResult.status === "fulfilled") {
      assert.match(finalContent, /^phone:\s*["']?123["']?\s*$/m);
      assert.match(
        finalContent,
        new RegExp(marker),
        "two successful same-path operations must preserve both verified effects"
      );
    } else {
      assert.ok(
        updateResult.status === "rejected" || maintenanceResult.status === "rejected",
        "a non-serialized overlap must reject at least one operation"
      );
    }
  } finally {
    setClinicalRoot(originalRoot);
  }
});
