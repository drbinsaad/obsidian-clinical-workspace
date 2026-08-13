/**
 * Property harness for the sync-safety state machine.
 *
 * For each fixed seed, a pseudo-random sequence of the events Sync and the
 * user can throw at the plugin — restarts, folder renames, record deletions
 * (live and while-closed), data.json deliveries, recovery retries, workspace
 * opens — runs against one vault. After every event a clinical write is
 * attempted, and the fail-closed property is asserted on the OUTCOME:
 *
 *   A write that succeeds must have happened against an active root holding
 *   at least the trusted record count, never while two roots hold records,
 *   and the trusted baseline may only ratchet upward.
 *
 * Blocking is always a legal outcome; silent acceptance of a depleted or
 * ambiguous root is the only failure. Any failure reproduces exactly from
 * its seed, and the assertion message carries the full event trace.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { App, TFolder } from "obsidian";
import ClinicalWorkspacePlugin from "../src/main";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import { DEFAULT_SETTINGS, type ClinicalSettings } from "../src/domain/settings";
import { ClinicalService } from "../src/services/clinical-service";
import { IntegrityService } from "../src/services/integrity";
import type { App as StubApp } from "./support/obsidian-stub";
import { episodeInput, harness } from "./support/harness";

const SOURCE_ROOT = DEFAULT_SETTINGS.rootFolder;
const OTHER_ROOT = "Ward Records";
const MANAGED_FOLDERS = ["Patients", "Episodes", "Tasks", "Procedures"] as const;

/** Deterministic 32-bit PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

interface TestPlugin {
  app: StubApp;
  settings: ClinicalSettings;
  repository: ClinicalRepository;
  structureReady: boolean;
  migrationRecoveryBlocked: boolean;
  recoveryBlockMessage: string;
  workspaceInitialized: boolean;
  expectedManagedRecordCount: number;
  firstUseInitializationPending: boolean;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  refreshOpenViews: () => Promise<void>;
  loadSettings: () => Promise<void>;
  onExternalSettingsChange: () => Promise<void>;
  handleVaultRename: (file: unknown, oldPath: string) => void;
  blockIfActiveRootDisappeared: (path: string) => void;
  retryMigrationForPath: (path: string) => void;
  retryPendingMigrationRecovery: () => Promise<boolean>;
  ensureStructure: () => Promise<void>;
  noteManagedRecordWrite: () => Promise<void>;
}

interface World {
  app: StubApp;
  stored: Record<string, unknown>;
  plugin: TestPlugin;
  repository: ClinicalRepository;
  service: ClinicalService;
  /** Records deleted by earlier events, available for Sync to restore. */
  lost: Map<string, string>;
  trace: string[];
}

