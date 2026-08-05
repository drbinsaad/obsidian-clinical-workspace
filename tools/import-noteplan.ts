/**
 * Imports NotePlan notes into a Clinical Workspace vault.
 *
 *   npm run import:noteplan -- --from "<staging folder>" --to "<vault>"
 *   npm run import:noteplan -- --from "<staging folder>" --to "<vault>" --apply
 *
 * The source is read-only. Apply is append-only: existing target files are
 * loaded so MRNs and prior imports can be reconciled, but an import that would
 * modify an existing record is refused. New files are created with no-clobber
 * writes and removed again if any write in the batch fails.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { App } from "obsidian";
import { parseClinicalRecord } from "../src/data/markdown";
import { clinicalRootFolder, setClinicalRoot } from "../src/data/paths";
import { ClinicalRepository } from "../src/data/repository";
import { DEFAULT_ROOT_FOLDER, normalizeFolderPath, validateRootFolder } from "../src/domain/settings";
import { mrnMatchKey, normalizeComparable, normalizePhone, todayIso } from "../src/domain/schema";
import type { EpisodeRecord } from "../src/domain/types";
import { ClinicalService } from "../src/services/clinical-service";
import { mergeRules, type ImportRules } from "./noteplan-rules";
import { isExcluded, parseNote, type ParsedNote } from "./noteplan-parse";

const argv = process.argv.slice(2).filter((argument) => argument !== "--");
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const from = flag("from");
const to = flag("to");
const apply = has("apply");
const allowProblems = has("allow-problems");
const skipIdentityConflicts = has("skip-identity-conflicts");
const limit = Number(flag("limit") ?? "0");

if (!from) {
  console.error(`
  Import NotePlan notes into a Clinical Workspace vault.

    npm run import:noteplan -- --from "<staging folder>" --to "<vault>"
    npm run import:noteplan -- --from "<staging folder>" --to "<vault>" --apply

  Options:
    --rules <file.json>   override the parsing rules
    --limit <n>           only look at the first n notes
    --allow-problems      import notes with missing fields reported by preflight
    --skip-identity-conflicts
                          leave ambiguous same-name/MRN clusters untouched
    --apply               create new records (requires --to)

  Never point this command at NotePlan's live data directory. Make a staging
  snapshot after NotePlan has quit, then import from that copy.
`);
  process.exit(1);
}

const exists = async (candidate: string): Promise<boolean> => stat(candidate).then(() => true).catch(() => false);
if (!(await exists(from))) {
  console.error("\n  The staging folder does not exist.\n");
  process.exit(1);
}
if (apply && !to) {
  console.error("\n  --apply needs --to \"<vault>\".\n");
  process.exit(1);
}
if (to && !(await exists(path.join(to, ".obsidian")))) {
  console.error("\n  The target is not an Obsidian vault.\n");
  process.exit(1);
}

const rules: ImportRules = mergeRules(
  flag("rules") ? JSON.parse(await readFile(flag("rules")!, "utf8")) : null
);

// --- Source: read only -------------------------------------------------------

async function textFiles(directory: string, accumulator: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      await textFiles(full, accumulator);
    } else if (/\.(?:md|txt)$/i.test(entry.name)) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

const sourceFiles = (await textFiles(from)).sort((left, right) => left.localeCompare(right));
const files = sourceFiles.filter((file) => {
  const relative = path.relative(from, file).split(path.sep).join("/");
  return path.matchesGlob(relative, rules.includeGlob) && !isExcluded(file, rules);
});
const considered = limit > 0 ? files.slice(0, limit) : files;
const parsed: ParsedNote[] = [];
let skipped = 0;
for (const file of considered) {
  const content = await readFile(file, "utf8");
  const note = parseNote(file, content, rules);
  if (note) parsed.push(note);
  else skipped += 1;
}

const byMrn = new Map<string, ParsedNote[]>();
for (const note of parsed) {
  const key = mrnMatchKey(note.mrn);
  if (!key) continue;
  byMrn.set(key, [...(byMrn.get(key) ?? []), note]);
}
const duplicateMrns = [...byMrn.values()].filter((notes) => notes.length > 1).length;
const noMrn = parsed.filter((note) => !note.mrn).length;
const withProblems = parsed.filter((note) => note.problems.length).length;
const totalOpenTasks = parsed.reduce((count, note) => count + note.openTasks.length, 0);

// A same-name cluster carrying more than one distinct MRN is never safe to
// resolve automatically. Skip the whole cluster rather than importing the two
// numbered notes and leaving only the MRN-less one behind.
const byName = new Map<string, ParsedNote[]>();
for (const note of parsed) {
  const key = normalizeComparable(note.patientName);
  if (!key) continue;
  byName.set(key, [...(byName.get(key) ?? []), note]);
}
const ambiguousNames = new Set(
  [...byName.entries()]
    .filter(([, notes]) => new Set(notes.map((note) => mrnMatchKey(note.mrn)).filter(Boolean)).size > 1)
    .map(([name]) => name)
);

// --- Target: hydrate a safe in-memory model ---------------------------------

type StubVault = {
  files: Map<string, string>;
  folders: Set<string>;
};

const stubVault = (app: App): StubVault => (app as unknown as { vault: StubVault }).vault;

async function configuredRoot(vault: string): Promise<string> {
  const settingsPath = path.join(vault, ".obsidian", "plugins", "clinical-workspace", "data.json");
  if (!(await exists(settingsPath))) return DEFAULT_ROOT_FOLDER;
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    throw new Error("The Clinical Workspace settings file is not valid JSON.");
  }
  const raw = stored && typeof stored === "object" ? (stored as Record<string, unknown>).rootFolder : undefined;
  if (typeof raw !== "string") return DEFAULT_ROOT_FOLDER;
  const root = normalizeFolderPath(raw);
  const problem = validateRootFolder(root);
  if (problem) throw new Error(`The configured clinical folder is unsafe: ${problem}`);
  return root;
}

async function hydrateDirectory(app: App, vault: string, relativeDirectory: string): Promise<void> {
  const absolute = path.join(vault, relativeDirectory);
  if (!(await exists(absolute))) return;
  const memory = stubVault(app);
  memory.folders.add(relativeDirectory.split(path.sep).join("/"));
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await hydrateDirectory(app, vault, relative);
    } else if (/\.(?:md|base)$/i.test(entry.name)) {
      memory.files.set(relative.split(path.sep).join("/"), await readFile(path.join(vault, relative), "utf8"));
    }
  }
}

function addTag(content: string, tag: string): string {
  if (content.includes(`  - ${tag}\n`) || content.includes(`  - ${tag}\r\n`)) return content;
  return content.replace(/^tags:\s*\r?\n/m, (line) => `${line}  - ${tag}\n`);
}

function sourceTag(file: string): string {
  const relative = path.relative(from!, file).split(path.sep).join("/");
  const fingerprint = createHash("sha256").update(relative).digest("hex").slice(0, 20);
  return `clinical/import-source-${fingerprint}`;
}

const app = new App();
let originalFiles = new Map<string, string>();
let targetRecordsBefore = 0;
if (to) {
  const root = await configuredRoot(to);
  setClinicalRoot(root);
  await hydrateDirectory(app, to, root);
  originalFiles = new Map(stubVault(app).files);
  targetRecordsBefore = [...originalFiles.values()].filter((content) => parseClinicalRecord(content)).length;
} else {
  setClinicalRoot(DEFAULT_ROOT_FOLDER);
}

const repository = new ClinicalRepository(app as never);
await repository.ensureStructure();
const service = new ClinicalService(repository);

let createdEpisodes = 0;
let reusedPatients = 0;
let matchedEpisodes = 0;
let alreadyImported = 0;
let verifiedNamePhoneMatches = 0;
let identityConflictNotes = 0;
const failures: string[] = [];
const journalSourceTags: string[] = [];

for (const note of parsed) {
  try {
    const provenanceTag = sourceTag(note.file);
    if (ambiguousNames.has(normalizeComparable(note.patientName))) {
      identityConflictNotes += 1;
      continue;
    }
    const prior = (await repository.list<EpisodeRecord>("episode"))
      .find(({ record }) => record.tags.includes(provenanceTag));
    if (prior) {
      alreadyImported += 1;
      journalSourceTags.push(provenanceTag);
      continue;
    }

    let existingPatientId: string | undefined;
    if (!note.mrn) {
      const candidates = await service.findPatientsByName(note.patientName);
      const verified = candidates.filter(
        (candidate) => note.phone && candidate.phone && normalizePhone(candidate.phone) === normalizePhone(note.phone)
      );
      if (candidates.length === 1 && verified.length === 1) {
        existingPatientId = verified[0]!.id;
        verifiedNamePhoneMatches += 1;
      } else if (candidates.length) {
        throw new Error("An MRN-less source note matches an existing patient name without a unique phone confirmation.");
      }
    }

    const firstTask = note.openTasks[0];
    const result = await service.createEpisode({
      mrn: note.mrn,
      patientName: note.patientName,
      phone: note.phone,
      caseName: note.caseName,
      careSetting: note.careSetting,
      pathway: "assessment",
      priority: note.priority,
      nextAction: firstTask?.text ?? "",
      dueDate: firstTask?.due ?? "",
      forceNewPatient: !note.mrn && !existingPatientId,
      ...(existingPatientId ? { existingPatientId } : {})
    });
    if (result.reusedPatient) reusedPatients += 1;
    if (result.duplicateEpisode) matchedEpisodes += 1;
    else {
      createdEpisodes += 1;
      const content = stubVault(app).files.get(result.episode.path);
      if (content) stubVault(app).files.set(result.episode.path, addTag(content, provenanceTag));
    }

    for (const task of note.openTasks.slice(1)) {
      await service.createTask({
        patientId: result.patient.record.id,
        episodeId: result.episode.record.id,
        task: task.text,
        taskType: "other",
        priority: note.priority,
        dueDate: task.due,
        owner: ""
      });
    }
    journalSourceTags.push(provenanceTag);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

const importTag = `clinical/imported-${todayIso()}`;
const newRecords: Array<[string, string]> = [];
const changedExisting: string[] = [];
for (const [vaultPath, rawContent] of stubVault(app).files) {
  if (!vaultPath.endsWith(".md") || !parseClinicalRecord(rawContent)) continue;
  const before = originalFiles.get(vaultPath);
  if (before === undefined) newRecords.push([vaultPath, addTag(rawContent, importTag)]);
  else if (before !== rawContent) changedExisting.push(vaultPath);
}

const byEntity = new Map<string, number>();
for (const [, content] of newRecords) {
  const entity = parseClinicalRecord(content)?.entity ?? "unknown";
  byEntity.set(entity, (byEntity.get(entity) ?? 0) + 1);
}

console.log(`
  NotePlan import — ${apply ? "APPLY" : "DRY RUN"}
  Privacy-safe report: counts only; no filenames or patient identifiers.

  Source
    text notes found        ${sourceFiles.length}
    considered              ${considered.length}
    recognised as patients  ${parsed.length}
    skipped (not a patient) ${skipped}
    notes with any problem  ${withProblems}
    notes with no MRN       ${noMrn}
    duplicate MRN groups    ${duplicateMrns}
    open tasks recognised   ${totalOpenTasks}
    completed to-dos seen   ${parsed.reduce((count, note) => count + note.doneTasks, 0)}
    cancelled to-dos seen   ${parsed.reduce((count, note) => count + note.cancelledTasks, 0)}

  Target-aware plan
    existing records loaded ${targetRecordsBefore}
    existing patients reused ${reusedPatients}
    name+phone identities confirmed ${verifiedNamePhoneMatches}
    existing episodes matched ${matchedEpisodes}
    source notes already imported ${alreadyImported}
    identity-conflict notes skipped ${identityConflictNotes}
    new patients            ${byEntity.get("patient") ?? 0}
    new episodes            ${byEntity.get("episode") ?? 0}
    new tasks               ${byEntity.get("task") ?? 0}
    new audit events        ${byEntity.get("event") ?? 0}
    existing files changed  ${changedExisting.length}
    conversion failures     ${failures.length}
`);

const blockers: string[] = [];
if (!parsed.length) blockers.push("no patient notes were recognised");
if (withProblems && !allowProblems) blockers.push("some patient notes have unresolved fields");
if (identityConflictNotes && !skipIdentityConflicts) blockers.push("an ambiguous identity cluster needs review");
if (changedExisting.length) blockers.push("the plan would modify existing target records");
if (failures.length) blockers.push("some notes failed conversion");

if (!apply) {
  if (blockers.length) {
    console.log(`  Apply is blocked: ${blockers.join("; ")}.
  Tune the import rules or resolve the target conflict, then repeat this dry run.
`);
  } else {
    console.log(`  Nothing was written. The append-only plan is ready for --apply.
`);
  }
  process.exit(0);
}

if (blockers.length) {
  console.error(`  Nothing was written. Apply is blocked: ${blockers.join("; ")}.
`);
  process.exit(1);
}

// --- Apply: create-only batch with rollback ---------------------------------

const targetRoot = path.resolve(to!);
const createdPaths: string[] = [];
const journalPath = path.join(
  targetRoot,
  ".obsidian",
  "plugins",
  "clinical-workspace",
  "imports",
  `import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);

try {
  for (const [vaultPath, content] of newRecords) {
    const target = path.resolve(targetRoot, vaultPath);
    if (!target.startsWith(`${targetRoot}${path.sep}`)) throw new Error("An import path resolved outside the vault.");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    createdPaths.push(target);
  }

  await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const journal = {
    imported_at: new Date().toISOString(),
    clinical_root: clinicalRootFolder(),
    source_note_fingerprints: journalSourceTags.map((tag) => tag.replace("clinical/import-source-", "")),
    created_record_paths: newRecords.map(([vaultPath]) => vaultPath),
    counts: Object.fromEntries(byEntity)
  };
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  createdPaths.push(journalPath);
} catch (error) {
  for (const created of createdPaths.reverse()) await unlink(created).catch(() => undefined);
  console.error(`  The import failed and newly created files were rolled back: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`  Imported ${createdEpisodes} new episode${createdEpisodes === 1 ? "" : "s"} and wrote ${newRecords.length} new records.
  Existing target files were not overwritten. The source snapshot was not changed.
  Search for #${importTag} to review the imported records.
`);
