/**
 * Exports the surgery logbook to CSV, joined across record types.
 *
 *   npm run export:logbook -- "/path/to/vault"
 *   npm run export:logbook -- "/path/to/vault" --out ~/Desktop/logbook.csv
 *   npm run export:logbook -- "/path/to/vault" --identifiers      # see below
 *
 * The Surgery Logbook base cannot produce this. A base filters one folder, and
 * the fields an appraisal logbook needs are spread across three: the procedure
 * carries the operation and role, the episode carries inpatient/outpatient,
 * pathway and priority, and the patient carries the identifiers. This joins them.
 *
 * DE-IDENTIFIED BY DEFAULT. A training or appraisal logbook almost never needs
 * an MRN or a name, and a spreadsheet is far easier to mislay than a vault.
 * Each row instead carries the procedure's own stable id, which resolves back
 * to the note if a case ever has to be looked up. `--identifiers` adds MRN and
 * patient name; it prints a warning, because that file is then a clinical
 * record and inherits every obligation that comes with one.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};

const vault = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--out" && argv[argv.indexOf(a) - 1] !== "--root");
const root = option("root", "Clinical Workspace");
const withIdentifiers = flag("identifiers");
const outPath = option("out", path.resolve("surgery-logbook.csv"));

if (!vault || flag("help")) {
  console.error(`
  Usage: npm run export:logbook -- "/path/to/vault" [options]

    --out <file>     Where to write the CSV      (default ./surgery-logbook.csv)
    --root <folder>  Clinical folder name        (default "Clinical Workspace")
    --identifiers    Include MRN and patient name (off by default)
`);
  process.exit(1);
}

/** Reads every .md under one folder. Nothing outside the clinical root is touched. */
async function notesIn(folder) {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("._"));
  return Promise.all(
    files.map(async (e) => {
      const full = path.join(e.parentPath ?? e.path, e.name);
      return { path: full, content: await readFile(full, "utf8") };
    })
  );
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function frontmatter(content) {
  const block = FRONTMATTER.exec(content)?.[1];
  if (!block) return null;
  try {
    const parsed = parse(block, { schema: "core" });
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function recordsIn(folder, entity) {
  const found = [];
  const unreadable = [];
  for (const note of await notesIn(path.join(vault, root, folder))) {
    const data = frontmatter(note.content);
    if (!data || data.entity !== entity || !data.id) {
      unreadable.push(note.path);
      continue;
    }
    found.push(data);
  }
  return { found, unreadable };
}

const procedures = await recordsIn("Procedures", "procedure");
const episodes = await recordsIn("Episodes", "episode");
const patients = await recordsIn("Patients", "patient");

if (!procedures.found.length && !procedures.unreadable.length) {
  console.error(`\n  No procedure notes found under "${path.join(vault, root, "Procedures")}".`);
  console.error("  Check the vault path and --root.\n");
  process.exit(1);
}

const byId = (list) => new Map(list.map((r) => [r.id, r]));
const episodeById = byId(episodes.found);
const patientById = byId(patients.found);

const text = (value) => (value === null || value === undefined ? "" : String(value)).replace(/\s+/g, " ").trim();

/**
 * Neutralises spreadsheet formula injection. A field beginning =, +, -, @ or a
 * control character is executed as a formula by Excel, Sheets and LibreOffice,
 * and clinical free text is user-authored — an outcome note starting with "-"
 * is ordinary. Prefixing with an apostrophe keeps the value readable as data.
 */
const csvCell = (value) => {
  const raw = text(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

const columns = [
  ["case_ref", (p) => p.id],
  ["date", (p) => p.procedure_date],
  ["procedure", (p) => p.procedure],
  ["role", (p) => p.role],
  ["care_setting", (p, e) => e?.care_setting],
  ["pathway", (p, e) => e?.pathway],
  ["priority", (p, e) => e?.priority],
  ["indication", (p, e) => e?.case],
  ["outcome", (p) => p.outcome],
  ["follow_up_required", (p) => (p.follow_up_required ? "yes" : "no")],
  ["follow_up_date", (p) => p.follow_up_date],
  ["episode_status", (p, e) => e?.status],
  ["logged_at", (p) => p.created_at],
  ...(withIdentifiers
    ? [
        ["mrn", (p, e, q) => q?.mrn],
        ["patient_name", (p, e, q) => q?.patient_name]
      ]
    : [])
];

const rows = procedures.found
  .filter((p) => p.status === "completed")
  .sort((a, b) => text(b.procedure_date).localeCompare(text(a.procedure_date)))
  .map((procedure) => {
    const episode = episodeById.get(procedure.episode_id);
    const patient = patientById.get(procedure.patient_id);
    return columns.map(([, read]) => csvCell(read(procedure, episode, patient))).join(",");
  });

// A BOM so Excel opens Arabic and accented names in UTF-8 rather than mojibake.
const csv = `﻿${columns.map(([name]) => name).join(",")}\n${rows.join("\n")}\n`;
await writeFile(outPath, csv, "utf8");

// --- Summary, which is what an appraisal actually asks for -------------------
const tally = (read) => {
  const counts = new Map();
  for (const procedure of procedures.found.filter((p) => p.status === "completed")) {
    const key = text(read(procedure, episodeById.get(procedure.episode_id))) || "(not recorded)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

const show = (title, entries) => {
  console.log(`\n  ${title}`);
  for (const [key, count] of entries) console.log(`    ${String(count).padStart(4)}  ${key}`);
};

console.log(`\n  Wrote ${rows.length} completed procedure${rows.length === 1 ? "" : "s"} to ${outPath}`);
show("By role", tally((p) => p.role));
show("By patient type", tally((p, e) => e?.care_setting));
show("By procedure", tally((p) => p.procedure));

const skipped = procedures.found.length - rows.length;
if (skipped > 0) console.log(`\n  ${skipped} non-completed procedure record${skipped === 1 ? "" : "s"} excluded.`);

const orphans = procedures.found.filter((p) => !episodeById.has(p.episode_id)).length;
if (orphans > 0) {
  console.log(`  ${orphans} procedure${orphans === 1 ? "" : "s"} could not be joined to an episode; their patient-type columns are blank.`);
  console.log("  Run the plugin's integrity check to see why.");
}

for (const [label, set] of [["procedure", procedures], ["episode", episodes], ["patient", patients]]) {
  if (set.unreadable.length) {
    console.log(`\n  WARNING: ${set.unreadable.length} ${label} note(s) could not be read and are MISSING from this export:`);
    for (const p of set.unreadable) console.log(`    ${path.relative(vault, p)}`);
  }
}

console.log(
  withIdentifiers
    ? "\n  WARNING: this CSV contains MRNs and patient names. It is a clinical record.\n  Store, transfer and dispose of it under the same policy as the vault.\n"
    : "\n  De-identified: no MRN or patient name. Use case_ref to trace a row back to its note.\n  Add --identifiers only if you have a specific reason to.\n"
);
