/**
 * Plugin lifecycle, read-only workspace and recovery wording.
 *
 * The Sync recovery barrier itself is exercised by migration-sync and
 * two-device-sync. These tests pin what a clinician sees around it: the
 * workspace still opens for reading, the banner and notices say what is
 * really happening in identifier-free words, the command they name is in the
 * palette, and routine edits or Sync deliveries do not cost more than they must.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin, {
  TRUSTED_INVENTORY_JOURNAL_KEY,
  WHATS_NEW_HIGHLIGHTS
} from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import {
  CLINICAL_WRITES_BLOCKED_MESSAGE,
  ClinicalRepository
} from "../src/data/repository";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import type { IntegrityIssue } from "../src/domain/types";
import { ClinicalService } from "../src/services/clinical-service";
import { IntegrityService } from "../src/services/integrity";
import { MigrationService } from "../src/services/migration";
import {
  ConfirmMaintenanceModal,
  InitializeWorkspaceModal,
  IntegrityReportModal,
  NewEpisodeModal
} from "../src/ui/modals";
import {
  CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE,
  CLINICAL_BASELINE_CONFIRMING_MESSAGE,
  CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE,
  CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE,
  CLINICAL_INITIALIZATION_CHANGED_MESSAGE,
  CLINICAL_INITIALIZATION_REQUIRED_MESSAGE,
  CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE,
  CLINICAL_RECORD_CHANGED_MESSAGE,
  CLINICAL_RECORDS_RECHECK_MESSAGE,
  CLINICAL_RECORDS_UNLOCKED_MESSAGE,
  CLINICAL_ROOT_UNAVAILABLE_MESSAGE,
  CLINICAL_SETTINGS_APPLYING_MESSAGE,
  CLINICAL_SYNC_GROWTH_PENDING_MESSAGE,
  CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE,
  compactClinicalRecoveryNotice,
  hideClinicalRecoveryNotice,
  isClinicalRecoveryMessage
} from "../src/ui/notices";
import { ClinicalSettingTab } from "../src/ui/settings-tab";
import {
  ClinicalWorkspaceView,
  type ClinicalWorkspaceRecoveryHost
} from "../src/ui/workspace-view";
import { installTestDomGlobals, TestElement } from "./support/dom-harness";
import { episodeInput, harness } from "./support/harness";
import {
  Notice as StubNotice,
  TFile as StubTFile,
  type App as StubApp
} from "./support/obsidian-stub";

const ROOT = DEFAULT_SETTINGS.rootFolder;
const MANAGED_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"];
const PATIENT_NAME = "Lifecycle Synthetic Patient";
const MRN = "9000009001";

const RECOVERY_MESSAGES = [
  CLINICAL_ROOT_UNAVAILABLE_MESSAGE,
  CLINICAL_RECORD_CHANGED_MESSAGE,
  CLINICAL_RECORDS_RECHECK_MESSAGE,
  CLINICAL_SETTINGS_APPLYING_MESSAGE,
  CLINICAL_BASELINE_CONFIRMING_MESSAGE,
  CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE,
  CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE,
  CLINICAL_WRITES_BLOCKED_MESSAGE,
  CLINICAL_INITIALIZATION_REQUIRED_MESSAGE,
  CLINICAL_INITIALIZATION_SAVE_FAILED_MESSAGE,
  CLINICAL_INITIALIZATION_CHANGED_MESSAGE,
  CLINICAL_BASELINE_REVIEW_REQUIRED_MESSAGE,
  CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE,
  CLINICAL_SYNC_GROWTH_PENDING_MESSAGE
];

interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

type Inventory = {
  counts: { patient: number; episode: number; task: number; procedure: number };
  digest: string;
  total: number;
};

type TestPlugin = {
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  integrity: IntegrityService;
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
  localTypedReviewRequired: boolean;
  recoveryBlockMessage: string;
  structureReady: boolean;
  integrityChecked: boolean;
  whatsNewShownThisSession: boolean;
  markerFreeRecoveryOperations: number;
  externalSettingsApplyOperations: number;
  pluginDataWriteQueue: Promise<unknown>;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  registerEvent: (event: unknown) => void;
  loadSettings: () => Promise<void>;
  onload: () => Promise<void>;
  onunload: () => void;
  onExternalSettingsChange: () => Promise<void>;
  retryPendingMigrationRecovery: () => Promise<boolean>;
  retryExactRestoredRootRecovery: () => Promise<boolean>;
  parsedRecordInventory: (root: string) => Promise<Inventory>;
  observeManagedRecordDelivery: (path: string) => void;
  blockIfActiveRootDisappeared: (path: string) => void;
  noteManagedRecordWrite: (paths?: readonly string[]) => Promise<boolean>;
  registerVaultEvents: () => void;
  setMigrationRecoveryBlocked: (blocked: boolean, message?: string) => void;
  activateWorkspace: () => Promise<ClinicalWorkspaceView>;
  openWorkspace: () => Promise<void>;
  runIntegrityCheck: (options?: { onlyWhenIssuesFound?: boolean }) => Promise<void>;
  requestFirstUseInitialization: () => Promise<boolean>;
  adoptCurrentBaseline: () => Promise<void>;
  migrateGeneratedBodies: () => Promise<void>;
  recoveryRecheckAvailable: () => boolean;
  workspaceRecoveryHost: () => ClinicalWorkspaceRecoveryHost;
};

beforeEach(() => {
  hideClinicalRecoveryNotice();
  StubNotice.history.length = 0;
});
afterEach(() => hideClinicalRecoveryNotice());

/** Deterministic stand-in for Obsidian's window timers. */
class FakeTimers {
  private nextId = 1;
  readonly pending = new Map<number, { run: () => void; delay: number }>();

