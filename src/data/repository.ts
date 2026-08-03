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
import { BASE_FILES, BASE_SOURCE_FOLDERS } from "./bases";
import { parseClinicalRecord, recordMarkdown, valueMatches } from "./markdown";
import {
  ALL_CLINICAL_FOLDERS,
  CLINICAL_FOLDERS,
  CLINICAL_ROOT,
  folderForEntity,
  pathForRecord
} from "./paths";

type FrontmatterChange = Record<string, string | number | boolean | string[]>;

const HOME_NOTE = [
  "# Clinical Workspace",
  "",
  "Use the **Open Clinical Workspace** command for the mobile patient, task and surgery interface.",
  "",
  "## Database views",
  "",
  "- ![[Clinical Workspace/Bases/Patients.base#All patients]]",
  "- ![[Clinical Workspace/Bases/Episodes.base#Active episodes]]",
  "- ![[Clinical Workspace/Bases/Tasks.base#Open tasks]]",
  "- ![[Clinical Workspace/Bases/Surgery Logbook.base#Surgery logbook]]",
  ""
].join("\n");

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

  constructor(private readonly app: App) {}

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
    await this.ensureFolder(CLINICAL_ROOT);
    for (const folder of ALL_CLINICAL_FOLDERS) await this.ensureFolder(folder);
    for (const [path, content] of Object.entries(BASE_FILES)) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!existing) {
        await this.app.vault.create(normalizePath(path), content);
        continue;
      }
      // Repair a base whose content no longer matches its name (0.1.0 shipped a
      // Patients.base that queried Episodes). Only rewritten when it is plainly
      // wrong, so a base the user has customised is left alone.
      const expectedFolder = BASE_SOURCE_FOLDERS[path];
      if (expectedFolder && existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        if (!current.includes(`file.inFolder("${expectedFolder}")`)) {
          await this.app.vault.modify(existing, content);
        }
      }
    }
    const homePath = `${CLINICAL_FOLDERS.home}/Clinical Workspace.md`;
    const homeNote = this.app.vault.getAbstractFileByPath(homePath);
    if (!homeNote) {
      await this.app.vault.create(normalizePath(homePath), HOME_NOTE);
    } else if (homeNote instanceof TFile) {
      // Version 0.1.0 embedded a view name that no longer exists, because the
      // base that held it was renamed. Left alone, the embed renders as an
      // error. Only the known-stale form is replaced.
      const current = await this.app.vault.read(homeNote);
      if (current.includes("Patients.base#Active patients")) {
        await this.app.vault.modify(homeNote, HOME_NOTE);
      }
    }
  }

  /** Managed folders that are absent from the vault. */
  missingFolders(): string[] {
    return ALL_CLINICAL_FOLDERS.filter((folder) => !this.app.vault.getAbstractFileByPath(normalizePath(folder)));
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
      actor: input.actor ?? "local-user",
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
