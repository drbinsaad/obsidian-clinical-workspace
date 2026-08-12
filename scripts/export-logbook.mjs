/**
 * Export a surgery logbook to CSV by joining procedures and episodes.
 *
 * The default export is PSEUDONYMIZED, NOT ANONYMOUS. It does not read the
 * Patients folder or add dedicated MRN and patient-name columns, but free text,
 * stable case references, dates, and clinical details may still identify a
 * person. The resulting CSV is confidential and may be re-identifiable.
 *
 * Identified export is deliberately opt-in. `--identifiers` reads Patients and
 * adds MRN and patient name after validating every relationship.
 */
import {
  chmod,
  link,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";

// Resolve the package root once from this script rather than from the caller's
// working directory. Confidential exports must never be created anywhere in the
// public source checkout, even when --out reaches it through a symbolic-link
// parent outside the checkout.
const SOURCE_CHECKOUT = await realpath(fileURLToPath(new URL("..", import.meta.url)));

const USAGE = `
  Usage: npm run export:logbook -- "/path/to/vault" --out "/safe/location/logbook.csv" [options]

    --out <file>     Required CSV destination outside the vault and source checkout
    --root <folder>  Vault-relative clinical folder (default "Clinical Workspace")
    --identifiers    Include MRN and patient name; reads the Patients folder
    --force          Replace an existing regular CSV file
    --help           Show this help

  The default CSV is pseudonymized, not anonymous. It remains confidential.
`;

class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportError";
  }
}

function fail(message) {
  throw new ExportError(message);
}

function parseArguments(args) {
  const valueOptions = new Set(["out", "root"]);
  const booleanOptions = new Set(["identifiers", "force", "help"]);
  const values = new Map();
  const flags = new Set();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    // npm removes its separator before invoking this script. Ignoring a literal
    // separator as well keeps direct `node ... -- ...` invocation equivalent.
    if (token === "--") continue;

    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (valueOptions.has(name)) {
        if (values.has(name)) fail(`Option --${name} may be supplied only once.`);
        const value = args[index + 1];
        if (!value || value === "--" || value.startsWith("--")) {
          fail(`Option --${name} requires a value.`);
        }
        values.set(name, value);
        index += 1;
        continue;
      }
      if (booleanOptions.has(name)) {
        if (flags.has(name)) fail(`Flag --${name} may be supplied only once.`);
        flags.add(name);
        continue;
      }
      fail("Unknown command-line option.");
    }

    if (token.startsWith("-") && token !== "-") fail("Unknown command-line option.");

    positionals.push(token);
  }

  if (flags.has("help")) return { help: true };
  if (positionals.length !== 1) fail("Supply exactly one vault path.");
  if (!values.has("out")) fail("Option --out is required; no default output path is used.");

  return {
    help: false,
    vault: positionals[0],
    out: values.get("out"),
    root: values.get("root") ?? "Clinical Workspace",
    identifiers: flags.has("identifiers"),
    force: flags.has("force")
  };
}

