/**
 * Final review, lifecycle and UI lane: the read-only banner's "may be
 * incomplete" hint, the exit an interrupted first-use initialization names,
 * the barrier text after a refused ADOPT, the open-time integrity check while
 * editing is paused, the record recheck delay, identifier-free Notices, the
 * Return key in forms that end with a date, ward-round buttons in narrow
 * panes, paging after a redraw burst or a filter change, and Complete's
 * double-tap guard.
 *
 * Synthetic data only; MRNs use the 9000 series.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach, beforeEach } from "node:test";
import { App } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import type { ClinicalRepository } from "../src/data/repository";
import { isoDateWithOffset, todayIso } from "../src/domain/schema";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import type {
  ClinicalSnapshot,
  EpisodeRecord,
  EpisodeUpdateInput,
  NewEpisodeInput,
  NewTaskInput,
  PatientRecord,
  TaskRecord
} from "../src/domain/types";
import { ClinicalService } from "../src/services/clinical-service";
import { IntegrityService } from "../src/services/integrity";
import { MigrationService } from "../src/services/migration";
import {
  InitializeWorkspaceModal,
  IntegrityReportModal,
  NewEpisodeModal,
  NewTaskModal,
  PatientListModal,
  QuickEntryEpisodeModal,
  UpdateEpisodeModal,
  type QuickEntryEpisodeChoice
} from "../src/ui/modals";
import {
  CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE,
  CLINICAL_BASELINE_CONFIRMING_MESSAGE,
  CLINICAL_INITIALIZATION_CHANGED_MESSAGE,
  CLINICAL_RECORD_CHANGED_MESSAGE,
  CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE,
  clinicalErrorNoticeText,
  hideClinicalRecoveryNotice
} from "../src/ui/notices";
import {
  CLINICAL_PAGE_SIZE,
  ClinicalWorkspaceView,
  type ClinicalWorkspaceRecoveryHost
} from "../src/ui/workspace-view";
import {
  computedDeclarations,
  installTestDomGlobals,
  parseCssRules,
  TestElement
} from "./support/dom-harness";
import { episodeInput, harness, type Harness } from "./support/harness";
import {
  Notice as StubNotice,
  TFile as StubTFile,
  type App as StubApp
} from "./support/obsidian-stub";

installTestDomGlobals();
// esbuild defines this flag in real builds; the More tab reads it.
(globalThis as { __DEV_TOOLS__?: boolean }).__DEV_TOOLS__ = false;
// Obsidian's global fragment builder; the Undo notice is built with it.
(globalThis as { createFragment?: unknown }).createFragment = (build?: (fragment: TestElement) => void) => {
  const fragment = new TestElement("#document-fragment");
  build?.(fragment);
  return fragment;
};

const ROOT = DEFAULT_SETTINGS.rootFolder;
const MANAGED_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"];
const PATIENT_NAME = "Synthetic Lane Patient";
const MRN = "9000009101";

beforeEach(() => {
  hideClinicalRecoveryNotice();
  StubNotice.history.length = 0;
});
afterEach(() => hideClinicalRecoveryNotice());

/* ------------------------------------------------------------- harness ----- */

interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

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
  expectedEntityCounts: unknown;
  expectedRecordDigest: string | null;
  workspaceSafetyNeedsPersistence: boolean;
  baselineReviewRequired: boolean;
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
  onload: () => Promise<void>;
  onunload: () => void;
  retryPendingMigrationRecovery: () => Promise<boolean>;
  retryExactRestoredRootRecovery: () => Promise<boolean>;
  parsedRecordInventory: (root: string) => Promise<unknown>;
  observeManagedRecordDelivery: (path: string) => void;
  noteManagedRecordWrite: (paths?: readonly string[]) => Promise<boolean>;
  registerVaultEvents: () => void;
  scheduleManagedRecordRecheck: (path: string) => void;
  activateWorkspace: () => Promise<ClinicalWorkspaceView>;
  updateSettings: (patch: Partial<ClinicalSettings>) => Promise<void>;
  runIntegrityCheck: (options?: { onlyWhenIssuesFound?: boolean }) => Promise<void>;
  requestFirstUseInitialization: () => Promise<boolean>;
  initializeNewWorkspace: () => Promise<void>;
  confirmCurrentBaselineAdoption: (root: string) => Promise<boolean>;
  readOnlyOpenRefusal: () => string | null;
  workspaceRecoveryHost: () => ClinicalWorkspaceRecoveryHost;
};

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

  ids(delay: number): number[] {
    return [...this.pending].filter(([, timer]) => timer.delay === delay).map(([id]) => id);
  }

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

interface Device {
  app: StubApp;
  repository: ClinicalRepository;
  service: ClinicalService;
  plugin: TestPlugin;
}

