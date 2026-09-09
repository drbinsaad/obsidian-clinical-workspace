import { App, Notice, normalizePath, TFile } from "obsidian";
import type {
  ClinicalRecord,
  ClinicalSnapshot,
  EntityType,
  EpisodeRecord,
  EventRecord,
  PatientRecord,
  ProcedureRecord,
  RecordWithPath,
  TaskRecord
} from "../domain/types";
import { createId, mrnMatchKey, nowIso, SCHEMA_VERSION } from "../domain/schema";
import { baseFiles, baseSourceFolders, homeNote } from "./bases";
import { parseClinicalRecord, recordMarkdown, valueMatches } from "./markdown";
import { isUntouchedBase, isUntouchedHome } from "./scaffold";
import { markdownFilesInFolder } from "./vault-scope";
import {
  allClinicalFolders,
  clinicalFolder,
  clinicalRootFolder,
  folderForEntity,
  pathForRecord
} from "./paths";

type FrontmatterChange = Record<string, string | number | boolean | string[]>;

interface ManagedMutationRelease {
  (): void;
  /** True once this claim has been handed off or otherwise released. */
  isReleased(): boolean;
  /** Only entity-record claims participate in the trusted id-set ratchet. */
  advancesInventory: boolean;
}

interface InventoryRatchetWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Intentionally contains no record ids, paths, patient text, or configured
 * folder names: it can reach Notices and the developer console.
 */
export const CLINICAL_WRITES_BLOCKED_MESSAGE =
  "Clinical Workspace is temporarily read-only while a synced folder move is being reconciled. After Sync finishes, run “Retry pending folder move recovery” from the Command Palette.";

export interface UnreadableRecordInfo {
  path: string;
  /** Stable internal id only; never patient text. Null means attribution failed. */
  episodeId: string | null;
}

function episodeIdFromUnreadableTask(content: string): string | null {
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!frontmatter) return null;
  const match = /^episode_id\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#\r\n]+))/m.exec(frontmatter);
  const candidate = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return /^EPI-[A-Za-z0-9-]+$/.test(candidate) ? candidate : null;
}


/**
 * Serialises async operations that share a key. Used both for writes to one
 * file path and for read-check-write guards that span several files, where the
 * key is a logical entity identity rather than a path.
 */
class KeyedWriteQueue {
  private readonly pending = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }
}

export class ClinicalRepository {
  private readonly queue = new KeyedWriteQueue();
  /** Parsed records keyed by the exact cachedRead content that produced them. */
  private readonly parsedRecords = new Map<string, { content: string; record: ClinicalRecord | null }>();
  /**
   * Parsed records by path, trusted until the path is invalidated.
   *
   * Every workflow action lists whole folders, so without this each action
   * re-reads and re-parses every record note — quadratic-feeling latency at
   * multi-thousand-record scale on a phone. Obsidian guarantees a vault
   * event for every file change (including Sync), and the plugin routes all
   * of them through invalidatePath, so an entry is trustworthy exactly
   * until then. Write verification uses fresh reads, which update this
   * index authoritatively; a file's absence is always re-checked against
   * the live vault before an entry is served.
   */
  private readonly recordIndex = new Map<string, ClinicalRecord | null>();
  /** Recorded as the actor on audit notes; set from settings on load. */
  private actor = "local-user";
  /** Non-null while Sync/migration recovery cannot identify one writable root. */
  private writeBlockReason: string | null = null;
  /** Persists path-free safety state when the first managed record is written. */
  private managedRecordWriteObserver: (
    (paths: readonly string[]) => Promise<boolean | void>
  ) | null = null;
  /** Lets vault-event recovery distinguish this repository's verified writes from Sync. */
  private readonly managedMutationDepth = new Map<string, number>();
  /** Monotonic per-path token: a stale readback can never acknowledge a later event. */
  private readonly managedMutationEventRevisions = new Map<string, number>();
  /** Events seen inside a claimed mutation remain untrusted until readback proves identity. */
  private readonly unclassifiedManagedMutationPaths = new Set<string>();
  /** Root changes close admission, then drain already-started record mutations. */
  private managedMutationAdmissionPauseDepth = 0;
  private activeManagedMutationCount = 0;
  /** Only Patient/Episode/Task/Procedure mutations advance the id commitment. */
  private activeInventoryMutationCount = 0;
  /** Successful id-set mutations that still need one whole-root observer pass. */
  private inventoryRatchetRevision = 0;
  private inventoryRatchetServicedRevision = 0;
  /** Writers that handed off a ratchet cannot report success before it is durable. */
  private readonly inventoryRatchetWaiters = new Set<InventoryRatchetWaiter>();
  private readonly managedMutationDrainWaiters = new Set<() => void>();