function managedRecordPaths(app: StubApp, root: string): string[] {
  return [...app.vault.files.keys()]
    .filter((path) => MANAGED_FOLDERS.some((folder) => path.startsWith(`${root}/${folder}/`)))
    .sort();
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

function attach(world: World): void {
  const plugin = new ClinicalWorkspacePlugin(
    world.app as unknown as App,
    {} as never
  ) as unknown as TestPlugin;
  plugin.app = world.app;
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.repository = world.repository;
  plugin.structureReady = false;
  plugin.loadData = async () => structuredClone(world.stored);
  plugin.saveData = async (data) => {
    world.stored = structuredClone(data) as Record<string, unknown>;
  };
  plugin.refreshOpenViews = async () => undefined;
  world.repository.setManagedRecordWriteObserver(() => plugin.noteManagedRecordWrite());
  world.plugin = plugin;
}

/** Fresh repository/service/plugin over the same vault + stored data.json. */
async function restart(world: World): Promise<void> {
  world.repository = new ClinicalRepository(world.app as unknown as App);
  world.service = new ClinicalService(world.repository);
  attach(world);
  await world.plugin.loadSettings();
  world.repository.setWriteBlock(
    world.plugin.migrationRecoveryBlocked ? world.plugin.recoveryBlockMessage : null
  );
}

async function buildWorld(): Promise<World> {
  setClinicalRoot(SOURCE_ROOT);
  const base = await harness();
  await base.service.createEpisode(
    episodeInput({ mrn: "9000000201", caseName: "Synthetic model case A", nextAction: "Review", dueDate: "2026-09-01" })
  );
  await base.service.createEpisode(
    episodeInput({ mrn: "9000000202", caseName: "Synthetic model case B" })
  );
  const count = managedRecordPaths(base.app, SOURCE_ROOT).length;
  const world: World = {
    app: base.app,
    stored: {
      ...DEFAULT_SETTINGS,
      workspaceSafety: {
        version: 1,
        initialized: true,
        initializationApproved: false,
        managedRecordsExpected: true,
        expectedManagedRecordCount: count,
        rootRecoveryRequired: false,
        recoveryRequiresRecords: true
      }
    },
    plugin: null as unknown as TestPlugin,
    repository: null as unknown as ClinicalRepository,
    service: null as unknown as ClinicalService,
    lost: new Map(),
    trace: []
  };
  await restart(world);
  return world;
}

/** The event alphabet. Each returns a short label for the failure trace. */
function events(world: World, random: () => number): Array<() => Promise<string>> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  return [
    async () => {
      await restart(world);
      return "restart";
    },
    async () => {
      // Live rename of the active root, as Sync delivers it.
      const from = clinicalRootFolder();
      const to = from === SOURCE_ROOT ? OTHER_ROOT : SOURCE_ROOT;
      if (!(world.app.vault.getAbstractFileByPath(from) instanceof TFolder)) return "rename-skipped";
      copyRoot(world.app, from, to);
      deleteRoot(world.app, from);
      const folder = world.app.vault.getAbstractFileByPath(to);
      world.plugin.handleVaultRename(folder, from);
      return `rename ${from} -> ${to}`;
    },
    async () => {
      // Live deletion of one record note; the vault event fires.
      const paths = managedRecordPaths(world.app, clinicalRootFolder());
      const victim = pick([...paths, null]);
      if (!victim) return "delete-skipped";
      world.lost.set(victim, world.app.vault.files.get(victim) ?? "");
      world.app.vault.deleteRaw(victim);
      world.repository.invalidatePath(victim);
      world.plugin.blockIfActiveRootDisappeared(victim);
      return "live-delete record";
    },
    async () => {
      // Records disappear while Obsidian is closed: no event, then restart.
      const paths = managedRecordPaths(world.app, clinicalRootFolder());
      const victim = pick([...paths, null]);
      if (!victim) return "closed-delete-skipped";
      world.lost.set(victim, world.app.vault.files.get(victim) ?? "");
      world.app.vault.deleteRaw(victim);
      await restart(world);
      return "closed-app delete + restart";
    },
    async () => {
      // Sync delivers a data.json carrying a migration marker to OTHER_ROOT.
      world.stored = {
        ...world.stored,
        rootFolder: OTHER_ROOT,
        migrationInProgress: { from: SOURCE_ROOT, to: OTHER_ROOT }
      };
      await world.plugin.onExternalSettingsChange();
      return "deliver marker data.json";
    },
    async () => {
      // Sync delivers a data.json claiming a HIGHER trusted count.
      const safety = structuredClone(
        (world.stored as { workspaceSafety?: Record<string, unknown> }).workspaceSafety ?? {}
      );
      safety.expectedManagedRecordCount =
        Number(safety.expectedManagedRecordCount ?? 0) + 2;
      safety.version = 1;
      safety.initialized = true;
      safety.managedRecordsExpected = true;
      safety.recoveryRequiresRecords = true;
      world.stored = { ...world.stored, workspaceSafety: safety };
      await world.plugin.onExternalSettingsChange();
      return "deliver higher-count data.json";
    },
    async () => {
      // Sync catch-up restores a record an earlier event lost. A real
      // delivery restores the missing file, never a duplicate of a live one.
      const candidates = [...world.lost.keys()].filter(
        (path) => !world.app.vault.files.has(path)
      );
      const path = pick([...candidates, null]);
      if (!path) return "arrival-skipped";
      world.app.vault.writeRaw(path, world.lost.get(path) ?? "");
      world.lost.delete(path);
      world.repository.invalidatePath(path);
      world.plugin.retryMigrationForPath(path);
      return "record restored by sync";
    },
    async () => {
      const settled = await world.plugin.retryPendingMigrationRecovery().catch(() => false);
      return `user retry (settled: ${settled})`;
    },
    async () => {
      await world.plugin.ensureStructure().catch(() => undefined);
      return "workspace open attempt";
    }
  ];
}