/** A trusted, writable workspace with one patient, one episode and one task. */
async function device(): Promise<Device> {
  const { app, repository, service } = await harness();
  await service.createEpisode(episodeInput({
    mrn: MRN,
    patientName: PATIENT_NAME,
    caseName: "Synthetic lane case",
    nextAction: "Synthetic bloods review",
    dueDate: todayIso()
  }));
  let stored: unknown = { ...DEFAULT_SETTINGS };
  const plugin = new ClinicalWorkspacePlugin(app as unknown as App, {} as never) as unknown as TestPlugin;
  plugin.app = app;
  plugin.repository = repository;
  plugin.service = service;
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
  plugin.managedRecordsExpected = true;
  plugin.expectedEntityCounts = null;
  plugin.expectedRecordDigest = null;
  plugin.workspaceSafetyNeedsPersistence = false;
  plugin.structureReady = true;
  plugin.whatsNewShownThisSession = true;
  plugin.loadData = async () => structuredClone(stored);
  plugin.saveData = async (data) => {
    stored = structuredClone(data);
  };
  plugin.refreshOpenViews = async () => undefined;
  repository.setManagedRecordWriteObserver((paths) => plugin.noteManagedRecordWrite(paths));
  await plugin.noteManagedRecordWrite();
  assert.equal(plugin.migrationRecoveryBlocked, false);
  return { app, repository, service, plugin };
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

/** Renders a captured modal into a test element, as Obsidian's open() would. */
function mount(modal: object): { content: TestElement; closes: () => number } {
  const content = new TestElement();
  const target = modal as { contentEl: unknown; modalEl: unknown; onOpen: () => void; close: () => void };
  target.contentEl = content;
  target.modalEl = new TestElement();
  let closes = 0;
  target.close = () => {
    closes += 1;
  };
  target.onOpen();
  return { content, closes: () => closes };
}

/** Loads the plugin through onload so the real command registrations are used. */
async function loadedPlugin(
  app: StubApp,
  readStored: () => unknown,
  onSave: (data: unknown) => void
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
  await plugin.onload();
  return { plugin, commands };
}

function commandAvailable(command: Command | undefined): boolean {
  assert.ok(command);
  if (command.checkCallback) return command.checkCallback(true) === true;
  return true;
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

/** Gives the plugin one workspace leaf holding a real view. */
function attachView(local: Device): { view: ClinicalWorkspaceView; root: TestElement } {
  const view = new ClinicalWorkspaceView(
    {} as never,
    local.repository,
    local.service,
    local.plugin.integrity,
    () => local.plugin.settings,
    local.plugin.workspaceRecoveryHost()
  );
  const root = new TestElement();
  (view as unknown as { contentEl: TestElement }).contentEl = root;
  const leaves: Array<{ view: unknown }> = [];
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
  return { view, root };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${label}`);
}

function noticeTexts(from = 0): string[] {
  return StubNotice.history.slice(from).map((notice) =>
    typeof notice.message === "string"
      ? notice.message
      : (notice.message as unknown as TestElement).textContent
  );
}

/** No MRN-shaped number, patient name, record path or clinical wording. */
function assertIdentifierFree(text: string): void {
  assert.doesNotMatch(text, /\d{7,}/, `no MRN-shaped number in: ${text}`);
  assert.doesNotMatch(text, /Synthetic/, `no patient or clinical text in: ${text}`);
  assert.doesNotMatch(text, new RegExp(`${ROOT}/|\\.md\\b`), `no record path in: ${text}`);
}

/* ------------------------------------------------ SP-1. Banner hint ----- */

test("a read-only open over an unreadable or replaced record says the list may be incomplete", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const host = local.plugin.workspaceRecoveryHost();
    assert.equal(host.recordsMayBeIncomplete(), false, "a verified, writable workspace");

    const episodePath = recordPath(local.app, "Episodes");
    local.app.vault.writeRaw(episodePath, "---\nid: [unterminated\n---\n");
    local.repository.invalidatePath(episodePath);
    local.plugin.observeManagedRecordDelivery(episodePath);
    await local.plugin.retryExactRestoredRootRecovery();
    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    assert.equal(local.plugin.readOnlyOpenRefusal(), null, "the workspace still opens for reading");
    assert.equal((await local.repository.snapshot()).episodes.length, 0, "the episode is in no list");
    assert.equal(
      managedRecordPaths(local.app).length,
      local.plugin.expectedManagedRecordCount,
      "the raw note count cannot see the gap"
    );
    assert.equal(host.recordsMayBeIncomplete(), true);

    const { view, root } = attachView(local);
    const opened = await local.plugin.activateWorkspace();
    assert.equal(opened, view);
    const banner = root.find(".clinical-write-block-banner");
    assert.ok(banner, "the read-only banner is shown");
    assert.match(banner.textContent, /The records shown may be incomplete until this is resolved\./);
    assertIdentifierFree(banner.textContent);

    // A deleted record with a stray note in its folder keeps the count too.
    const second = await device();
    const secondHost = second.plugin.workspaceRecoveryHost();
    const deleted = recordPath(second.app, "Episodes");
    second.app.vault.deleteRaw(deleted);
    second.repository.invalidatePath(deleted);
    second.app.vault.writeRaw(`${ROOT}/Episodes/Scratch.md`, "stray text\n");
    second.plugin.observeManagedRecordDelivery(deleted);
    await second.plugin.retryExactRestoredRootRecovery();
    assert.equal(second.plugin.migrationRecoveryBlocked, true);
    assert.equal(managedRecordPaths(second.app).length, second.plugin.expectedManagedRecordCount);
    assert.equal(secondHost.recordsMayBeIncomplete(), true);
  } finally {
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

/* ------------------------------------- SP-2. Interrupted first use ----- */

test("an initialization interrupted by a Sync delivery names typed ADOPT, not Initialize", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  const confirmations = captureModals(InitializeWorkspaceModal);
  let plugin: TestPlugin | null = null;
  try {
    setClinicalRoot(ROOT);
    const { app, service } = await harness();
    await service.createEpisode(episodeInput({ mrn: "9000009102", patientName: PATIENT_NAME }));
    let stored: unknown = null;
    let deliverOnSave = false;
    const loaded = await loadedPlugin(app, () => stored, (data) => {
      stored = data;
      if (!deliverOnSave || !plugin) return;
      // A record lands between the approval save and the final scan.
      deliverOnSave = false;
      const path = `${ROOT}/Tasks/TSK-SYNCED.md`;
      app.vault.writeRaw(path, "---\nid: TSK-SYNCED\n---\n");
      plugin.observeManagedRecordDelivery(path);
    });
    plugin = loaded.plugin;
    const initialize = loaded.commands.get("initialize-new-workspace");
    const adopt = loaded.commands.get("adopt-current-baseline");
    assert.equal(plugin.firstUseInitializationPending, true);
    assert.equal(commandAvailable(initialize), true);

    const approval = plugin.requestFirstUseInitialization();
    await waitFor(() => confirmations.opened.length === 1, "the initialization question");
    (confirmations.opened[0] as unknown as { onDecision: (initialize: boolean) => void }).onDecision(true);
    assert.equal(await approval, true);
    deliverOnSave = true;
    await assert.rejects(
      () => plugin!.initializeNewWorkspace(),
      (error: unknown) => error instanceof Error && error.message === CLINICAL_INITIALIZATION_CHANGED_MESSAGE
    );

    assert.equal(plugin.baselineReviewRequired, true);
    assert.equal(plugin.recoveryBlockMessage, CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE);
    assert.equal(plugin.repository.getWriteBlockReason(), CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE);
    assert.match(plugin.recoveryBlockMessage, /“Confirm current records as the recovery baseline”/);
    assert.equal(
      commandAvailable(initialize),
      false,
      "Initialize would only reopen read-only while typed ADOPT is required"
    );
    assert.equal(commandAvailable(adopt), true);
    // A settings change in this state names the same exit, not the hidden command.
    await assert.rejects(
      () => plugin!.updateSettings({ clinicianName: "Synthetic Clinician" }),
      (error: unknown) =>
        error instanceof Error && error.message === CLINICAL_BASELINE_CONFIRMATION_REQUIRED_MESSAGE
    );
  } finally {
    plugin?.onunload();
    confirmations.restore();
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

/* -------------------------------------------- SP-3. Refused ADOPT ----- */

test("a refused ADOPT puts back the barrier's reason instead of 'try again in a few seconds'", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const episodePath = recordPath(local.app, "Episodes");
    local.app.vault.deleteRaw(episodePath);
    local.app.vault.writeRaw(`${ROOT}/Tasks/Scratch.md`, "stray text\n");
    local.plugin.observeManagedRecordDelivery(episodePath);
    await local.plugin.retryExactRestoredRootRecovery();
    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    const before = local.plugin.recoveryBlockMessage;
    assert.equal(before, CLINICAL_RECORD_CHANGED_MESSAGE);

    // A note that is not a record is refused.
    const noticesBefore = StubNotice.history.length;
    assert.equal(await local.plugin.confirmCurrentBaselineAdoption(ROOT), false);
    await settle(local.plugin);
    assert.ok(
      StubNotice.history.slice(noticesBefore).some((notice) =>
        notice.attributes.get("aria-label") === CLINICAL_UNRECOGNIZED_RECORD_NOTES_MESSAGE)
    );
    assert.notEqual(local.plugin.recoveryBlockMessage, CLINICAL_BASELINE_CONFIRMING_MESSAGE);
    assert.equal(local.plugin.recoveryBlockMessage, before);
    assert.equal(local.repository.getWriteBlockReason(), before);
    assert.equal(local.plugin.migrationRecoveryBlocked, true, "the barrier stays armed");

    // A scan that cannot read the records is refused the same way.
    local.app.vault.deleteRaw(`${ROOT}/Tasks/Scratch.md`);
    const parse = local.plugin.parsedRecordInventory.bind(local.plugin);
    let parses = 0;
    local.plugin.parsedRecordInventory = async (root) => {
      parses += 1;
      if (parses === 2) throw new Error("scan failed");
      return parse(root);
    };
    assert.equal(await local.plugin.confirmCurrentBaselineAdoption(ROOT), false);
    await settle(local.plugin);
    assert.equal(parses, 2, "the preview scan passed and the confirming scan failed");
    assert.equal(local.plugin.recoveryBlockMessage, before);
    assert.equal(local.repository.getWriteBlockReason(), before);
  } finally {
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

/* ------------------------------------ SP-4. Open-time integrity ----- */

test("the open-time integrity check waits for a writable open; the command still runs", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  const reports = captureModals(IntegrityReportModal);
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    local.plugin.settings = { ...local.plugin.settings, runIntegrityOnStartup: true };
    local.plugin.integrityChecked = false;
    let scans = 0;
    const report = local.plugin.integrity.report.bind(local.plugin.integrity);
    local.plugin.integrity.report = async () => {
      scans += 1;
      return report();
    };
    attachView(local);

    const episodePath = recordPath(local.app, "Episodes");
    const original = local.app.vault.files.get(episodePath);
    assert.ok(original);
    local.app.vault.writeRaw(episodePath, "---\nid: [unterminated\n---\n");
    local.plugin.observeManagedRecordDelivery(episodePath);
    await local.plugin.retryExactRestoredRootRecovery();
    assert.equal(local.plugin.migrationRecoveryBlocked, true);

    await local.plugin.activateWorkspace();
    assert.equal(scans, 0, "no report on a record set that may be partial");
    assert.equal(local.plugin.integrityChecked, false, "the check stays armed");

    await local.plugin.runIntegrityCheck();
    assert.equal(scans, 1, "the explicit command still reports while paused");
    assert.equal(reports.opened.length, 1);

    local.app.vault.writeRaw(episodePath, original);
    local.repository.invalidatePath(episodePath);
    assert.equal(await local.plugin.retryPendingMigrationRecovery(), true);
    await settle(local.plugin);
    assert.equal(local.plugin.migrationRecoveryBlocked, false);

    await local.plugin.activateWorkspace();
    assert.equal(scans, 2, "the first writable open runs the check");
    assert.equal(local.plugin.integrityChecked, true);
  } finally {
    reports.restore();
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

/* --------------------------------------------- SP-5. Recheck delay ----- */

test("saving a note outside the clinical folder does not postpone the record recheck", async () => {
  const originalRoot = clinicalRootFolder();
  const timers = new FakeTimers();
  const restoreWindow = timers.install();
  try {
    setClinicalRoot(ROOT);
    const local = await device();
    const modify = captureVaultEvents(local.plugin, local.app).get("modify");
    assert.ok(modify);
    const episodePath = recordPath(local.app, "Episodes");
    local.app.vault.writeRaw(episodePath, `${local.app.vault.files.get(episodePath)}\nPost-op day 1.\n`);
    modify(new StubTFile(episodePath));
    assert.equal(local.plugin.migrationRecoveryBlocked, true);
    const armed = timers.ids(1500);
    assert.equal(armed.length, 1);

    // Sync keeps pulling unrelated notes and attachments.
    for (const path of ["Inbox/Unrelated.md", "Attachments/scan.png", `${ROOT} copy/Episodes/EPI-x.md`]) {
      local.app.vault.writeRaw(path, "unrelated\n");
      modify(new StubTFile(path));
      assert.deepEqual(timers.ids(1500), armed, `${path} must not restart the recheck delay`);
    }

    timers.flush(1500);
    await settle(local.plugin);
    assert.equal(local.plugin.migrationRecoveryBlocked, false, "the edit is rechecked on time");

    // With a folder move pending, only the move's two roots count.
    const moving = await device();
    moving.plugin.pendingMigrationMarker = { migrationInProgress: { from: ROOT, to: "Ward Records" } };
    const before = timers.ids(1500);
    moving.plugin.scheduleManagedRecordRecheck("Elsewhere/Note.md");
    assert.deepEqual(timers.ids(1500), before);
    moving.plugin.scheduleManagedRecordRecheck("Ward Records/Episodes/EPI-y.md");
    const scheduled = timers.ids(1500).filter((id) => !before.includes(id));
    assert.equal(scheduled.length, 1, "a delivery into the destination schedules a recheck");
    moving.plugin.scheduleManagedRecordRecheck("Elsewhere/Other.md");
    assert.deepEqual(timers.ids(1500).filter((id) => !before.includes(id)), scheduled);
    for (const id of scheduled) timers.pending.delete(id);
  } finally {
    restoreWindow();
    setClinicalRoot(originalRoot);
  }
});

/* ---------------------------------------------- SP-7. Error notices ----- */

test("error Notices show the plugin's own and recovery messages, never a file-system error", () => {
  const fallback = "The patient list could not be created. The form shows why.";
  const own = [
    "No episodes match these filters any more. Change a filter and try again.",
    "Case / reason is required.",
    "Restore the episode before reopening its tasks.",
    CLINICAL_RECORD_CHANGED_MESSAGE
  ];
  for (const message of own) assert.equal(clinicalErrorNoticeText(new Error(message), fallback), message);

  const nodeError = Object.assign(
    new Error(`ENOENT: no such file or directory, open '/Users/synthetic/Vault/${ROOT}/Patients/PAT-a.md'`),
    { code: "ENOENT", errno: -2, syscall: "open" }
  );
  const foreign: unknown[] = [
    nodeError,
    new Error(`File already exists: ${ROOT}/Documents/Synthetic Lane Patient.md`),
    new Error("EACCES: permission denied, mkdir '/Users/synthetic/Vault'"),
    new Error("The file could not be read from file:///var/mobile/Containers/Data/vault"),
    new Error("C:\\Users\\synthetic\\Vault could not be written"),
    new Error("Bad indentation of a mapping entry (3:1)\n\n 3 | patient_name: Synthetic"),
    "a thrown string",
    new Error("")
  ];
  for (const error of foreign) assert.equal(clinicalErrorNoticeText(error, fallback), fallback);
});

test("patient-list failures keep file paths out of Notices, and the form keeps the detail", async () => {
  const forms = captureModals(PatientListModal);
  try {
    // Opening the form: the snapshot read fails with an adapter error.
    const failing = createView("patients", snapshotOf({}), {
      repository: {
        snapshot: async () => {
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, open '/Users/synthetic/Vault/${ROOT}/Patients/PAT-a.md'`),
            { code: "ENOENT" }
          );
        }
      }
    });
    const noticesBefore = StubNotice.history.length;
    await failing.view.openPatientListExport();
    assert.deepEqual(noticeTexts(noticesBefore), ["The patient list could not be opened."]);

    // Submitting the form: the note cannot be created.
    const h = await harness();
    await h.service.createEpisode(episodeInput({ mrn: "9000009103", patientName: PATIENT_NAME }));
    const { view } = await mountView(h, "patients");
    await view.openPatientListExport();
    const form = forms.opened.at(-1);
    assert.ok(form);
    const { content } = mount(form);
    await flush();
    const detail = `File already exists: ${ROOT}/Documents/Synthetic Lane Patient.md`;
    const repository = h.repository as unknown as { createLooseNote: () => Promise<string> };
    repository.createLooseNote = async () => {
      throw new Error(detail);
    };
    const submitted = StubNotice.history.length;
    submitButton(content).dispatch("click");
    await waitFor(() => StubNotice.history.length > submitted, "the failure notice");
    assert.deepEqual(noticeTexts(submitted), ["The patient list could not be created. The form shows why."]);
    assert.equal(content.find(".clinical-modal-error")?.textContent, detail, "the form shows what happened");

    // The service's own message is still shown as written.
    const episodes = await h.repository.list<EpisodeRecord>("episode");
    await h.service.archiveEpisode(episodes[0]!.record.id, "Discharged");
    const refused = StubNotice.history.length;
    submitButton(content).dispatch("click");
    await waitFor(() => StubNotice.history.length > refused, "the refusal notice");
    assert.deepEqual(noticeTexts(refused), [
      "No episodes match these filters any more. Change a filter and try again."
    ]);
  } finally {
    forms.restore();
  }
});