  install(): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: (run: () => void, delay = 0) => {
          const id = this.nextId++;
          this.pending.set(id, { run, delay });
          return id;
        },
        clearTimeout: (id: number) => {
          this.pending.delete(id);
        }
      }
    });
    return () => {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else delete (globalThis as { window?: unknown }).window;
    };
  }

  count(delay: number): number {
    return [...this.pending.values()].filter((timer) => timer.delay === delay).length;
  }

  /** Runs every timer scheduled with this delay, as if it had elapsed. */
  flush(delay: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.delay !== delay) continue;
      this.pending.delete(id);
      timer.run();
    }
  }
}

function managedRecordPaths(app: StubApp): string[] {
  return [...app.vault.files.keys()]
    .filter((path) => MANAGED_FOLDERS.some((folder) => path.startsWith(`${ROOT}/${folder}/`)))
    .sort();
}

function recordPath(app: StubApp, folder: string): string {
  const path = managedRecordPaths(app).find((candidate) => candidate.includes(`/${folder}/`));
  assert.ok(path, `expected a ${folder} record`);
  return path;
}

function makePlugin(
  app: StubApp,
  repository: ClinicalRepository,
  readStored: () => unknown,
  onSave: (data: unknown) => void = () => undefined
): TestPlugin {
  const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as TestPlugin;
  plugin.app = app;
  plugin.repository = repository;
  plugin.service = new ClinicalService(repository);
  plugin.integrity = new IntegrityService(repository);
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
  plugin.whatsNewShownThisSession = true;
  plugin.loadData = async () => structuredClone(readStored());
  plugin.saveData = async (data) => {
    onSave(structuredClone(data));
  };
  plugin.refreshOpenViews = async () => undefined;
  repository.setManagedRecordWriteObserver((paths) => plugin.noteManagedRecordWrite(paths));
  return plugin;
}

interface Device {
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  plugin: TestPlugin;
  stored: () => unknown;
  setStored: (value: unknown) => void;
  saves: () => number;
}

/** A trusted, writable workspace with one patient, one episode and one task. */
async function device(): Promise<Device> {
  const { app, repository, service } = await harness();
  await service.createEpisode(episodeInput({
    mrn: MRN,
    patientName: PATIENT_NAME,
    caseName: "Lifecycle synthetic case",
    nextAction: "Review bloods",
    dueDate: "2026-09-20"
  }));
  let stored: unknown = { ...DEFAULT_SETTINGS };
  let saves = 0;
  const plugin = makePlugin(app, repository, () => stored, (data) => {
    saves += 1;
    stored = data;
  });
  await plugin.noteManagedRecordWrite();
  assert.equal(plugin.migrationRecoveryBlocked, false);
  assert.ok(plugin.expectedRecordDigest);
  saves = 0;
  return {
    app,
    repository,
    service,
    plugin,
    stored: () => stored,
    setStored: (value) => {
      stored = value;
    },
    saves: () => saves
  };
}