  constructor(private readonly app: App) {}

  setActor(actor: string): void {
    this.actor = actor.trim() || "local-user";
  }

  /**
   * Enables or clears the fail-closed write barrier used during folder-move
   * recovery. Reads deliberately remain available from the last safe root.
   */
  setWriteBlock(reason: string | null): void {
    this.writeBlockReason = reason;
  }

  setManagedRecordWriteObserver(
    observer: ((paths: readonly string[]) => Promise<boolean | void>) | null
  ): void {
    this.managedRecordWriteObserver = observer;
  }

  isManagedRecordMutationInProgress(path: string): boolean {
    return (this.managedMutationDepth.get(normalizePath(path)) ?? 0) > 0;
  }

  noteManagedRecordMutationEvent(path: string): void {
    const normalized = normalizePath(path);
    if (this.isManagedRecordMutationInProgress(normalized)) {
      this.managedMutationEventRevisions.set(
        normalized,
        (this.managedMutationEventRevisions.get(normalized) ?? 0) + 1
      );
      this.unclassifiedManagedMutationPaths.add(normalized);
    }
  }

  consumeUnclassifiedManagedMutationEvent(paths?: readonly string[]): boolean {
    if (!paths) {
      if (this.unclassifiedManagedMutationPaths.size === 0) return false;
      this.unclassifiedManagedMutationPaths.clear();
      return true;
    }
    let consumed = false;
    for (const path of paths) {
      const normalized = normalizePath(path);
      if (this.unclassifiedManagedMutationPaths.delete(normalized)) consumed = true;
    }
    return consumed;
  }

  hasUnclassifiedManagedMutationEvent(path: string): boolean {
    return this.unclassifiedManagedMutationPaths.has(normalizePath(path));
  }

  private managedMutationEventRevision(path: string): number {
    return this.managedMutationEventRevisions.get(normalizePath(path)) ?? 0;
  }

  private beginManagedMutation(
    path: string,
    advancesInventory = true
  ): ManagedMutationRelease {
    const normalized = normalizePath(path);
    this.activeManagedMutationCount += 1;
    if (advancesInventory) this.activeInventoryMutationCount += 1;
    this.managedMutationDepth.set(
      normalized,
      (this.managedMutationDepth.get(normalized) ?? 0) + 1
    );
    let released = false;
    const release = (() => {
      if (released) return;
      released = true;
      this.endManagedMutation(normalized, advancesInventory);
    }) as ManagedMutationRelease;
    release.isReleased = () => released;
    release.advancesInventory = advancesInventory;
    return release;
  }

  private endManagedMutation(path: string, advancesInventory: boolean): void {
    const normalized = normalizePath(path);
    const depth = this.managedMutationDepth.get(normalized) ?? 0;
    if (depth > 1) {
      this.managedMutationDepth.set(normalized, depth - 1);
    } else {
      this.managedMutationDepth.delete(normalized);
      if (!this.unclassifiedManagedMutationPaths.has(normalized)) {
        this.managedMutationEventRevisions.delete(normalized);
      }
    }
    this.activeManagedMutationCount = Math.max(0, this.activeManagedMutationCount - 1);
    if (advancesInventory) {
      this.activeInventoryMutationCount = Math.max(0, this.activeInventoryMutationCount - 1);
    }
    if (this.activeManagedMutationCount === 0) {
      const waiters = [...this.managedMutationDrainWaiters];
      this.managedMutationDrainWaiters.clear();
      // Let the completed write's own promise continuations observe success
      // before the waiting root move resumes and changes every path.
      queueMicrotask(() => {
        for (const resolve of waiters) resolve();
      });
    }
  }

  /**
   * Atomically prevents a new managed-record mutation from starting and waits
   * for every admitted mutation to finish. The caller must release the gate.
   */
  async pauseManagedRecordMutations(): Promise<{
    release: () => void;
    drainedExisting: boolean;
  }> {
    const drainedExisting = this.activeManagedMutationCount > 0;
    // The prefix of an async function runs synchronously. Incrementing before
    // the first await means a Sync settings callback closes admission in the
    // same stack that received it. A depth counter lets overlapping callbacks
    // share the gate without one callback reopening writes under another.
    this.managedMutationAdmissionPauseDepth += 1;
    if (drainedExisting) {
      await new Promise<void>((resolve) => {
        this.managedMutationDrainWaiters.add(resolve);
      });
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.managedMutationAdmissionPauseDepth = Math.max(
        0,
        this.managedMutationAdmissionPauseDepth - 1
      );
    };
    return { release, drainedExisting };
  }