/* ----------------------------------- SP-6 / UI-6. Task-added notices ----- */

test("adding or replacing a task never echoes the task's wording in a Notice", async () => {
  const taskForms = captureModals(NewTaskModal);
  const updateForms = captureModals(UpdateEpisodeModal);
  const pickers = captureModals(QuickEntryEpisodeModal);
  try {
    const h = await harness();
    const created = await h.service.createEpisode(episodeInput({
      mrn: "9000009104",
      patientName: PATIENT_NAME,
      caseName: "Synthetic hernia",
      careSetting: "inpatient",
      nextAction: "Synthetic potassium recheck bed 12",
      dueDate: todayIso()
    }));
    const input = (task: string): NewTaskInput => ({
      patientId: created.patient.record.id,
      episodeId: created.episode.record.id,
      task,
      taskType: "clinical-review",
      priority: "routine",
      dueDate: todayIso(),
      owner: ""
    });
    const submitTask = async (form: NewTaskModal | undefined, task: string): Promise<void> => {
      assert.ok(form);
      await (form as unknown as { onSubmit: (value: NewTaskInput) => Promise<void> }).onSubmit(input(task));
    };
    const noticesBefore = StubNotice.history.length;

    // + Task on an episode card, twice with the same wording.
    const patients = await mountView(h, "patients");
    buttonNamed(patients.root, /^\+ Task — /).dispatch("click");
    await submitTask(taskForms.opened.at(-1), "Synthetic chase histology Ahmed");
    buttonNamed(patients.root, /^\+ Task — /).dispatch("click");
    await submitTask(taskForms.opened.at(-1), "Synthetic chase histology Ahmed");

    // + Task on a task card, and from Quick entry.
    const tasks = await mountView(h, "tasks");
    buttonNamed(tasks.root, /^\+ Task — /).dispatch("click");
    await submitTask(taskForms.opened.at(-1), "Synthetic wound review");
    await tasks.view.openAddTaskQuickEntry();
    const picker = pickers.opened.at(-1) as unknown as {
      searchIndex: Array<{ choice: QuickEntryEpisodeChoice }>;
      onChoose: (choice: QuickEntryEpisodeChoice) => void;
    } | undefined;
    assert.ok(picker?.searchIndex[0]);
    picker.onChoose(picker.searchIndex[0].choice);
    await submitTask(taskForms.opened.at(-1), "Synthetic dressing change");

    // Update: a reworded next action replaces the old task.
    const update = async (nextAction: string, dueDate: string): Promise<void> => {
      const view = await mountView(h, "patients");
      buttonNamed(view.root, /^Update — /).dispatch("click");
      const form = updateForms.opened.at(-1);
      assert.ok(form);
      const seeded = (form as unknown as { input: EpisodeUpdateInput }).input;
      await (form as unknown as { onSubmit: (value: EpisodeUpdateInput) => Promise<void> })
        .onSubmit({ ...seeded, nextAction, dueDate });
    };
    await update("Synthetic repeat bloods for Ahmed", todayIso());
    // Update: the plan names a task that was already completed.
    const replacement = (await h.repository.list<TaskRecord>("task")).find(
      ({ record }) => record.task === "Synthetic repeat bloods for Ahmed"
    );
    assert.ok(replacement);
    await h.service.completeTask(replacement.record.id);
    // The first plan's task was cancelled as superseded; the second was completed.
    await update("Synthetic potassium recheck bed 12", todayIso());
    await update("Synthetic repeat bloods for Ahmed", todayIso());

    const shown = noticeTexts(noticesBefore);
    assert.deepEqual(shown, [
      "Task added.",
      "Task already exists.",
      "Task added.",
      "Task added.",
      "Task added. 1 superseded task cancelled.",
      "No task added: that task was already cancelled. Use + Task to raise it again.",
      "No task added: that task was already completed. Use + Task to raise it again."
    ]);
    for (const text of shown) assertIdentifierFree(text);
  } finally {
    taskForms.restore();
    updateForms.restore();
    pickers.restore();
  }
});