function isInside(parent, candidate, allowEqual = false) {
  const relative = path.relative(parent, candidate);
  if (relative === "") return allowEqual;
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function existingDirectory(input, label) {
  try {
    const canonical = await realpath(path.resolve(input));
    const details = await stat(canonical);
    if (!details.isDirectory()) fail(`${label} must be a directory.`);
    return canonical;
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail(`${label} does not exist or cannot be accessed.`);
  }
}

function validateRootArgument(root) {
  if (!root || path.isAbsolute(root)) fail("--root must be a non-empty vault-relative folder.");
  const segments = root.split(/[\\/]+/u);
  if (segments.some((segment) => segment === "..") || segments.every((segment) => segment === "." || segment === "")) {
    fail("--root must name a child folder and may not contain traversal segments.");
  }
}

async function clinicalRoot(vault, rootArgument) {
  validateRootArgument(rootArgument);
  let canonical;
  try {
    canonical = await realpath(path.resolve(vault, rootArgument));
    if (!(await stat(canonical)).isDirectory()) fail("The clinical root must be a directory.");
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail("The clinical root does not exist or cannot be accessed.");
  }
  if (!isInside(vault, canonical)) {
    fail("The clinical root must remain inside the supplied vault, including after resolving symbolic links.");
  }
  return canonical;
}

async function entityFolder(root, name) {
  let canonical;
  try {
    canonical = await realpath(path.join(root, name));
    if (!(await stat(canonical)).isDirectory()) fail(`The required ${name} folder is not a directory.`);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail(`The required ${name} folder does not exist or cannot be accessed.`);
  }
  if (!isInside(root, canonical)) {
    fail(`The required ${name} folder resolves outside the clinical root.`);
  }
  return canonical;
}

async function markdownContents(folder, label) {
  const contents = [];

  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      fail(`The ${label} folder could not be read completely.`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`The ${label} folder contains a symbolic link; export stops rather than following an ambiguous path.`);
      }
      if (entry.isDirectory()) {
        let canonical;
        try {
          canonical = await realpath(candidate);
        } catch {
          fail(`The ${label} folder contains an inaccessible directory.`);
        }
        if (!isInside(folder, canonical, true)) fail(`The ${label} folder contains a path that resolves outside it.`);
        await visit(canonical);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;

      try {
        const canonical = await realpath(candidate);
        if (!isInside(folder, canonical)) fail(`The ${label} folder contains a record outside its boundary.`);
        contents.push(await readFile(canonical, "utf8"));
      } catch (error) {
        if (error instanceof ExportError) throw error;
        fail(`A Markdown record in the ${label} folder could not be read.`);
      }
    }
  }

  await visit(folder);
  return contents;
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