/** Waits until every queued recovery pass, settings apply and save has settled. */
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
  assert.fail("plugin did not settle");
}

/** Registers the real vault listeners and returns them by event name. */
function captureVaultEvents(plugin: TestPlugin, app: StubApp): Map<string, (file: StubTFile) => void> {
  const handlers = new Map<string, (file: StubTFile) => void>();
  (app.vault as unknown as { on: unknown }).on = (name: string, handler: (file: StubTFile) => void) => {
    handlers.set(name, handler);
    return { id: name };
  };
  plugin.registerEvent = () => undefined;
  plugin.registerVaultEvents();
  return handlers;
}

/** Captures instances instead of opening Obsidian modals, then restores `open`. */
function captureModals<T extends object>(
  modalClass: { prototype: T }
): { opened: T[]; restore: () => void } {
  const prototype = modalClass.prototype as { open?: () => void };
  const original = Object.getOwnPropertyDescriptor(prototype, "open");
  const opened: T[] = [];
  prototype.open = function (this: T) {
    opened.push(this);
  };
  return {
    opened,
    restore: () => {
      if (original) Object.defineProperty(prototype, "open", original);
      else delete prototype.open;
    }
  };
}

function recoveryNoticeMessages(): string[] {
  return StubNotice.history.map((notice) => notice.attributes.get("aria-label") ?? notice.message);
}

function assertIdentifierFree(text: string): void {
  assert.doesNotMatch(text, new RegExp(`${PATIENT_NAME}|${MRN}|${ROOT}/|\\.md`));
}

/** Loads the plugin through onload so the real command registrations are used. */
async function loadedPlugin(
  app: StubApp,
  readStored: () => unknown,
  onSave: (data: unknown) => void = () => undefined
): Promise<{ plugin: TestPlugin; commands: Map<string, Command> }> {
  const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as TestPlugin;
  const commands = new Map<string, Command>();
  Object.assign(plugin, {
    app,
    loadData: async () => structuredClone(readStored()),
    saveData: async (data: unknown) => {
      onSave(structuredClone(data));
    },
    registerView: () => undefined,
    addSettingTab: () => undefined,
    addRibbonIcon: () => undefined,
    addCommand: (command: Command) => {
      commands.set(command.id, command);
      return command;
    },
    registerObsidianProtocolHandler: () => undefined,
    registerEvent: () => undefined,
    refreshOpenViews: async () => undefined
  });
  (app as unknown as { workspace: unknown }).workspace = {
    onLayoutReady: () => undefined,
    getLeavesOfType: () => []
  };
  const globals = globalThis as { __DEV_TOOLS__?: boolean };
  globals.__DEV_TOOLS__ = false;
  try {
    await plugin.onload();
  } finally {
    delete globals.__DEV_TOOLS__;
  }
  return { plugin, commands };
}

function commandAvailable(command: Command | undefined): boolean {
  assert.ok(command);
  if (command.checkCallback) return command.checkCallback(true) === true;
  return true;
}