/* ------------------------------------------------ UI-1. Return key ----- */

function pressEnter(content: TestElement, target: TestElement, modifiers: { ctrlKey?: boolean } = {}): void {
  const event = {
    key: "Enter",
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
    target,
    preventDefault: () => undefined
  };
  for (const listener of content.listeners.get("keydown") ?? []) listener(event as unknown as Event);
}

function control(content: TestElement, label: string): TestElement {
  const found = content.findAll(`[aria-label="${label}"]`).find((element) =>
    ["INPUT", "SELECT"].includes(element.tagName.toUpperCase()));
  assert.ok(found, `expected a field named ${label}`);
  return found;
}

test("Return on Next action moves to Due date in Add patient and Update workflow", async () => {
  const added: NewEpisodeInput[] = [];
  const addForm = mount(new NewEpisodeModal(new App(), async (value) => {
    added.push(value);
  }));
  const updated: EpisodeUpdateInput[] = [];
  const updateForm = mount(new UpdateEpisodeModal(new App(), episode("EPI-a", "PAT-a", {
    next_action: "Synthetic review",
    due_date: isoDateWithOffset(-3)
  }), async (value) => {
    updated.push(value);
  }));
  await flush();

  for (const [form, submitted] of [[addForm, added], [updateForm, updated]] as const) {
    const nextAction = control(form.content, "Next action");
    const dueDate = control(form.content, "Due date");
    assert.equal(nextAction.getAttribute("enterkeyhint"), "next", "Return is not the last step here");
    pressEnter(form.content, nextAction);
    await flush();
    assert.equal(submitted.length, 0, "Return must not file the form before its due date");
    assert.equal(dueDate.focused, true, "Return moves on to Due date");
    for (const field of form.content.findAll("input")) {
      assert.notEqual(field.getAttribute("enterkeyhint"), "done", "no text field ends this form");
    }
    pressEnter(form.content, nextAction, { ctrlKey: true });
    await flush();
    assert.equal(submitted.length, 1, "Ctrl/Cmd+Return still saves from any field");
  }

  // A form that does end with a text field still saves from it.
  const tasks: NewTaskInput[] = [];
  const taskForm = mount(new NewTaskModal(new App(), episode("EPI-a", "PAT-a"), "Synthetic", async (value) => {
    tasks.push(value);
  }));
  await flush();
  const owner = control(taskForm.content, "Owner");
  assert.equal(owner.getAttribute("enterkeyhint"), "done");
  assert.equal(control(taskForm.content, "Task").getAttribute("enterkeyhint"), "next");
  pressEnter(taskForm.content, owner);
  await flush();
  assert.equal(tasks.length, 1);
});