function frontmatter(content) {
  const block = FRONTMATTER.exec(content)?.[1];
  if (!block) return null;
  try {
    const parsed = parse(block, { schema: "core", maxAliasCount: 0 });
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function recordsIn(root, folderName, entity) {
  const folder = await entityFolder(root, folderName);
  const contents = await markdownContents(folder, folderName);
  const records = [];
  let invalid = 0;

  for (const content of contents) {
    const data = frontmatter(content);
    const id = data ? requiredString(data, "id") : null;
    if (!data || data.entity !== entity || !id) {
      invalid += 1;
      continue;
    }
    records.push({ ...data, id });
  }

  if (invalid > 0) {
    fail(`${invalid} Markdown record${invalid === 1 ? "" : "s"} in ${folderName} had invalid or unreadable frontmatter.`);
  }

  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    if (seen.has(record.id)) duplicates += 1;
    seen.add(record.id);
  }
  if (duplicates > 0) {
    fail(`${folderName} contains duplicate record IDs (${duplicates} conflict${duplicates === 1 ? "" : "s"}).`);
  }

  return records;
}

function indexById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function validateRelationships(procedures, episodes, patients) {
  const episodeById = indexById(episodes);
  const patientById = patients ? indexById(patients) : null;
  let invalid = 0;

  for (const episode of episodes) {
    const patientId = requiredString(episode, "patient_id");
    if (!patientId) {
      invalid += 1;
    } else if (patientById && !patientById.has(patientId)) {
      invalid += 1;
    }
  }

  for (const procedure of procedures) {
    const episodeId = requiredString(procedure, "episode_id");
    const procedurePatientId = requiredString(procedure, "patient_id");
    const episode = episodeId ? episodeById.get(episodeId) : null;
    const episodePatientId = episode ? requiredString(episode, "patient_id") : null;

    if (!episodeId || !procedurePatientId || !episode || !episodePatientId) {
      invalid += 1;
      continue;
    }
    if (procedurePatientId !== episodePatientId) invalid += 1;
    if (patientById && !patientById.has(procedurePatientId)) invalid += 1;
  }

  if (invalid > 0) {
    fail(`Record integrity validation found ${invalid} invalid or mismatched relationship${invalid === 1 ? "" : "s"}. No CSV was written.`);
  }

  return { episodeById, patientById };
}

const CARE_SETTINGS = new Set(["inpatient", "outpatient"]);
const PATHWAYS = new Set([
  "assessment",
  "or-booking",
  "opd-follow-up",
  "result-review",
  "consultation",
  "discharge-ready"
]);
const PRIORITIES = new Set(["routine", "urgent", "emergency"]);
const EPISODE_STATUSES = new Set([
  "active",
  "on-hold",
  "ready-to-close",
  "archived",
  "cancelled",
  "entered-in-error"
]);
const PROCEDURE_STATUSES = new Set(["completed", "cancelled", "entered-in-error"]);

function isString(value) {
  return typeof value === "string";
}

function isNonEmptyString(value) {
  return isString(value) && value.trim().length > 0;
}

function isDateOnly(value) {
  if (!isNonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  // Runtime records use UTC ISO timestamps. Date.parse alone is insufficient:
  // it silently normalizes impossible values such as 30 February.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return false;
  const canonical = `${match[1]}.${match[2] ?? "000"}Z`;
  const parsed = new Date(canonical);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === canonical;
}

/**
 * Validate every value that can reach a CSV cell. Empty optional strings are
 * explicit and accepted; missing values, arrays, objects, and invalid enums are
 * not silently stringified. Error output is aggregate-only so it cannot expose
 * a filename, record ID, patient identifier, or clinical text.
 */
function validateExportSchema(procedures, episodeById, patientById, identifiers) {
  let invalidProcedureStatuses = 0;
  let invalidProcedureFields = 0;
  let invalidEpisodeFields = 0;
  let invalidPatientFields = 0;
  const completed = [];
  const joinedEpisodes = new Map();
  const joinedPatients = new Map();

  for (const procedure of procedures) {
    if (!isNonEmptyString(procedure.status) || !PROCEDURE_STATUSES.has(procedure.status)) {
      invalidProcedureStatuses += 1;
      continue;
    }
    if (procedure.status !== "completed") continue;
    completed.push(procedure);

    const stringFields = [procedure.outcome];
    const requiredFields = [procedure.procedure, procedure.role];
    invalidProcedureFields += stringFields.filter((value) => !isString(value)).length;
    invalidProcedureFields += requiredFields.filter((value) => !isNonEmptyString(value)).length;
    if (!isDateOnly(procedure.procedure_date)) invalidProcedureFields += 1;
    if (!isTimestamp(procedure.created_at)) invalidProcedureFields += 1;
    if (typeof procedure.follow_up_required !== "boolean") invalidProcedureFields += 1;
    const followUpDateValid =
      isString(procedure.follow_up_date) &&
      (procedure.follow_up_date === "" || isDateOnly(procedure.follow_up_date));
    if (!followUpDateValid || (procedure.follow_up_required === true && procedure.follow_up_date === "")) {
      invalidProcedureFields += 1;
    }

    const episodeId = requiredString(procedure, "episode_id");
    const patientId = requiredString(procedure, "patient_id");
    const episode = episodeId ? episodeById.get(episodeId) : null;
    const patient = identifiers && patientId ? patientById?.get(patientId) : null;
    if (episode) joinedEpisodes.set(episode.id, episode);
    if (patient) joinedPatients.set(patient.id, patient);
  }

  for (const episode of joinedEpisodes.values()) {
    if (!isNonEmptyString(episode.case)) invalidEpisodeFields += 1;
    if (!isNonEmptyString(episode.care_setting) || !CARE_SETTINGS.has(episode.care_setting)) {
      invalidEpisodeFields += 1;
    }
    if (!isNonEmptyString(episode.pathway) || !PATHWAYS.has(episode.pathway)) invalidEpisodeFields += 1;
    if (!isNonEmptyString(episode.priority) || !PRIORITIES.has(episode.priority)) invalidEpisodeFields += 1;
    if (!isNonEmptyString(episode.status) || !EPISODE_STATUSES.has(episode.status)) invalidEpisodeFields += 1;
  }

  for (const patient of joinedPatients.values()) {
    const validMrn = isString(patient.mrn) && (patient.mrn === "" || /^\d+$/u.test(patient.mrn));
    const validName = isString(patient.patient_name);
    if (!validMrn) {
      invalidPatientFields += 1;
    }
    if (!validName) invalidPatientFields += 1;
    // The runtime permits MRN-only or name-only identities, but never neither.
    if (
      !(validMrn && patient.mrn.length > 0) &&
      !(validName && patient.patient_name.trim().length > 0)
    ) {
      invalidPatientFields += 1;
    }
  }

  const errors = [];
  if (invalidProcedureStatuses > 0) {
    errors.push(`${invalidProcedureStatuses} procedure status value${invalidProcedureStatuses === 1 ? "" : "s"}`);
  }
  if (invalidProcedureFields > 0) {
    errors.push(`${invalidProcedureFields} completed-procedure field value${invalidProcedureFields === 1 ? "" : "s"}`);
  }
  if (invalidEpisodeFields > 0) {
    errors.push(`${invalidEpisodeFields} joined-episode field value${invalidEpisodeFields === 1 ? "" : "s"}`);
  }
  if (invalidPatientFields > 0) {
    errors.push(`${invalidPatientFields} joined-patient identifier field value${invalidPatientFields === 1 ? "" : "s"}`);
  }
  if (errors.length > 0) {
    fail(`Export schema validation rejected ${errors.join(", ")}. No CSV was written.`);
  }

  return completed;
}

async function outputTarget(vault, requested, force) {
  const resolved = path.resolve(requested);
  if (path.extname(resolved).toLowerCase() !== ".csv") fail("--out must use the .csv extension.");

  let parent;
  try {
    parent = await realpath(path.dirname(resolved));
    if (!(await stat(parent)).isDirectory()) fail("The output parent must be a directory.");
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail("The output parent directory does not exist or cannot be accessed.");
  }

  const target = path.join(parent, path.basename(resolved));
  if (isInside(vault, target, true)) {
    fail("The output CSV must be outside the supplied vault, even when --force is used.");
  }
  if (isInside(SOURCE_CHECKOUT, target, true)) {
    fail("The output CSV must be outside this source checkout.");
  }

  let existing = null;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") fail("The output destination could not be inspected safely.");
  }
  if (existing?.isSymbolicLink()) fail("The output destination may not be a symbolic link.");
  if (existing && !existing.isFile()) fail("The output destination must be a regular file.");
  if (existing && !force) fail("The output file already exists. Use --force to replace it explicitly.");

  return target;
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  const withoutControls = [...String(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    // Strip directionality controls (LRM/RLM, embeddings/overrides, isolates):
    // an RLO smuggled into a cell can visually reorder neighbouring cells in a
    // spreadsheet — and this CSV is the one artifact meant to leave the vault.
    // ZWNJ/ZWJ are deliberately preserved: they are orthographically
    // significant in Persian and other Arabic-script text (see
    // src/domain/schema.ts normalizeText, which applies the same class).
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");
  return withoutControls.replace(/\s+/gu, " ").trim();
}

/** Prevent Excel, Numbers, Sheets, and LibreOffice from evaluating formulas. */
function csvCell(value) {
  const raw = cleanText(value);
  const safe = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvFor(procedures, episodeById, patientById, identifiers) {
  const columns = [
    ["case_ref", (procedure) => procedure.id],
    ["date", (procedure) => procedure.procedure_date],
    ["procedure", (procedure) => procedure.procedure],
    ["role", (procedure) => procedure.role],
    ["care_setting", (procedure, episode) => episode.care_setting],
    ["pathway", (procedure, episode) => episode.pathway],
    ["priority", (procedure, episode) => episode.priority],
    ["indication", (procedure, episode) => episode.case],
    ["outcome", (procedure) => procedure.outcome],
    ["follow_up_required", (procedure) => (procedure.follow_up_required ? "yes" : "no")],
    ["follow_up_date", (procedure) => procedure.follow_up_date],
    ["episode_status", (procedure, episode) => episode.status],
    ["logged_at", (procedure) => procedure.created_at],
    ...(identifiers
      ? [
          ["mrn", (procedure, episode, patient) => patient.mrn],
          ["patient_name", (procedure, episode, patient) => patient.patient_name]
        ]
      : [])
  ];

  const completed = [...procedures].sort((left, right) =>
    cleanText(right.procedure_date).localeCompare(cleanText(left.procedure_date))
  );
  const rows = completed.map((procedure) => {
    const episode = episodeById.get(requiredString(procedure, "episode_id"));
    const patient = patientById?.get(requiredString(procedure, "patient_id"));
    return columns.map(([, read]) => csvCell(read(procedure, episode, patient))).join(",");
  });

  return {
    csv: `﻿${columns.map(([name]) => name).join(",")}\n${rows.join("\n")}\n`,
    completed: completed.length
  };
}

async function restrictPermissions(file) {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (process.platform === "win32" && isRecord(error) && ["ENOSYS", "EINVAL", "EPERM"].includes(error.code)) return;
    fail("Owner-only permissions could not be applied to the output safely.");
  }
}

async function atomicWrite(target, content, force) {
  const temporary = path.join(
    path.dirname(target),
    `.clinical-workspace-export-${process.pid}-${randomUUID()}.tmp`
  );
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await restrictPermissions(temporary);

    if (force) {
      try {
        await rename(temporary, target);
      } catch {
        fail("The completed temporary CSV could not replace the destination atomically. No partial CSV was left behind.");
      }
    } else {
      // A same-directory hard link publishes the complete, fsynced inode only
      // if the destination is still absent. Unlike check-then-rename, this is
      // atomic and cannot clobber a file created by a concurrent process.
      try {
        await link(temporary, target);
      } catch (error) {
        if (isRecord(error) && error.code === "EEXIST") {
          fail("The output file appeared during export and was not overwritten. Use --force only after inspecting it.");
        }
        fail("The completed temporary CSV could not be published atomically. No partial CSV was left behind.");
      }
    }
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The cleanup below still removes the private temporary file.
      }
    }
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const vault = await existingDirectory(options.vault, "The supplied vault");
  const root = await clinicalRoot(vault, options.root);
  const target = await outputTarget(vault, options.out, options.force);

  if (options.identifiers) {
    console.error(
      "WARNING: identified export requested. The CSV will contain MRNs and patient names and must be handled as a clinical record."
    );
  }

  const procedures = await recordsIn(root, "Procedures", "procedure");
  if (procedures.length === 0) fail("No valid procedure records were found; no CSV was written.");
  const episodes = await recordsIn(root, "Episodes", "episode");
  const patients = options.identifiers ? await recordsIn(root, "Patients", "patient") : null;
  const { episodeById, patientById } = validateRelationships(procedures, episodes, patients);
  const completed = validateExportSchema(procedures, episodeById, patientById, options.identifiers);
  const result = csvFor(completed, episodeById, patientById, options.identifiers);

  await atomicWrite(target, result.csv, options.force);

  console.log(`Exported ${result.completed} completed procedure record${result.completed === 1 ? "" : "s"}.`);
  const skipped = procedures.length - result.completed;
  if (skipped > 0) {
    console.log(`Excluded ${skipped} non-completed procedure record${skipped === 1 ? "" : "s"}.`);
  }
  console.log(
    options.identifiers
      ? "Identified confidential CSV created with owner-only permissions where supported."
      : "Pseudonymized confidential CSV created. It is not anonymous and may be re-identifiable."
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof ExportError ? error.message : "Unexpected internal error. No CSV was written.";
  console.error(`Export failed: ${message}`);
  process.exitCode = 1;
}
