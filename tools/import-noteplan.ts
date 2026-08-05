/**
 * Imports NotePlan notes into a Clinical Workspace vault.
 *
 *   npm run import:noteplan -- --from "<staging folder>" [--rules rules.json]
 *   npm run import:noteplan -- --from "<staging folder>" --to "<vault>" --apply
 *
 * Reads only. The source folder is never written to, renamed or deleted from,
 * and nothing is written anywhere without --apply.
 *
 * Records are produced by driving the plugin's own ClinicalService against an
 * in-memory vault, then writing the result to disk. That means an imported
 * record is byte-identical to one the plugin would have created itself —
 * including ids, idempotency keys, wikilinks and audit events — rather than
 * frontmatter this tool assembles by hand and hopes is right.
 */
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { App } from "obsidian";
import { ClinicalRepository } from "../src/data/repository";
import { ClinicalService } from "../src/services/clinical-service";
import { todayIso } from "../src/domain/schema";
import { mergeRules, type ImportRules } from "./noteplan-rules";
import { isExcluded, parseNote, type ParsedNote } from "./noteplan-parse";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

const from = flag("from");
const to = flag("to");
const apply = has("apply");
const limit = Number(flag("limit") ?? "0");

if (!from) {
  console.error(`
  Import NotePlan notes into a Clinical Workspace vault.

    npm run import:noteplan -- --from "<staging folder>"              # dry run
    npm run import:noteplan -- --from "<folder>" --to "<vault>" --apply

  Options:
    --rules <file.json>   override the parsing rules
    --limit <n>           only look at the first n notes
    --apply               actually write (requires --to)

  The source folder is only ever read. Copy your NotePlan notes into a staging
  folder first; never point this at the live NotePlan directory.
`);
  process.exit(1);
}

const exists = async (p: string) => stat(p).then(() => true).catch(() => false);
if (!(await exists(from))) {
  console.error(`\n  No such folder: ${from}\n`);
  process.exit(1);
}
if (apply && !to) {
  console.error("\n  --apply needs --to \"<vault>\"\n");
  process.exit(1);
}
if (to && !(await exists(path.join(to, ".obsidian")))) {
  console.error(`\n  Not an Obsidian vault (no .obsidian folder): ${to}\n`);
  process.exit(1);
}

const rules: ImportRules = mergeRules(
  flag("rules") ? JSON.parse(await readFile(flag("rules")!, "utf8")) : null
);

// --- Read the source (never write to it) ------------------------------------

async function markdownFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      await markdownFiles(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

const files = (await markdownFiles(from)).filter((f) => !isExcluded(f, rules));
const considered = limit > 0 ? files.slice(0, limit) : files;

const parsed: ParsedNote[] = [];
let skipped = 0;
for (const file of considered) {
  const note = parseNote(file, await readFile(file, "utf8"), rules);
  if (note) parsed.push(note);
  else skipped += 1;
}

// --- Report -----------------------------------------------------------------

const byMrn = new Map<string, ParsedNote[]>();
for (const note of parsed) {
  if (!note.mrn) continue;
  byMrn.set(note.mrn, [...(byMrn.get(note.mrn) ?? []), note]);
}
const duplicates = [...byMrn.entries()].filter(([, notes]) => notes.length > 1);
const noMrn = parsed.filter((n) => !n.mrn);
const withProblems = parsed.filter((n) => n.problems.length);
const totalOpenTasks = parsed.reduce((n, p) => n + p.openTasks.length, 0);

const rel = (f: string) => path.relative(from!, f);

console.log(`
  NotePlan import — ${apply ? "APPLY" : "DRY RUN"}
  source: ${from}${to ? `\n  target: ${to}` : ""}

  Files
    markdown found          ${files.length}
    considered              ${considered.length}
    recognised as patients  ${parsed.length}
    skipped (not a patient) ${skipped}

  Would create
    patients                ${byMrn.size + noMrn.length}
    episodes                ${parsed.length}
    open tasks              ${totalOpenTasks}
    (completed to-dos seen  ${parsed.reduce((n, p) => n + p.doneTasks, 0)}, not imported)
    (cancelled to-dos seen  ${parsed.reduce((n, p) => n + p.cancelledTasks, 0)}, not imported)

  Needs your attention
    duplicate MRNs          ${duplicates.length}
    notes with no MRN       ${noMrn.length}
    notes with any problem  ${withProblems.length}
`);

if (duplicates.length) {
  console.log("  Duplicate MRNs — these notes share an MRN and will merge into one patient:");
  for (const [mrn, notes] of duplicates.slice(0, 20)) {
    console.log(`    ${mrn}  ->  ${notes.map((n) => rel(n.file)).join(", ")}`);
  }
  console.log("");
}
if (withProblems.length) {
  console.log("  Notes the rules did not fully understand:");
  for (const note of withProblems.slice(0, 30)) {
    console.log(`    ${rel(note.file)}\n      ${note.problems.join("; ")}`);
  }
  if (withProblems.length > 30) console.log(`    ... and ${withProblems.length - 30} more`);
  console.log("");
}

if (!apply) {
  console.log(`  Nothing was written. Review the above, then re-run with:
    --to "<vault>" --apply

  If the numbers look wrong the rules need tuning, not the data. Copy
  tools/noteplan-rules.ts defaults into a JSON file, edit, and pass --rules.
`);
  process.exit(0);
}

// --- Apply ------------------------------------------------------------------

const app = new App() as never;
const repository = new ClinicalRepository(app);
await repository.ensureStructure();
const service = new ClinicalService(repository);

let created = 0;
const failures: string[] = [];
for (const note of parsed) {
  try {
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
      forceNewPatient: !note.mrn
    });
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
    created += 1;
  } catch (error) {
    failures.push(`${rel(note.file)}: ${error instanceof Error ? error.message : error}`);
  }
}

const vaultFiles = (app as unknown as { vault: { files: Map<string, string> } }).vault.files;
let written = 0;
for (const [vaultPath, content] of vaultFiles) {
  if (!vaultPath.endsWith(".md")) continue;
  const target = path.join(to!, vaultPath);
  await mkdir(path.dirname(target), { recursive: true });
  // Imported records are tagged so the whole import can be found — and undone.
  await writeFile(target, content.replace(/^tags:\n/m, `tags:\n  - clinical/imported-${todayIso()}\n`));
  written += 1;
}

console.log(`  Imported ${created} episode${created === 1 ? "" : "s"}; wrote ${written} notes to ${to}`);
if (failures.length) {
  console.log(`\n  ${failures.length} note${failures.length === 1 ? "" : "s"} failed:`);
  for (const f of failures.slice(0, 20)) console.log(`    ${f}`);
}
console.log(`
  Every imported record is tagged  #clinical/imported-${todayIso()}
  Search that tag to review the whole import, or to remove it.

  Next: open the vault and run the integrity check.
`);