/* ----------------------------------------------- UI-2. Ward buttons ----- */

test("ward-round View and Open keep their own width in narrow panes", async () => {
  const rules = parseCssRules(await readFile(new URL("../styles.css", import.meta.url), "utf8"));
  const narrowButton = ".clinical-workspace-view.is-narrow .clinical-card-button";
  const narrowWard = ".clinical-workspace-view.is-narrow .clinical-ward-actions .clinical-card-button";
  const phone = { width: 390, height: 844 };
  assert.equal(computedDeclarations(rules, [narrowButton], phone).get("width"), "100%");
  const ward = computedDeclarations(rules, [narrowButton, ".clinical-ward-actions .clinical-card-button", narrowWard], phone);
  assert.equal(ward.get("width"), "auto", "a full-width button pushed Open past the row edge");
  assert.equal(ward.get("flex"), "0 0 auto");
  const indexOf = (selector: string): number => rules.findIndex((rule) => rule.selectors.includes(selector));
  assert.ok(indexOf(narrowWard) > indexOf(narrowButton), "the override follows the rule it overrides");
});

test("ward-round rows wrap View and Open under the text instead of squeezing it", async () => {
  // In a 300 px pane the buttons left the patient line ~90 px, one word per
  // line, and an MRN broke across two lines.
  const rules = parseCssRules(await readFile(new URL("../styles.css", import.meta.url), "utf8"));
  const phone = { width: 320, height: 568 };
  assert.equal(computedDeclarations(rules, [".clinical-ward-row"], phone).get("flex-wrap"), "wrap");
  const flex = computedDeclarations(rules, [".clinical-ward-text"], phone).get("flex") ?? "";
  const basis = /^1 1 (\d+(?:\.\d+)?)em$/.exec(flex);
  assert.ok(basis && Number(basis[1]) >= 12, `the text needs a readable basis to wrap at, got "${flex}"`);
  const actions = computedDeclarations(rules, [".clinical-ward-actions"], phone);
  assert.equal(actions.get("margin-inline-start"), "auto", "wrapped buttons stay at the row's end");
});

