/**
 * Two devices, one vault, ordinary clinical use.
 *
 * A clinician adds tasks on a phone in the ward and on a desktop at the desk.
 * Obsidian Sync on a phone only runs while the app is open, so the two devices
 * routinely add records "at the same time" from Sync's point of view. Every
 * scenario here contains no data loss whatsoever: the on-disk record set only
 * ever grows, and every record either device trusted is still present. None
 * of them may end in a typed ADOPT or a permanent read-only barrier.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin, { TRUSTED_INVENTORY_JOURNAL_KEY } from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import { MigrationService } from "../src/services/migration";
import { ClinicalService } from "../src/services/clinical-service";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness } from "./support/harness";

type Inventory = {
  counts: { patient: number; episode: number; task: number; procedure: number };
  digest: string;
  total: number;
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
  workspaceInitialized: boolean;
  managedRecordsExpected: boolean;
  expectedManagedRecordCount: number;
  expectedEntityCounts: Inventory["counts"] | null;
  expectedRecordDigest: string | null;
  workspaceSafetyNeedsPersistence: boolean;
  baselineReviewRequired: boolean;
  recoveryBlockMessage: string;
  structureReady: boolean;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  loadSettings: () => Promise<void>;
  onExternalSettingsChange: () => Promise<void>;
  retryPendingMigrationRecovery: () => Promise<boolean>;
  retryExactRestoredRootRecovery: () => Promise<boolean>;
  parsedRecordInventory: (root: string) => Promise<Inventory>;
  observeManagedRecordDelivery: (path: string) => void;
  retryMigrationForPath: (path: string) => void;
  noteManagedRecordWrite: (paths?: readonly string[]) => Promise<boolean>;
  markerFreeRecoveryOperations: number;
  externalSettingsApplyOperations: number;
  pluginDataWriteQueue: Promise<unknown>;
  markerFreeRecoveryReleaseRequested: boolean;
  markerFreeRecoveryRevision: number;
  pendingSyncedInventory: Inventory | null;
  expectedRecordIdentityDigests: string[] | null;
};

/** Diagnostic snapshot for assertion messages. */
function state(plugin: TestPlugin): string {
  return JSON.stringify({
    blocked: plugin.migrationRecoveryBlocked,
    missingRoot: plugin.missingRootRecoveryBlocked,
    review: plugin.baselineReviewRequired,
    message: plugin.recoveryBlockMessage.slice(0, 60),
    ops: plugin.markerFreeRecoveryOperations,
    releaseRequested: plugin.markerFreeRecoveryReleaseRequested,
    revision: plugin.markerFreeRecoveryRevision,
    expectedCount: plugin.expectedManagedRecordCount,
    pending: plugin.pendingSyncedInventory?.total ?? null,
    witness: plugin.expectedRecordIdentityDigests?.length ?? null,
    disk: managedRecordPaths(plugin.app).length,
    journal: plugin.app.loadLocalStorage("clinical-workspace:trusted-inventory-journal:v1")
  });
}

const ROOT = DEFAULT_SETTINGS.rootFolder;
const MANAGED_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"];

function makePlugin(
  app: StubApp,
  repository: ClinicalRepository,
  readStored: () => unknown,
  onSave: (data: unknown) => void = () => undefined
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
  plugin.workspaceInitialized = true;
  plugin.expectedManagedRecordCount = managedRecordPaths(app).length;
  plugin.managedRecordsExpected = plugin.expectedManagedRecordCount > 0;
  plugin.expectedEntityCounts = null;
  plugin.expectedRecordDigest = null;
  plugin.workspaceSafetyNeedsPersistence = false;
  plugin.structureReady = true;
  plugin.loadData = async () => structuredClone(readStored());
  plugin.saveData = async (data) => {
    onSave(structuredClone(data));
  };
  plugin.refreshOpenViews = async () => undefined;
  repository.setManagedRecordWriteObserver((paths) => plugin.noteManagedRecordWrite(paths));
  return plugin;
}

function managedRecordPaths(app: StubApp): string[] {
  return [...app.vault.files.keys()]
    .filter((path) => MANAGED_FOLDERS.some((folder) => path.startsWith(`${ROOT}/${folder}/`)))
    .sort();
}

