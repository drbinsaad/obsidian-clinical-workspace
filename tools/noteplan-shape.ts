/**
 * Reports the *shape* of a NotePlan folder: how many files carry each
 * structural feature the importer looks for.
 *
 * Deliberately emits counts and nothing else — no file names, no note content,
 * no captured values. It exists so import rules can be tuned against real notes
 * without the notes themselves having to be shown to anyone.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DEFAULT_RULES } from "./noteplan-rules";
import { isExcluded } from "./noteplan-parse";

const from = process.argv[2];
if (!from) {
  console.error("Usage: npm run import:shape -- \"<staging folder>\"");
  process.exit(1);
}

async function markdownFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      await markdownFiles(full, acc);
    } else if (/\.(?:md|txt)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

const all = await markdownFiles(from);
const considered = all.filter((f) => !isExcluded(f, DEFAULT_RULES));

/** How many files satisfy a predicate. Never reports which. */
const count = (files: { body: string; name: string }[], test: (f: { body: string; name: string }) => boolean) =>
  files.filter(test).length;

const files: { body: string; name: string }[] = [];
for (const f of considered) files.push({ body: await readFile(f, "utf8"), name: path.basename(f) });

const rx = (p: string) => new RegExp(p, "m");
const anyOf = (patterns: string[], body: string) => patterns.some((p) => rx(p).test(body));

type ShapeFile = { body: string; name: string };
type ShapeRow = readonly [string, (file: ShapeFile) => boolean];

const structural: readonly ShapeRow[] = [
  ["has YAML frontmatter", (f) => /^---\r?\n/.test(f.body)],
  ["has a '# ' heading", (f) => /^#\s+\S/m.test(f.body)],
  ["has a '## ' heading", (f) => /^##\s+\S/m.test(f.body)],
  ["filename starts with digits", (f) => /^\d/.test(f.name)],
  ["contains a 4+ digit number", (f) => /\d{4,}/.test(f.body)],
  ["contains 'MRN' (any case)", (f) => /mrn/i.test(f.body)],
  ["contains a phone-like label", (f) => /(phone|tel|mobile|contact)/i.test(f.body)],
  ["contains a reason-like label", (f) => /(case|reason|diagnos|dx|problem|complaint|indication)/i.test(f.body)],
  ["contains '#' tags", (f) => /(^|\s)#[A-Za-z][\w/-]*/.test(f.body)],
  ["contains a wikilink", (f) => /\[\[.+?\]\]/.test(f.body)]
] as const;

const todo: readonly ShapeRow[] = [
  ["'* [ ]' open to-do", (f) => /^\s*\*\s*\[ \]/m.test(f.body)],
  ["'- [ ]' open to-do", (f) => /^\s*-\s*\[ \]/m.test(f.body)],
  ["'+ [ ]' open to-do", (f) => /^\s*\+\s*\[ \]/m.test(f.body)],
  ["'* ' plain bullet", (f) => /^\s*\*\s+(?!\[)\S/m.test(f.body)],
  ["'- ' plain bullet", (f) => /^\s*-\s+(?!\[)\S/m.test(f.body)],
  ["'[x]' done", (f) => /^\s*[*+-]\s*\[[xX]\]/m.test(f.body)],
  ["'[-]' cancelled", (f) => /^\s*[*+-]\s*\[-\]/m.test(f.body)],
  ["'>YYYY-MM-DD' schedule", (f) => />\d{4}-\d{2}-\d{2}/.test(f.body)],
  ["'@due(...)'", (f) => /@due\(/.test(f.body)]
] as const;

const rulesNow: readonly ShapeRow[] = [
  ["current MRN patterns match", (f) => anyOf(DEFAULT_RULES.mrnPatterns, f.body)],
  ["current name patterns match", (f) => anyOf(DEFAULT_RULES.namePatterns, f.body)],
  ["current phone patterns match", (f) => anyOf(DEFAULT_RULES.phonePatterns, f.body)],
  ["current case patterns match", (f) => anyOf(DEFAULT_RULES.casePatterns, f.body)],
  ["current open-task patterns match", (f) => anyOf(DEFAULT_RULES.openTaskPatterns, f.body)],
  ["hits a 'not a patient' marker", (f) => DEFAULT_RULES.notAPatientMarkers.some((m) => f.body.includes(m))]
] as const;

const section = (title: string, rows: readonly ShapeRow[]) => {
  console.log(`\n  ${title}`);
  for (const [label, test] of rows) {
    const n = count(files, test);
    const bar = "#".repeat(Math.round((n / Math.max(files.length, 1)) * 20));
    console.log(`    ${label.padEnd(34)} ${String(n).padStart(4)} / ${files.length}  ${bar}`);
  }
};

const lineCounts = files.map((f) => f.body.split("\n").length).sort((a, b) => a - b);
const median = lineCounts[Math.floor(lineCounts.length / 2)] ?? 0;

console.log(`
  NotePlan shape report
  Counts only — no file names, no content, no captured values.

  markdown files            ${all.length}
  after exclusions          ${considered.length}
  median lines per note     ${median}`);

section("Structure", structural);
section("To-do syntax", todo);
section("Against the current import rules", rulesNow);

console.log(`
  A zero against "current MRN patterns match" or "current open-task patterns
  match" means the rules need changing, not the notes.
`);