/* ------------------------------------------------------- view harness ----- */

const STAMP = "2026-09-01T08:00:00.000Z";

function patient(id: string, overrides: Partial<PatientRecord> = {}): PatientRecord {
  return {
    schema_version: 3,
    entity: "patient",
    id,
    created_at: STAMP,
    updated_at: STAMP,
    tags: ["clinical/patient"],
    mrn: "9000009105",
    mrn_status: "confirmed",
    patient_name: "Synthetic Alpha",
    phone: "",
    phone_status: "not-found",
    status: "active",
    merged_into: "",
    ...overrides
  };
}

function episode(id: string, patientId: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    schema_version: 3,
    entity: "episode",
    id,
    created_at: STAMP,
    updated_at: STAMP,
    tags: ["clinical/episode"],
    patient_id: patientId,
    patient: "",
    case: "Synthetic case",
    care_setting: "outpatient",
    pathway: "assessment",
    priority: "routine",
    status: "active",
    next_action: "",
    due_date: "",
    opened_at: STAMP,
    closed_at: "",
    outcome: "",
    pathway_before_archive: "",
    status_before_archive: "",
    ...overrides
  };
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema_version: 3,
    entity: "task",
    id,
    created_at: STAMP,
    updated_at: STAMP,
    tags: ["clinical/task"],
    patient_id: "PAT-a",
    patient: "",
    episode_id: "EPI-a",
    episode: "",
    task: "Synthetic task",
    task_type: "clinical-review",
    status: "open",
    priority: "routine",
    due_date: todayIso(),
    owner: "",
    completed_at: "",
    cancelled_at: "",
    cancel_reason: "",
    idempotency_key: `key-${id}`,
    ...overrides
  };
}

function snapshotOf(parts: Partial<ClinicalSnapshot>): ClinicalSnapshot {
  return { patients: [], episodes: [], tasks: [], procedures: [], ...parts };
}

type WorkspaceTab = "today" | "patients" | "tasks" | "surgery" | "more";

type ViewInternals = {
  activeTab: WorkspaceTab;
  contentEl: TestElement;
  render: (snapshot: ClinicalSnapshot) => void;
  refresh: () => Promise<void>;
  pendingPageContext: unknown;
  selectListPage: (key: string, page: number, action: "previous" | "next", keyboard: boolean) => void;
  openPatientListExport: () => Promise<void>;
  openAddTaskQuickEntry: () => Promise<void>;
};

