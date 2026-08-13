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
  /** Recorded as the actor on audit notes; set from settings on load. */
  private actor = "local-user";
  /** Non-null while Sync/migration recovery cannot identify one writable root. */
  private writeBlockReason: string | null = null;
  /** Persists path-free safety state when the first managed record is written. */
  private managedRecordWriteObserver: (() => Promise<void>) | null = null;

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

  setManagedRecordWriteObserver(observer: (() => Promise<void>) | null): void {
    this.managedRecordWriteObserver = observer;
  }

  private assertWritesAllowed(): void {
    if (this.writeBlockReason) throw new Error(this.writeBlockReason);
  }

  /** Drops memoized YAML after Obsidian reports a vault change for this path. */
  invalidatePath(path: string): void {
    this.parsedRecords.delete(normalizePath(path));
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
      const verified = await this.read<T>(file.path, true);
      if (!verified || verified.record.id !== record.id || verified.record.entity !== record.entity) {
        throw new Error(`Clinical record verification failed for ${record.id}.`);
      }
      if (this.managedRecordWriteObserver) await this.managedRecordWriteObserver();
      return verified;
    });
  }

  async read<T extends ClinicalRecord>(path: string, fresh = false): Promise<RecordWithPath<T> | null> {
    const abstract = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(abstract instanceof TFile)) return null;
    const content = fresh
      ? await this.app.vault.read(abstract)
      : await this.app.vault.cachedRead(abstract);
    const record = this.parseRecord(abstract.path, content);
    return record ? { record: record as T, path: abstract.path } : null;
  }

  async update<T extends ClinicalRecord>(
    path: string,
    changes: FrontmatterChange
  ): Promise<RecordWithPath<T>> {
    const normalized = normalizePath(path);
    return this.queue.run(normalized, async () => {
      this.assertWritesAllowed();
      const abstract = this.app.vault.getAbstractFileByPath(normalized);
      if (!(abstract instanceof TFile)) throw new Error("Clinical record not found. It may have been moved or deleted; run the clinical data integrity check.");
      const expected = { ...changes, updated_at: nowIso() };
      this.assertWritesAllowed();
      await this.app.fileManager.processFrontMatter(abstract, (frontmatter) => {
        const values = frontmatter as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(expected)) values[key] = value;
      });
      const verified = await this.read<T>(normalized, true);
      if (!verified) throw new Error("A clinical record could not be read back after an update. Run the clinical data integrity check.");
      const verifiedValues = verified.record as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) {
        const actual = verifiedValues[key];
        if (!valueMatches(actual, value)) {
          throw new Error(`Clinical update verification failed for ${key}. Run the clinical data integrity check.`);
        }
      }
      return verified;
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
        const content = await this.app.vault.cachedRead(file);
        const record = this.parseRecord(file.path, content);
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