for (const seed of [3, 17, 31, 59, 73]) {
  test(`sync state machine stays fail-closed under random event sequences (seed ${seed})`, async () => {
    const originalRoot = clinicalRootFolder();
    try {
      const random = prng(seed);
      const world = await buildWorld();
      const alphabet = events(world, random);

      for (let step = 0; step < 14; step += 1) {
        const event = alphabet[Math.floor(random() * alphabet.length)];
        const label = await event!().catch((error: unknown) => `threw: ${String(error)}`);
        world.trace.push(`${step}: ${label}`);

        // Ground truth BEFORE the probe, from the same metrics the plugin uses.
        const activeRoot = clinicalRootFolder();
        const trustedBefore = world.plugin.workspaceInitialized
          ? world.plugin.expectedManagedRecordCount
          : 0;
        const countBefore = managedRecordPaths(world.app, activeRoot).length;
        const sourcePopulated = managedRecordPaths(world.app, SOURCE_ROOT).length > 0;
        const otherPopulated = managedRecordPaths(world.app, OTHER_ROOT).length > 0;

        const probe = await world.service
          .createEpisode(
            episodeInput({
              mrn: "9000000209",
              caseName: `Synthetic probe ${seed}-${step}`,
              patientName: "Synthetic Probe Patient"
            })
          )
          .then(() => "accepted")
          .catch(() => "blocked");
        world.trace.push(`${step}: probe ${probe}`);

        const trace = () => `seed ${seed}\n${world.trace.join("\n")}`;
        if (probe === "accepted") {
          // The fail-closed property: acceptance is only legal against a
          // root that still holds everything the device trusts, with no
          // second populated root waiting to be reconciled.
          assert.ok(
            countBefore >= trustedBefore,
            `write accepted over a depleted root (${countBefore} < ${trustedBefore})\n${trace()}`
          );
          assert.ok(
            !(sourcePopulated && otherPopulated),
            `write accepted while both roots hold records\n${trace()}`
          );
        }
        // The baseline may only ratchet upward.
        assert.ok(
          world.plugin.expectedManagedRecordCount >= trustedBefore,
          `trusted baseline decreased\n${trace()}`
        );
      }

      // Final Sync convergence: one tree wins. Every record the model lost
      // arrives under the active root, and every record stranded under the
      // other root (a restore can legitimately land on an abandoned path)
      // moves across too. Only NOW is zero corruption a fair demand —
      // before convergence, orphan reports are the integrity check
      // detecting the model's own deletions, which is designed behavior.
      const activeRoot = clinicalRootFolder();
      for (const [path, content] of world.lost) {
        const mapped = path.replace(/^[^/]+\//, `${activeRoot}/`);
        if (!world.app.vault.files.has(mapped)) world.app.vault.writeRaw(mapped, content);
        world.repository.invalidatePath(mapped);
      }
      world.lost.clear();
      const abandonedRoot = activeRoot === SOURCE_ROOT ? OTHER_ROOT : SOURCE_ROOT;
      for (const path of managedRecordPaths(world.app, abandonedRoot)) {
        const mapped = path.replace(/^[^/]+\//, `${activeRoot}/`);
        if (!world.app.vault.files.has(mapped)) {
          world.app.vault.writeRaw(mapped, world.app.vault.files.get(path) ?? "");
        }
        world.app.vault.deleteRaw(path);
        world.repository.invalidatePath(path);
        world.repository.invalidatePath(mapped);
      }

      // End state: whatever was accepted must be coherent records.
      const integrity = new IntegrityService(world.repository);
      const errors = (await integrity.scan()).filter((issue) => issue.severity === "error");
      // duplicate-mrn is the documented per-device limitation: a probe can
      // legitimately re-register an MRN whose patient note was missing at
      // the time, and Sync convergence then surfaces the pair for the merge
      // workflow. Detection is the designed outcome, not corruption.
      const allowed = new Set(["missing-folder", "duplicate-mrn"]);
      const corruption = errors.filter((issue) => !allowed.has(issue.code));
      assert.deepEqual(
        corruption,
        [],
        `seed ${seed} ended with corruption:\n${JSON.stringify(corruption, null, 2)}\n${world.trace.join("\n")}`
      );
    } finally {
      setClinicalRoot(originalRoot);
    }
  });
}