function createView(
  tab: WorkspaceTab,
  snapshot: ClinicalSnapshot,
  options: { repository?: Record<string, unknown>; service?: Record<string, unknown> } = {}
): { root: TestElement; view: ViewInternals } {
  const root = new TestElement();
  const repository = {
    snapshot: async () => snapshot,
    getWriteBlockReason: () => null,
    list: async () => [],
    findById: async () => null,
    ...options.repository
  };
  const view = new ClinicalWorkspaceView(
    {} as never,
    repository as unknown as ClinicalRepository,
    (options.service ?? {}) as unknown as ClinicalService,
    {} as IntegrityService
  ) as unknown as ViewInternals;
  view.activeTab = tab;
  view.contentEl = root;
  return { root, view };
}

async function mountView(h: Harness, tab: WorkspaceTab): Promise<{ view: ViewInternals; root: TestElement }> {
  const root = new TestElement();
  const view = new ClinicalWorkspaceView(
    {} as never,
    h.repository,
    h.service,
    h.integrity,
    () => DEFAULT_SETTINGS
  ) as unknown as ViewInternals;
  view.contentEl = root;
  view.activeTab = tab;
  await view.refresh();
  return { view, root };
}

function buttonNamed(root: TestElement, pattern: RegExp): TestElement {
  const button = root
    .findAll("button")
    .find((candidate) => pattern.test(candidate.getAttribute("aria-label") ?? candidate.textContent));
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

function submitButton(content: TestElement): TestElement {
  const submit = content.find(".clinical-modal-actions")?.findAll("button").find((button) =>
    button.classes.has("mod-cta"));
  assert.ok(submit, "expected the form's submit button");
  return submit;
}

function pagerText(root: TestElement, key: string): string {
  return root.find(`[data-page-key="${key}"]`)?.find(".clinical-section-note")?.textContent ?? "";
}

/* ------------------------------------------- UI-3. Page context once ----- */

test("a page change places the reader once; later Sync redraws leave scroll and focus alone", async () => {
  const snapshot = snapshotOf({
    patients: [patient("PAT-a")],
    episodes: [episode("EPI-a", "PAT-a")],
    tasks: Array.from({ length: CLINICAL_PAGE_SIZE + 3 }, (_value, index) =>
      task(`TSK-${String(index).padStart(3, "0")}`, { task: `Synthetic task ${String(index).padStart(3, "0")}` }))
  });
  const resolvers: Array<() => void> = [];
  const { root, view } = createView("tasks", snapshot, {
    repository: {
      snapshot: () => new Promise<ClinicalSnapshot>((resolve) => resolvers.push(() => resolve(snapshot)))
    }
  });
  const document = { activeElement: null as TestElement | null, body: new TestElement("body") };
  (root as unknown as { ownerDocument: unknown }).ownerDocument = document;
  view.render(snapshot);

  // Tap Next; a Sync refresh queues behind the one the tap started.
  view.selectListPage("tasks-open", 1, "next", false);
  void view.refresh();
  resolvers.shift()?.();
  await flush();
  const placed = root.findAll("h4")[0];
  assert.equal(placed?.textContent, `Synthetic task ${String(CLINICAL_PAGE_SIZE).padStart(3, "0")}`);
  assert.equal(placed?.focused, true, "the new page starts at its first item");
  assert.equal(view.pendingPageContext, null, "the tap's own redraw used the context");

  // The user moves into an editor while Sync keeps delivering.
  document.activeElement = new TestElement("div");
  const header = root.find('[data-page-section="tasks-open"]');
  const headerCalls = header?.scrollIntoViewCalls.length ?? 0;
  void view.refresh();
  resolvers.shift()?.();
  await flush();
  resolvers.shift()?.();
  await flush();
  assert.equal(root.findAll("h4").some((heading) => heading.focused), false, "focus stays in the editor");
  assert.equal(
    root.find('[data-page-section="tasks-open"]')?.scrollIntoViewCalls.length ?? 0,
    0,
    "the rebuilt header is not scrolled into view again"
  );
  assert.ok(headerCalls >= 1);
  assert.equal(pagerText(root, "tasks-open"), `Page 2 of 2 · ${CLINICAL_PAGE_SIZE + 3} total`);

  // A tap during an in-flight refresh still reaches the redraw it queued.
  document.activeElement = null;
  void view.refresh();
  view.selectListPage("tasks-open", 0, "previous", false);
  resolvers.shift()?.();
  await flush();
  assert.notEqual(view.pendingPageContext, null, "kept for the queued redraw");
  resolvers.shift()?.();
  await flush();
  assert.equal(view.pendingPageContext, null);
  assert.equal(root.findAll("h4")[0]?.focused, true);
  assert.equal(pagerText(root, "tasks-open"), `Page 1 of 2 · ${CLINICAL_PAGE_SIZE + 3} total`);
});

/* --------------------------------------------- UI-4. Filter paging ----- */

test("changing a filter chip or clearing filters goes back to the first page", async () => {
  const emergencies = Array.from({ length: CLINICAL_PAGE_SIZE + 5 }, (_value, index) =>
    task(`TSK-e${String(index).padStart(3, "0")}`, {
      task: `Synthetic emergency ${String(index).padStart(3, "0")}`,
      priority: "emergency"
    }));
  const routine = Array.from({ length: CLINICAL_PAGE_SIZE }, (_value, index) =>
    task(`TSK-r${String(index).padStart(3, "0")}`, {
      task: `Synthetic routine ${String(index).padStart(3, "0")}`,
      task_type: "wound-care"
    }));
  const snapshot = snapshotOf({
    patients: [patient("PAT-a")],
    episodes: [episode("EPI-a", "PAT-a")],
    tasks: [...emergencies, ...routine]
  });
  const { root, view } = createView("tasks", snapshot);
  view.render(snapshot);
  view.selectListPage("tasks-open", 2, "next", false);
  await flush();
  assert.match(pagerText(root, "tasks-open"), /^Page 3 of 3/);

  buttonNamed(root, /^Emergency$/).dispatch("click");
  await flush();
  assert.match(pagerText(root, "tasks-open"), /^Page 1 of 2/, "the top matches are shown first");
  assert.equal(root.findAll("h4")[0]?.textContent, "Synthetic emergency 000");

  // Re-selecting the chip already in force changes nothing and keeps the page.
  view.selectListPage("tasks-open", 1, "next", false);
  await flush();
  buttonNamed(root, /^All$/).dispatch("click");
  await flush();
  buttonNamed(root, /^Emergency$/).dispatch("click");
  await flush();
  view.selectListPage("tasks-open", 1, "next", false);
  await flush();
  buttonNamed(root, /^All types$/).dispatch("click");
  await flush();
  assert.match(pagerText(root, "tasks-open"), /^Page 2 of 2/);

  // Clear filters from an empty filtered list.
  buttonNamed(root, /^Wound Care$/).dispatch("click");
  await flush();
  assert.match(root.textContent, /No open tasks match these filters\./);
  view.selectListPage("tasks-open", 1, "next", false);
  await flush();
  buttonNamed(root, /^Clear filters/).dispatch("click");
  await waitFor(() => /^Page 1 of 3/.test(pagerText(root, "tasks-open")), "the cleared list on page 1");

  // The Patients chips reset both care-setting lists.
  const inpatients = Array.from({ length: CLINICAL_PAGE_SIZE + 2 }, (_value, index) =>
    episode(`EPI-${String(index).padStart(3, "0")}`, "PAT-a", {
      case: `Synthetic case ${String(index).padStart(3, "0")}`,
      care_setting: "inpatient",
      priority: index % 2 ? "urgent" : "routine"
    }));
  const ward = snapshotOf({ patients: [patient("PAT-a")], episodes: inpatients });
  const patients = createView("patients", ward);
  patients.view.render(ward);
  patients.view.selectListPage("patients-inpatient", 1, "next", false);
  await flush();
  assert.match(pagerText(patients.root, "patients-inpatient"), /^Page 2 of 2/);
  buttonNamed(patients.root, /^Urgent$/).dispatch("click");
  await flush();
  assert.equal(patients.root.find('[data-page-key="patients-inpatient"]'), null, "one page of urgent inpatients");
  const cards = patients.root.findAll("h4").map((heading) => heading.textContent);
  assert.equal(cards[0], "Synthetic case 001", "the first urgent inpatient is shown");
});

/* ----------------------------------------------- UI-5. Double tap ----- */

test("a double tap on Complete completes once and offers Undo once", async () => {
  const open = task("TSK-a", { task: "Synthetic dressing" });
  const snapshot = snapshotOf({ patients: [patient("PAT-a")], episodes: [episode("EPI-a", "PAT-a")], tasks: [open] });
  let calls = 0;
  let release: () => void = () => undefined;
  const service = {
    completeTask: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { path: "", record: { ...open, status: "completed", completed_at: new Date().toISOString() } };
    }
  };
  const { root, view } = createView("tasks", snapshot, { service });
  view.render(snapshot);
  const complete = buttonNamed(root, /^Complete — /);
  const noticesBefore = StubNotice.history.length;
  complete.dispatch("click");
  await flush();
  assert.equal(complete.disabled, true, "the button waits for the write");
  complete.dispatch("click");
  await flush();
  release();
  await waitFor(() => StubNotice.history.length > noticesBefore, "the completion notice");
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(noticeTexts(noticesBefore), ["Task completed.Undo"]);

  // A card left stale by another device's completion offers no Undo.
  const stale = createView("tasks", snapshot, {
    service: {
      completeTask: async () => ({
        path: "",
        record: { ...open, status: "completed", completed_at: "2026-09-01T09:00:00.000Z" }
      })
    }
  });
  stale.view.render(snapshot);
  const staleBefore = StubNotice.history.length;
  buttonNamed(stale.root, /^Complete — /).dispatch("click");
  await waitFor(() => StubNotice.history.length > staleBefore, "the stale-card notice");
  assert.deepEqual(noticeTexts(staleBefore), ["This task was already completed."]);
});

/* ---------------------------------------------- copy that names things ----- */

test("More-tab and CSV copy match what the workspace writes", async () => {
  const h = await harness();
  await h.service.createEpisode(episodeInput({ mrn: "9000009106", patientName: PATIENT_NAME }));
  const { root } = await mountView(h, "more");
  assert.match(root.textContent, /every patient's overdue, due-today, due-tomorrow and undated tasks/);
  assert.match(root.textContent, /text stored as a number, invalid dates and repeat intervals/);
  assert.match(root.textContent, /logbook-export readiness, stale database views/);

  const forms = captureModals(PatientListModal);
  try {
    const { view } = await mountView(h, "patients");
    await view.openPatientListExport();
    const form = forms.opened.at(-1);
    assert.ok(form);
    const { content } = mount(form);
    await flush();
    const format = control(content, "Format");
    format.value = "csv";
    format.dispatch("change");
    const before = StubNotice.history.length;
    submitButton(content).dispatch("click");
    await waitFor(() => StubNotice.history.length > before, "the CSV notice");
    const [shown] = noticeTexts(before);
    assert.match(shown ?? "", /It contains patient identifiers\./);
    assertIdentifierFree(shown ?? "");
  } finally {
    forms.restore();
  }
});