/** A record another device created: same shape as an existing one, new id. */
function foreignRecord(app: StubApp, suffix: string): { path: string; content: string } {
  const sourcePath = managedRecordPaths(app).find((path) => path.includes("/Tasks/")) ??
    managedRecordPaths(app).at(-1);
  assert.ok(sourcePath);
  const sourceContent = app.vault.files.get(sourcePath);
  assert.ok(sourceContent);
  const folder = sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1);
  return {
    path: `${folder}other-device-${suffix}.md`,
    content: sourceContent.replace(
      /^id:\s*(.+)$/m,
      (_line, id: string) => `id: ${id.trim()}-other-${suffix}`
    )
  };
}

/** What the other device would persist after it wrote `extra` on top of disk. */
async function foreignInventory(
  plugin: TestPlugin,
  app: StubApp,
  extra: ReadonlyArray<{ path: string; content: string }>,
  without: ReadonlyArray<string> = []
): Promise<Inventory> {
  const removed = without.map((path) => [path, app.vault.files.get(path)] as const);
  for (const path of without) app.vault.deleteRaw(path);
  for (const record of extra) app.vault.writeRaw(record.path, record.content);
  const inventory = await plugin.parsedRecordInventory(ROOT);
  for (const record of extra) app.vault.deleteRaw(record.path);
  for (const [path, content] of removed) if (content !== undefined) app.vault.writeRaw(path, content);
  return inventory;
}

function syncedSafety(stored: unknown, inventory: Inventory): Record<string, unknown> {
  const current = (stored as { workspaceSafety?: Record<string, unknown> }).workspaceSafety ?? {};
  return {
    ...(stored as Record<string, unknown>),
    workspaceSafety: {
      ...current,
      version: 1,
      initialized: true,
      managedRecordsExpected: true,
      expectedManagedRecordCount: inventory.total,
      expectedEntityCounts: { ...inventory.counts },
      expectedRecordDigest: inventory.digest,
      rootRecoveryRequired: false,
      recoveryRequiresRecords: true,
      recoveryValidationRequired: false,
      baselineReviewRequired: false
    }
  };
}

/** Sync delivers a record file: the vault event handlers run as in Obsidian. */
async function deliverFile(
  plugin: TestPlugin,
  app: StubApp,
  record: { path: string; content: string }
): Promise<void> {
  app.vault.writeRaw(record.path, record.content);
  plugin.repository.invalidatePath(record.path);
  plugin.observeManagedRecordDelivery(record.path);
  plugin.retryMigrationForPath(record.path);
  await settle(plugin);
}

/**
 * Waits until every queued recovery scan, settings apply, and save has
 * finished. Time-based rather than turn-based: the scans hash records on the
 * WebCrypto thread pool, which can take a while on a loaded CI machine.
 */
async function settle(plugin: TestPlugin): Promise<void> {
  const deadline = Date.now() + 20_000;
  let quietPolls = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await plugin.pluginDataWriteQueue.catch(() => undefined);
    const idle =
      plugin.markerFreeRecoveryOperations === 0 &&
      plugin.externalSettingsApplyOperations === 0;
    quietPolls = idle ? quietPolls + 1 : 0;
    if (quietPolls >= 3) return;
  }
  assert.fail(`plugin did not settle: ${state(plugin)}`);
}

async function assertWritable(repository: ClinicalRepository, mrn: string): Promise<void> {
  await new ClinicalService(repository).createEpisode(
    episodeInput({ mrn, caseName: `Writable after sync ${mrn}` })
  );
}

interface Device {
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  plugin: TestPlugin;
  stored: () => unknown;
  setStored: (value: unknown) => void;
  episodeId: string;
  patientId: string;
}

async function device(): Promise<Device> {
  const { app, repository, service } = await harness();
  const created = await service.createEpisode(
    episodeInput({ nextAction: "Review bloods", dueDate: "2026-09-20" })
  );
  let stored: unknown = { ...DEFAULT_SETTINGS };
  const plugin = makePlugin(app, repository, () => stored, (data) => {
    stored = data;
  });
  await plugin.noteManagedRecordWrite();
  assert.equal(plugin.migrationRecoveryBlocked, false);
  assert.ok(plugin.expectedRecordDigest);
  return {
    app,
    repository,
    service,
    plugin,
    stored: () => stored,
    setStored: (value) => {
      stored = value;
    },
    episodeId: created.episode.record.id,
    patientId: created.patient.record.id
  };
}

async function localTask(local: Device, task: string): Promise<void> {
  await local.service.createTask({
    patientId: local.patientId,
    episodeId: local.episodeId,
    task,
    taskType: "clinical-review",
    priority: "routine",
    dueDate: "2026-09-21",
    owner: ""
  });
  assert.equal(local.plugin.migrationRecoveryBlocked, false);
}

