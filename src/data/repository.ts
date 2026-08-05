import { App, normalizePath, TFile } from "obsidian";
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
import {
  allClinicalFolders,
  clinicalFolder,
  clinicalRootFolder,
  folderForEntity,
  pathForRecord
} from "./paths";

type FrontmatterChange = Record<string, string | number | boolean | string[]>;


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
  /** Recorded as the actor on audit notes; set from settings on load. */
  private actor = "local-user";

  constructor(private readonly app: App) {}

  setActor(actor: string): void {
    this.actor = actor.trim() || "local-user";
  }

  /**
   * Serialises a read-check-write sequence under a caller-chosen logical key.
   * Guards that span multiple files (duplicate detection, for instance) cannot
   * rely on path-keyed locking because the file being written does not exist
   * yet when the check runs.
   */
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(`lock:${key}`, operation);
  }

  async ensureStructure(): Promise<void> {
    await this.ensureFolder(clinicalRootFolder());
    for (const folder of allClinicalFolders()) await this.ensureFolder(folder);
    for (const [path, content] of Object.entries(baseFiles())) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!existing) {
        await this.app.vault.create(normalizePath(path), content);
        continue;
      }
      // Repair a base whose content no longer matches its name (0.1.0 shipped a
      // Patients.base that queried Episodes). Only rewritten when it is plainly
      // wrong, so a base the user has customised is left alone.
      const expectedFolder = baseSourceFolders()[path];
      if (expectedFolder && existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        if (current.includes(`file.inFolder("${expectedFolder}")`)) continue;
        // Only a base still recognisably generated is repaired. Once the user
        // has customised it, silently replacing their work on every open is
        // worse than leaving a stale query they can fix themselves.
        if (!isUntouchedBase(path, current)) {
          console.warn(
            "Clinical Workspace: a database view points at the wrong folder but has been customised, so it was left alone."
          );
          continue;
        }
        await this.app.vault.modify(existing, content);
      }
    }
    const homePath = `${clinicalFolder("home")}/Clinical Workspace.md`;
    const expectedHome = homeNote();
    const existingHome = this.app.vault.getAbstractFileByPath(homePath);
    if (!existingHome) {
      await this.app.vault.create(normalizePath(homePath), expectedHome);
    } else if (existingHome instanceof TFile) {
      // Version 0.1.0 embedded a view name that no longer exists, because the
      // base that held it was renamed; a root-folder migration invalidates the
      // embeds the same way. Rewritten only when an embed is plainly stale.
      const current = await this.app.vault.read(existingHome);
      const stale =
        current.includes("Patients.base#Active patients") ||
        (current.includes("![[") && !current.includes(`${clinicalFolder("bases")}/Patients.base`));
      // A note the user has written in is theirs. Repair only the untouched
      // scaffolding this plugin generated.
      if (stale && isUntouchedHome(current)) {
        await this.app.vault.modify(existingHome, expectedHome);
      } else if (stale) {
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
    const normalized = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    const segments = normalized.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async create<T extends ClinicalRecord>(record: T): Promise<RecordWithPath<T>> {
    const path = normalizePath(pathForRecord(record.entity, record.id));
    return this.queue.run(path, async () => {
      if (this.app.vault.getAbstractFileByPath(path)) {
        const existing = await this.read<T>(path);
        if (existing) return existing;
        throw new Error(`A non-clinical file already exists at ${path}.`);
      }
      // A managed folder can go missing between sessions — moved in the file
      // explorer, or lost to a sync conflict. Recreating it here means a
      // displaced folder degrades nothing; without this the write fails and,
      // for audit notes, fails silently.
      await this.ensureFolder(folderForEntity(record.entity));
      const file = await this.app.vault.create(path, recordMarkdown(record));
      const verified = await this.read<T>(file.path);
      if (!verified || verified.record.id !== record.id || verified.record.entity !== record.entity) {
        throw new Error(`Clinical record verification failed for ${record.id}.`);
      }
      return verified;
    });
  }

  async read<T extends ClinicalRecord>(path: string): Promise<RecordWithPath<T> | null> {
    const abstract = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(abstract instanceof TFile)) return null;
    const content = await this.app.vault.read(abstract);
    const record = parseClinicalRecord(content);
    return record ? { record: record as T, path: abstract.path } : null;
  }

  async update<T extends ClinicalRecord>(
    path: string,
    changes: FrontmatterChange
  ): Promise<RecordWithPath<T>> {
    const normalized = normalizePath(path);
    return this.queue.run(normalized, async () => {
      const abstract = this.app.vault.getAbstractFileByPath(normalized);
      if (!(abstract instanceof TFile)) throw new Error(`Clinical record not found: ${normalized}`);
      const expected = { ...changes, updated_at: nowIso() };
      await this.app.fileManager.processFrontMatter(abstract, (frontmatter) => {
        for (const [key, value] of Object.entries(expected)) frontmatter[key] = value;
      });
      const verified = await this.read<T>(normalized);
      if (!verified) throw new Error(`Clinical record could not be read after update: ${normalized}`);
      for (const [key, value] of Object.entries(expected)) {
        const actual = (verified.record as unknown as Record<string, unknown>)[key];
        if (!valueMatches(actual, value)) {
          throw new Error(`Clinical update verification failed for ${key} in ${normalized}.`);
        }
      }
      return verified;
    });
  }

  async list<T extends ClinicalRecord>(entity: EntityType): Promise<RecordWithPath<T>[]> {
    const folder = `${folderForEntity(entity)}/`;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(folder));
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
    const folder = `${folderForEntity(entity)}/`;
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(folder));
    const results = await Promise.all(
      files.map(async (file) => ((await this.read(file.path)) ? null : file.path))
    );
    return results.filter((path): path is string => path !== null);
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
    } catch (error) {
      // No identifiers in this message: it reaches the developer console.
      console.warn(
        `Clinical Workspace: audit event "${input.action}" could not be written.`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }
}