  private assertManagedMutationAdmissionOpen(): void {
    if (this.managedMutationAdmissionPauseDepth > 0) {
      throw new Error("Clinical Workspace is preparing a record-folder move. Try again after it finishes.");
    }
  }

  /** A revision captured by a stale async read is never allowed to clear a newer event. */
  private confirmManagedMutationIdentity(path: string, revision: number): boolean {
    const normalized = normalizePath(path);
    if (this.managedMutationEventRevision(normalized) !== revision) return false;
    this.unclassifiedManagedMutationPaths.delete(normalized);
    return true;
  }

  /**
   * Reads until one attempt spans no vault event. Three attempts bound work
   * under a continuously changing Sync stream; instability then fails closed.
   */
  private async readStableManagedRecord<T extends ClinicalRecord>(
    path: string
  ): Promise<{
    value: RecordWithPath<T> | null;
    revision: number;
    stable: boolean;
  }> {
    let value: RecordWithPath<T> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.managedMutationEventRevision(path);
      value = await this.read<T>(path, true);
      const after = this.managedMutationEventRevision(path);
      if (before === after) return { value, revision: after, stable: true };
    }
    return {
      value,
      revision: this.managedMutationEventRevision(path),
      stable: false
    };
  }

  private pathBelongsToCurrentEntityFolder(path: string, entity: EntityType): boolean {
    const folder = normalizePath(folderForEntity(entity));
    return normalizePath(path).startsWith(`${folder}/`);
  }

  private pathAdvancesTrustedInventory(path: string): boolean {
    const normalized = normalizePath(path);
    return ["Patients", "Episodes", "Tasks", "Procedures"].some(
      (folder) => normalized.startsWith(`${clinicalRootFolder()}/${folder}/`)
    );
  }

  private markInventoryRatchetNeeded(): number {
    this.inventoryRatchetRevision += 1;
    return this.inventoryRatchetRevision;
  }

  private waitForInventoryRatchet(revision: number): Promise<void> {
    if (this.inventoryRatchetServicedRevision >= revision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.inventoryRatchetWaiters.add({ revision, resolve, reject });
    });
  }

  private resolveInventoryRatchetWaiters(): void {
    for (const waiter of [...this.inventoryRatchetWaiters]) {
      if (waiter.revision > this.inventoryRatchetServicedRevision) continue;
      this.inventoryRatchetWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectInventoryRatchetWaiters(error: unknown): void {
    for (const waiter of [...this.inventoryRatchetWaiters]) {
      this.inventoryRatchetWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  /**
   * A clean mutation may hand its whole-root ratchet to another concurrent
   * claimant. If that claimant later fails before writing, its finalizer must
   * still service the successful predecessor before releasing the last claim.
   */
  private async flushDeferredInventoryRatchet(
    paths: readonly string[],
    releases: readonly ManagedMutationRelease[],
    inventoryClaimCount = releases.filter(
      (release) => release.advancesInventory && !release.isReleased()
    ).length
  ): Promise<void> {
    if (releases.every((release) => release.isReleased())) return;
    // Settlement owns the final release. In particular, do not return a
    // resolved promise and let the caller release after `await`: a Sync event
    // can run in that microtask gap, see the stale claim, and be stranded as a
    // plugin-owned event with nobody left to classify it.
    await this.notifyManagedRecordWriteUntilSettled(
      paths,
      releases,
      undefined,
      inventoryClaimCount
    );
  }

  /**
   * Keeps the mutation claim until every event that arrived during an
   * observer await has itself been classified. With no await between the
   * final check and claim release, a later event is handled as external by
   * the normal vault listener instead of being stranded as plugin-owned.
   */
  private async notifyManagedRecordWriteUntilSettled(
    paths: readonly string[],
    releases: readonly ManagedMutationRelease[] = [],
    finalIdentityCheck?: () => boolean,
    inventoryClaimCount = paths.filter((path) =>
      this.pathAdvancesTrustedInventory(path)
    ).length,
    requiredInventoryRatchetRevision?: number
  ): Promise<boolean> {
    const release = (): void => {
      for (const releaseClaim of releases) releaseClaim();
    };
    if (!this.managedRecordWriteObserver) {
      const valid = finalIdentityCheck?.() ?? true;
      release();
      return valid;
    }
    let finalIdentityValid = true;
    try {
      while (true) {
        if (finalIdentityValid && finalIdentityCheck && !finalIdentityCheck()) {
          finalIdentityValid = false;
          for (const path of paths) this.noteManagedRecordMutationEvent(path);
        }
        const ownsDirtyEvent = paths.some((path) =>
          this.hasUnclassifiedManagedMutationEvent(path)
        );
        if (!ownsDirtyEvent) {
          const deferredInventoryRatchetPending =
            this.inventoryRatchetServicedRevision < this.inventoryRatchetRevision;
          if (!deferredInventoryRatchetPending) {
            release();
            return finalIdentityValid;
          }
          if (
            inventoryClaimCount > 0 &&
            this.activeInventoryMutationCount > inventoryClaimCount
          ) {
            // Another verified record mutation will be the final claimant and
            // ratchet one inventory containing both writes. Releasing here is
            // atomic, so concurrent clean writes cannot consume each other's
            // still-unverified vault events or baseline partial state.
            release();
            if (requiredInventoryRatchetRevision !== undefined) {
              await this.waitForInventoryRatchet(requiredInventoryRatchetRevision);
            }
            return finalIdentityValid;
          }
        }
        const ratchetRevision = this.inventoryRatchetRevision;
        const ratchetWasDurablyServiced = await this.managedRecordWriteObserver(paths);
        if (ratchetWasDurablyServiced === false) {
          throw new Error(
            "Clinical record verification failed because an untrusted delivery overlapped the inventory update."
          );
        }
        this.inventoryRatchetServicedRevision = Math.max(
          this.inventoryRatchetServicedRevision,
          ratchetRevision
        );
        this.resolveInventoryRatchetWaiters();
        if (finalIdentityValid && finalIdentityCheck && !finalIdentityCheck()) {
          finalIdentityValid = false;
          for (const path of paths) this.noteManagedRecordMutationEvent(path);
          continue;
        }
        if (
          inventoryClaimCount > 0 &&
          this.inventoryRatchetServicedRevision < this.inventoryRatchetRevision
        ) {
          continue;
        }
        if (paths.some((path) => this.hasUnclassifiedManagedMutationEvent(path))) {
          continue;
        }
        // No await may separate the final dirty check from releasing the
        // claim. An event queued after this check will therefore be observed
        // as external instead of being stranded as plugin-owned.
        release();
        return finalIdentityValid;
      }
    } catch (error) {
      this.rejectInventoryRatchetWaiters(error);
      release();
      throw error;
    }
  }

  /** Acquires overlapping path queues in one canonical order, avoiding deadlock. */
  private runWithManagedPathLocks<T>(
    paths: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const ordered = [...new Set(paths.map((path) => normalizePath(path)))].sort();
    const acquire = (index: number): Promise<T> =>
      index >= ordered.length
        ? operation()
        : this.queue.run(ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  /** Marks a bounded plugin-owned maintenance batch so its vault events are not mistaken for Sync. */
  async withManagedRecordMutation<T>(
    paths: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const normalized = [...new Set(paths.map((path) => normalizePath(path)))];
    return this.runWithManagedPathLocks(normalized, async () => {
      this.assertWritesAllowed();
      this.assertManagedMutationAdmissionOpen();
      const identities = new Map<string, { entity: EntityType; id: string }>();
      const inventoryClaimCount = normalized.filter((path) =>
        this.pathAdvancesTrustedInventory(path)
      ).length;
      const releases = normalized.map((path) =>
        this.beginManagedMutation(path, this.pathAdvancesTrustedInventory(path))
      );
      try {
        for (const path of normalized) {
          const before = await this.read<ClinicalRecord>(path, true);
          if (before) {
            identities.set(path, {
              entity: before.record.entity,
              id: before.record.id
            });
          }
        }
        this.assertWritesAllowed();
        const result = await operation();
        for (const path of normalized) {
          const before = identities.get(path);
          const verification = await this.readStableManagedRecord<ClinicalRecord>(path);
          const after = verification.value;
          if (
            before &&
            verification.stable &&
            after?.record.entity === before.entity &&
            after.record.id === before.id &&
            this.pathBelongsToCurrentEntityFolder(path, before.entity) &&
            this.confirmManagedMutationIdentity(path, verification.revision)
          ) {
            // Identity and the event revision were confirmed atomically above.
          }
        }
        const requiredInventoryRatchetRevision = inventoryClaimCount > 0
          ? this.markInventoryRatchetNeeded()
          : undefined;
        const identityStayedInActiveRoot = await this.notifyManagedRecordWriteUntilSettled(
          normalized,
          releases,
          () => normalized.every((path) => {
            const identity = identities.get(path);
            return !identity || this.pathBelongsToCurrentEntityFolder(path, identity.entity);
          }),
          inventoryClaimCount,
          requiredInventoryRatchetRevision
        );
        if (!identityStayedInActiveRoot) {
          throw new Error("The clinical record folder changed during maintenance. Run folder recovery before retrying.");
        }
        return result;
      } catch (error) {
        if (
          normalized.some((path) => this.hasUnclassifiedManagedMutationEvent(path)) &&
          this.managedRecordWriteObserver
        ) {
          await this.notifyManagedRecordWriteUntilSettled(normalized, releases);
        }
        throw error;
      } finally {
        try {
          await this.flushDeferredInventoryRatchet(normalized, releases);
        } finally {
          for (const release of releases) release();
        }
      }
    });
  }

  private assertWritesAllowed(): void {
    if (this.writeBlockReason) throw new Error(this.writeBlockReason);
  }

  /**
   * Drops the trusted index entry after Obsidian reports a vault change for
   * this path. The content-keyed parse memo deliberately survives: it
   * verifies exact content equality on every use, so it can never serve a
   * stale record — and a spurious change event (Sync touches a file without
   * altering it) then re-reads but skips the re-parse.
   */
  invalidatePath(path: string): void {
    this.recordIndex.delete(normalizePath(path));
  }

  private parseRecord(path: string, content: string): ClinicalRecord | null {
    const normalized = normalizePath(path);
    const cached = this.parsedRecords.get(normalized);
    if (cached?.content === content) return cached.record;
    const record = parseClinicalRecord(content);
    this.parsedRecords.set(normalized, { content, record });
    return record;
  }

  /**
   * Serialises a read-check-write sequence under a caller-chosen logical key.
   * Guards that span multiple files (duplicate detection, for instance) cannot
   * rely on path-keyed locking because the file being written does not exist
   * yet when the check runs.
   */
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(`lock:${key}`, async () => {
      // Check inside the queue as well as in create/update. A write can have
      // been waiting behind another operation when Sync arms the barrier.
      this.assertWritesAllowed();
      return operation();
    });
  }

  async ensureStructure(): Promise<void> {
    this.assertWritesAllowed();
    this.assertManagedMutationAdmissionOpen();
    const release = this.beginManagedMutation(
      `structure:${clinicalRootFolder()}`,
      false
    );
    try {
      await this.ensureFolder(clinicalRootFolder());
      for (const folder of allClinicalFolders()) await this.ensureFolder(folder);
      for (const [path, content] of Object.entries(baseFiles())) {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (!existing) {
          this.assertWritesAllowed();
          await this.app.vault.create(normalizePath(path), content);
          continue;
        }
        // Repair a base whose content no longer matches its name (0.1.0 shipped a
        // Patients.base that queried Episodes). Only rewritten when it is plainly
        // wrong, so a base the user has customised is left alone.
        //
        // The decision runs INSIDE Vault.process, against the content the write
        // will actually replace. A separate read-then-modify left a window in
        // which Sync could deliver the user's own version of this file and have
        // it silently destroyed by the repair.
        const expectedFolder = baseSourceFolders()[path];
        if (expectedFolder && existing instanceof TFile) {
          this.assertWritesAllowed();
          let leftAlone = false;
          await this.app.vault.process(existing, (current) => {
            if (current.includes(`file.inFolder("${expectedFolder}")`)) return current;
            // Only a base still recognisably generated is repaired. Once the user
            // has customised it, silently replacing their work on every open is
            // worse than leaving a stale query they can fix themselves.
            if (!isUntouchedBase(path, current)) {
              leftAlone = true;
              return current;
            }
            return content;
          });
          if (leftAlone) {
            console.warn(
              "Clinical Workspace: a database view points at the wrong folder but has been customised, so it was left alone."
            );
          }
        }
      }
      const homePath = `${clinicalFolder("home")}/Clinical Workspace.md`;
      const expectedHome = homeNote();
      const existingHome = this.app.vault.getAbstractFileByPath(homePath);
      if (!existingHome) {
        this.assertWritesAllowed();
        await this.app.vault.create(normalizePath(homePath), expectedHome);
      } else if (existingHome instanceof TFile) {
        // Version 0.1.0 embedded a view name that no longer exists, because the
        // base that held it was renamed; a root-folder migration invalidates the
        // embeds the same way. Rewritten only when an embed is plainly stale —
        // and the staleness decision runs inside Vault.process against the
        // content actually being replaced, so a Sync delivery landing mid-repair
        // is never destroyed.
        this.assertWritesAllowed();
        let editedButStale = false;
        await this.app.vault.process(existingHome, (current) => {
          const stale =
            current.includes("Patients.base#Active patients") ||
            (current.includes("![[") && !current.includes(`${clinicalFolder("bases")}/Patients.base`));
          if (!stale) return current;
          // A note the user has written in is theirs. Repair only the untouched
          // scaffolding this plugin generated.
          if (!isUntouchedHome(current)) {
            editedButStale = true;
            return current;
          }
          return expectedHome;
        });
        if (editedButStale) {
          console.warn(
            "Clinical Workspace: the home note has stale database embeds but has been edited, so it was left alone."
          );
        }
      }
    } finally {
      release();
    }
  }

  /** Managed folders that are absent from the vault. */
  missingFolders(): string[] {
    return allClinicalFolders().filter((folder) => !this.app.vault.getAbstractFileByPath(normalizePath(folder)));
  }

  private async ensureFolder(path: string): Promise<void> {
    this.assertWritesAllowed();
    const normalized = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    const segments = normalized.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        this.assertWritesAllowed();
        await this.app.vault.createFolder(current);
      }
    }
  }

  async create<T extends ClinicalRecord>(record: T): Promise<RecordWithPath<T>> {
    const path = normalizePath(pathForRecord(record.entity, record.id));
    return this.queue.run(path, async () => {
      this.assertWritesAllowed();
      this.assertManagedMutationAdmissionOpen();
      const advancesInventory = this.pathAdvancesTrustedInventory(path);
      const release = this.beginManagedMutation(path, advancesInventory);
      try {
        if (this.app.vault.getAbstractFileByPath(path)) {
          const existing = await this.read<T>(path);
          // Only the exact record being created makes this an idempotent retry.
          // A different record at this path would otherwise be returned as if
          // it were the one the caller asked to create.
          if (existing && existing.record.id === record.id && existing.record.entity === record.entity) {
            return existing;
          }
          throw new Error("A different note already occupies a managed record path. Run the clinical data integrity check.");
        }
        // A managed folder can go missing between sessions — moved in the file
        // explorer, or lost to a sync conflict. Recreating it here means a
        // displaced folder degrades nothing; without this the write fails and,
        // for audit notes, fails silently.
        await this.ensureFolder(folderForEntity(record.entity));
        this.assertWritesAllowed();
        const file = await this.app.vault.create(path, recordMarkdown(record));
        const verification = await this.readStableManagedRecord<T>(file.path);
        const verified = verification.value;
        if (
          !verification.stable ||
          !verified ||
          verified.record.id !== record.id ||
          verified.record.entity !== record.entity ||
          !this.pathBelongsToCurrentEntityFolder(path, record.entity) ||
          !this.confirmManagedMutationIdentity(path, verification.revision)
        ) {
          if (!this.pathBelongsToCurrentEntityFolder(path, record.entity)) {
            this.noteManagedRecordMutationEvent(path);
          }
          throw new Error(`Clinical record verification failed for ${record.id}.`);
        }
        const requiredInventoryRatchetRevision = advancesInventory
          ? this.markInventoryRatchetNeeded()
          : undefined;
        const identityStayedInActiveRoot = await this.notifyManagedRecordWriteUntilSettled(
          [path],
          [release],
          () => this.pathBelongsToCurrentEntityFolder(path, record.entity),
          advancesInventory ? 1 : 0,
          requiredInventoryRatchetRevision
        );
        if (!identityStayedInActiveRoot) {
          throw new Error("The clinical record folder changed while the record was being saved. Run folder recovery before retrying.");
        }
        return verified;
      } catch (error) {
        if (
          this.hasUnclassifiedManagedMutationEvent(path) &&
          this.managedRecordWriteObserver
        ) {
          await this.notifyManagedRecordWriteUntilSettled(
            [path],
            [release],
            undefined,
            advancesInventory ? 1 : 0
          );
        }
        throw error;
      } finally {
        try {
          await this.flushDeferredInventoryRatchet([path], [release]);
        } finally {
          release();
        }
      }
    });
  }

  async read<T extends ClinicalRecord>(path: string, fresh = false): Promise<RecordWithPath<T> | null> {
    const abstract = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(abstract instanceof TFile)) return null;
    if (!fresh) {
      // Served from the index only while the file still exists (checked
      // above) and no vault event has invalidated the path since it was
      // parsed. This is what keeps whole-folder lists linear-in-changes
      // instead of linear-in-records on every workflow action.
      const indexed = this.recordIndex.get(abstract.path);
      if (indexed !== undefined) {
        return indexed ? { record: indexed as T, path: abstract.path } : null;
      }
    }
    const content = fresh
      ? await this.app.vault.read(abstract)
      : await this.app.vault.cachedRead(abstract);
    const record = this.parseRecord(abstract.path, content);
    this.recordIndex.set(abstract.path, record);
    return record ? { record: record as T, path: abstract.path } : null;
  }

  async update<T extends ClinicalRecord>(
    path: string,
    changes: FrontmatterChange
  ): Promise<RecordWithPath<T>> {
    const normalized = normalizePath(path);
    return this.queue.run(normalized, async () => {
      this.assertWritesAllowed();
      this.assertManagedMutationAdmissionOpen();
      const release = this.beginManagedMutation(
        normalized,
        this.pathAdvancesTrustedInventory(normalized)
      );
      try {
        const abstract = this.app.vault.getAbstractFileByPath(normalized);
        if (!(abstract instanceof TFile)) throw new Error("Clinical record not found. It may have been moved or deleted; run the clinical data integrity check.");
        const before = await this.read<T>(normalized, true);
        if (!before) throw new Error("A clinical record could not be read before an update. Run the clinical data integrity check.");
        const expected = { ...changes, updated_at: nowIso() };
        this.assertWritesAllowed();
        await this.app.fileManager.processFrontMatter(abstract, (frontmatter) => {
          const values = frontmatter as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(expected)) values[key] = value;
        });
        const verification = await this.readStableManagedRecord<T>(normalized);
        const verified = verification.value;
        if (!verification.stable || !verified) {
          throw new Error("A clinical record could not be read back after an update. Run the clinical data integrity check.");
        }
        if (
          verified.record.id !== before.record.id ||
          verified.record.entity !== before.record.entity ||
          !this.pathBelongsToCurrentEntityFolder(normalized, before.record.entity)
        ) {
          if (!this.pathBelongsToCurrentEntityFolder(normalized, before.record.entity)) {
            this.noteManagedRecordMutationEvent(normalized);
          }
          throw new Error("A clinical record identity changed during an update. Run the clinical data integrity check.");
        }
        const verifiedValues = verified.record as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(expected)) {
          const actual = verifiedValues[key];
          if (!valueMatches(actual, value)) {
            throw new Error(`Clinical update verification failed for ${key}. Run the clinical data integrity check.`);
          }
        }
        if (!this.confirmManagedMutationIdentity(normalized, verification.revision)) {
          throw new Error("A clinical record changed after update verification. Run the clinical data integrity check.");
        }
        return verified;
      } catch (error) {
        if (
          this.hasUnclassifiedManagedMutationEvent(normalized) &&
          this.managedRecordWriteObserver
        ) {
          await this.notifyManagedRecordWriteUntilSettled([normalized], [release]);
        }
        throw error;
      } finally {
        try {
          // An update preserves record identity, but its inventory claim may
          // inherit a ratchet from a concurrent create that released first.
          // The helper skips the whole-root observer when no such obligation
          // (and no dirty same-path event) exists.
          await this.flushDeferredInventoryRatchet([normalized], [release]);
        } finally {
          release();
        }
      }
    });
  }

  async list<T extends ClinicalRecord>(entity: EntityType): Promise<RecordWithPath<T>[]> {
    const files = markdownFilesInFolder(this.app.vault, folderForEntity(entity));
    const records = await Promise.all(files.map((file) => this.read<T>(file.path)));
    return records.filter((record): record is RecordWithPath<T> => Boolean(record?.record.entity === entity));
  }

  /**
   * Notes sitting in a managed folder that could not be parsed as a record.
   *
   * A note damaged by a sync conflict or a hand edit silently disappears from
   * `list()`, because `parseClinicalRecord` returns null for unreadable
   * frontmatter. Silence is the wrong behaviour here: an unreadable *task* is
   * still outstanding work, and treating it as absent would let an episode be
   * discharged with work still open. Every caller that makes a safety decision
   * from a list must also consult this.
   */
  async unreadablePaths(entity: EntityType): Promise<string[]> {
    return (await this.unreadableRecords(entity)).map(({ path }) => path);
  }

  /** Unreadable notes plus the episode id recoverable from raw task YAML. */
  async unreadableRecords(entity: EntityType): Promise<UnreadableRecordInfo[]> {
    const files = markdownFilesInFolder(this.app.vault, folderForEntity(entity));
    const results = await Promise.all(
      files.map(async (file) => {
        // The healthy common case is served from the index; only files that
        // are unindexed, unreadable, or wrongly filed re-read their content
        // (the raw YAML is needed to attribute an unreadable task).
        const indexed = this.recordIndex.get(file.path);
        if (indexed !== undefined && indexed?.entity === entity) return null;
        const content = await this.app.vault.cachedRead(file);
        const record = this.parseRecord(file.path, content);
        this.recordIndex.set(file.path, record);
        if (record?.entity === entity) return null;
        return {
          path: file.path,
          episodeId: entity === "task" ? episodeIdFromUnreadableTask(content) : null
        };
      })
    );
    return results.filter((item): item is UnreadableRecordInfo => item !== null);
  }

  /**
   * Resolves a record by its stable identifier.
   *
   * The conventional path is checked first because it is a single read and is
   * correct for every record the plugin created and nobody has touched. When a
   * note has been renamed or its filename no longer matches its id, the folder
   * is scanned and the `id` in the frontmatter wins — the filename is cosmetic.
   */
  async findById<T extends ClinicalRecord>(entity: EntityType, id: string): Promise<RecordWithPath<T> | null> {
    if (!id) return null;
    const direct = await this.read<T>(pathForRecord(entity, id));
    if (direct && direct.record.id === id) return direct;
    const all = await this.list<T>(entity);
    return all.find((item) => item.record.id === id) ?? null;
  }

  async findPatientByMrn(mrn: string): Promise<RecordWithPath<PatientRecord> | null> {
    const key = mrnMatchKey(mrn);
    if (!key) return null;
    const patients = await this.list<PatientRecord>("patient");
    const usable = patients.filter(
      (item) => item.record.status !== "entered-in-error" && !item.record.merged_into
    );
    return usable.find((item) => mrnMatchKey(item.record.mrn) === key) ?? null;
  }

  async snapshot(): Promise<ClinicalSnapshot> {
    const [patients, episodes, tasks, procedures] = await Promise.all([
      this.list<PatientRecord>("patient"),
      this.list<EpisodeRecord>("episode"),
      this.list<TaskRecord>("task"),
      this.list<ProcedureRecord>("procedure")
    ]);
    return {
      patients: patients.map((item) => item.record),
      episodes: episodes.map((item) => item.record),
      tasks: tasks.map((item) => item.record),
      procedures: procedures.map((item) => item.record)
    };
  }

  /**
   * Writes a free-form note (for example a generated handover) into a
   * managed folder, honouring the same fail-closed write barrier as record
   * writes. A name collision gets a numeric suffix rather than overwriting.
   */
  async createLooseNote(folder: string, baseName: string, content: string): Promise<string> {
    return this.queue.run(`loose:${folder}/${baseName}`, async () => {
      this.assertWritesAllowed();
      this.assertManagedMutationAdmissionOpen();
      const release = this.beginManagedMutation(
        `loose:${normalizePath(folder)}`,
        false
      );
      try {
        await this.ensureFolder(folder);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const name = attempt === 0 ? baseName : `${baseName} ${attempt + 1}`;
          const path = normalizePath(`${folder}/${name}.md`);
          if (this.app.vault.getAbstractFileByPath(path)) continue;
          this.assertWritesAllowed();
          await this.app.vault.create(path, content);
          return path;
        }
        throw new Error("A unique note name could not be found. Run the clinical data integrity check.");
      } finally {
        release();
      }
    });
  }

  /**
   * Writes an audit note. A failure here must never roll back or fail the
   * clinical action that has already been committed, so the error is reported
   * and swallowed; `IntegrityService` reports the resulting gap separately.
   */
  async createEvent(input: {
    action: string;
    actor?: string;
    patientId?: string;
    episodeId?: string;
    targetId: string;
    targetEntity: EntityType;
    summary: string;
    previousState?: string;
    newState?: string;
  }): Promise<RecordWithPath<EventRecord> | null> {
    const timestamp = nowIso();
    const event: EventRecord = {
      schema_version: SCHEMA_VERSION,
      entity: "event",
      id: createId("EVT"),
      created_at: timestamp,
      updated_at: timestamp,
      tags: ["clinical/event"],
      action: input.action,
      actor: input.actor ?? this.actor,
      patient_id: input.patientId ?? "",
      episode_id: input.episodeId ?? "",
      target_id: input.targetId,
      target_entity: input.targetEntity,
      summary: input.summary,
      previous_state: input.previousState ?? "",
      new_state: input.newState ?? ""
    };
    try {
      return await this.create(event);
    } catch {
      // No identifiers in this message: it reaches the developer console.
      // I/O exceptions can embed a patient-named vault path, so the caught
      // value is intentionally not forwarded.
      console.warn(`Clinical Workspace: audit event "${input.action}" could not be written.`);
      // The user must hear about the gap, not just the console: the clinical
      // action succeeded, so nothing else will look wrong. The integrity
      // check's audit-trail coverage reports the same gap durably.
      new Notice(
        "The clinical action succeeded, but its audit note could not be written. Run the clinical data integrity check to see the gap.",
        9000
      );
      return null;
    }
  }
}