test("a task added on each device at the same time never needs typed ADOPT", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    // The other device added a task on top of the shared baseline...
    const remote = foreignRecord(local.app, "ward-round");
    const remoteInventory = await foreignInventory(local.plugin, local.app, [remote]);
    // ...while this device added its own. Equal counts, different digests.
    await localTask(local, "Call the family");
    assert.equal(local.plugin.expectedManagedRecordCount, remoteInventory.total);
    assert.notEqual(local.plugin.expectedRecordDigest, remoteInventory.digest);

    await deliverFile(local.plugin, local.app, remote);
    local.setStored(syncedSafety(local.stored(), remoteInventory));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);

    assert.equal(local.plugin.baselineReviewRequired, false, "no record was lost, so no ADOPT");
    assert.equal(local.plugin.migrationRecoveryBlocked, false);
    const converged = await local.plugin.parsedRecordInventory(ROOT);
    assert.equal(local.plugin.expectedManagedRecordCount, converged.total);
    assert.equal(local.plugin.expectedRecordDigest, converged.digest);
    await assertWritable(local.repository, "9000005301");

    // The persisted baseline is the converged set, so the other device sees
    // ordinary additive growth rather than a competing equal-count tuple.
    const persisted = (local.stored() as {
      workspaceSafety?: { expectedRecordDigest?: string; baselineReviewRequired?: boolean };
    }).workspaceSafety;
    assert.equal(persisted?.baselineReviewRequired, false);
    assert.equal(persisted?.expectedRecordDigest, local.plugin.expectedRecordDigest);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("the same concurrent addition reopens after a restart mid-delivery", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "restart");
    const remoteInventory = await foreignInventory(local.plugin, local.app, [remote]);
    await localTask(local, "Chase imaging");
    // data.json arrives, then Obsidian is closed before the record file lands.
    local.setStored(syncedSafety(local.stored(), remoteInventory));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);
    assert.equal(local.plugin.baselineReviewRequired, false);

    local.app.vault.writeRaw(remote.path, remote.content);
    const restartedRepository = new ClinicalRepository(local.app as unknown as App);
    const restarted = makePlugin(local.app, restartedRepository, local.stored, local.setStored);
    await restarted.loadSettings();
    restartedRepository.setWriteBlock(restarted.migrationRecoveryBlocked ? restarted.recoveryBlockMessage : null);
    assert.equal(restarted.baselineReviewRequired, false, "restart must not turn growth into a conflict");
    assert.equal(await restarted.retryExactRestoredRootRecovery(), true);
    assert.equal(restarted.migrationRecoveryBlocked, false);
    await assertWritable(restartedRepository, "9000005302");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a higher synced baseline that disk then exceeds still reopens", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remoteA = foreignRecord(local.app, "clinic-a");
    const remoteB = foreignRecord(local.app, "clinic-b");
    const remoteInventory = await foreignInventory(local.plugin, local.app, [remoteA, remoteB]);
    await localTask(local, "Book theatre");

    local.setStored(syncedSafety(local.stored(), remoteInventory));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);
    assert.equal(local.plugin.baselineReviewRequired, false);
    assert.equal(local.plugin.migrationRecoveryBlocked, true, "still waiting for the files");

    await deliverFile(local.plugin, local.app, remoteA);
    assert.equal(local.plugin.baselineReviewRequired, false);
    await deliverFile(local.plugin, local.app, remoteB);

    assert.equal(local.plugin.baselineReviewRequired, false);
    assert.equal(local.plugin.migrationRecoveryBlocked, false, state(local.plugin));
    const converged = await local.plugin.parsedRecordInventory(ROOT);
    assert.equal(local.plugin.expectedManagedRecordCount, converged.total);
    await assertWritable(local.repository, "9000005303");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("an older, lower data.json arriving after a staged higher one is ignored", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remoteA = foreignRecord(local.app, "older");
    const remoteB = foreignRecord(local.app, "newer");
    const older = await foreignInventory(local.plugin, local.app, [remoteA]);
    const newer = await foreignInventory(local.plugin, local.app, [remoteA, remoteB]);

    local.setStored(syncedSafety(local.stored(), newer));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);
    local.setStored(syncedSafety(local.stored(), older));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);
    assert.equal(local.plugin.baselineReviewRequired, false, "a stale lower tuple is not a conflict");
    assert.equal(local.plugin.expectedManagedRecordCount, newer.total, "the higher floor is kept");

    await deliverFile(local.plugin, local.app, remoteA);
    await deliverFile(local.plugin, local.app, remoteB);
    assert.equal(local.plugin.migrationRecoveryBlocked, false);
    await assertWritable(local.repository, "9000005304");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("record files arriving before their data.json reopen once the files are complete", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "files-first");
    await deliverFile(local.plugin, local.app, remote);
    // The other device's data.json is still in transit. Nothing this device
    // trusted is missing, so the workspace stays usable.
    assert.equal(local.plugin.baselineReviewRequired, false);
    assert.equal(local.plugin.migrationRecoveryBlocked, false, state(local.plugin));
    await assertWritable(local.repository, "9000005305");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("explicit Retry accepts growth that keeps every trusted record", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "retry");
    local.app.vault.writeRaw(remote.path, remote.content);
    local.plugin.repository.invalidatePath(remote.path);
    local.plugin.observeManagedRecordDelivery(remote.path);
    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    assert.equal(await local.plugin.retryPendingMigrationRecovery(), true);
    assert.equal(local.plugin.baselineReviewRequired, false);
    assert.equal(local.plugin.migrationRecoveryBlocked, false);
    await assertWritable(local.repository, "9000005306");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a trusted record that vanished still fails closed", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "replacement");
    const victim = managedRecordPaths(local.app).find((path) => path.includes("/Tasks/"));
    assert.ok(victim);
    // Another device's tuple that looks like growth in aggregate, but one of
    // this device's trusted records was replaced rather than kept.
    const replaced = await foreignInventory(local.plugin, local.app, [remote], [victim]);
    const remote2 = foreignRecord(local.app, "replacement-2");
    const replacementGrowth = await foreignInventory(local.plugin, local.app, [remote, remote2], [victim]);
    assert.equal(replaced.total, local.plugin.expectedManagedRecordCount);
    assert.ok(replacementGrowth.total > local.plugin.expectedManagedRecordCount);

    local.app.vault.deleteRaw(victim);
    local.plugin.repository.invalidatePath(victim);
    local.plugin.observeManagedRecordDelivery(victim);
    await deliverFile(local.plugin, local.app, remote);
    await deliverFile(local.plugin, local.app, remote2);
    local.setStored(syncedSafety(local.stored(), replacementGrowth));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);
    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    assert.equal(await local.plugin.retryPendingMigrationRecovery(), false);
    assert.equal(local.plugin.migrationRecoveryBlocked, true, "a lost trusted record needs a human");
    await assert.rejects(
      () => assertWritable(local.repository, "9000005307"),
      /read-only/
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

/** data.json as an older version (or a still-locked peer) would have saved it. */
function lockedSafety(stored: unknown): Record<string, unknown> {
  const current = (stored as { workspaceSafety?: Record<string, unknown> }).workspaceSafety ?? {};
  return {
    ...(stored as Record<string, unknown>),
    workspaceSafety: { ...current, baselineReviewRequired: true }
  };
}

async function restart(local: Device): Promise<{ plugin: TestPlugin; repository: ClinicalRepository }> {
  const repository = new ClinicalRepository(local.app as unknown as App);
  const plugin = makePlugin(local.app, repository, local.stored, local.setStored);
  await plugin.loadSettings();
  repository.setWriteBlock(plugin.migrationRecoveryBlocked ? plugin.recoveryBlockMessage : null);
  return { plugin, repository };
}

function persistedReviewFlag(local: Device): boolean | undefined {
  return (local.stored() as { workspaceSafety?: { baselineReviewRequired?: boolean } })
    .workspaceSafety?.baselineReviewRequired;
}

test("a review flag saved by an older version clears itself on restart when every trusted record is present", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    await localTask(local, "Review discharge letter");
    // The previous version locked this device and saved the lock in data.json.
    local.setStored(lockedSafety(local.stored()));

    const restarted = await restart(local);
    assert.equal(restarted.plugin.baselineReviewRequired, true, "the saved lock holds until the records are proven");
    assert.ok(restarted.plugin.expectedRecordIdentityDigests, "the device-local witness survives the restart");

    assert.equal(await restarted.plugin.retryExactRestoredRootRecovery(), true, state(restarted.plugin));
    assert.equal(restarted.plugin.baselineReviewRequired, false, "nothing was lost, so no ADOPT");
    assert.equal(restarted.plugin.migrationRecoveryBlocked, false, state(restarted.plugin));
    assert.equal(persistedReviewFlag(local), false, "the cleared flag is what Sync carries to the other device");
    await assertWritable(restarted.repository, "9000005308");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a review flag delivered by a still-locked device clears itself once its records are on disk", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "locked-peer");
    const remoteInventory = await foreignInventory(local.plugin, local.app, [remote]);
    await localTask(local, "Chase histology");
    await deliverFile(local.plugin, local.app, remote);

    // The other device had not yet cleared its own review when it saved.
    local.setStored(lockedSafety(syncedSafety(local.stored(), remoteInventory)));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);

    assert.equal(local.plugin.baselineReviewRequired, false, `a peer's stale lock is not a local conflict: ${state(local.plugin)}`);
    assert.equal(local.plugin.migrationRecoveryBlocked, false, state(local.plugin));
    assert.equal(persistedReviewFlag(local), false);
    const converged = await local.plugin.parsedRecordInventory(ROOT);
    assert.equal(local.plugin.expectedManagedRecordCount, converged.total);
    await assertWritable(local.repository, "9000005309");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("explicit Retry clears a saved review flag through the same membership proof", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "retry-after-lock");
    local.app.vault.writeRaw(remote.path, remote.content);
    local.setStored(lockedSafety(local.stored()));

    const restarted = await restart(local);
    assert.equal(restarted.plugin.baselineReviewRequired, true);
    assert.equal(await restarted.plugin.retryPendingMigrationRecovery(), true, state(restarted.plugin));
    assert.equal(restarted.plugin.baselineReviewRequired, false);
    assert.equal(restarted.plugin.migrationRecoveryBlocked, false);
    await assertWritable(restarted.repository, "9000005310");
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a delivered review flag still needs ADOPT when a trusted record vanished", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const remote = foreignRecord(local.app, "lock-with-loss");
    const victim = managedRecordPaths(local.app).find((path) => path.includes("/Tasks/"));
    assert.ok(victim);
    const replacement = await foreignInventory(local.plugin, local.app, [remote], [victim]);

    local.app.vault.deleteRaw(victim);
    local.plugin.repository.invalidatePath(victim);
    local.plugin.observeManagedRecordDelivery(victim);
    await deliverFile(local.plugin, local.app, remote);
    local.setStored(lockedSafety(syncedSafety(local.stored(), replacement)));
    await local.plugin.onExternalSettingsChange();
    await settle(local.plugin);

    assert.equal(local.plugin.baselineReviewRequired, true, "a lost trusted record needs a human");
    assert.equal(await local.plugin.retryPendingMigrationRecovery(), false);
    assert.equal(local.plugin.baselineReviewRequired, true);
    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    await assert.rejects(() => assertWritable(local.repository, "9000005311"), /read-only/);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a review raised by unreadable safety metadata still needs typed ADOPT", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    local.setStored({ ...lockedSafety(local.stored()), retiredRootFolders: "not a list" });

    const restarted = await restart(local);
    assert.equal(restarted.plugin.baselineReviewRequired, true);
    assert.equal(await restarted.plugin.retryExactRestoredRootRecovery(), false);
    assert.equal(await restarted.plugin.retryPendingMigrationRecovery(), false);
    assert.equal(restarted.plugin.baselineReviewRequired, true, "metadata a scan cannot verify stays with ADOPT");
    assert.equal(restarted.plugin.migrationRecoveryBlocked, true);
    await assert.rejects(() => assertWritable(restarted.repository, "9000005312"), /read-only/);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a legacy journal without a membership witness stays on ADOPT once the disk has grown", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    await localTask(local, "Order audiogram");
    // A journal written before witnesses existed: digest only, no per-record proof.
    const journal = local.app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as {
      trustedInventory?: { expectedRecordIdentityDigests?: unknown };
    };
    assert.ok(journal?.trustedInventory?.expectedRecordIdentityDigests);
    delete journal.trustedInventory.expectedRecordIdentityDigests;
    local.app.saveLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY, journal);
    const remote = foreignRecord(local.app, "legacy-growth");
    local.app.vault.writeRaw(remote.path, remote.content);
    local.setStored(lockedSafety(local.stored()));

    const restarted = await restart(local);
    assert.equal(restarted.plugin.expectedRecordIdentityDigests, null, "no witness to prove inclusion with");
    assert.equal(await restarted.plugin.retryExactRestoredRootRecovery(), false);
    assert.equal(restarted.plugin.baselineReviewRequired, true, "a digest alone cannot prove which ids it covered");
    await assert.rejects(() => assertWritable(restarted.repository, "9000005313"), /read-only/);
  } finally {
    setClinicalRoot(originalRoot);
  }
});
