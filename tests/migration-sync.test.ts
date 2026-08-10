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
import type { EpisodeRecord } from "../src/domain/types";
import { resolveMigrationRoot, type MigrationMarker } from "../src/services/migration";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness } from "./support/harness";

type TestPlugin = {
  app: StubApp;
  repository: ClinicalRepository;
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
  workspaceInitialized: boolean;
  managedRecordsExpected: boolean;
  expectedManagedRecordCount: number;
  workspaceSafetyNeedsPersistence: boolean;
  recoveryBlockMessage: string;
  structureReady: boolean;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  loadSettings: () => Promise<void>;
  onExternalSettingsChange: () => Promise<void>;
  retryPendingMigrationRecovery: () => Promise<boolean>;
  reconcileMigration: (stored: unknown) => Promise<boolean>;
  retryMigrationReconciliation: () => Promise<boolean>;
  ensureStructure: () => Promise<void>;
  initializeNewWorkspace: () => Promise<void>;
  retryMigrationForPath: (path: string) => void;
  handleVaultRename: (file: TFile | TFolder, oldPath: string) => void;
  handleExternalRootRename: (file: unknown, oldPath: string) => boolean;
  blockIfActiveRootDisappeared: (path: string) => void;
  noteManagedRecordWrite: () => Promise<void>;
  persistWorkspaceSafety: () => Promise<void>;
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
  plugin.workspaceInitialized = app.vault.getAbstractFileByPath(DEFAULT_SETTINGS.rootFolder) !== null;
  plugin.expectedManagedRecordCount = [...app.vault.files.keys()].filter((path) =>
    ["Patients", "Episodes", "Tasks", "Procedures"].some((folder) =>
      path.startsWith(`${DEFAULT_SETTINGS.rootFolder}/${folder}/`)
    )
  ).length;
  plugin.managedRecordsExpected = plugin.expectedManagedRecordCount > 0;
  plugin.workspaceSafetyNeedsPersistence = false;
  plugin.structureReady = true;
  plugin.loadData = async () => structuredClone(readStored());
  plugin.saveData = async (data) => {
    await onSave(structuredClone(data));
  };
  plugin.refreshOpenViews = async () => undefined;
  repository.setManagedRecordWriteObserver(() => plugin.noteManagedRecordWrite());
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

function managedRecordPaths(app: StubApp, root: string): string[] {
  return [...app.vault.files.keys()]
    .filter((path) => MANAGED_FOLDERS.some((folder) => path.startsWith(`${root}/${folder}/`)))
    .sort();
}

function retainManagedRecords(app: StubApp, root: string, count: number): void {
  for (const path of managedRecordPaths(app, root).slice(count)) app.vault.deleteRaw(path);
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

function primeAdoption(
  plugin: TestPlugin,
  stored: unknown,
  recordCount: number
): void {
  plugin.pendingAdoptionRoot = plugin.settings.rootFolder;
  plugin.pendingAdoptionRecordCount = recordCount;
  plugin.pendingAdoptionDataFingerprint = JSON.stringify(stored) ?? "undefined";
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

    await renameRoot(app, "Clinical Workspace", "Ward Records");
    const deliveredFolder = app.vault.getAbstractFileByPath("Ward Records");
    assert.ok(deliveredFolder);
    assert.equal(plugin.handleExternalRootRename(deliveredFolder, "Clinical Workspace"), true);

    // The event callback arms the barrier before its first await.
    assert.equal(plugin.migrationRecoveryBlocked, true);
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

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
    primeAdoption(upgrading, stored, expectedCount);
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

test("a safety-metadata save failure does not turn a verified record write into a failed action", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const { app, repository, service } = await harness();
    const plugin = makePlugin(app, repository, () => DEFAULT_SETTINGS, () => {
      throw new Error("simulated settings write failure");
    });

    const created = await service.createEpisode(episodeInput());

    assert.ok(created.episode.record.id);
    assert.equal((await repository.list<EpisodeRecord>("episode")).length, 1);
    assert.equal(plugin.workspaceSafetyNeedsPersistence, true, "later writes can retry persistence");
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

    primeAdoption(plugin, null, 0);
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
      () => {
        primeAdoption(plugin, null, 0);
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
    primeAdoption(plugin, stored, 0);
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
    primeAdoption(approving, stored, 0);
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
    primeAdoption(plugin, stored, 0);

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
        assert.equal(plugin.migrationRecoveryBlocked, false);
        assert.equal(plugin.pendingMigrationMarker, null);
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
        assert.equal(plugin.migrationRecoveryBlocked, false);
        assert.equal(
          (saved as { migrationInProgress?: MigrationMarker } | null)?.migrationInProgress,
          undefined
        );
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
    primeAdoption(restarted, stored, adoptedCount);
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
    assert.equal(safePlugin.migrationRecoveryBlocked, false);
    await first.service.createEpisode(episodeInput({ mrn: "7010" }));

    setClinicalRoot(DEFAULT_SETTINGS.rootFolder);
    const second = await harness();
    await second.service.createEpisode(episodeInput());
    const blockedPlugin = makePlugin(second.app, second.repository, () => DEFAULT_SETTINGS);
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