test("recovery guidance names only real commands and stays identifier-free and phone-sized", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  try {
    setClinicalRoot(ROOT);
    const { app } = await harness();
    const { plugin, commands } = await loadedPlugin(app, () => null);
    plugin.onunload();

    // Command ids are stable for existing hotkeys and toolbar entries.
    assert.deepEqual([...commands.keys()].sort(), [
      "add-patient-episode",
      "add-task-follow-up",
      "adopt-current-baseline",
      "export-patient-list",
      "generate-handover-note",
      "initialize-new-workspace",
      "open-quick-entry",
      "open-today-pending-work",
      "open-workspace",
      "record-procedure",
      "remove-identifiers-from-generated-bodies",
      "retry-folder-move-recovery",
      "run-integrity-check",
      "search-clinical-records"
    ]);
    assert.equal(
      commands.get("retry-folder-move-recovery")?.name,
      "Recheck records and unlock editing"
    );
    const names = new Set([...commands.values()].map((command) => command.name));
    for (const message of RECOVERY_MESSAGES) {
      assert.equal(isClinicalRecoveryMessage(message), true);
      const compact = compactClinicalRecoveryNotice(message);
      assert.ok(compact.length < 165, `compact notice too long: ${compact}`);
      for (const text of [message, compact]) {
        assert.doesNotMatch(text, /Retry pending folder move recovery|folder move recovery command/);
        assert.doesNotMatch(text, /[0-9/\\]/, "recovery text carries no ids, counts or paths");
        for (const [, named] of text.matchAll(/“([^”]+)”/g)) {
          assert.ok(names.has(named!), `“${named}” is not a registered command`);
        }
      }
    }
    assert.match(CLINICAL_WRITES_BLOCKED_MESSAGE, /Recheck records and unlock editing/);
    assert.doesNotMatch(CLINICAL_RECORD_CHANGED_MESSAGE, /folder is unavailable/);
    assert.doesNotMatch(CLINICAL_SETTINGS_APPLYING_MESSAGE, /folder|Command Palette/);
  } finally {
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

test("each recovery command is offered exactly while its guidance can name it", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  try {
    setClinicalRoot(ROOT);
    const trusted = await device();
    // Restart the trusted device through onload, as Obsidian would.
    const { plugin, commands } = await loadedPlugin(
      trusted.app,
      trusted.stored,
      (data) => trusted.setStored(data)
    );
    const recheck = commands.get("retry-folder-move-recovery");
    const adopt = commands.get("adopt-current-baseline");
    const initialize = commands.get("initialize-new-workspace");

    // Startup begins read-only until the exact commitment is rechecked.
    assert.equal(plugin.migrationRecoveryBlocked, true);
    assert.equal(plugin.recoveryBlockMessage, CLINICAL_RECORDS_RECHECK_MESSAGE);
    assert.equal(commandAvailable(recheck), true);
    assert.equal(commandAvailable(adopt), true);
    assert.equal(commandAvailable(initialize), false);

    assert.equal(await plugin.retryExactRestoredRootRecovery(), true);
    assert.equal(plugin.migrationRecoveryBlocked, false);
    assert.equal(commandAvailable(recheck), false);
    assert.equal(commandAvailable(adopt), false, "a healthy workspace hides re-baselining");
    assert.equal(commandAvailable(initialize), false);

    const episodePath = recordPath(trusted.app, "Episodes");
    trusted.app.vault.writeRaw(
      episodePath,
      `${trusted.app.vault.files.get(episodePath)}\nPost-op day 1: comfortable.\n`
    );
    plugin.observeManagedRecordDelivery(episodePath);
    assert.equal(plugin.recoveryBlockMessage, CLINICAL_RECORD_CHANGED_MESSAGE);
    assert.equal(commandAvailable(recheck), true);
    assert.equal(commandAvailable(adopt), true);
    await settle(plugin);
    plugin.onunload();

    // First use offers initialization, and the adopt command explains itself.
    const fresh = await harness();
    await fresh.service.createEpisode(episodeInput({ mrn: "9000009002", patientName: PATIENT_NAME }));
    const firstUse = await loadedPlugin(fresh.app, () => null);
    assert.equal(firstUse.plugin.firstUseInitializationPending, true);
    assert.equal(commandAvailable(firstUse.commands.get("initialize-new-workspace")), true);
    assert.equal(commandAvailable(firstUse.commands.get("retry-folder-move-recovery")), false);
    firstUse.plugin.onunload();
  } finally {
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

test("typing into a record note pauses writes at once and rechecks once after the autosaves", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const handlers = captureVaultEvents(local.plugin, local.app);
    const modify = handlers.get("modify");
    assert.ok(modify);
    const parse = local.plugin.parsedRecordInventory.bind(local.plugin);
    let parses = 0;
    local.plugin.parsedRecordInventory = async (root) => {
      parses += 1;
      return parse(root);
    };

    const episodePath = recordPath(local.app, "Episodes");
    const original = local.app.vault.files.get(episodePath);
    assert.ok(original);
    for (const line of ["Post-op day 1", "Post-op day 1: comfortable", "Post-op day 1: comfortable, eating"]) {
      local.app.vault.writeRaw(episodePath, `${original}\n${line}.\n`);
      modify(new StubTFile(episodePath));
      // Fail-closed before the event returns: the barrier and the pending
      // device-local journal are armed synchronously.
      assert.equal(local.plugin.migrationRecoveryBlocked, true);
      assert.equal(local.repository.getWriteBlockReason(), CLINICAL_RECORD_CHANGED_MESSAGE);
      const journal = local.app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY) as { pending?: boolean };
      assert.equal(journal.pending, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(parses, 0, "no rescan runs while autosaves are still arriving");
    assert.equal(timers.count(1500), 1, "one coalesced recheck is scheduled");

    timers.flush(1500);
    await settle(local.plugin);
    assert.equal(local.plugin.migrationRecoveryBlocked, false);
    assert.equal(local.repository.getWriteBlockReason(), null);
    assert.equal(parses, 2, "one recheck: the exact scan and its post-save confirmation");
    assert.equal(local.saves(), 2, "one barrier save and one clearing save for the whole burst");
    await local.service.createEpisode(episodeInput({ mrn: "9000009003", caseName: "Writable after edit" }));
  } finally {
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

test("a note left unreadable keeps record-level wording and the integrity check still names it", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  const reports = captureModals(IntegrityReportModal);
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const handlers = captureVaultEvents(local.plugin, local.app);
    const episodePath = recordPath(local.app, "Episodes");
    local.app.vault.writeRaw(episodePath, "---\nid: [unterminated\n---\nTyping in progress\n");
    handlers.get("modify")?.(new StubTFile(episodePath));
    timers.flush(1500);
    await settle(local.plugin);

    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    assert.equal(local.plugin.recoveryBlockMessage, CLINICAL_RECORD_CHANGED_MESSAGE);
    await assert.rejects(
      () => local.service.createEpisode(episodeInput({ mrn: "9000009004" })),
      /a record note was added, edited, deleted or moved outside Clinical Workspace/
    );

    StubNotice.history.length = 0;
    assert.equal(await local.plugin.retryPendingMigrationRecovery(), false);
    const guidance = recoveryNoticeMessages().join("\n");
    assert.match(guidance, /Run clinical data integrity check/);
    assertIdentifierFree(guidance);

    // The report reads only; it must not wait for the scaffolding a blocked
    // workspace refuses to create.
    local.plugin.structureReady = false;
    StubNotice.history.length = 0;
    await local.plugin.runIntegrityCheck();
    assert.equal(StubNotice.history.length, 0, "no read-only refusal");
    assert.equal(reports.opened.length, 1);
    const issues = (reports.opened[0] as unknown as { issues: IntegrityIssue[] }).issues;
    assert.ok(issues.some((issue) => issue.code === "unreadable-record" && issue.path === episodePath));
    assert.equal(local.plugin.migrationRecoveryBlocked, true, "the check never reopens writes");
  } finally {
    reports.restore();
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

test("a blocked workspace opens read-only with a banner, and a pending folder move still refuses", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  const patientForms = captureModals(NewEpisodeModal);
  installTestDomGlobals();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const leaves: Array<{ view: unknown; setViewState: (state: unknown) => Promise<void> }> = [];
    const view = new ClinicalWorkspaceView(
      {} as never,
      local.repository,
      local.service,
      local.plugin.integrity,
      () => local.plugin.settings,
      local.plugin.workspaceRecoveryHost()
    );
    const contentEl = new TestElement();
    (view as unknown as { contentEl: TestElement }).contentEl = contentEl;
    const leaf = {
      view: null as unknown,
      setViewState: async () => {
        leaf.view = view;
      }
    };
    (local.app as unknown as { workspace: unknown }).workspace = {
      getLeavesOfType: () => leaves.filter((candidate) => candidate.view),
      getLeaf: () => {
        leaves.push(leaf);
        return leaf;
      },
      revealLeaf: async () => undefined
    };

    const episodePath = recordPath(local.app, "Episodes");
    const original = local.app.vault.files.get(episodePath);
    assert.ok(original);
    local.app.vault.writeRaw(episodePath, "---\nid: [unterminated\n---\n");
    local.plugin.observeManagedRecordDelivery(episodePath);
    await local.plugin.retryExactRestoredRootRecovery();
    assert.equal(local.plugin.migrationRecoveryBlocked, true);

    const foldersBefore = [...local.app.vault.folders].sort();
    const filesBefore = [...local.app.vault.files.keys()].sort();
    local.plugin.structureReady = false;
    const opened = await local.plugin.activateWorkspace();
    assert.equal(opened, view, "reading does not wait for writes to reopen");
    assert.deepEqual([...local.app.vault.folders].sort(), foldersBefore, "no folder was scaffolded");
    assert.deepEqual([...local.app.vault.files.keys()].sort(), filesBefore);

    const banner = contentEl.querySelector(".clinical-write-block-banner");
    assert.ok(banner, "a persistent banner explains the pause");
    assert.equal(banner.getAttribute("role"), "status");
    assert.match(banner.textContent, /Editing is paused/);
    assert.match(banner.textContent, /record note changed outside Clinical Workspace/);
    assertIdentifierFree(banner.textContent);
    const recheck = banner.querySelector("button");
    assert.ok(recheck);
    assert.equal(recheck.text, "Recheck now");

    // Data-entry forms refuse before collecting input that could not be saved.
    StubNotice.history.length = 0;
    view.openAddPatient();
    assert.equal(patientForms.opened.length, 0);
    assert.equal(recoveryNoticeMessages().at(-1), CLINICAL_RECORD_CHANGED_MESSAGE);

    // Repairing the note and pressing Recheck now reopens writes; the banner
    // clears through the deferred sync rather than a full re-render.
    local.app.vault.writeRaw(episodePath, original);
    local.repository.invalidatePath(episodePath);
    recheck.dispatch("click");
    await settle(local.plugin);
    assert.equal(local.plugin.migrationRecoveryBlocked, false);
    assert.ok(timers.count(600) >= 1, "the banner update is deferred to avoid flicker");
    timers.flush(600);
    assert.equal(contentEl.querySelector(".clinical-write-block-banner"), null);
    assert.ok(
      StubNotice.history.some((notice) => notice.message === CLINICAL_RECORDS_UNLOCKED_MESSAGE)
    );

    // A pending folder move can leave either root partial: still refuse, and
    // say so. An already-open view states that its list may be incomplete.
    local.plugin.pendingMigrationMarker = { migrationInProgress: { from: ROOT, to: "Ward Records" } };
    local.plugin.pendingMigrationConfiguredRoot = "Ward Records";
    local.plugin.setMigrationRecoveryBlocked(true);
    await assert.rejects(
      () => local.plugin.activateWorkspace(),
      (error: unknown) => error instanceof Error && error.message === CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE
    );
    assert.match(compactClinicalRecoveryNotice(CLINICAL_FOLDER_MOVE_OPEN_REFUSED_MESSAGE), /may be incomplete/);
    view.syncWriteBlockBanner();
    assert.match(
      contentEl.querySelector(".clinical-write-block-banner")?.textContent ?? "",
      /records shown may be incomplete/
    );
  } finally {
    patientForms.restore();
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

test("another device's settings save shows a transient message and needs no recovery command", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    local.plugin.integrityChecked = true;
    local.setStored({ ...(local.stored() as object), clinicianName: "Dr Synthetic" });
    const applying = local.plugin.onExternalSettingsChange();
    assert.equal(local.repository.getWriteBlockReason(), CLINICAL_SETTINGS_APPLYING_MESSAGE);
    assert.equal(local.plugin.recoveryRecheckAvailable(), false);
    await applying;
    await settle(local.plugin);
    assert.equal(local.plugin.migrationRecoveryBlocked, false);
    assert.equal(local.plugin.settings.clinicianName, "Dr Synthetic");
    assert.equal(
      local.plugin.integrityChecked,
      true,
      "a same-root peer save does not re-arm the open-time integrity check"
    );
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("the open-time integrity check does not re-show an unchanged issue set", async () => {
  const reports = captureModals(IntegrityReportModal);
  try {
    const { app, repository } = await harness();
    const plugin = makePlugin(app, repository, () => null);
    let issues: IntegrityIssue[] = [{
      code: "missing-audit-event",
      severity: "warning",
      message: "A record has no audit event.",
      recordId: "EPI-SYNTHETIC",
      path: `${ROOT}/Episodes/EPI-SYNTHETIC.md`
    }];
    plugin.integrity = {
      report: async () => ({ issues, scannedRecords: 1, checkFamilies: 1 })
    } as unknown as IntegrityService;
    await plugin.runIntegrityCheck({ onlyWhenIssuesFound: true });
    await plugin.runIntegrityCheck({ onlyWhenIssuesFound: true });
    assert.equal(reports.opened.length, 1);
    issues = [...issues, { ...issues[0]!, code: "untracked-next-action", message: "Next action untracked." }];
    await plugin.runIntegrityCheck({ onlyWhenIssuesFound: true });
    assert.equal(reports.opened.length, 2, "a changed issue set is shown");
    await plugin.runIntegrityCheck();
    assert.equal(reports.opened.length, 3, "an explicit check always reports");
  } finally {
    reports.restore();
  }
});

test("a Sync delivery before first-use initialization does not turn the next launch into typed ADOPT", async () => {
  const originalRoot = clinicalRootFolder();
  try {
    setClinicalRoot(ROOT);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput({ mrn: "9000009005", patientName: PATIENT_NAME }));
    const first = makePlugin(app, repository, () => null);
    await first.loadSettings();
    assert.equal(first.firstUseInitializationPending, true);

    first.observeManagedRecordDelivery(recordPath(app, "Episodes"));
    assert.equal(app.loadLocalStorage(TRUSTED_INVENTORY_JOURNAL_KEY), null);
    assert.equal(first.migrationRecoveryBlocked, true, "first use stays read-only");

    const restarted = makePlugin(app, new ClinicalRepository(app as unknown as App), () => null);
    await restarted.loadSettings();
    assert.equal(restarted.firstUseInitializationPending, true);
    assert.equal(restarted.baselineReviewRequired, false);
    assert.equal(restarted.localTypedReviewRequired, false);
    assert.equal(restarted.recoveryBlockMessage, CLINICAL_INITIALIZATION_REQUIRED_MESSAGE);
  } finally {
    setClinicalRoot(originalRoot);
  }
});

test("a stray note in a record folder gets not-a-record guidance instead of a Sync wait", async () => {
  const originalRoot = clinicalRootFolder();
  const confirmations = captureModals(InitializeWorkspaceModal);
  const reports = captureModals(IntegrityReportModal);
  try {
    setClinicalRoot(ROOT);
    const { app, repository, service } = await harness();
    await service.createEpisode(episodeInput({ mrn: "9000009006", patientName: PATIENT_NAME }));
    const strayPath = `${ROOT}/Patients/Ward list scratch.md`;
    app.vault.writeRaw(strayPath, "Beds to review after lunch.\n");
    const plugin = makePlugin(app, repository, () => null);
    await plugin.loadSettings();
    repository.setWriteBlock(plugin.recoveryBlockMessage);
    assert.equal(plugin.firstUseInitializationPending, true);

    assert.equal(await plugin.requestFirstUseInitialization(), false);
    assert.equal(confirmations.opened.length, 0);
    const shown = recoveryNoticeMessages();
    assert.equal(shown.at(-1), CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE);
    assert.ok(!shown.includes(CLINICAL_INITIALIZATION_CHANGED_MESSAGE));
    for (const text of StubNotice.history.map((notice) => notice.message)) {
      assert.doesNotMatch(text, /Ward list|scratch/);
    }

    // The integrity check, reachable while first use is still read-only, is
    // the identifier-safe place that names the note to move.
    plugin.structureReady = false;
    await plugin.runIntegrityCheck();
    assert.equal(reports.opened.length, 1);
    const issues = (reports.opened[0] as unknown as { issues: IntegrityIssue[] }).issues;
    assert.ok(issues.some((issue) => issue.path === strayPath));

    app.vault.deleteRaw(strayPath);
    void plugin.requestFirstUseInitialization();
    for (let attempt = 0; attempt < 200 && confirmations.opened.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(confirmations.opened.length, 1, "a clean record set reaches the confirmation");
    (confirmations.opened[0] as unknown as { onDecision: (initialize: boolean) => void })
      .onDecision(false);
  } finally {
    confirmations.restore();
    reports.restore();
    setClinicalRoot(originalRoot);
  }
});

test("the ADOPT confirmation shows the previously trusted counts and warns about a drop", async () => {
  const originalRoot = clinicalRootFolder();
  const confirmations = captureModals(ConfirmMaintenanceModal);
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const taskPath = recordPath(local.app, "Tasks");
    local.app.vault.deleteRaw(taskPath);
    local.repository.invalidatePath(taskPath);
    local.plugin.observeManagedRecordDelivery(taskPath);
    local.plugin.blockIfActiveRootDisappeared(taskPath);
    assert.equal(local.plugin.recoveryBlockMessage, CLINICAL_RECORD_CHANGED_MESSAGE);

    await local.plugin.adoptCurrentBaseline();
    assert.equal(confirmations.opened.length, 1);
    const lines = (confirmations.opened[0] as unknown as { options: { lines: string[] } }).options.lines;
    assert.ok(lines.includes("Parsed records now on disk: 1 patient, 1 episode, 0 tasks, 0 procedures."));
    assert.ok(lines.includes("Previously trusted on this device: 1 patient, 1 episode, 1 task, 0 procedures."));
    const warning = lines.find((line) => line.startsWith("Warning:"));
    assert.ok(warning);
    assert.match(warning, /\(1 task fewer\)/);
    assert.match(warning, /restore them from Sync version history or File recovery/);
    for (const line of lines) assertIdentifierFree(line);

    // Without a device-local anchor or per-type counts, the aggregate floor is
    // still shown and labelled by source.
    local.app.localStorage.delete(TRUSTED_INVENTORY_JOURNAL_KEY);
    local.plugin.expectedEntityCounts = null;
    await local.plugin.adoptCurrentBaseline();
    const fallback = (confirmations.opened[1] as unknown as { options: { lines: string[] } }).options.lines;
    assert.ok(fallback.includes(
      "Last baseline in the synced settings: 3 records in total; no per-type counts were saved."
    ));
    assert.ok(fallback.some((line) => /^Warning: .*\(1 record fewer\)/.test(line)));
  } finally {
    confirmations.restore();
    setClinicalRoot(originalRoot);
  }
});

test("a rewrite of generated bodies that Sync interrupts is reported with its count", async () => {
  const originalRoot = clinicalRootFolder();
  const confirmations = captureModals(ConfirmMaintenanceModal);
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const patientPath = recordPath(local.app, "Patients");
    const content = local.app.vault.files.get(patientPath);
    assert.ok(content);
    const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(content)?.[0];
    assert.ok(frontmatter);
    const legacy = `${frontmatter}# ${PATIENT_NAME}\n\n> Managed by Clinical Workspace. Structured properties above are the source of truth.\n\n## Patient summary\n\n- MRN: ${MRN}\n- Phone: not recorded\n`;
    local.app.vault.writeRaw(patientPath, legacy);
    let refreshed = 0;
    local.plugin.refreshOpenViews = async () => {
      refreshed += 1;
    };

    await local.plugin.migrateGeneratedBodies();
    assert.equal(confirmations.opened.length, 1);
    // Sync closes writes after the preview but before the typed confirmation.
    local.repository.setWriteBlock(CLINICAL_SETTINGS_APPLYING_MESSAGE);
    StubNotice.history.length = 0;
    (confirmations.opened[0] as unknown as { options: { onDecide: (confirmed: boolean) => void } })
      .options.onDecide(true);
    for (let attempt = 0; attempt < 200 && refreshed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(refreshed, 1, "open views refresh even when the rewrite stops");
    assert.ok(StubNotice.history.some((notice) =>
      notice.message.startsWith("The rewrite stopped after 0 generated bodies.")));
    assert.ok(recoveryNoticeMessages().includes(CLINICAL_SETTINGS_APPLYING_MESSAGE));
    for (const notice of StubNotice.history) assertIdentifierFree(notice.message);
    assert.equal(local.app.vault.files.get(patientPath), legacy, "nothing was rewritten");
  } finally {
    confirmations.restore();
    setClinicalRoot(originalRoot);
  }
});

test("what's-new highlights avoid Sync-recovery jargon", () => {
  assert.ok(WHATS_NEW_HIGHLIGHTS.length > 0);
  for (const highlight of WHATS_NEW_HIGHLIGHTS) {
    assert.doesNotMatch(highlight, /journal|flag|ADOPT|baseline|tuple|digest|marker|witness/i);
    assert.ok(highlight.length < 200);
  }
});

test("the settings privacy text discloses the folder names data.json keeps", () => {
  const app = new App();
  const tab = new ClinicalSettingTab(
    app,
    { settings: { ...DEFAULT_SETTINGS } } as never,
    new MigrationService(app)
  );
  const definitions = tab.getSettingDefinitions() as unknown as Array<{
    items?: Array<{ name?: string; desc?: string }>;
  }>;
  const privacy = definitions
    .flatMap((definition) => definition.items ?? [])
    .find((item) => item.name === "Plugin settings");
  assert.ok(privacy?.desc);
  assert.doesNotMatch(privacy.desc, /path-free/);
  assert.match(privacy.desc, /up to 64 previous clinical folders/);
  assert.match(privacy.desc, /folder move is in progress/);
  assert.match(privacy.desc, /never stores MRNs, patient names, phone numbers, individual note paths or clinical record content/);
});
